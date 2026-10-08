import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { resolve } from "node:path";
import {
  credentials,
  loadPackageDefinition,
  Metadata,
  status,
} from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";

// 故障实例只注入观测契约；消息错误由 MessageQuery 的传输测试验证。
// 不打印原始响应，也不把合成故障当成真实 IM 事实。
const { operations } = loadPackageDefinition(
  loadSync(resolve("src/connectors/go-im/proto/operations.proto"), {
    longs: String,
    defaults: true,
    keepCase: false,
  }),
);
const token = process.env.GO_IM_OBSERVATION_SERVICE_TOKEN;
if (
  !token ||
  !process.env.GO_IM_FAULT_GRPC_URL ||
  !process.env.GO_IM_OBSERVATION_GRPC_URL
)
  throw new Error("observation_fault_configuration_missing");
const metadata = new Metadata();
metadata.set("x-im-service-token", token);
metadata.set("x-request-id", "fault-deployment-probe");
const transport = () =>
  process.env.GO_IM_INSECURE === "true"
    ? credentials.createInsecure()
    : credentials.createSsl();
const fault = new operations.ObservationQuery(
  process.env.GO_IM_FAULT_GRPC_URL,
  transport(),
);
const baseline = new operations.ObservationQuery(
  process.env.GO_IM_OBSERVATION_GRPC_URL,
  transport(),
);
function call(client, method, input, meta = metadata) {
  return new Promise((resolveResponse, reject) =>
    client[method](
      input,
      meta,
      { deadline: new Date(Date.now() + 5000) },
      (err, response) => (err ? reject(err) : resolveResponse(response)),
    ),
  );
}
try {
  for (const client of [fault, baseline]) {
    const caps = await call(client, "getCapabilities", {});
    assert.equal(caps.messageRecord, "unsupported");
    assert.equal(caps.messageSearch, "unsupported");
  }
  const input = (suffix) => ({
    messageId: "665f1c0000000000000000" + suffix,
    limit: 1,
  });
  const empty = await call(fault, "getDeliveryTimeline", input("a1"));
  assert.equal(empty.events.length, 0);
  assert.equal(empty.coverageStatus, "complete");
  await assert.rejects(call(fault, "getDeliveryTimeline", input("a2")), {
    code: status.DEADLINE_EXCEEDED,
  });
  for (const [suffix, type] of [
    ["a3", "receiver_offline"],
    ["a4", "ack_timeout"],
  ]) {
    const result = await call(fault, "getDeliveryTimeline", input(suffix));
    assert.equal(result.events[0].eventType, type);
    assert.equal(result.events[0].source, "fault-injection");
  }
  await assert.rejects(
    call(fault, "getConnectionObservations", {
      userId: "fault-user-timeout",
      limit: 1,
    }),
    { code: status.DEADLINE_EXCEEDED },
  );
  await assert.rejects(call(fault, "getDeliveryTimeline", input("a6")), {
    code: status.UNIMPLEMENTED,
  });
  const normal = await call(baseline, "getDeliveryTimeline", input("a3"));
  assert.ok(normal.events.every((event) => event.source !== "fault-injection"));
  await assert.rejects(call(fault, "getCapabilities", {}, new Metadata()), {
    code: status.PERMISSION_DENIED,
  });
  console.log("observation_fault_checks=8_passed");
} catch (error) {
  console.error(
    "fault_deployment_probe=failed code=" + (error.code ?? error.name),
  );
  process.exitCode = 1;
} finally {
  fault.close();
  baseline.close();
}

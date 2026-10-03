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

// Deployment Probe（部署探测）：只读验证服务端注入，真实 Token 仅放在 metadata。
// 不调用模型，不打印原始响应；合成注入结果不能记为真实 IM 故障。
const definition = loadSync(
  resolve("src/connectors/go-im/proto/operations.proto"),
  {
    longs: String,
    defaults: true,
    keepCase: false,
  },
);
const { operations } = loadPackageDefinition(definition);
const metadata = new Metadata();
if (!process.env.GO_IM_SERVICE_TOKEN) throw new Error("service_token_missing");
metadata.set("x-im-service-token", process.env.GO_IM_SERVICE_TOKEN);
metadata.set("x-request-id", "fault-deployment-probe");
metadata.set("x-agent-run-id", "fault-deployment-probe");
const fault = new operations.OperationsQuery(
  process.env.GO_IM_FAULT_GRPC_URL ?? "127.0.0.1:19100",
  credentials.createInsecure(),
);
const baseline = new operations.OperationsQuery(
  process.env.GO_IM_BASELINE_GRPC_URL ?? "127.0.0.1:19101",
  credentials.createInsecure(),
);

function call(client, method, input, meta = metadata) {
  return new Promise((resolveResponse, reject) => {
    client[method](
      input,
      meta,
      { deadline: new Date(Date.now() + 5000) },
      (error, response) => {
        if (error) reject(error);
        else resolveResponse(response);
      },
    );
  });
}

try {
  await call(fault, "getCapabilities", {});
  await call(baseline, "getCapabilities", {});
  console.log("both_services_reachable=passed");
  const missing = await call(fault, "getMessageRecord", {
    messageId: "665f1c0000000000000000a1",
  });
  assert.equal(missing.found, false);
  assert.equal(missing.source, "fault-injection");
  console.log("message_missing=passed");
  for (const [suffix, code, name] of [
    ["a2", status.DEADLINE_EXCEEDED, "query_timeout"],
    ["a3", status.PERMISSION_DENIED, "permission_denied"],
    ["a6", status.UNIMPLEMENTED, "unsupported_capability"],
  ]) {
    await assert.rejects(
      call(fault, "getMessageRecord", {
        messageId: `665f1c0000000000000000${suffix}`,
      }),
      { code },
    );
    console.log(`${name}=passed`);
  }
  const mismatch = await call(fault, "getMessageRecord", {
    messageId: "665f1c0000000000000000a4",
  });
  assert.equal(mismatch.found, true);
  assert.notEqual(mismatch.messageId, "665f1c0000000000000000a4");
  console.log("wrong_message_id=passed");
  const malformed = await call(fault, "getMessageRecord", {
    messageId: "665f1c0000000000000000a5",
  });
  assert.equal(malformed.found, true);
  assert.equal(malformed.observedAt, "0");
  console.log("malformed_response=passed");

  // 正常服务查询相同合成 ID，仍走真实查询，证明没有全局启用故障。
  const original = await call(baseline, "getMessageRecord", {
    messageId: "665f1c0000000000000000a2",
  });
  assert.notEqual(original.source, "fault-injection");
  console.log("baseline_not_injected=passed");
  await assert.rejects(
    call(fault, "getCapabilities", {}, new Metadata()),
    (error) =>
      error.code === status.UNAUTHENTICATED ||
      error.code === status.PERMISSION_DENIED,
  );
  console.log("authentication_still_required=passed");
} catch (error) {
  console.error(
    `fault_deployment_probe=failed code=${error.code ?? error.name}`,
  );
  process.exitCode = 1;
} finally {
  fault.close();
  baseline.close();
}

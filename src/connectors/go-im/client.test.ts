import {
  loadPackageDefinition,
  Server,
  ServerCredentials,
  status,
  type ServiceDefinition,
  type ServerUnaryCall,
  type sendUnaryData,
} from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ConnectorRequestContext } from "../../tools/context";
import { QueryGrpcClient } from "./client";
import { GoIMConnector } from "./go-im-connector";

const context: ConnectorRequestContext = {
  tenantId: "transport_test",
  actorId: "transport_test",
  requestId: "transport_request",
  runId: "transport_run",
};
const observedAt = "1760000000000000001";

/**
 * Transport Test（传输测试）使用本机随机空闲端口和合成响应。
 * 验证真实 protobuf 编解码、metadata 和 deadline，不代表真实 IM 数据联调。
 */
describe("MessageQuery gRPC transport", () => {
  const server = new Server();
  let client: QueryGrpcClient;
  let receivedMetadata: Record<string, unknown>;

  beforeAll(async () => {
    const loaded = loadPackageDefinition(
      loadSync(resolve("src/connectors/go-im/proto/message_query.proto"), {
        longs: String,
        defaults: true,
        keepCase: false,
      }),
    ) as unknown as {
      im: { MessageQuery: { service: ServiceDefinition } };
    };
    server.addService(loaded.im.MessageQuery.service, {
      searchMessages(
        call: ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>,
        callback: sendUnaryData<Record<string, unknown>>,
      ) {
        callback(null, {
          messages: [],
          truncated: false,
          observedAt,
        });
      },
      getMessageRecord(
        call: ServerUnaryCall<{ messageId: string }, Record<string, unknown>>,
        callback: sendUnaryData<Record<string, unknown>>,
      ) {
        receivedMetadata = {
          token: call.metadata.get("x-im-service-token")[0],
          requestId: call.metadata.get("x-request-id")[0],
          runId: call.metadata.get("x-agent-run-id")[0],
        };
        const messageId = call.request.messageId;
        if (messageId === "msg_denied") {
          callback({ code: status.PERMISSION_DENIED, details: "denied" });
          return;
        }
        if (messageId === "msg_slow") return; // 等待客户端 deadline，不返回假事实。
        callback(null, {
          found: messageId !== "msg_missing",
          messageId,
          observedAt: messageId === "msg_invalid" ? "0" : observedAt,
          createdAt: observedAt,
          source: "synthetic-transport-test",
        });
      },
    });
    const port = await new Promise<number>((resolvePort, reject) => {
      server.bindAsync(
        "127.0.0.1:0",
        ServerCredentials.createInsecure(),
        (error, port) => (error ? reject(error) : resolvePort(port)),
      );
    });
    client = new QueryGrpcClient(
      {
        address: `127.0.0.1:${port}`,
        serviceToken: "synthetic-test-token",
        protoPath: resolve("src/connectors/go-im/proto/message_query.proto"),
      },
      "im.MessageQuery",
    );
  });

  afterAll(() => {
    client?.close();
    server.forceShutdown();
  });

  function connector() {
    return new GoIMConnector({
      client,
      timeoutMs: 200,
      capabilities: {
        messageLookup: "supported",
        messageSearch: "supported",
        deliveryEvents: "unsupported",
        historicalPresence: "unsupported",
        ackTracking: "unsupported",
        writeFailureEvents: "unsupported",
      },
    });
  }

  it("通过消息 proto 路径加载服务，保持 int64 精度并传递服务端身份和追踪字段", async () => {
    const raw = await client.getMessageRecord(
      { messageId: "msg_transport" },
      context,
      Date.now() + 2000,
    );
    expect(raw).toMatchObject({ observedAt, messageId: "msg_transport" });
    expect(receivedMetadata).toEqual({
      token: "synthetic-test-token",
      requestId: context.requestId,
      runId: context.runId,
    });
  });

  it("实际 gRPC 空结果映射为 exists=false，而不是工具错误", async () => {
    expect(
      await connector().getMessageStatus({ messageId: "msg_missing" }, context),
    ).toMatchObject({
      ok: true,
      data: { exists: false, persisted: null },
    });
  });

  it("实际 gRPC 权限拒绝不会生成消息事实", async () => {
    const result = await connector().getMessageStatus(
      { messageId: "msg_denied" },
      context,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "permission_denied", retryable: false },
    });
    expect(result).not.toHaveProperty("data");
  });

  it("实际 deadline 到期映射为 timeout，不冒充消息不存在", async () => {
    const result = await connector().getMessageStatus(
      { messageId: "msg_slow" },
      context,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
    expect(result).not.toHaveProperty("data");
  });

  it("protobuf 格式合法但缺少有效观测时间时，拒绝提升为事实", async () => {
    const result = await connector().getMessageStatus(
      { messageId: "msg_invalid" },
      context,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "internal" } });
    expect(result).not.toHaveProperty("data");
  });
});

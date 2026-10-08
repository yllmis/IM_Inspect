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
import { DomainQueryGrpcClient } from "./domain-client";
import { createDomainGoIMConnector, GoIMConnector } from "./go-im-connector";

const context = {
  tenantId: "test",
  actorId: "test",
  requestId: "route-test",
  runId: "route-test",
};
const timestamp = "1760000000000000001";
type Call = ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>;
type Reply = sendUnaryData<Record<string, unknown>>;

/** 真实 gRPC 序列化和分流测试：服务端不注册旧契约，避免误走兼容层也能通过。 */
describe("领域查询 Connector", () => {
  it("观测 proto 只保留四个正式方法，不包含旧服务或业务消息类型", () => {
    const loaded = loadPackageDefinition(
      loadSync(resolve("src/connectors/go-im/proto/operations.proto")),
    ) as unknown as {
      operations: Record<string, { service?: ServiceDefinition }>;
    };
    expect(loaded.operations.OperationsQuery).toBeUndefined();
    for (const name of [
      "GetMessageRecordRequest",
      "SearchMessagesRequest",
      "FindUserReferenceRequest",
    ])
      expect(loaded.operations[name]).toBeUndefined();
    expect(
      Object.values(loaded.operations.ObservationQuery.service!)
        .map((method) => method.path)
        .sort(),
    ).toEqual(
      [
        "GetCapabilities",
        "GetConnectionObservations",
        "GetDeliveryTimeline",
        "GetMessageTimeline",
      ].map((name) => `/operations.ObservationQuery/${name}`),
    );
  });

  const servers: Server[] = [];
  let client: DomainQueryGrpcClient;
  let options: ConstructorParameters<typeof DomainQueryGrpcClient>[0];
  const received: Record<string, unknown>[] = [];

  async function endpoint(
    proto: string,
    contract: string,
    token: string,
    handlers: Record<string, (call: Call, reply: Reply) => void>,
  ) {
    const [namespace, service] = contract.split(".");
    const loaded = loadPackageDefinition(
      loadSync(resolve(`src/connectors/go-im/proto/${proto}`), {
        longs: String,
        defaults: true,
        keepCase: false,
      }),
    ) as unknown as Record<
      string,
      Record<string, { service: ServiceDefinition }>
    >;
    const server = new Server();
    servers.push(server);
    server.addService(
      loaded[namespace][service].service,
      Object.fromEntries(
        Object.entries(handlers).map(([method, handler]) => [
          method,
          (call: Call, reply: Reply) => {
            const credential = call.metadata.get("x-im-service-token")[0];
            received.push({
              contract,
              method,
              token: credential,
              requestId: call.metadata.get("x-request-id")[0],
            });
            if (credential !== token) {
              reply({ code: status.PERMISSION_DENIED, details: "denied" });
              return;
            }
            handler(call, reply);
          },
        ]),
      ),
    );
    const port = await new Promise<number>((ok, fail) =>
      server.bindAsync(
        "127.0.0.1:0",
        ServerCredentials.createInsecure(),
        (err, port) => (err ? fail(err) : ok(port)),
      ),
    );
    return {
      address: `127.0.0.1:${port}`,
      serviceToken: token,
      insecure: true,
    };
  }

  beforeAll(async () => {
    const message = await endpoint(
      "message_query.proto",
      "im.MessageQuery",
      "message-test-token",
      {
        getMessageRecord(call, reply) {
          if (call.request.messageId === "slow") return;
          if (call.request.messageId === "denied") {
            reply({ code: status.PERMISSION_DENIED, details: "denied" });
            return;
          }
          reply(null, {
            found: call.request.messageId !== "000000000000000000000000",
            messageId: call.request.messageId,
            senderId: "sender",
            receiverId: "receiver",
            createdAt: timestamp,
            observedAt: timestamp,
          });
        },
        searchMessages(_call, reply) {
          reply(null, {
            messages: [],
            truncated: false,
            observedAt: timestamp,
          });
        },
      },
    );
    const user = await endpoint(
      "user_query.proto",
      "user.UserQuery",
      "user-test-token",
      {
        findUserReference(call, reply) {
          reply(null, {
            users:
              call.request.userId === "im-inspect-capability-probe"
                ? []
                : [
                    {
                      userId: call.request.userId,
                      displayName: "test",
                      observedAt: timestamp,
                    },
                  ],
            truncated: call.request.userId !== "im-inspect-capability-probe",
          });
        },
      },
    );
    const observation = await endpoint(
      "operations.proto",
      "operations.ObservationQuery",
      "observation-test-token",
      {
        getCapabilities(_call, reply) {
          reply(null, {
            messageRecord: "unsupported",
            messageSearch: "unsupported",
            deliveryEvents: "partial",
            observedAt: timestamp,
          });
        },
        getMessageTimeline(call, reply) {
          reply(null, {
            messageId: call.request.messageId,
            events: [],
            coverageStatus: "partial",
          });
        },
        getDeliveryTimeline(call, reply) {
          reply(null, {
            messageId: call.request.messageId,
            events: [],
            coverageStatus: "partial",
          });
        },
        getConnectionObservations(_call, reply) {
          reply(null, { observations: [], coverageStatus: "unknown" });
        },
      },
    );
    options = { message, user, observation };
    client = new DomainQueryGrpcClient(options);
  });

  afterAll(() => {
    client?.close();
    servers.forEach((server) => server.forceShutdown());
  });

  it("三类方法发往对应契约，并使用各自凭证和同一追踪 ID", async () => {
    await client.getMessageRecord(
      { messageId: "message" },
      context,
      Date.now() + 2000,
    );
    await client.searchMessages(
      { senderId: "sender", startTime: "1", endTime: "2", limit: 1 },
      context,
      Date.now() + 2000,
    );
    await client.findUserReference(
      { userId: "user", limit: 1 },
      context,
      Date.now() + 2000,
    );
    await client.getMessageTimeline(
      { messageId: "message", limit: 1 },
      context,
      Date.now() + 2000,
    );
    await client.getDeliveryTimeline(
      { messageId: "message", limit: 1 },
      context,
      Date.now() + 2000,
    );
    await client.getConnectionObservations(
      { userId: "user", at: timestamp, includeCurrent: true, limit: 1 },
      context,
      Date.now() + 2000,
    );
    for (const row of received)
      expect(row).toMatchObject({
        token:
          row.contract === "im.MessageQuery"
            ? "message-test-token"
            : row.contract === "user.UserQuery"
              ? "user-test-token"
              : "observation-test-token",
        requestId: context.requestId,
      });
    expect(new Set(received.map((row) => row.contract))).toEqual(
      new Set([
        "im.MessageQuery",
        "user.UserQuery",
        "operations.ObservationQuery",
      ]),
    );
  });

  it("观测不支持业务查询，不影响领域查询的能力声明", async () => {
    expect(
      await client.getCapabilities(context, Date.now() + 2000),
    ).toMatchObject({
      messageRecord: "supported",
      messageSearch: "supported",
      deliveryEvents: "partial",
    });
  });

  it("消息查询不依赖观测查询，不把未查询事件变成不存在", async () => {
    const isolated = new DomainQueryGrpcClient({
      ...options,
      observation: {
        address: "127.0.0.1:1",
        insecure: true,
        serviceToken: "test-only",
      },
    });
    try {
      const connector = new GoIMConnector({
        client: isolated,
        capabilities: {
          messageLookup: "supported",
          messageSearch: "supported",
          deliveryEvents: "unknown",
          historicalPresence: "unknown",
          ackTracking: "unknown",
          writeFailureEvents: "unknown",
        },
      });
      const result = await connector.getMessageStatus(
        { messageId: "message" },
        context,
      );
      expect(result).toMatchObject({
        ok: true,
        data: {
          exists: true,
          metadata: { eventsState: "unknown", eventsAvailable: "unknown" },
        },
      });
      expect(
        await isolated.getMessageRecord(
          { messageId: "000000000000000000000000" },
          context,
          Date.now() + 2000,
        ),
      ).toMatchObject({ found: false });
    } finally {
      isolated.close();
    }
  });

  it("用户分页截断由服务端字段表达，不能把单条截断结果认为唯一", async () => {
    const connector = new GoIMConnector({
      client,
      capabilities: {
        messageLookup: "supported",
        messageSearch: "supported",
        deliveryEvents: "partial",
        historicalPresence: "unknown",
        ackTracking: "unknown",
        writeFailureEvents: "unknown",
      },
    });
    expect(
      await connector.findUserOrMessage({ userId: "user", limit: 1 }, context),
    ).toMatchObject({
      ok: true,
      data: { truncated: true, resolutionStatus: "multiple" },
    });
  });

  it("保留超时和权限错误，不返回不存在", async () => {
    await expect(
      client.getMessageRecord({ messageId: "slow" }, context, Date.now() + 100),
    ).rejects.toMatchObject({ code: status.DEADLINE_EXCEEDED });
    await expect(
      client.getMessageRecord(
        { messageId: "denied" },
        context,
        Date.now() + 2000,
      ),
    ).rejects.toMatchObject({ code: status.PERMISSION_DENIED });
  });

  it("启动探测验证领域凭证，不把地址配置成功当作接口可用", async () => {
    const connector = await createDomainGoIMConnector({
      ...options,
      message: { ...options.message, serviceToken: "wrong-test-token" },
      bootstrapContext: context,
    });
    expect(connector.getCapabilities().messageLookup).toBe("unknown");
    expect(
      await connector.getMessageStatus({ messageId: "message" }, context),
    ).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    connector.close();
  });

  it("观测启动探测失败不阻止独立消息查询，并保留观测真实错误", async () => {
    const connector = await createDomainGoIMConnector({
      ...options,
      observation: { ...options.observation, serviceToken: "wrong-test-token" },
      bootstrapContext: context,
    });
    try {
      expect(connector.getCapabilities()).toMatchObject({
        messageLookup: "supported",
        deliveryEvents: "unknown",
      });
      expect(
        await connector.getMessageStatus({ messageId: "message" }, context),
      ).toMatchObject({ ok: true, data: { exists: true } });
      expect(
        await connector.getDeliveryEvents(
          { messageId: "message", limit: 1 },
          context,
        ),
      ).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    } finally {
      connector.close();
    }
  });
});

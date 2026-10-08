import { status } from "@grpc/grpc-js";
import { afterAll, describe, expect, it } from "vitest";
import {
  DomainQueryGrpcClient,
  type DomainQueryClientOptions,
} from "./domain-client";
import {
  createDomainGoIMConnector,
  type GoIMConnector,
} from "./go-im-connector";

const configured = ["MESSAGE", "USER", "OBSERVATION"].every(
  (kind) =>
    process.env[`GO_IM_${kind}_GRPC_URL`] &&
    process.env[`GO_IM_${kind}_SERVICE_TOKEN`],
);
const context = {
  tenantId: "integration-test",
  actorId: "integration-test",
  requestId: "domain-integration",
  runId: "domain-integration",
};
const messageId = process.env.GO_IM_TEST_MESSAGE_ID;
const missingId = process.env.GO_IM_TEST_MISSING_MESSAGE_ID;
const userId = process.env.GO_IM_TEST_USER_ID;

/** 只读联调：不创建用户/消息；存在记录仅使用显式配置的隔离测试 ID。 */
describe.skipIf(!configured)("真实领域契约联调", () => {
  const clients: DomainQueryGrpcClient[] = [];
  const connectors: GoIMConnector[] = [];
  function options(): DomainQueryClientOptions {
    const endpoint = (kind: string) => ({
      address: process.env[`GO_IM_${kind}_GRPC_URL`]!,
      serviceToken: process.env[`GO_IM_${kind}_SERVICE_TOKEN`]!,
      insecure: process.env.GO_IM_INSECURE === "true",
      rootCertificatePath: process.env.GO_IM_TLS_CA_PATH || undefined,
    });
    return {
      message: endpoint("MESSAGE"),
      user: endpoint("USER"),
      observation: endpoint("OBSERVATION"),
    };
  }
  function client() {
    const instance = new DomainQueryGrpcClient(options());
    clients.push(instance);
    return instance;
  }
  async function connector() {
    const instance = await createDomainGoIMConnector({
      ...options(),
      bootstrapContext: context,
    });
    connectors.push(instance);
    return instance;
  }
  afterAll(() => {
    clients.forEach((instance) => instance.close());
    connectors.forEach((instance) => instance.close());
  });

  it("三个新契约可访问，领域查询和观测能力正确组合", async () => {
    const caps = await client().getCapabilities(context, Date.now() + 5000);
    expect(caps.messageRecord).toBe("supported");
    expect(caps.messageSearch).toBe("supported");
    expect(["supported", "partial", "unsupported"]).toContain(
      caps.deliveryEvents,
    );
    expect((await connector()).getCapabilities().messageLookup).toBe(
      "supported",
    );
  }, 15000);

  it("消息与用户新接口拒绝错误令牌，不回退到旧接口", async () => {
    const bad = new DomainQueryGrpcClient({
      ...options(),
      message: { ...options().message, serviceToken: "invalid-test-token" },
      user: { ...options().user, serviceToken: "invalid-test-token" },
    });
    clients.push(bad);
    await expect(
      bad.getMessageRecord(
        { messageId: "000000000000000000000000" },
        context,
        Date.now() + 3000,
      ),
    ).rejects.toMatchObject({ code: status.PERMISSION_DENIED });
    await expect(
      bad.findUserReference(
        { userId: "im-inspect-capability-probe", limit: 1 },
        context,
        Date.now() + 3000,
      ),
    ).rejects.toMatchObject({ code: status.PERMISSION_DENIED });
  }, 10000);

  it("观测新契约也拒绝错误令牌", async () => {
    const bad = new DomainQueryGrpcClient({
      ...options(),
      observation: {
        ...options().observation,
        serviceToken: "invalid-test-token",
      },
    });
    clients.push(bad);
    await expect(
      bad.getDeliveryTimeline(
        { messageId: "000000000000000000000000", limit: 1 },
        context,
        Date.now() + 3000,
      ),
    ).rejects.toMatchObject({ code: status.PERMISSION_DENIED });
  });

  it("合法凭证可查询用户领域，查询成功无记录返回空数组", async () => {
    const raw = await client().findUserReference(
      { userId: "im-inspect-capability-probe", limit: 1 },
      context,
      Date.now() + 3000,
    );
    expect(raw.users).toEqual([]);
    expect(raw.truncated).toBe(false);
  });

  it("消息搜索拒绝超出服务预算，用户查询拒绝多选择器", async () => {
    await expect(
      client().searchMessages(
        {
          senderId: "im-inspect-capability-probe",
          startTime: "1",
          endTime: "2",
          limit: 21,
        },
        context,
        Date.now() + 3000,
      ),
    ).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    await expect(
      client().findUserReference(
        { userId: "im-inspect-capability-probe", nickname: "probe", limit: 1 },
        context,
        Date.now() + 3000,
      ),
    ).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
  });

  it.skipIf(!missingId)(
    "不存在记录是成功空结果，事件未查询保持未知",
    async () => {
      expect(
        await client().getMessageRecord(
          { messageId: missingId! },
          context,
          Date.now() + 3000,
        ),
      ).toMatchObject({ found: false, eventsState: "unknown" });
      expect(
        await (
          await connector()
        ).getMessageStatus({ messageId: missingId! }, context),
      ).toMatchObject({ ok: true, data: { exists: false, persisted: null } });
    },
    10000,
  );

  it.skipIf(!messageId)(
    "真实隔离消息映射正确，不返回正文和敏感字段",
    async () => {
      const result = await (
        await connector()
      ).getMessageStatus({ messageId: messageId! }, context);
      expect(result).toMatchObject({
        ok: true,
        data: {
          messageId,
          exists: true,
          persisted: true,
          metadata: { eventsState: "unknown" },
        },
      });
      expect(JSON.stringify(result)).not.toMatch(
        /password|token|phone|msgContent/i,
      );
    },
    10000,
  );

  it.skipIf(!userId)("只读查询隔离测试用户", async () => {
    const result = await client().findUserReference(
      { userId: userId!, limit: 1 },
      context,
      Date.now() + 3000,
    );
    expect(result.users.length).toBeLessThanOrEqual(1);
    for (const row of result.users) expect(row.userId).toBe(userId);
  });

  it("空观测也返回覆盖语义，不能伪造投递成功", async () => {
    const raw = await client().getDeliveryTimeline(
      { messageId: missingId || "000000000000000000000000", limit: 1 },
      context,
      Date.now() + 3000,
    );
    expect(raw.events).toEqual([]);
    expect(["complete", "partial", "unknown"]).toContain(raw.coverageStatus);
  });
});

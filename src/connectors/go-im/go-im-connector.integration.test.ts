import { describe, expect, it } from "vitest";

import type { ConnectorRequestContext } from "../../tools/context";
import { OperationsQueryGrpcClient } from "./client";
import { createGoIMConnector } from "./go-im-connector";

const address = process.env.GO_IM_OPERATIONS_GRPC_URL;
const serviceToken = process.env.GO_IM_SERVICE_TOKEN;
const messageId = process.env.GO_IM_TEST_MESSAGE_ID;
const missingMessageId = process.env.GO_IM_TEST_MISSING_MESSAGE_ID;
const userId = process.env.GO_IM_TEST_USER_ID;
const permissionMessageId = process.env.GO_IM_TEST_PERMISSION_MESSAGE_ID;
const timeoutMessageId = process.env.GO_IM_TEST_TIMEOUT_MESSAGE_ID;

const context: ConnectorRequestContext = {
  tenantId: "integration-test",
  actorId: "integration-test",
  requestId: "go-im-integration-request",
  runId: "go-im-integration-run",
};

const configured = Boolean(address);
const messageConfigured = Boolean(address && messageId);

/**
 * 真实 Connector 测试只接受显式配置的隔离环境和测试 ID。
 * 未配置时 skip 是“没有运行”，不是伪造的通过；固定 Fixture 由普通单测覆盖。
 */
describe.skipIf(!configured)("GoIMConnector 真实 OperationsQuery 集成", () => {
  it("真实连接可读取 OperationsQuery 能力声明", async () => {
    const client = new OperationsQueryGrpcClient({
      address: address!,
      serviceToken,
      insecure: process.env.GO_IM_INSECURE !== "false",
    });
    try {
      const raw = await client.getCapabilities(context, Date.now() + 5_000);
      expect(typeof raw.messageRecord).toBe("string");
      expect(typeof raw.deliveryEvents).toBe("string");
      expect(typeof raw.observedAt).toBe("string");
    } finally {
      client.close();
    }
  }, 8_000);
  it.skipIf(!messageConfigured)(
    "读取能力声明，并通过 Connector 映射为 Canonical capability",
    async () => {
      const connector = await createGoIMConnector({
        address: address!,
        serviceToken: serviceToken!,
        bootstrapContext: context,
      });
      const capabilities = connector.getCapabilities();
      expect(capabilities).toHaveProperty("messageLookup");
      expect(["supported", "partial", "unsupported"]).toContain(
        capabilities.messageLookup,
      );
    },
  );

  it.skipIf(!messageConfigured)(
    "映射真实消息字段、时间和状态，并且不暴露原始敏感字段",
    async () => {
      const connector = await createGoIMConnector({
        address: address!,
        serviceToken: serviceToken!,
        bootstrapContext: context,
      });
      const result = await connector.getMessageStatus(
        { messageId: messageId! },
        context,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.messageId).toBe(messageId);
        expect(result.data.statusAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(JSON.stringify(result.data)).not.toMatch(
          /password|token|phone|msgContent/i,
        );
      }
    },
  );

  it.skipIf(!messageConfigured || !missingMessageId)(
    "区分真实空结果与错误",
    async () => {
      const connector = await createGoIMConnector({
        address: address!,
        serviceToken: serviceToken!,
        bootstrapContext: context,
      });
      const result = await connector.getMessageStatus(
        { messageId: missingMessageId! },
        context,
      );
      expect(result).toMatchObject({
        ok: true,
        data: { messageId: missingMessageId!, exists: false, persisted: null },
      });
    },
  );

  it.skipIf(!messageConfigured || !userId)(
    "验证用户匹配、投递事件和连接观测的字段映射",
    async () => {
      const connector = await createGoIMConnector({
        address: address!,
        serviceToken: serviceToken!,
        bootstrapContext: context,
      });
      const user = await connector.findUserOrMessage(
        { userId: userId!, limit: 10 },
        context,
      );
      expect(user.ok).toBe(true);

      const delivery = await connector.getDeliveryEvents(
        { messageId: messageId!, limit: 20 },
        context,
      );
      if (delivery.ok) {
        expect(delivery.data.events.length).toBeLessThanOrEqual(20);
        expect(["complete", "partial", "unknown"]).toContain(
          delivery.data.coverageStatus,
        );
      } else {
        expect(delivery.error.code).toBe("unsupported_capability");
      }

      const connection = await connector.getConnectionStatus(
        { userId: userId!, at: new Date().toISOString() },
        context,
      );
      if (!connection.ok) {
        expect(["unsupported_capability", "not_found"]).toContain(
          connection.error.code,
        );
      }
    },
  );

  it.skipIf(!messageConfigured || !permissionMessageId)(
    "可选验证权限错误映射",
    async () => {
      const connector = await createGoIMConnector({
        address: address!,
        serviceToken: process.env.GO_IM_INVALID_SERVICE_TOKEN ?? serviceToken!,
        bootstrapContext: context,
      });
      const result = await connector.getMessageStatus(
        { messageId: permissionMessageId! },
        context,
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: "permission_denied" },
      });
    },
  );

  it.skipIf(!messageConfigured || !timeoutMessageId)(
    "可选验证服务端 deadline 映射为 timeout 且不生成事实",
    async () => {
      const connector = await createGoIMConnector({
        address: address!,
        serviceToken: serviceToken!,
        bootstrapContext: context,
      });
      const result = await connector.getMessageStatus(
        { messageId: timeoutMessageId! },
        context,
      );
      expect(result).toMatchObject({ ok: false, error: { code: "timeout" } });
      expect(result).not.toHaveProperty("data");
    },
  );
});

if (!configured) {
  describe("Go IM 真实集成测试配置", () => {
    it.skip("未配置 GO_IM_OPERATIONS_GRPC_URL，明确跳过真实服务测试", () =>
      undefined);
  });
}

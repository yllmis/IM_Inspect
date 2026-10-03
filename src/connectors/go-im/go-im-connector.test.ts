import { describe, expect, it, vi } from "vitest";

import type { ConnectorRequestContext } from "../../tools/context";
import { OperationsQueryClient } from "./client";
import { GoIMConnector } from "./go-im-connector";

const context: ConnectorRequestContext = {
  tenantId: "tenant_test",
  actorId: "actor_test",
  requestId: "request_test",
  runId: "run_test",
};

const observedAt = "1760000000000000000";
const capabilities = {
  messageLookup: "supported" as const,
  deliveryEvents: "supported" as const,
  historicalPresence: "supported" as const,
  ackTracking: "unsupported" as const,
  writeFailureEvents: "unsupported" as const,
};

function client(
  overrides: Partial<OperationsQueryClient> = {},
): OperationsQueryClient {
  return {
    findUserReference: vi.fn(async () => ({ users: [] })),
    getMessageRecord: vi.fn(async () => ({
      found: true,
      messageId: "msg_001",
      conversationId: "conv_001",
      senderId: "user_sender",
      receiverId: "user_receiver",
      createdAt: observedAt,
      observedAt,
      source: "chat_log",
      readState: "unknown",
      eventsAvailable: false,
    })),
    getMessageTimeline: vi.fn(async () => ({
      events: [],
      complete: true,
      truncated: false,
    })),
    getDeliveryTimeline: vi.fn(async () => ({
      messageId: "msg_001",
      events: [],
      complete: true,
      truncated: false,
      coverageStatus: "complete" as const,
      eventsDropped: "0",
    })),
    getConnectionObservations: vi.fn(async () => ({
      observations: [],
      current: { online: true, observedAt, source: "ws-conn-table" },
      complete: true,
      truncated: false,
      coverageStatus: "complete" as const,
      eventsDropped: "0",
    })),
    getCapabilities: vi.fn(async () => ({})),
    ...overrides,
  };
}

describe("GoIMConnector", () => {
  it("将 OperationsQuery 的已存在消息映射为 Canonical MessageFact", async () => {
    const connector = new GoIMConnector({ client: client(), capabilities });
    const result = await connector.getMessageStatus(
      { messageId: "msg_001" },
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({
        messageId: "msg_001",
        exists: true,
        persisted: true,
        status: "persisted",
        conversationId: "conv_001",
      });
      expect(JSON.stringify(result.data)).not.toContain("msgContent");
    }
  });

  it("区分查询成功但没有记录与查询错误", async () => {
    const noRecord = client({
      getMessageRecord: vi.fn(async () => ({
        found: false,
        messageId: "msg_missing",
        observedAt,
        source: "chat_log",
      })),
    });
    const connector = new GoIMConnector({ client: noRecord, capabilities });
    const missing = await connector.getMessageStatus(
      { messageId: "msg_missing" },
      context,
    );
    expect(missing).toMatchObject({
      ok: true,
      data: { exists: false, persisted: null, status: "unknown" },
    });

    const timeout = new Error("deadline exceeded");
    Object.assign(timeout, { code: 4 });
    const timedOut = new GoIMConnector({
      client: client({
        getMessageRecord: vi.fn(async () => {
          throw timeout;
        }),
      }),
      capabilities,
    });
    expect(
      await timedOut.getMessageStatus({ messageId: "msg_001" }, context),
    ).toMatchObject({
      ok: false,
      error: { code: "timeout", retryable: true },
    });
  });

  it("拒绝下游返回的错误 messageId，避免把别的消息当成当前事实", async () => {
    const connector = new GoIMConnector({
      client: client({
        getMessageRecord: vi.fn(async () => ({
          found: true,
          messageId: "msg_other",
          observedAt,
          createdAt: observedAt,
        })),
      }),
      capabilities,
    });
    expect(
      await connector.getMessageStatus({ messageId: "msg_001" }, context),
    ).toMatchObject({
      ok: false,
      error: { code: "internal" },
    });
  });

  it("映射投递事件并保留 partial 观测缺口", async () => {
    const connector = new GoIMConnector({
      client: client({
        getDeliveryTimeline: vi.fn(async () => ({
          messageId: "msg_001",
          complete: false,
          truncated: true,
          coverageStatus: "partial" as const,
          eventsDropped: "2",
          events: [
            {
              eventId: "event_001",
              eventType: "ack_timeout",
              messageId: "msg_001",
              receiverId: "user_receiver",
              attemptId: "attempt_001",
              occurredAt: observedAt,
              source: "message_events",
              errorCode: "ack_timeout",
              evidence: "transport-ack",
            },
          ],
        })),
      }),
      capabilities,
    });
    const result = await connector.getDeliveryEvents(
      { messageId: "msg_001", limit: 20 },
      context,
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        complete: false,
        truncated: true,
        coverageStatus: "partial",
        eventsDropped: 2,
      },
    });
    if (result.ok) expect(result.data.events[0]?.result).toBe("timeout");
  });

  it("能力声明为 unsupported 时不调用下游", async () => {
    const getDeliveryTimeline = vi.fn();
    const connector = new GoIMConnector({
      client: client({ getDeliveryTimeline }),
      capabilities: { ...capabilities, deliveryEvents: "unsupported" },
    });
    const result = await connector.getDeliveryEvents(
      { messageId: "msg_001", limit: 20 },
      context,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "unsupported_capability" },
    });
    expect(getDeliveryTimeline).not.toHaveBeenCalled();
  });

  it("使用 OperationsQuery 的当前连接观测生成 ConnectionFact", async () => {
    const connector = new GoIMConnector({ client: client(), capabilities });
    const result = await connector.getConnectionStatus(
      { userId: "user_receiver", at: "2025-10-09T08:53:20.000Z" },
      context,
    );
    expect(result).toMatchObject({
      ok: true,
      data: { userId: "user_receiver", state: "online", historical: false },
    });
  });

  it("映射 userId、displayName 和 multiple resolution，而不是自动选择用户", async () => {
    const connector = new GoIMConnector({
      client: client({
        findUserReference: vi.fn(async (request) => ({
          users: request.nickname
            ? [
                { userId: "u_1", displayName: request.nickname, observedAt },
                { userId: "u_2", displayName: request.nickname, observedAt },
              ]
            : [
                {
                  userId: request.userId ?? "u_1",
                  displayName: "客服甲",
                  observedAt,
                },
              ],
        })),
      }),
      capabilities,
    });

    const byId = await connector.findUserOrMessage(
      { userId: "u_1", limit: 10 },
      context,
    );
    expect(byId).toMatchObject({
      ok: true,
      data: { resolutionStatus: "unique", matches: [{ userId: "u_1" }] },
    });

    const byName = await connector.findUserOrMessage(
      { displayName: "客服甲", limit: 10 },
      context,
    );
    expect(byName).toMatchObject({
      ok: true,
      data: {
        resolutionStatus: "multiple",
        matches: [{ userId: "u_1" }, { userId: "u_2" }],
      },
    });
  });

  it("拒绝不支持的 conversation 查询，且不调用下游", async () => {
    const findUserReference = vi.fn();
    const connector = new GoIMConnector({
      client: client({ findUserReference }),
      capabilities,
    });
    const result = await connector.findUserOrMessage(
      { conversationId: "conv_001", limit: 10 },
      context,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "unsupported_capability" },
    });
    expect(findUserReference).not.toHaveBeenCalled();
  });

  it("映射权限错误和非法响应，而不是生成 Canonical Fact", async () => {
    const permission = new Error("permission denied");
    Object.assign(permission, { code: 7 });
    const denied = new GoIMConnector({
      client: client({
        getMessageRecord: vi.fn(async () => {
          throw permission;
        }),
      }),
      capabilities,
    });
    expect(
      await denied.getMessageStatus({ messageId: "msg_001" }, context),
    ).toMatchObject({ ok: false, error: { code: "permission_denied" } });

    const malformed = new GoIMConnector({
      client: client({
        getMessageRecord: vi.fn(async () => ({
          found: true,
          messageId: "msg_001",
          observedAt: "not-a-time",
        })),
      }),
      capabilities,
    });
    expect(
      await malformed.getMessageStatus({ messageId: "msg_001" }, context),
    ).toMatchObject({ ok: false, error: { code: "internal" } });
  });

  it("timeout 时不产生 exists=false 或 persisted=null 的事实", async () => {
    const timeout = new Error("deadline exceeded");
    Object.assign(timeout, { code: 4 });
    const connector = new GoIMConnector({
      client: client({
        getMessageRecord: vi.fn(async () => {
          throw timeout;
        }),
      }),
      capabilities,
    });
    const result = await connector.getMessageStatus(
      { messageId: "msg_001" },
      context,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(result).not.toHaveProperty("data.exists");
    expect(result).not.toHaveProperty("data.persisted");
  });

  it("拒绝投递事件和请求 messageId 不一致，并过滤敏感字段", async () => {
    const connector = new GoIMConnector({
      client: client({
        getDeliveryTimeline: vi.fn(async () => ({
          messageId: "msg_001",
          events: [
            {
              eventType: "delivery_succeeded",
              messageId: "msg_other",
              occurredAt: observedAt,
              phone: "13800000000",
            },
          ],
          complete: true,
          truncated: false,
          coverageStatus: "complete" as const,
          eventsDropped: "0",
        })),
      }),
      capabilities,
    });
    expect(
      await connector.getDeliveryEvents(
        { messageId: "msg_001", limit: 20 },
        context,
      ),
    ).toMatchObject({ ok: false, error: { code: "internal" } });
  });

  it("能力不支持时不把空结果当成真实查询结果", async () => {
    const getMessageRecord = vi.fn();
    const connector = new GoIMConnector({
      client: client({ getMessageRecord }),
      capabilities: { ...capabilities, messageLookup: "unsupported" },
    });
    expect(
      await connector.getMessageStatus({ messageId: "msg_001" }, context),
    ).toMatchObject({ ok: false, error: { code: "unsupported_capability" } });
    expect(getMessageRecord).not.toHaveBeenCalled();
  });

  it("能力初始化的权限错误不能降级成能力不支持", async () => {
    const getMessageRecord = vi.fn();
    const connector = new GoIMConnector({
      client: client({ getMessageRecord }),
      capabilities: { ...capabilities, messageLookup: "unsupported" },
      bootstrapFailure: {
        code: "permission_denied",
        message: "OperationsQuery permission denied",
        retryable: false,
      },
    });
    expect(
      await connector.getMessageStatus({ messageId: "msg_001" }, context),
    ).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expect(getMessageRecord).not.toHaveBeenCalled();
  });

  it("能力初始化失败时返回 unknown，工具层可以看到真实依赖错误", async () => {
    const getMessageRecord = vi.fn();
    const connector = new GoIMConnector({
      client: client({ getMessageRecord }),
      capabilities: {
        messageLookup: "unknown",
        deliveryEvents: "unknown",
        historicalPresence: "unknown",
        ackTracking: "unknown",
        writeFailureEvents: "unknown",
      },
      bootstrapFailure: {
        code: "dependency_unavailable",
        message: "OperationsQuery unavailable",
        retryable: true,
      },
    });
    expect(connector.getCapabilities().messageLookup).toBe("unknown");
    expect(
      await connector.getMessageStatus({ messageId: "msg_001" }, context),
    ).toMatchObject({ ok: false, error: { code: "dependency_unavailable" } });
    expect(getMessageRecord).not.toHaveBeenCalled();
  });
});

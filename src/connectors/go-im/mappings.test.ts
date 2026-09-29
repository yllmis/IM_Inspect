import { describe, expect, it } from "vitest";
import { status as grpcStatus } from "@grpc/grpc-js";

import {
  mapCapabilities,
  mapConnectionResponse,
  mapDeliveryEvent,
  mapDeliveryTimeline,
  mapGrpcError,
  mapMessageRecord,
  mapUserMatches,
  unixNanoToIso,
} from "./mappings";

const observedAt = "1760000000000000000";

describe("Go IM 映射函数", () => {
  it("使用 BigInt 进行 UnixNano 到 ISO 的精确转换", () => {
    expect(unixNanoToIso(observedAt)).toBe("2025-10-09T08:53:20.000Z");
    expect(unixNanoToIso("0")).toBeUndefined();
    expect(unixNanoToIso("-1")).toBeUndefined();
    expect(unixNanoToIso("not-a-number")).toBeUndefined();
  });

  it("映射消息字段，并且不把敏感原始字段带入 Canonical Model", () => {
    const result = mapMessageRecord(
      {
        found: true,
        messageId: "msg_001",
        conversationId: "conv_001",
        senderId: "user_001",
        receiverId: "user_002",
        createdAt: observedAt,
        observedAt,
        source: "chat_log",
        readState: "unread",
        eventsAvailable: true,
        msgContent: "不应暴露",
        phone: "13800000000",
      } as never,
      "msg_001",
    );
    expect(result).toMatchObject({
      messageId: "msg_001",
      conversationId: "conv_001",
      senderId: "user_001",
      receiverId: "user_002",
      exists: true,
      persisted: true,
    });
    expect(JSON.stringify(result)).not.toContain("不应暴露");
    expect(JSON.stringify(result)).not.toContain("13800000000");
  });

  it("拒绝下游返回与请求不一致的消息 ID", () => {
    expect(() =>
      mapMessageRecord(
        { found: true, messageId: "msg_other", observedAt } as never,
        "msg_001",
      ),
    ).toThrow(/different messageId/);
  });

  it("映射用户 ID、displayName 和多匹配结果", () => {
    const result = mapUserMatches({
      users: [
        { userId: "u1", displayName: "客服甲", observedAt },
        { userId: "u2", displayName: "客服甲", observedAt },
      ],
    } as never);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      entityType: "user",
      userId: "u1",
      displayName: "客服甲",
    });
    expect(result[0]?.evidence[0]?.value).toBe("u1");
  });

  it.each([
    ["delivery_attempted", "attempted"],
    ["delivery_succeeded", "success"],
    ["delivery_failed", "failed"],
    ["receiver_offline", "failed"],
    ["ack_received", "success"],
    ["ack_timeout", "timeout"],
    ["unknown_event", "unknown"],
  ] as const)("将事件 %s 映射为 %s", (eventType, result) => {
    expect(
      mapDeliveryEvent(
        { eventType, messageId: "msg_001", occurredAt: observedAt } as never,
        "msg_001",
      ).result,
    ).toBe(result);
  });

  it("保留时间线 partial 和丢弃数量，不把空事件伪造成成功", () => {
    expect(
      mapDeliveryTimeline(
        {
          messageId: "msg_001",
          events: [],
          coverageStatus: "partial",
          eventsDropped: "3",
        } as never,
        "msg_001",
      ),
    ).toMatchObject({
      events: [],
      coverageStatus: "partial",
      eventsDropped: 3,
    });
  });

  it("优先使用历史连接观测，避免用当前状态冒充过去状态", () => {
    const result = mapConnectionResponse(
      {
        observations: [{ state: "offline", observedAt, connectionId: "old" }],
        current: {
          online: true,
          observedAt: "1760000100000000000",
          source: "ws",
        },
      } as never,
      "u1",
    );
    expect(result).toMatchObject({
      userId: "u1",
      state: "offline",
      historical: true,
      connectionId: "old",
    });
  });

  it("未知连接来源只能映射为 unknown", () => {
    const result = mapConnectionResponse(
      {
        observations: [],
        current: { online: true, observedAt, source: "unknown" },
      } as never,
      "u1",
    );
    expect(result?.state).toBe("unknown");
  });

  it("未知能力状态默认按 unsupported 处理", () => {
    expect(
      mapCapabilities({
        messageRecord: "supported",
        deliveryEvents: "partial",
        historicalConnection: "new-value",
        ackHistory: "unsupported",
        writeFailureEvents: "supported",
      } as never),
    ).toEqual({
      messageLookup: "supported",
      deliveryEvents: "partial",
      historicalPresence: "unsupported",
      ackTracking: "unsupported",
      writeFailureEvents: "supported",
    });
  });

  it.each([
    [grpcStatus.DEADLINE_EXCEEDED, "timeout", true],
    [grpcStatus.UNAVAILABLE, "dependency_unavailable", true],
    [grpcStatus.RESOURCE_EXHAUSTED, "rate_limited", true],
    [grpcStatus.INVALID_ARGUMENT, "invalid_argument", false],
    [grpcStatus.PERMISSION_DENIED, "permission_denied", false],
    [grpcStatus.UNAUTHENTICATED, "permission_denied", false],
    [grpcStatus.UNIMPLEMENTED, "unsupported_capability", false],
    [grpcStatus.INTERNAL, "internal", false],
  ] as const)("将 gRPC 状态 %s 映射为 %s", (code, expected, retryable) => {
    expect(mapGrpcError({ code, message: "backend error" })).toMatchObject({
      code: expected,
      retryable,
    });
  });
});

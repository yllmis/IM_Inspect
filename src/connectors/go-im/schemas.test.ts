import { describe, expect, it } from "vitest";

import {
  RawCapabilitiesSchema,
  RawDeliveryTimelineResponseSchema,
  RawMessageRecordSchema,
  RawMessageTimelineResponseSchema,
} from "./schemas";

describe("Go IM 原始响应 Schema", () => {
  it("接受合法消息记录和 proto-loader 的额外字段", () => {
    const parsed = RawMessageRecordSchema.parse({
      found: true,
      messageId: "msg_001",
      observedAt: "1760000000000000000",
      createdAt: "1760000000000000000",
      internalPhone: "13800000000",
    });
    expect(parsed.messageId).toBe("msg_001");
    expect(parsed).toHaveProperty("internalPhone");
  });

  it("允许 found=false，但仍要求 found 是布尔值", () => {
    expect(
      RawMessageRecordSchema.parse({
        found: false,
        observedAt: "1760000000000000000",
      }),
    ).toMatchObject({ found: false, messageId: "" });
    expect(() => RawMessageRecordSchema.parse({ found: "false" })).toThrow();
  });

  it("对非法 coverageStatus 和事件结构拒绝，而不是让错误进入诊断", () => {
    expect(() =>
      RawMessageTimelineResponseSchema.parse({ coverageStatus: "bad" }),
    ).toThrow();
    expect(() =>
      RawDeliveryTimelineResponseSchema.parse({
        events: [{ occurredAt: "not-a-number" }],
      }),
    ).toThrow();
  });

  it("缺失能力字段时显式默认为 unsupported", () => {
    expect(RawCapabilitiesSchema.parse({})).toMatchObject({
      messageRecord: "unsupported",
      deliveryEvents: "unsupported",
      historicalConnection: "unsupported",
    });
  });

  it("旧 protobuf 没有事件状态时空字符串表示未知，非法状态仍拒绝", () => {
    expect(
      RawMessageRecordSchema.parse({ found: false, eventsState: "" })
        .eventsState,
    ).toBe("unknown");
    expect(() =>
      RawMessageRecordSchema.parse({ found: false, eventsState: "invalid" }),
    ).toThrow();
  });

  it("Schema 的 passthrough 不等于向 Agent 暴露敏感字段", () => {
    const parsed = RawMessageRecordSchema.parse({
      found: true,
      messageId: "msg_001",
      observedAt: "1760000000000000000",
      secretToken: "do-not-forward",
    });
    expect(parsed.secretToken).toBe("do-not-forward");
    // 敏感字段必须在 mappings.ts 的白名单映射边界被丢弃。
  });
});

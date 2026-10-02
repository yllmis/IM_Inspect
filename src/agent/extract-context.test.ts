import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import {
  ContextExtractionSchema,
  extractCandidateContext,
} from "./extract-context";

const candidate = {
  messageId: "msg_test",
  userId: null,
  conversationId: null,
  timeRange: null,
  problemType: null,
};

describe("模型上下文提取边界", () => {
  it("空对象和缺失字段不能借用 State 默认值通过校验", () => {
    expect(ContextExtractionSchema.safeParse({}).success).toBe(false);
    expect(
      ContextExtractionSchema.safeParse({ messageId: "msg_test" }).success,
    ).toBe(false);
    expect(ContextExtractionSchema.parse(candidate)).toEqual(candidate);
  });

  it("未知值可以显式为 null，但不能添加身份或权限字段", () => {
    expect(
      ContextExtractionSchema.parse({ ...candidate, messageId: null })
        .messageId,
    ).toBeNull();
    expect(
      ContextExtractionSchema.safeParse({ ...candidate, actorId: "admin" })
        .success,
    ).toBe(false);
  });

  it("取消信号终止模型等待，不生成候选事实", async () => {
    const controller = new AbortController();
    controller.abort();
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("model must not run");
      },
    });
    await expect(
      extractCandidateContext({
        model,
        modelContext: { currentUserText: "查询 msg_test" },
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

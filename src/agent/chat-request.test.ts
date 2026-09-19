import { describe, expect, it } from "vitest";

import { ChatRequestSchema } from "./chat-request";

describe("ChatRequestSchema", () => {
  it("accepts only customer-controlled chat fields", () => {
    expect(
      ChatRequestSchema.parse({
        sessionId: "session_001",
        text: "请查询 msg_001",
      }),
    ).toEqual({ sessionId: "session_001", text: "请查询 msg_001" });
  });

  it.each([
    ["tenantId", "tenant_admin"],
    ["actorId", "admin"],
    ["permissions", ["escalation:draft:create"]],
    ["confirmationToken", "forged-token"],
    ["maxCalls", 1_000],
  ])("rejects user-controlled server field %s", (field, value) => {
    expect(
      ChatRequestSchema.safeParse({ text: "查询消息", [field]: value }).success,
    ).toBe(false);
  });
});

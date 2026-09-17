import { describe, expect, it } from "vitest";

import { recordConversationExchange } from "./conversation-memory";
import { createAgentSessionState } from "./session-state";

describe("recordConversationExchange", () => {
  it("keeps bounded recent dialogue and compresses evicted entries", () => {
    let state = createAgentSessionState({
      sessionId: "session_memory",
      tenantId: "tenant_001",
      actorId: "support_001",
      issueSummary: "排查消息",
      now: new Date("2026-09-14T10:00:00Z"),
    });

    for (let index = 0; index < 3; index += 1) {
      state = recordConversationExchange(state, {
        userText: `第${index}轮客服内容${"问".repeat(90)}`,
        assistantText: `第${index}轮回复内容${"答".repeat(90)}`,
        now: new Date(`2026-09-14T10:0${index}:00Z`),
        budget: {
          maxRecentConversationCharacters: 300,
          maxSingleMessageCharacters: 150,
          maxHistorySummaryCharacters: 200,
        },
      });
    }

    const recentCharacters = state.recentConversation.reduce(
      (total, entry) => total + entry.content.length,
      0,
    );
    expect(recentCharacters).toBeLessThanOrEqual(300);
    expect(state.recentConversation.length).toBeLessThanOrEqual(6);
    expect(state.historySummary).toMatchObject({
      summarizedMessages: expect.any(Number),
      contextOnly: true,
      evidenceEligible: false,
    });
    expect(state.historySummary!.summarizedMessages).toBeGreaterThan(0);
    expect(state.historySummary!.text.length).toBeLessThanOrEqual(200);
  });

  it("compresses repeated descriptions without turning the summary into evidence", () => {
    let state = createAgentSessionState({
      sessionId: "session_repeated_description",
      tenantId: "tenant_001",
      actorId: "support_001",
      issueSummary: "排查重复描述",
      now: new Date("2026-09-14T10:00:00Z"),
    });

    for (let index = 0; index < 5; index += 1) {
      state = recordConversationExchange(state, {
        userText: "客服重复声称 msg_001 不存在",
        assistantText: "该说法尚未经过工具确认",
        now: new Date(`2026-09-14T10:0${index}:00Z`),
        budget: {
          maxRecentConversationCharacters: 200,
          maxSingleMessageCharacters: 100,
          maxHistorySummaryCharacters: 180,
        },
      });
    }

    expect(state.historySummary).toMatchObject({
      contextOnly: true,
      evidenceEligible: false,
    });
    expect(state.historySummary?.text).toContain("尚未经过工具确认");
    expect(state.confirmedFacts.message).toBeNull();
    expect(state.evidence).toEqual([]);
  });

  it("does not turn dialogue into confirmed facts", () => {
    const initial = createAgentSessionState({
      sessionId: "session_fact_boundary",
      tenantId: "tenant_001",
      actorId: "support_001",
      issueSummary: "排查消息",
      now: new Date("2026-09-14T10:00:00Z"),
    });

    const next = recordConversationExchange(initial, {
      userText: "我确定消息 msg_001 已经成功投递",
      assistantText: "我还需要通过工具核实。",
      now: new Date("2026-09-14T10:01:00Z"),
    });

    expect(next.confirmedFacts).toEqual(initial.confirmedFacts);
    expect(next.messageId).toBeNull();
    expect(next.recentConversation).toHaveLength(2);
  });
});

import { describe, expect, it } from "vitest";

import {
  AgentSessionStateSchema,
  createAgentSessionState,
} from "./session-state";
import { InMemoryStateStore, StateStoreError } from "./state-store";

const start = new Date("2026-09-06T10:00:00Z");

function state(sessionId = "session_001") {
  return createAgentSessionState({
    sessionId,
    tenantId: "tenant_001",
    actorId: "support_001",
    issueSummary: "用户反馈消息未收到",
    problemType: "message_not_received",
    now: start,
    ttlMs: 60_000,
  });
}

describe("AgentSessionState", () => {
  it("creates bounded working memory without chat history", () => {
    const created = state();

    expect(created).toMatchObject({
      sessionId: "session_001",
      candidateContext: {
        messageId: null,
        userId: null,
        conversationId: null,
      },
      confirmedFacts: {
        message: null,
        deliveries: [],
        connection: null,
      },
      calledTools: [],
      confirmationState: { status: "not_required" },
      status: "received",
      version: 1,
    });
    expect(created).not.toHaveProperty("messages");
    expect(created).not.toHaveProperty("chatHistory");
  });

  it("rejects duplicate evidence ids and unbounded tool summaries", () => {
    const evidence = {
      id: "evidence_001",
      source: "fixture",
      kind: "message" as const,
      observedAt: "2026-09-06T10:00:00Z",
      field: "message_id",
      value: "msg_001",
    };
    expect(() =>
      AgentSessionStateSchema.parse({
        ...state(),
        evidence: [evidence, evidence],
      }),
    ).toThrow();

    expect(() =>
      AgentSessionStateSchema.parse({
        ...state(),
        calledTools: Array.from({ length: 21 }, (_, index) => ({
          toolName: "get_message_status",
          inputHash: index.toString(16).padStart(64, "0"),
          outcome: "success",
          calledAt: "2026-09-06T10:00:00Z",
        })),
      }),
    ).toThrow();
  });
});

describe("InMemoryStateStore", () => {
  it("isolates sessions by tenant, actor and session id", async () => {
    const store = new InMemoryStateStore({
      now: () => start.getTime(),
    });
    await store.create(state());

    expect(
      await store.load({
        sessionId: "session_001",
        tenantId: "tenant_001",
        actorId: "support_001",
      }),
    ).not.toBeNull();
    expect(
      await store.load({
        sessionId: "session_001",
        tenantId: "tenant_other",
        actorId: "support_001",
      }),
    ).toBeNull();
  });

  it("returns copies so callers cannot mutate stored state", async () => {
    const store = new InMemoryStateStore({
      now: () => start.getTime(),
    });
    const created = await store.create(state());
    created.currentIssue.summary = "被调用方修改";

    const loaded = await store.load({
      sessionId: "session_001",
      tenantId: "tenant_001",
      actorId: "support_001",
    });
    expect(loaded?.currentIssue.summary).toBe("用户反馈消息未收到");
  });

  it("increments versions and rejects stale concurrent saves", async () => {
    let now = start.getTime();
    const store = new InMemoryStateStore({ now: () => now });
    const original = await store.create(state());
    now += 1_000;

    const saved = await store.save(
      { ...original, status: "extracting_context" },
      1,
    );
    expect(saved).toMatchObject({
      status: "extracting_context",
      version: 2,
      createdAt: "2026-09-06T10:00:00.000Z",
      updatedAt: "2026-09-06T10:00:01.000Z",
    });

    await expect(store.save(original, 1)).rejects.toMatchObject({
      code: "version_conflict",
    } satisfies Partial<StateStoreError>);
  });

  it("expires sessions and releases their capacity", async () => {
    let now = start.getTime();
    const store = new InMemoryStateStore({
      now: () => now,
      maxSessions: 1,
    });
    await store.create(state("session_expiring"));
    await expect(store.create(state("session_blocked"))).rejects.toMatchObject({
      code: "capacity_exceeded",
    } satisfies Partial<StateStoreError>);

    now += 60_000;
    expect(
      await store.load({
        sessionId: "session_expiring",
        tenantId: "tenant_001",
        actorId: "support_001",
      }),
    ).toBeNull();
    await expect(
      store.create(
        createAgentSessionState({
          sessionId: "session_after_expiry",
          tenantId: "tenant_001",
          actorId: "support_001",
          issueSummary: "新的诊断任务",
          now: new Date(now),
          ttlMs: 60_000,
        }),
      ),
    ).resolves.toMatchObject({ sessionId: "session_after_expiry" });
  });
});

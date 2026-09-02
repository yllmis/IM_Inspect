import { describe, expect, it } from "vitest";

import { FakeConnector } from "../connectors/fake/fake-connector";
import { DeliveryFact } from "../domain/delivery";
import { createToolContext, ToolContext } from "./context";
import {
  computeDraftContentHash,
  CreateEscalationDraftInput,
} from "./create-escalation-draft";
import { createInMemoryDraftRepository } from "./draft-repository";
import { createFixedConfirmationVerifier } from "./confirmation-verifier";
import { ToolRegistry } from "./registry";

const permissions = [
  "diagnosis:read",
  "diagnosis:read_delivery",
  "diagnosis:read_connection",
  "escalation:draft:create",
];

const repository = () => createInMemoryDraftRepository();

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return Object.assign(
    createToolContext({
      requestId: "req_test",
      runId: "run_test",
      tenantId: "tenant_test",
      actorId: "support_test",
      permissions,
    }),
    overrides,
  );
}

function draftInput(): Omit<CreateEscalationDraftInput, "contentHash"> & {
  contentHash: string;
} {
  const base = {
    messageId: "msg_write_failed",
    classification: "write_failed" as const,
    facts: ["消息持久化失败"],
    evidenceRefs: ["fixture:write_failed:insert"],
    possibleCauses: [],
    missingInformation: [],
    unsupportedCapabilities: [],
    recommendedAction: "escalate" as const,
    summary: "请研发排查消息持久化失败。",
    idempotencyKey: "idempotency-key-001",
  };
  return { ...base, contentHash: computeDraftContentHash(base) };
}

describe("ToolRegistry", () => {
  it("only executes allowlisted tools and records request/run trace", async () => {
    const ctx = context();
    const registry = new ToolRegistry({
      connector: new FakeConnector("delivered"),
      draftRepository: repository(),
    });
    const blocked = await registry.execute("execute_shell", {}, ctx);
    expect(blocked).toMatchObject({
      ok: false,
      error: { code: "invalid_argument" },
    });
    expect(ctx.traces[0]).toMatchObject({
      requestId: "req_test",
      runId: "run_test",
      toolName: "execute_shell",
      outcome: "blocked",
    });
  });

  it("rejects invalid arguments and extra fields before Connector access", async () => {
    const connector = new FakeConnector("delivered");
    const registry = new ToolRegistry({
      connector,
      draftRepository: repository(),
    });
    const result = await registry.execute(
      "get_message_status",
      { messageId: "", sql: "DROP TABLE chat_log" },
      context(),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_argument" },
    });
    expect(connector.calls).toHaveLength(0);
  });

  it("enforces permissions and call budget", async () => {
    const registry = new ToolRegistry({
      connector: new FakeConnector("delivered"),
      draftRepository: repository(),
    });
    const denied = await registry.execute(
      "get_message_status",
      { messageId: "msg_delivered" },
      context({ permissions: new Set(["diagnosis:read_delivery"]) }),
    );
    expect(denied).toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });

    const limitedContext = context({ maxCalls: 1 });
    expect(
      (
        await registry.execute(
          "get_message_status",
          { messageId: "msg_delivered" },
          limitedContext,
        )
      ).ok,
    ).toBe(true);
    const limited = await registry.execute(
      "get_message_status",
      { messageId: "msg_delivered" },
      limitedContext,
    );
    expect(limited).toMatchObject({
      ok: false,
      error: { code: "rate_limited" },
    });
  });

  it("maps a successful message query through the Connector", async () => {
    const ctx = context();
    const result = await new ToolRegistry({
      connector: new FakeConnector("delivered"),
      draftRepository: repository(),
    }).execute("get_message_status", { messageId: "msg_delivered" }, ctx);
    expect(result).toMatchObject({
      ok: true,
      data: { message: { messageId: "msg_delivered", persisted: true } },
      meta: { requestId: "req_test", runId: "run_test" },
    });
    expect(ctx.traces[0]?.outcome).toBe("success");
    expect(ctx.traces[0]?.resultSummary).toMatchObject({
      message: { messageId: "msg_delivered", persisted: true },
    });
  });

  it.each([
    ["find_user_or_message", { displayName: "" }],
    [
      "get_delivery_events",
      {
        messageId: "msg_delivered",
        timeRange: {
          start: "2026-09-02T00:00:00Z",
          end: "2026-09-03T00:00:01Z",
        },
      },
    ],
  ] as const)("rejects invalid time or selector for %s", async (name, args) => {
    const result = await new ToolRegistry({
      connector: new FakeConnector("delivered"),
      draftRepository: repository(),
    }).execute(name, args, context());
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_argument" },
    });
  });

  it("finds a unique message and reads historical connection status", async () => {
    const connector = new FakeConnector("receiver_offline");
    const registry = new ToolRegistry({
      connector,
      draftRepository: repository(),
    });
    const found = await registry.execute(
      "find_user_or_message",
      { messageId: "msg_receiver_offline" },
      context(),
    );
    expect(found).toMatchObject({
      ok: true,
      data: {
        resolutionStatus: "unique",
        matches: [{ messageId: "msg_receiver_offline" }],
      },
    });
    const connection = await registry.execute(
      "get_connection_status",
      { userId: "user_receiver_offline", at: "2026-09-02T10:00:00Z" },
      context(),
    );
    expect(connection).toMatchObject({
      ok: true,
      data: { connection: { state: "offline", historical: true } },
    });
  });

  it("preserves Connector timeout as timeout and retries read-only once", async () => {
    const connector = new FakeConnector("delivered");
    connector.getMessageStatus = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const slowResult = await new FakeConnector("delivered").getMessageStatus({
        messageId: "msg_delivered",
      });
      if (!slowResult.ok) return slowResult;
      return {
        ok: true,
        source: "slow",
        data: slowResult.data,
      };
    };
    const ctx = context({ deadline: Date.now() + 10 });
    const result = await new ToolRegistry({
      connector,
      draftRepository: repository(),
    }).execute("get_message_status", { messageId: "msg_delivered" }, ctx);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "timeout", retryable: true },
      meta: { attempts: 1 },
    });
  });

  it("marks responses truncated when delivery results exceed the limit", async () => {
    const base = new FakeConnector("delivered");
    const event: DeliveryFact = {
      messageId: "msg_delivered",
      receiverId: "user_delivered",
      attemptId: "attempt_1",
      attemptedAt: "2026-09-02T09:59:30Z",
      result: "success",
      deliveredAt: "2026-09-02T09:59:31Z",
      evidence: [
        {
          id: "delivery:test",
          source: "test",
          kind: "delivery",
          observedAt: "2026-09-02T09:59:31Z",
          field: "delivery_result",
          value: "success",
        },
      ],
    };
    base.getDeliveryEvents = async () => ({
      ok: true,
      source: "test",
      data: Array.from({ length: 51 }, (_, index) => ({
        ...event,
        attemptId: `attempt_${index}`,
      })),
    });
    const result = await new ToolRegistry({
      connector: base,
      draftRepository: repository(),
    }).execute(
      "get_delivery_events",
      { messageId: "msg_delivered" },
      context(),
    );
    expect(result).toMatchObject({
      ok: true,
      data: { events: expect.any(Array), truncated: true },
      meta: { truncated: true },
    });
    if (result.ok) {
      expect((result.data as { events: DeliveryFact[] }).events).toHaveLength(
        50,
      );
    }
  });
});

describe("create_escalation_draft", () => {
  it("requires server context confirmation and saves a real repository record", async () => {
    const input = draftInput();
    const verifier = createFixedConfirmationVerifier(
      new Map([
        [
          "confirm-001",
          {
            contentHash: input.contentHash,
            idempotencyKey: input.idempotencyKey,
            actorId: "support_test",
            runId: "run_test",
          },
        ],
      ]),
    );
    const repository = createInMemoryDraftRepository();
    const registry = new ToolRegistry({
      connector: new FakeConnector("delivered"),
      draftRepository: repository,
      confirmationVerifier: verifier,
    });
    const missingToken = await registry.execute(
      "create_escalation_draft",
      input,
      context(),
    );
    expect(missingToken).toMatchObject({
      ok: false,
      error: { code: "confirmation_required" },
    });

    const confirmedContext = context({ confirmationToken: "confirm-001" });
    const confirmed = await registry.execute(
      "create_escalation_draft",
      input,
      confirmedContext,
    );
    expect(confirmed).toMatchObject({
      ok: true,
      data: { reused: false, draft: { status: "draft" } },
    });
    expect(confirmedContext.traces[0]?.args.contentHash).toBe("[REDACTED]");
  });

  it("reuses same idempotency content and rejects different content", async () => {
    const input = draftInput();
    const verifier = createFixedConfirmationVerifier(
      new Map([["confirm-001", input]]),
    );
    const registry = new ToolRegistry({
      connector: new FakeConnector("delivered"),
      draftRepository: createInMemoryDraftRepository(),
      confirmationVerifier: verifier,
    });
    const ctx = context({ confirmationToken: "confirm-001" });
    const first = await registry.execute("create_escalation_draft", input, ctx);
    const second = await registry.execute(
      "create_escalation_draft",
      input,
      ctx,
    );
    expect(first).toMatchObject({ ok: true, data: { reused: false } });
    expect(second).toMatchObject({ ok: true, data: { reused: true } });

    const changed = { ...input, summary: "内容被修改" };
    const conflict = await registry.execute(
      "create_escalation_draft",
      changed,
      ctx,
    );
    expect(conflict).toMatchObject({
      ok: false,
      error: { code: "invalid_argument" },
    });
  });

  it("does not allow delivered messages to create escalation drafts", async () => {
    const input = draftInput();
    const verifier = createFixedConfirmationVerifier(
      new Map([["confirm-001", input]]),
    );
    const registry = new ToolRegistry({
      connector: new FakeConnector("delivered"),
      draftRepository: repository(),
      confirmationVerifier: verifier,
    });
    const result = await registry.execute(
      "create_escalation_draft",
      { ...input, classification: "delivered" },
      context({ confirmationToken: "confirm-001" }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_argument" },
    });
  });
});

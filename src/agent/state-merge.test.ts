import { describe, expect, it } from "vitest";

import { loadFixture } from "../connectors/fake/fixture-loader";
import { diagnose } from "../domain/diagnose";
import { ToolResponse } from "../tools/context";
import { buildDiagnosisInput } from "./diagnosis-input";
import { buildModelContext } from "./model-context";
import {
  AgentSessionState,
  AgentSessionStateSchema,
  createAgentSessionState,
} from "./session-state";
import {
  hashToolInput,
  mergeCandidateContext,
  mergeDiagnosisResult,
  mergeToolResult,
  resolveTargetSwitch,
  TargetSwitchResolutionError,
} from "./state-merge";

const now = new Date("2026-09-07T10:00:00Z");

function session(): AgentSessionState {
  return createAgentSessionState({
    sessionId: "session_merge",
    tenantId: "tenant_001",
    actorId: "support_001",
    issueSummary: "用户反馈消息没有收到",
    problemType: "message_not_received",
    now,
  });
}

function success(data: unknown, truncated = false): ToolResponse<unknown> {
  return {
    ok: true,
    data,
    meta: {
      requestId: "request_001",
      runId: "run_001",
      durationMs: 10,
      attempts: 1,
      truncated,
    },
  };
}

function timeout(): ToolResponse<unknown> {
  return {
    ok: false,
    error: {
      code: "timeout",
      message: "tool timed out",
      retryable: true,
      details: { internalLog: "must not enter working memory" },
    },
    meta: {
      requestId: "request_001",
      runId: "run_001",
      durationMs: 2_000,
      attempts: 2,
      truncated: false,
    },
  };
}

describe("mergeCandidateContext", () => {
  it("keeps model extraction as a candidate and treats an identical patch as idempotent", () => {
    const first = mergeCandidateContext(session(), {
      messageId: "msg_delivered",
    });
    expect(first).toMatchObject({
      changed: true,
      state: {
        candidateContext: { messageId: "msg_delivered" },
        messageId: null,
        confirmedFacts: { message: null },
      },
    });

    const repeated = mergeCandidateContext(first.state, {
      messageId: "msg_delivered",
    });
    expect(repeated.changed).toBe(false);
  });

  it("asks before switching away from an already confirmed message", () => {
    const fixture = loadFixture("delivered");
    const state = AgentSessionStateSchema.parse({
      ...session(),
      messageId: fixture.message.messageId,
      confirmedFacts: { message: fixture.message },
    });
    const result = mergeCandidateContext(
      state,
      { messageId: "msg_other" },
      now,
    );

    expect(result.state).toMatchObject({
      messageId: "msg_delivered",
      candidateContext: { messageId: "msg_other" },
      status: "awaiting_information",
      pendingQuestion: { field: "targetSwitch" },
      pendingTargetSwitch: {
        fromMessageId: "msg_delivered",
        toMessageId: "msg_other",
      },
      confirmedFacts: { message: { messageId: "msg_delivered" } },
    });
  });
});

describe("resolveTargetSwitch", () => {
  function pendingSwitch(toMessageId = "msg_other") {
    const fixture = loadFixture("delivered");
    const current = AgentSessionStateSchema.parse({
      ...session(),
      messageId: fixture.message.messageId,
      confirmedFacts: { message: fixture.message },
    });
    return mergeCandidateContext(current, { messageId: toMessageId }, now)
      .state;
  }

  it("starts a clean issue after an explicitly bound confirmation", () => {
    const pending = pendingSwitch();
    const result = resolveTargetSwitch(
      pending,
      {
        type: "resolve_target_switch",
        decisionId: pending.pendingTargetSwitch!.decisionId,
        decision: "confirm",
        expectedVersion: pending.version,
      },
      new Date("2026-09-07T10:01:00Z"),
    );

    expect(result.state).toMatchObject({
      currentIssue: {
        summary: "检查消息 msg_other",
        reopenedFromIssueId: null,
      },
      candidateContext: { messageId: "msg_other" },
      messageId: null,
      confirmedFacts: {
        message: null,
        deliveries: [],
        connection: null,
        deliveryQuery: null,
      },
      pendingQuestion: null,
      pendingTargetSwitch: null,
      diagnosisResult: null,
    });
    expect(result.state.previousIssues).toEqual([
      expect.objectContaining({
        messageId: "msg_delivered",
        summary: "用户反馈消息没有收到",
      }),
    ]);
  });

  it("links a repeated message to its previous issue without restoring stale facts", () => {
    const state = AgentSessionStateSchema.parse({
      ...pendingSwitch("msg_previous"),
      previousIssues: [
        {
          issueId: "issue_previous",
          messageId: "msg_previous",
          summary: "第一次检查 msg_previous",
          classification: "not_delivered",
          closedAt: "2026-09-07T09:00:00Z",
        },
      ],
    });
    const result = resolveTargetSwitch(
      state,
      {
        type: "resolve_target_switch",
        decisionId: state.pendingTargetSwitch!.decisionId,
        decision: "confirm",
        expectedVersion: state.version,
      },
      new Date("2026-09-07T10:01:00Z"),
    );

    expect(result.state.currentIssue.reopenedFromIssueId).toBe(
      "issue_previous",
    );
    expect(result.state.confirmedFacts.message).toBeNull();
    expect(result.state.messageId).toBeNull();
  });

  it("keeps the active issue when the operator rejects the switch", () => {
    const pending = pendingSwitch();
    const result = resolveTargetSwitch(
      pending,
      {
        type: "resolve_target_switch",
        decisionId: pending.pendingTargetSwitch!.decisionId,
        decision: "reject",
        expectedVersion: pending.version,
      },
      new Date("2026-09-07T10:01:00Z"),
    );

    expect(result.state.messageId).toBe("msg_delivered");
    expect(result.state.confirmedFacts.message?.messageId).toBe(
      "msg_delivered",
    );
    expect(result.state.candidateContext.messageId).toBe("msg_delivered");
    expect(result.state.pendingTargetSwitch).toBeNull();
  });

  it("rejects a stale or unrelated confirmation", () => {
    const pending = pendingSwitch();

    expect(() =>
      resolveTargetSwitch(pending, {
        type: "resolve_target_switch",
        decisionId: "switch_unrelated",
        decision: "confirm",
        expectedVersion: pending.version,
      }),
    ).toThrowError(TargetSwitchResolutionError);
    expect(() =>
      resolveTargetSwitch(pending, {
        type: "resolve_target_switch",
        decisionId: pending.pendingTargetSwitch!.decisionId,
        decision: "confirm",
        expectedVersion: pending.version + 1,
      }),
    ).toThrowError(TargetSwitchResolutionError);
  });

  it("rejects a confirmation after the pending switch expires", () => {
    const pending = pendingSwitch();

    expect(() =>
      resolveTargetSwitch(
        pending,
        {
          type: "resolve_target_switch",
          decisionId: pending.pendingTargetSwitch!.decisionId,
          decision: "confirm",
          expectedVersion: pending.version,
        },
        new Date("2026-09-07T10:06:00Z"),
      ),
    ).toThrowError(TargetSwitchResolutionError);
  });
});

describe("mergeToolResult", () => {
  it("moves a validated MessageFact into confirmed facts", () => {
    const fixture = loadFixture("delivered");
    const candidate = mergeCandidateContext(session(), {
      messageId: fixture.message.messageId,
    }).state;
    const result = mergeToolResult(candidate, {
      toolName: "get_message_status",
      args: { messageId: fixture.message.messageId },
      response: success({
        message: fixture.message,
        unsupportedCapabilities: [],
      }),
      calledAt: now,
    });

    expect(result.state).toMatchObject({
      messageId: "msg_delivered",
      matchResolution: "unique",
      confirmedFacts: {
        message: { messageId: "msg_delivered", persisted: true },
      },
      calledTools: [{ toolName: "get_message_status", outcome: "success" }],
      toolErrors: [],
    });
  });

  it("preserves a timeout without creating confirmed facts", () => {
    const candidate = mergeCandidateContext(session(), {
      messageId: "msg_delivered",
    }).state;
    const result = mergeToolResult(candidate, {
      toolName: "get_message_status",
      args: { messageId: "msg_delivered" },
      response: timeout(),
      calledAt: now,
    });

    expect(result.state.candidateContext.messageId).toBe("msg_delivered");
    expect(result.state.confirmedFacts.message).toBeNull();
    expect(result.state).toMatchObject({
      calledTools: [
        {
          toolName: "get_message_status",
          outcome: "error",
          errorCode: "timeout",
        },
      ],
      toolErrors: [{ tool: "get_message_status", error: { code: "timeout" } }],
    });
    expect(result.state.toolErrors[0]?.error.details).toBeUndefined();
  });

  it("records mismatched message evidence without replacing current facts", () => {
    const delivered = loadFixture("delivered");
    const other = loadFixture("write_failed");
    const state = AgentSessionStateSchema.parse({
      ...session(),
      messageId: delivered.message.messageId,
      confirmedFacts: { message: delivered.message },
    });
    const result = mergeToolResult(state, {
      toolName: "get_message_status",
      args: { messageId: delivered.message.messageId },
      response: success({
        message: other.message,
        unsupportedCapabilities: [],
      }),
      calledAt: now,
    });

    expect(result.state.confirmedFacts.message?.messageId).toBe(
      "msg_delivered",
    );
    expect(result.state.conflicts).toHaveLength(1);
    expect(result.state.conflicts[0]?.subject).toBe("messageId");
  });

  it("marks a successful empty delivery query complete and enables not_delivered", () => {
    const fixture = loadFixture("not_delivered");
    const state = AgentSessionStateSchema.parse({
      ...session(),
      messageId: fixture.message.messageId,
      matchResolution: "unique",
      confirmedFacts: { message: fixture.message },
      evidence: fixture.message.evidence,
    });
    const merged = mergeToolResult(state, {
      toolName: "get_delivery_events",
      args: { messageId: fixture.message.messageId },
      response: success({
        events: [],
        query: {
          complete: true,
          effectiveTimeRange: {
            start: "2026-09-06T10:00:00Z",
            end: "2026-09-07T10:00:00Z",
          },
          returnedCount: 0,
          source: "fake_connector",
          sourceReference: "fixture:not_delivered:delivery-events",
        },
        unsupportedCapabilities: [],
        truncated: false,
      }),
      calledAt: now,
    }).state;

    expect(merged.confirmedFacts.deliveryQuery).toMatchObject({
      complete: true,
      truncated: false,
      returnedCount: 0,
      source: "fake_connector",
      evidence: {
        id: expect.stringMatching(/^delivery-query:/),
        metadata: {
          sourceReference: "fixture:not_delivered:delivery-events",
        },
      },
    });
    expect(diagnose(buildDiagnosisInput(merged)).classification).toBe(
      "not_delivered",
    );
    expect(
      JSON.stringify(buildModelContext(merged, "select_tool")),
    ).not.toContain("fixture:not_delivered:delivery-events");
  });

  it("keeps an incomplete empty delivery query as insufficient data", () => {
    const fixture = loadFixture("not_delivered");
    const state = AgentSessionStateSchema.parse({
      ...session(),
      messageId: fixture.message.messageId,
      matchResolution: "unique",
      confirmedFacts: { message: fixture.message },
      evidence: fixture.message.evidence,
    });
    const merged = mergeToolResult(state, {
      toolName: "get_delivery_events",
      args: { messageId: fixture.message.messageId },
      response: success({
        events: [],
        query: {
          complete: false,
          effectiveTimeRange: {
            start: "2026-09-07T09:00:00Z",
            end: "2026-09-07T10:00:00Z",
          },
          returnedCount: 0,
          source: "partial_connector",
          sourceReference: "partial:delivery-query:001",
        },
        unsupportedCapabilities: [],
        truncated: false,
      }),
      calledAt: now,
    }).state;

    expect(merged.confirmedFacts.deliveryQuery?.complete).toBe(false);
    expect(diagnose(buildDiagnosisInput(merged))).toMatchObject({
      classification: "insufficient_data",
      missingInformation: expect.arrayContaining(["completeDeliveryQuery"]),
    });
  });

  it("uses normalized arguments to create a deterministic input hash", () => {
    const first = hashToolInput("get_message_status", {
      messageId: "msg_001",
    });
    const second = hashToolInput("get_message_status", {
      messageId: "msg_001",
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("diagnosis state projection", () => {
  it("distinguishes an unqueried delivery list from a confirmed empty result", () => {
    const fixture = loadFixture("not_delivered");
    const state = AgentSessionStateSchema.parse({
      ...session(),
      messageId: fixture.message.messageId,
      confirmedFacts: { message: fixture.message },
    });

    const input = buildDiagnosisInput(state);
    expect(input.deliveries).toBeUndefined();
    expect(diagnose(input)).toMatchObject({
      classification: "insufficient_data",
      missingInformation: ["deliveryEvents"],
    });
  });

  it("builds DiagnosisInput from working memory, not ModelContext", () => {
    const fixture = loadFixture("delivered");
    const state = AgentSessionStateSchema.parse({
      ...session(),
      messageId: fixture.message.messageId,
      confirmedFacts: {
        message: fixture.message,
        deliveries: fixture.deliveries,
      },
      evidence: [
        ...fixture.message.evidence,
        ...fixture.deliveries.flatMap((item) => item.evidence),
      ],
    });
    const input = buildDiagnosisInput(state, {
      requestId: "request_001",
      currentUserText: "客服仍然认为没有收到，但这不是证据",
    });
    const diagnosis = diagnose(input);

    expect(input).toMatchObject({
      requestId: "request_001",
      rawText: "客服仍然认为没有收到，但这不是证据",
      messageId: "msg_delivered",
    });
    expect(diagnosis.classification).toBe("delivered");
  });

  it("stores DiagnosisResult separately without rewriting confirmed facts", () => {
    const fixture = loadFixture("delivered");
    const state = AgentSessionStateSchema.parse({
      ...session(),
      messageId: fixture.message.messageId,
      confirmedFacts: {
        message: fixture.message,
        deliveries: fixture.deliveries,
      },
    });
    const diagnosis = diagnose(buildDiagnosisInput(state));
    const merged = mergeDiagnosisResult(state, diagnosis);

    expect(merged.state.diagnosisResult?.classification).toBe("delivered");
    expect(merged.state.status).toBe("generating_response");
    expect(merged.state.confirmedFacts).toEqual(state.confirmedFacts);
  });

  it("rejects a diagnosis classification not produced by deterministic code", () => {
    const fixture = loadFixture("delivered");
    const state = AgentSessionStateSchema.parse({
      ...session(),
      messageId: fixture.message.messageId,
      confirmedFacts: {
        message: fixture.message,
        deliveries: fixture.deliveries,
      },
    });
    const realDiagnosis = diagnose(buildDiagnosisInput(state));

    expect(() =>
      mergeDiagnosisResult(state, {
        ...realDiagnosis,
        classification: "ack_timeout",
      }),
    ).toThrow("diagnosis result does not match deterministic diagnosis");
  });
});

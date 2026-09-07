import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { diagnose } from "../domain/diagnose";
import { loadFixture } from "../connectors/fake/fixture-loader";
import { buildModelContext } from "./model-context";
import {
  AgentSessionState,
  AgentSessionStateSchema,
  createAgentSessionState,
} from "./session-state";

function inputHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function session(): AgentSessionState {
  const fixture = loadFixture("delivered");
  const diagnosisResult = diagnose({
    rawText: "用户反馈消息未收到",
    messageId: fixture.message.messageId,
    message: fixture.message,
    deliveries: fixture.deliveries,
  });
  return AgentSessionStateSchema.parse({
    ...createAgentSessionState({
      sessionId: "session_context",
      tenantId: "tenant_001",
      actorId: "support_001",
      issueSummary: "用户反馈消息未收到",
      problemType: "message_not_received",
      now: new Date("2026-09-06T10:00:00Z"),
    }),
    candidateContext: {
      messageId: fixture.message.messageId,
      problemType: "message_not_received",
    },
    messageId: fixture.message.messageId,
    confirmedFacts: {
      message: fixture.message,
      deliveries: fixture.deliveries,
      connection: fixture.connection,
      deliveryQuery: null,
    },
    evidence: [
      ...fixture.message.evidence,
      ...fixture.deliveries.flatMap((item) => item.evidence),
    ],
    calledTools: [
      {
        toolName: "get_message_status",
        inputHash: inputHash("message"),
        outcome: "success",
        calledAt: "2026-09-06T10:00:01Z",
      },
      {
        toolName: "get_delivery_events",
        inputHash: inputHash("delivery"),
        outcome: "success",
        calledAt: "2026-09-06T10:00:02Z",
      },
    ],
    connectorCapabilities: {
      messageLookup: "supported",
      deliveryEvents: "supported",
      historicalPresence: "unsupported",
    },
    diagnosisResult,
    status: "generating_response",
  });
}

describe("buildModelContext", () => {
  it("only exposes current input and candidate data for extraction", () => {
    const state = session();
    const context = buildModelContext(state, "extract_context", {
      currentUserText: "消息 ID 是 msg_delivered",
    });

    expect(context).toMatchObject({
      purpose: "extract_context",
      currentUserText: "消息 ID 是 msg_delivered",
      candidateContext: { messageId: "msg_delivered" },
    });
    expect(context).not.toHaveProperty("confirmedFacts");
    expect(context).not.toHaveProperty("recentTools");
    expect(context).not.toHaveProperty("diagnosis");
  });

  it("provides bounded summaries for tool selection without raw evidence values", () => {
    const state = AgentSessionStateSchema.parse({
      ...session(),
      calledTools: Array.from({ length: 5 }, (_, index) => ({
        toolName: "get_message_status",
        inputHash: inputHash(`message-${index}`),
        outcome: "success",
        calledAt: `2026-09-06T10:00:0${index}Z`,
      })),
    });
    const context = buildModelContext(state, "select_tool", {
      limits: { maxCalledTools: 2 },
    });

    expect(context.recentTools).toHaveLength(2);
    expect(context.truncation).toMatchObject({
      truncated: true,
      omitted: { recentTools: 3 },
    });
    expect(context.confirmedFacts?.message).toMatchObject({
      messageId: "msg_delivered",
      exists: true,
      persisted: true,
    });
    expect(context.connectorCapabilities).toEqual({
      messageLookup: "supported",
      deliveryEvents: "supported",
      historicalPresence: "unsupported",
    });
    expect(JSON.stringify(context)).not.toContain("metadata");
    expect(JSON.stringify(context)).not.toContain("delivery_result");
  });

  it("uses the deterministic diagnosis for response and hides candidates and calls", () => {
    const context = buildModelContext(session(), "generate_response");

    expect(context.diagnosis).toMatchObject({
      classification: "delivered",
      recommendedAction: "reply",
    });
    expect(context).not.toHaveProperty("candidateContext");
    expect(context).not.toHaveProperty("recentTools");
  });

  it("enforces a total character budget and reports omitted content", () => {
    const oversized = AgentSessionStateSchema.parse({
      ...session(),
      currentIssue: {
        problemType: "message_not_received",
        summary: "问题".repeat(450),
      },
      evidence: Array.from({ length: 80 }, (_, index) => ({
        id: `evidence_${index}_${"x".repeat(80)}`,
        source: "fixture",
        kind: "message",
        observedAt: "2026-09-06T10:00:00Z",
        field: "message_id",
        value: `sensitive-${index}`,
      })),
    });
    const context = buildModelContext(oversized, "select_tool", {
      limits: {
        maxCharacters: 1_200,
        maxIssueSummaryCharacters: 1_000,
        maxEvidenceRefs: 80,
      },
    });

    expect(JSON.stringify(context).length).toBeLessThanOrEqual(1_200);
    expect(context.truncation.truncated).toBe(true);
    expect(Object.keys(context.truncation.omitted).length).toBeGreaterThan(0);
    expect(JSON.stringify(context)).not.toContain("sensitive-");
  });
});

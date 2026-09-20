import { describe, expect, it } from "vitest";

import { RunTraceRecorder } from "./run-trace";
import { queryTrace, replayTrace } from "./trace-query";

function traceFixture() {
  const recorder = new RunTraceRecorder({
    runId: "run_query_001",
    sessionId: "session_query_001",
    requestId: "request_query_001",
    startedAt: new Date("2026-09-20T00:00:00.000Z"),
  });
  recorder.syncToolTraces([
    {
      requestId: "request_query_001",
      runId: "run_query_001",
      toolName: "get_message_status",
      args: { messageId: "msg_001" },
      outcome: "error",
      errorCode: "timeout",
      resultSummary: { retryable: true },
      durationMs: 100,
      attempts: 2,
      retryDelaysMs: [25],
      cached: false,
      truncated: false,
    },
    {
      requestId: "request_query_001",
      runId: "run_query_001",
      toolName: "get_connection_status",
      args: { userId: "user_001" },
      outcome: "error",
      errorCode: "unsupported_capability",
      resultSummary: { capability: "historicalPresence" },
      durationMs: 4,
      attempts: 1,
      retryDelaysMs: [],
      cached: false,
      truncated: false,
    },
    {
      requestId: "request_query_001",
      runId: "run_query_001",
      toolName: "create_escalation_draft",
      args: {
        messageId: "msg_001",
        contentHash: "[REDACTED]",
        idempotencyKey: "[REDACTED]",
      },
      outcome: "blocked",
      errorCode: "confirmation_required",
      resultSummary: { confirmation: "required" },
      durationMs: 1,
      attempts: 1,
      retryDelaysMs: [],
      cached: false,
      truncated: false,
    },
  ]);
  return recorder.finish({
    status: "stopped",
    stopReason: "ask_for_information",
    finalClassification: "insufficient_data",
    finishedAt: new Date("2026-09-20T00:00:01.000Z"),
  });
}

describe("trace query and replay", () => {
  it("projects tools, retries, timeout, unsupported capability and confirmation", () => {
    const result = queryTrace(traceFixture());

    expect(result.tools).toHaveLength(3);
    expect(result.tools[0]).toMatchObject({
      name: "get_message_status",
      attempts: 2,
      retried: true,
      retryDelaysMs: [25],
      timedOut: true,
    });
    expect(result.timeouts).toEqual([
      { sequence: 1, tool: "get_message_status", errorCode: "timeout" },
    ]);
    expect(result.unsupportedCapabilities).toEqual(["historicalPresence"]);
    expect(result.humanConfirmationTriggered).toBe(true);
    expect(result.humanConfirmationStatus).toBe("pending");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "stop",
          code: "tool_timeout",
        }),
        expect.objectContaining({
          kind: "stop",
          code: "ask_for_information",
        }),
      ]),
    );
  });

  it("replays explanations without executing any tool", () => {
    const replay = replayTrace(traceFixture());

    expect(replay).toMatchObject({
      mode: "read_only_replay",
      executedTools: false,
      source: {
        runId: "run_query_001",
        finalClassification: "insufficient_data",
      },
    });
  });
});

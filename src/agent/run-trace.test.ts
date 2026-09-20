import { describe, expect, it } from "vitest";

import { RunTraceRecorder } from "./run-trace";

describe("RunTraceRecorder", () => {
  it("records agent, tool and security steps in one ordered trace", () => {
    const recorder = new RunTraceRecorder({
      runId: "run_trace_001",
      sessionId: "session_trace_001",
      requestId: "request_trace_001",
      startedAt: new Date("2026-09-20T00:00:00.000Z"),
    });

    const agentStarted = recorder.mark();
    recorder.recordAgent("extract_context", agentStarted, "success", {
      extractedFields: ["messageId"],
    });
    recorder.syncToolTraces([
      {
        requestId: "request_trace_001",
        runId: "run_trace_001",
        toolName: "get_message_status",
        args: {
          messageId: "msg_001",
          confirmationToken: "do-not-store",
          password: "do-not-store",
          phone: "13800138000",
        },
        outcome: "success",
        resultSummary: {
          message: {
            messageId: "msg_001",
            content: "完整消息正文不应进入 Trace",
          },
        },
        durationMs: 12,
        attempts: 1,
        retryDelaysMs: [],
        cached: false,
        truncated: false,
      },
      {
        requestId: "request_trace_001",
        runId: "run_trace_001",
        toolName: "security_input_guard",
        args: { source: "customer_input", trust: "untrusted_data" },
        outcome: "blocked",
        errorCode: "prompt_injection_detected",
        resultSummary: {
          policy: "ignored_untrusted_instruction",
          requestedActions: ["resend_message"],
        },
        durationMs: 0,
        attempts: 0,
        retryDelaysMs: [],
        cached: false,
        truncated: false,
      },
    ]);

    const trace = recorder.finish({
      status: "completed",
      stopReason: "diagnosed",
      finalClassification: "receiver_offline",
      finishedAt: new Date("2026-09-20T00:00:01.000Z"),
    });

    expect(trace).toMatchObject({
      traceVersion: 1,
      runId: "run_trace_001",
      sessionId: "session_trace_001",
      requestId: "request_trace_001",
      status: "completed",
      stopReason: "diagnosed",
      finalClassification: "receiver_offline",
      classificationSource: "deterministic_diagnosis",
    });
    expect(trace.steps.map((step) => step.type)).toEqual([
      "agent",
      "tool",
      "security",
    ]);
    expect(trace.steps.map((step) => step.sequence)).toEqual([1, 2, 3]);
    expect(trace.steps[1]).toMatchObject({
      type: "tool",
      name: "get_message_status",
      inputHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      attempts: 1,
    });
    expect(trace.steps[2]).toMatchObject({
      type: "security",
      action: "prompt_injection_detected",
      outcome: "blocked",
    });
    expect(trace.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("redacts credentials, phone numbers and message content before storing trace", () => {
    const recorder = new RunTraceRecorder({
      runId: "run_trace_redaction",
      sessionId: "session_trace_redaction",
      requestId: "request_trace_redaction",
    });

    recorder.syncToolTraces([
      {
        requestId: "request_trace_redaction",
        runId: "run_trace_redaction",
        toolName: "get_message_status",
        args: {
          messageId: "msg_002",
          confirmationToken: "confirmation-secret",
          authorization: "Bearer secret",
          phone: "13900000000",
          content: "敏感消息正文",
        },
        outcome: "success",
        resultSummary: {
          content: "敏感消息正文",
          phone: "13900000000",
          status: "persisted",
        },
        durationMs: 1,
        attempts: 1,
        retryDelaysMs: [],
        cached: false,
        truncated: false,
      },
    ]);

    const trace = recorder.finish({
      status: "completed",
      finalClassification: "delivered",
    });
    const serialized = JSON.stringify(trace);

    expect(serialized).not.toContain("confirmation-secret");
    expect(serialized).not.toContain("Bearer secret");
    expect(serialized).not.toContain("13900000000");
    expect(serialized).not.toContain("敏感消息正文");
    expect(trace.steps[0]).toMatchObject({
      params: {
        confirmationToken: "[REDACTED]",
        authorization: "[REDACTED]",
        phone: "[REDACTED]",
        content: "[REDACTED]",
      },
      resultSummary: {
        content: "[REDACTED]",
        phone: "[REDACTED]",
        status: "persisted",
      },
    });
  });

  it("syncs only newly appended tool traces and keeps a null final classification explicit", () => {
    const recorder = new RunTraceRecorder({
      runId: "run_trace_sync",
      sessionId: "session_trace_sync",
      requestId: "request_trace_sync",
    });
    const traces = [
      {
        requestId: "request_trace_sync",
        runId: "run_trace_sync",
        toolName: "get_message_status",
        args: { messageId: "msg_003" },
        outcome: "error" as const,
        errorCode: "timeout",
        resultSummary: { retryable: true },
        durationMs: 50,
        attempts: 1,
        retryDelaysMs: [],
        cached: false,
        truncated: false,
      },
    ];

    recorder.syncToolTraces(traces);
    recorder.syncToolTraces(traces);
    const trace = recorder.finish({
      status: "awaiting_information",
      stopReason: "ask_for_information",
    });

    expect(trace.steps).toHaveLength(1);
    expect(trace.steps[0]).toMatchObject({
      type: "tool",
      outcome: "error",
      errorCode: "timeout",
    });
    expect(trace.finalClassification).toBeNull();
    expect(trace.classificationSource).toBe("deterministic_diagnosis");
  });
});

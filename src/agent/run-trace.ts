import { createHash } from "node:crypto";
import { z } from "zod";

import { ToolTrace } from "../tools/context";

const TraceOutcomeSchema = z.enum(["success", "error", "blocked", "cached"]);
export type TraceOutcome = z.infer<typeof TraceOutcomeSchema>;

const TraceStepBaseSchema = z.object({
  stepId: z.string().regex(/^step_[a-f0-9]{16}$/),
  sequence: z.number().int().positive(),
  durationMs: z.number().int().nonnegative(),
  outcome: TraceOutcomeSchema,
  errorCode: z.string().min(1).max(128).optional(),
});

export const AgentTraceStepSchema = TraceStepBaseSchema.extend({
  type: z.literal("agent"),
  action: z.enum([
    "extract_context",
    "select_tool",
    "generate_response",
    "diagnose",
  ]),
  resultSummary: z.record(z.unknown()).optional(),
}).strict();
export type AgentTraceStep = z.infer<typeof AgentTraceStepSchema>;

export const ToolTraceStepSchema = TraceStepBaseSchema.extend({
  type: z.literal("tool"),
  name: z.string().min(1).max(128),
  params: z.record(z.unknown()),
  inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  resultSummary: z.record(z.unknown()).optional(),
  attempts: z.number().int().nonnegative(),
  retryDelaysMs: z.array(z.number().int().nonnegative()).max(10),
  cached: z.boolean(),
  truncated: z.boolean(),
}).strict();
export type ToolTraceStep = z.infer<typeof ToolTraceStepSchema>;

export const SecurityTraceStepSchema = TraceStepBaseSchema.extend({
  type: z.literal("security"),
  action: z.enum(["prompt_injection_detected"]),
  params: z.record(z.unknown()),
  resultSummary: z.record(z.unknown()).optional(),
}).strict();
export type SecurityTraceStep = z.infer<typeof SecurityTraceStepSchema>;

export const RunTraceStepSchema = z.discriminatedUnion("type", [
  AgentTraceStepSchema,
  ToolTraceStepSchema,
  SecurityTraceStepSchema,
]);
export type RunTraceStep = z.infer<typeof RunTraceStepSchema>;

// 给 addStep 使用显式的联合输入类型；直接 Omit 联合类型会丢失每个分支的专属字段。
type TraceStepInput =
  | Omit<AgentTraceStep, "stepId" | "sequence">
  | Omit<ToolTraceStep, "stepId" | "sequence">
  | Omit<SecurityTraceStep, "stepId" | "sequence">;

const HumanConfirmationTraceSchema = z
  .object({
    triggered: z.boolean(),
    status: z.enum([
      "not_required",
      "pending",
      "confirmed",
      "rejected",
      "expired",
      "unknown",
    ]),
  })
  .strict();
export type HumanConfirmationTrace = z.infer<
  typeof HumanConfirmationTraceSchema
>;

export const AgentRunTraceSchema = z
  .object({
    traceVersion: z.literal(1),
    runId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
    requestId: z.string().min(1).max(128),
    startedAt: z.string().datetime({ offset: true }),
    finishedAt: z.string().datetime({ offset: true }),
    status: z.enum(["completed", "awaiting_information", "stopped", "failed"]),
    stopReason: z.string().min(1).max(128).nullable(),
    steps: z.array(RunTraceStepSchema).max(100),
    finalClassification: z
      .enum([
        "message_not_found",
        "write_failed",
        "not_delivered",
        "receiver_offline",
        "ack_timeout",
        "delivered",
        "insufficient_data",
      ])
      .nullable(),
    classificationSource: z.literal("deterministic_diagnosis"),
    humanConfirmation: HumanConfirmationTraceSchema.default({
      triggered: false,
      status: "not_required",
    }),
    totalDurationMs: z.number().int().nonnegative(),
  })
  .strict();
export type AgentRunTrace = z.infer<typeof AgentRunTraceSchema>;

interface RunTraceInput {
  runId: string;
  sessionId: string;
  requestId: string;
  startedAt?: Date;
}

/**
 * RunTraceRecorder 把模型阶段、工具 Trace 和安全 Trace 统一成一次 Run。
 * 它只接收已经脱敏的 ToolTrace，不保存 Prompt、完整响应或凭证。
 */
export class RunTraceRecorder {
  private readonly startedAt: Date;
  private readonly monotonicStart = performance.now();
  private readonly steps: RunTraceStep[] = [];
  private sequence = 0;
  private syncedToolTraceCount = 0;

  constructor(private readonly input: RunTraceInput) {
    this.startedAt = input.startedAt ?? new Date();
  }

  mark(): number {
    return performance.now();
  }

  recordAgent(
    action: AgentTraceStep["action"],
    startedAt: number,
    outcome: TraceOutcome = "success",
    resultSummary?: Record<string, unknown>,
    errorCode?: string,
  ): void {
    this.addStep({
      type: "agent",
      action,
      durationMs: elapsedMs(startedAt),
      outcome,
      ...(resultSummary
        ? { resultSummary: sanitizeTraceObject(resultSummary) }
        : {}),
      ...(errorCode ? { errorCode } : {}),
    });
  }

  /** 将 ToolContext 中新增的单工具 Trace 转为统一 Run Step。 */
  syncToolTraces(traces: readonly ToolTrace[]): void {
    for (const trace of traces.slice(this.syncedToolTraceCount)) {
      if (trace.toolName === "security_input_guard") {
        this.addStep({
          type: "security",
          action: "prompt_injection_detected",
          durationMs: trace.durationMs,
          outcome: trace.outcome,
          params: sanitizeTraceObject(trace.args),
          ...(trace.resultSummary
            ? { resultSummary: sanitizeTraceObject(trace.resultSummary) }
            : {}),
          errorCode: trace.errorCode,
        });
        continue;
      }
      this.addStep({
        type: "tool",
        name: trace.toolName,
        params: sanitizeTraceObject(trace.args),
        inputHash: `sha256:${hashValue(trace.args)}`,
        ...(trace.resultSummary
          ? { resultSummary: sanitizeTraceObject(trace.resultSummary) }
          : {}),
        durationMs: trace.durationMs,
        outcome: trace.outcome,
        errorCode: trace.errorCode,
        attempts: trace.attempts,
        retryDelaysMs: trace.retryDelaysMs,
        cached: trace.cached,
        truncated: trace.truncated,
      });
    }
    this.syncedToolTraceCount = traces.length;
  }

  finish(input: {
    status: AgentRunTrace["status"];
    stopReason?: string;
    finalClassification?: AgentRunTrace["finalClassification"];
    humanConfirmation?: HumanConfirmationTrace;
    finishedAt?: Date;
  }): AgentRunTrace {
    const finishedAt = input.finishedAt ?? new Date();
    return AgentRunTraceSchema.parse({
      traceVersion: 1,
      runId: this.input.runId,
      sessionId: this.input.sessionId,
      requestId: this.input.requestId,
      startedAt: this.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      status: input.status,
      stopReason: input.stopReason ?? null,
      steps: this.steps,
      finalClassification: input.finalClassification ?? null,
      classificationSource: "deterministic_diagnosis",
      humanConfirmation: input.humanConfirmation ?? {
        triggered: false,
        status: "not_required",
      },
      totalDurationMs: Math.max(
        0,
        Math.round(performance.now() - this.monotonicStart),
      ),
    });
  }

  private addStep(input: TraceStepInput): void {
    if (this.steps.length >= 100) return;
    const step = RunTraceStepSchema.parse({
      ...input,
      stepId: `step_${createHash("sha256")
        .update(`${this.input.runId}:${this.sequence + 1}`)
        .digest("hex")
        .slice(0, 16)}`,
      sequence: this.sequence + 1,
    });
    this.steps.push(step);
    this.sequence += 1;
  }
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function hashValue(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sanitizeTraceValue(value)))
    .digest("hex");
}

function sanitizeTraceObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeTraceValue(value) as Record<string, unknown>;
}

function sanitizeTraceValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[TRUNCATED]";
  if (typeof value === "string") return value.slice(0, 256);
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value))
    return value
      .slice(0, 20)
      .map((item) => sanitizeTraceValue(item, depth + 1));
  const sensitive =
    /token|password|secret|authorization|phone|body|content|credential/i;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 30)
      .map(([key, item]) => [
        key,
        sensitive.test(key)
          ? "[REDACTED]"
          : sanitizeTraceValue(item, depth + 1),
      ]),
  );
}

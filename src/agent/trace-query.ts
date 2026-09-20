import { z } from "zod";

import { AgentRunTrace, AgentRunTraceSchema, RunTraceStep } from "./run-trace";

const ReplayReasonSchema = z
  .object({
    sequence: z.number().int().positive(),
    kind: z.enum(["continue", "stop"]),
    code: z.string().min(1).max(128),
    detail: z.string().min(1).max(512),
  })
  .strict();
export type ReplayReason = z.infer<typeof ReplayReasonSchema>;

const ToolTraceViewSchema = z
  .object({
    sequence: z.number().int().positive(),
    name: z.string().min(1).max(128),
    params: z.record(z.unknown()),
    resultSummary: z.record(z.unknown()).nullable(),
    outcome: z.enum(["success", "error", "blocked", "cached"]),
    errorCode: z.string().nullable(),
    attempts: z.number().int().nonnegative(),
    retried: z.boolean(),
    retryDelaysMs: z.array(z.number().int().nonnegative()).max(10),
    cached: z.boolean(),
    truncated: z.boolean(),
    timedOut: z.boolean(),
  })
  .strict();
export type ToolTraceView = z.infer<typeof ToolTraceViewSchema>;

export const TraceQueryViewSchema = z
  .object({
    runId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
    requestId: z.string().min(1).max(128),
    status: z.enum(["completed", "awaiting_information", "stopped", "failed"]),
    stopReason: z.string().nullable(),
    finalClassification: z.string().nullable(),
    totalDurationMs: z.number().int().nonnegative(),
    tools: z.array(ToolTraceViewSchema).max(100),
    timeouts: z
      .array(
        z
          .object({
            sequence: z.number().int().positive(),
            tool: z.string().min(1).max(128),
            errorCode: z.literal("timeout"),
          })
          .strict(),
      )
      .max(100),
    reasons: z.array(ReplayReasonSchema).max(200),
    humanConfirmationTriggered: z.boolean(),
    humanConfirmationStatus: z.enum([
      "not_required",
      "pending",
      "confirmed",
      "rejected",
      "expired",
      "unknown",
    ]),
    unsupportedCapabilities: z.array(z.string().min(1).max(128)).max(50),
  })
  .strict();
export type TraceQueryView = z.infer<typeof TraceQueryViewSchema>;

export const TraceReplaySchema = z
  .object({
    mode: z.literal("read_only_replay"),
    executedTools: z.literal(false),
    source: TraceQueryViewSchema,
  })
  .strict();
export type TraceReplay = z.infer<typeof TraceReplaySchema>;

/** 将完整审计 Trace 投影成查询接口需要的有限字段。 */
export function queryTrace(trace: AgentRunTrace): TraceQueryView {
  return buildTraceQueryView(trace);
}

/**
 * 错误回放只重建历史决策解释，不调用模型、工具或写操作。
 * 这样可以回答“当时为什么停”，但不会把历史故障再次发送到生产系统。
 */
export function replayTrace(trace: AgentRunTrace): TraceReplay {
  return TraceReplaySchema.parse({
    mode: "read_only_replay",
    executedTools: false,
    source: buildTraceQueryView(trace),
  });
}

function buildTraceQueryView(rawTrace: AgentRunTrace): TraceQueryView {
  const trace = AgentRunTraceSchema.parse(rawTrace);
  const tools = trace.steps.filter(isToolStep).map((step) => ({
    sequence: step.sequence,
    name: step.name,
    params: step.params,
    resultSummary: step.resultSummary ?? null,
    outcome: step.outcome,
    errorCode: step.errorCode ?? null,
    attempts: step.attempts,
    retried: step.attempts > 1 || step.retryDelaysMs.length > 0,
    retryDelaysMs: step.retryDelaysMs,
    cached: step.cached,
    truncated: step.truncated,
    timedOut: step.errorCode === "timeout",
  }));
  const timeouts = tools
    .filter((tool) => tool.timedOut)
    .map((tool) => ({
      sequence: tool.sequence,
      tool: tool.name,
      errorCode: "timeout" as const,
    }));
  const reasons = buildReasons(trace, tools);
  const unsupportedCapabilities = unique(
    trace.steps.flatMap((step) => {
      if (step.type === "agent" && step.action === "diagnose") {
        const capabilities = step.resultSummary?.unsupportedCapabilities;
        return Array.isArray(capabilities)
          ? capabilities.filter(
              (capability): capability is string =>
                typeof capability === "string",
            )
          : [];
      }
      if (!isToolStep(step) || step.errorCode !== "unsupported_capability") {
        return [];
      }
      const capability = step.resultSummary?.capability;
      return typeof capability === "string" ? [capability] : [];
    }),
  );
  const confirmation = confirmationStatus(trace);

  return TraceQueryViewSchema.parse({
    runId: trace.runId,
    sessionId: trace.sessionId,
    requestId: trace.requestId,
    status: trace.status,
    stopReason: trace.stopReason,
    finalClassification: trace.finalClassification,
    totalDurationMs: trace.totalDurationMs,
    tools,
    timeouts,
    reasons,
    humanConfirmationTriggered: confirmation.triggered,
    humanConfirmationStatus: confirmation.status,
    unsupportedCapabilities,
  });
}

function buildReasons(
  trace: AgentRunTrace,
  tools: readonly ToolTraceView[],
): ReplayReason[] {
  const reasons: ReplayReason[] = [];
  for (const tool of tools) {
    if (tool.errorCode === "timeout") {
      reasons.push({
        sequence: tool.sequence,
        kind: "stop",
        code: "tool_timeout",
        detail: `${tool.name} 超时，未获得可作为诊断事实的结果。`,
      });
    } else if (tool.outcome === "error" || tool.outcome === "blocked") {
      reasons.push({
        sequence: tool.sequence,
        kind: "stop",
        code: tool.errorCode ?? "tool_error",
        detail: `${tool.name} 返回 ${tool.errorCode ?? tool.outcome}，系统没有把错误直接当作诊断事实。`,
      });
    } else {
      reasons.push({
        sequence: tool.sequence,
        kind: "continue",
        code: tool.cached ? "cached_result" : "evidence_received",
        detail: tool.cached
          ? `${tool.name} 命中本次 Run 的缓存，继续使用已校验结果。`
          : `${tool.name} 返回受限摘要，继续进行证据评估。`,
      });
    }
  }
  const lastStep = trace.steps.at(-1);
  if (trace.stopReason) {
    reasons.push({
      sequence: lastStep?.sequence ?? 1,
      kind: "stop",
      code: trace.stopReason,
      detail: stopDetail(trace),
    });
  }
  return reasons;
}

function stopDetail(trace: AgentRunTrace): string {
  switch (trace.stopReason) {
    case "diagnosed":
      return "确定性诊断已得到最终分类，停止继续调用工具。";
    case "ask_for_information":
      return "缺少必要信息，停止并等待客服补充。";
    case "max_tokens":
      return "达到模型 Token 预算，安全停止。";
    default:
      return `Run 以 ${trace.stopReason} 停止。`;
  }
}

function confirmationStatus(trace: AgentRunTrace): {
  triggered: boolean;
  status: TraceQueryView["humanConfirmationStatus"];
} {
  if (trace.humanConfirmation.triggered) {
    return {
      triggered: true,
      status: trace.humanConfirmation.status,
    };
  }
  const hasConfirmationStep = trace.steps.some(
    (step) =>
      isToolStep(step) &&
      (step.name === "create_escalation_draft" ||
        step.errorCode === "confirmation_required"),
  );
  return {
    triggered: hasConfirmationStep,
    status: hasConfirmationStep ? "pending" : "not_required",
  };
}

function isToolStep(
  step: RunTraceStep,
): step is Extract<RunTraceStep, { type: "tool" }> {
  return step.type === "tool";
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

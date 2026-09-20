import { ToolContext, ToolTraceSchema } from "../tools/context";

const OVERRIDE_PATTERNS = [
  /忽略(?:之前|以上)?(?:所有)?(?:的)?(?:规则|指令|提示词)/i,
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:rules|instructions|prompts)/i,
];

const FORBIDDEN_ACTIONS = [
  "resend_message",
  "modify_message",
  "kick_user",
  "execute_sql",
  "execute_shell",
  "submit_incident",
] as const;

export interface PromptInjectionDetection {
  detected: boolean;
  requestedActions: string[];
}

/**
 * PromptInjectionGuard 只做审计检测，不负责安全授权。
 * 即使某种注入措辞没有命中，工具白名单仍是最终执行边界。
 */
export function detectPromptInjection(text: string): PromptInjectionDetection {
  const requestedActions = FORBIDDEN_ACTIONS.filter((action) =>
    text.toLowerCase().includes(action),
  );
  return {
    detected:
      requestedActions.length > 0 &&
      OVERRIDE_PATTERNS.some((pattern) => pattern.test(text)),
    requestedActions: [...requestedActions],
  };
}

/** 只记录安全摘要，不把原始日志或消息内容复制到 Trace。 */
export function recordPromptInjectionTrace(
  context: ToolContext,
  detection: PromptInjectionDetection,
): void {
  if (!detection.detected) return;
  context.traces.push(
    ToolTraceSchema.parse({
      requestId: context.requestId,
      runId: context.runId,
      toolName: "security_input_guard",
      args: { source: "customer_input", trust: "untrusted_data" },
      outcome: "blocked",
      errorCode: "prompt_injection_detected",
      resultSummary: {
        policy: "ignored_untrusted_instruction",
        requestedActions: detection.requestedActions,
      },
      durationMs: 0,
      attempts: 0,
      retryDelaysMs: [],
      cached: false,
      truncated: false,
    }),
  );
}

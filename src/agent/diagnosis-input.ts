import { DiagnosisInput, DiagnosisInputSchema } from "../domain/diagnosis";
import { AgentSessionState, AgentSessionStateSchema } from "./session-state";

export function buildDiagnosisInput(
  rawState: AgentSessionState,
  options: { requestId?: string; currentUserText?: string } = {},
): DiagnosisInput {
  const state = AgentSessionStateSchema.parse(rawState);
  const { message, deliveries, connection, deliveryQuery } =
    state.confirmedFacts;
  const rawText = options.currentUserText?.trim() || state.currentIssue.summary;

  return DiagnosisInputSchema.parse({
    requestId: options.requestId,
    // rawText 只用于保留本轮问题上下文，诊断引擎不会把它当作证据。
    rawText,
    userId: state.userId ?? undefined,
    conversationId: state.conversationId ?? undefined,
    messageId: state.messageId ?? undefined,
    timeRange: state.timeRange ?? undefined,
    problemType:
      state.currentIssue.problemType ??
      state.candidateContext.problemType ??
      undefined,
    matchResolution: state.matchResolution ?? undefined,
    message: message ?? undefined,
    // 空数组只有在 deliveryQuery 存在时才表示“查询成功但没有事件”；
    // 初始空数组只是尚未查询，不能伪装成空查询结果。
    deliveries: deliveries.length > 0 || deliveryQuery ? deliveries : undefined,
    connection: connection ?? undefined,
    deliveryQuery: deliveryQuery ?? undefined,
    toolErrors: state.toolErrors,
    capabilities: state.connectorCapabilities,
    conflicts: state.conflicts,
  });
}

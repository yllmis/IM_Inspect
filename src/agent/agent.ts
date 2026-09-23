import {
  generateText,
  Output,
  stepCountIs,
  tool,
  type LanguageModel,
} from "ai";

import {
  ConnectionStatusInputSchema,
  DeliveryEventsInputSchema,
  FindUserOrMessageInputSchema,
  MessageLookupInputSchema,
} from "../connectors/connector";
import { diagnose } from "../domain/diagnose";
import { DiagnosisResult, DiagnosisToolNameSchema } from "../domain/diagnosis";
import { createToolContext, ToolContext, ToolResponse } from "../tools/context";
import { ToolRegistry } from "../tools/registry";
import { buildDiagnosisInput } from "./diagnosis-input";
import {
  CandidateContext,
  CONTEXT_EXTRACTION_PROMPT,
  extractCandidateContext,
} from "./extract-context";
import { buildModelContext } from "./model-context";
import {
  detectPromptInjection,
  recordPromptInjectionTrace,
} from "./prompt-injection";
import { fallbackReply, GeneratedAgentReplySchema } from "./response";
import { recordConversationExchange } from "./conversation-memory";
import {
  assertModelRequestFits,
  ContextBudget,
  ContextBudgetExceededError,
  resolveContextBudget,
  RunTokenBudget,
  RunTokenUsage,
} from "./context-budget";
import {
  AgentSessionState,
  AgentSessionStateSchema,
  createAgentSessionState,
  TargetSwitchDecision,
} from "./session-state";
import {
  CandidateContextPatch,
  DiagnosticToolName,
  expireTargetSwitch,
  mergeCandidateContext,
  mergeDiagnosisResult,
  mergeToolResult,
  recordToolValidationError,
  resolveTargetSwitch,
  TargetSwitchResolutionError,
} from "./state-merge";
import {
  SessionStateIdentity,
  StateStore,
  StateStoreError,
} from "./state-store";
import { evaluateStopRules } from "./stop-rules";
import { SYSTEM_PROMPT } from "./system-prompt";
import { AgentRunTrace, RunTraceRecorder } from "./run-trace";
import { TraceStore } from "./trace-store";

const RESPONSE_PROMPT = `${SYSTEM_PROMPT}

当前阶段只负责生成客服回复：
- 只能解释输入中的 confirmedFacts 和 diagnosis。
- 不得改变 diagnosis.classification。
- 工具失败或超时时，明确说明本次查询失败，不得说成数据不存在。
- 回复简洁，并说明下一步需要客服补充什么或是否建议升级。
- classification 必须原样复制输入中 diagnosis.classification。`;

export interface AgentInput {
  sessionId: string;
  text: string;
  model: LanguageModel;
  toolContext: ToolContext;
  registry: ToolRegistry;
  stateStore: StateStore;
  /** 可选审计仓储；未配置时 Trace 仍会随响应返回。 */
  traceStore?: TraceStore;
  targetSwitchDecision?: TargetSwitchDecision;
  contextBudget?: Partial<ContextBudget>;
  maxSteps?: number;
  sessionTtlMs?: number;
  now?: () => Date;
}

export interface AgentToolCall {
  name: DiagnosticToolName;
  args: unknown;
  response: ToolResponse<unknown>;
  cached: boolean;
}

export interface AgentExecutionResult {
  sessionId: string;
  stateVersion: number;
  status: "completed" | "awaiting_information" | "stopped" | "failed";
  reply: string;
  diagnosis: DiagnosisResult;
  candidateContext: CandidateContext;
  toolCalls: AgentToolCall[];
  steps: number;
  stopReason?: string;
  modelText: string;
  tokenUsage: RunTokenUsage;
  trace: AgentRunTrace;
  pendingAction?: {
    type: "switch_diagnosis_target";
    decisionId: string;
    fromMessageId: string;
    toMessageId: string;
    expiresAt: string;
  };
}

export async function runAgent(
  input: AgentInput,
): Promise<AgentExecutionResult> {
  const now = input.now ?? (() => new Date());
  const traceRecorder = new RunTraceRecorder({
    runId: input.toolContext.runId,
    sessionId: input.sessionId,
    requestId: input.toolContext.requestId,
    startedAt: now(),
  });
  // 客服消息和其中粘贴的日志都是不可信数据；检测结果只用于审计，不能成为诊断证据。
  recordPromptInjectionTrace(
    input.toolContext,
    detectPromptInjection(input.text),
  );
  traceRecorder.syncToolTraces(input.toolContext.traces);
  try {
    return await runAgentLoop({
      ...input,
      now,
      traceRecorder,
    });
  } catch (error) {
    // 即使模型、预算或 StateStore 抛错，也保存失败 Run 的最小审计 Trace。
    traceRecorder.recordAgent(
      "diagnose",
      traceRecorder.mark(),
      "error",
      { classification: null },
      errorCodeForTrace(error),
    );
    const trace = traceRecorder.finish({
      status: "failed",
      stopReason: "execution_failed",
      finalClassification: null,
    });
    await saveFailureTraceBestEffort(input, trace);
    throw error;
  }
}

async function runAgentLoop(
  input: AgentInput & {
    now: () => Date;
    traceRecorder: RunTraceRecorder;
  },
): Promise<AgentExecutionResult> {
  const now = input.now;
  const traceRecorder = input.traceRecorder;
  const contextBudget = resolveContextBudget(input.contextBudget);
  const runTokenBudget = new RunTokenBudget(contextBudget.maxTotalTokens);
  const identity: SessionStateIdentity = {
    sessionId: input.sessionId,
    tenantId: input.toolContext.tenantId,
    actorId: input.toolContext.actorId,
  };
  let state = await loadOrCreateState(input, identity, now());
  state = AgentSessionStateSchema.parse({
    ...state,
    connectorCapabilities: input.registry.getConnectorCapabilities(),
    lastRunId: input.toolContext.runId,
  });
  const expectedVersion = state.version;
  const calls: AgentToolCall[] = [];
  let repeatedCall = false;
  let lastToolFailed = false;

  const expiredSwitch = expireTargetSwitch(state, now());
  if (expiredSwitch.changed) {
    state = expiredSwitch.state;
    const diagnosis = refreshDiagnosis(state, input);
    state = diagnosis.state;
    const reply = state.pendingQuestion!.question;
    state = recordConversationExchange(state, {
      userText: input.text,
      assistantText: reply,
      now: now(),
      budget: contextBudget,
    });
    const saved = await input.stateStore.save(state, expectedVersion);
    return executionResult({
      state: saved,
      diagnosis: diagnosis.result,
      reply,
      modelText: "",
      calls,
      steps: 0,
      stopReason: "ask_for_information",
      tokenUsage: runTokenBudget.snapshot(),
      traceRecorder,
      traceStore: input.traceStore,
    });
  }

  if (state.pendingTargetSwitch && !input.targetSwitchDecision) {
    const diagnosis =
      state.diagnosisResult ?? refreshDiagnosis(state, input).result;
    return executionResult({
      state,
      diagnosis,
      reply: state.pendingQuestion!.question,
      modelText: "",
      calls,
      steps: 0,
      stopReason: "ask_for_information",
      tokenUsage: runTokenBudget.snapshot(),
      traceRecorder,
      traceStore: input.traceStore,
    });
  }

  if (input.targetSwitchDecision) {
    state = resolveTargetSwitch(state, input.targetSwitchDecision, now()).state;
  } else {
    state = withStatus(state, "extracting_context");
    runTokenBudget.assertCanReserve(contextBudget.maxOutputTokens);
    const extractionContext = buildModelContext(state, "extract_context", {
      currentUserText: input.text,
      budget: contextBudget,
    });
    const extractionStarted = traceRecorder.mark();
    const extracted = await extractCandidateContext({
      model: input.model,
      modelContext: extractionContext,
      budget: contextBudget,
      maxOutputTokens: contextBudget.maxOutputTokens,
      onUsage: (usage) =>
        runTokenBudget.record(
          usage,
          CONTEXT_EXTRACTION_PROMPT.length +
            JSON.stringify(extractionContext).length,
        ),
    });
    const candidatePatch = nonNullCandidatePatch(extracted);
    traceRecorder.recordAgent("extract_context", extractionStarted, "success", {
      extractedFields: Object.keys(candidatePatch ?? {}),
    });
    if (candidatePatch) {
      state = mergeCandidateContext(state, candidatePatch, now()).state;
    }
  }

  let diagnosis = refreshDiagnosis(state, input);
  state = diagnosis.state;

  if (state.pendingQuestion) {
    state = withStatus(state, "awaiting_information");
    const reply = state.pendingQuestion!.question;
    state = recordConversationExchange(state, {
      userText: input.text,
      assistantText: reply,
      now: now(),
      budget: contextBudget,
    });
    const saved = await input.stateStore.save(state, expectedVersion);
    return executionResult({
      state: saved,
      diagnosis: diagnosis.result,
      reply,
      modelText: "",
      calls,
      steps: 0,
      stopReason: "ask_for_information",
      tokenUsage: runTokenBudget.snapshot(),
      traceRecorder,
      traceStore: input.traceStore,
    });
  }

  state = withStatus(state, "selecting_tool");

  const execute = async (name: DiagnosticToolName, args: unknown) => {
    state = withStatus(state, "calling_tool");
    const response = await input.registry.execute(
      name,
      args,
      input.toolContext,
    );
    traceRecorder.syncToolTraces(input.toolContext.traces);
    // ToolRegistry 统一拥有 Run 内去重；Agent 只根据 meta 识别无进展循环并停止。
    const cached = response.meta.cached;
    repeatedCall = repeatedCall || cached;
    calls.push({ name, args, response, cached });
    state = mergeToolResult(state, {
      toolName: name,
      args,
      response,
      calledAt: now(),
      cached,
    }).state;
    state = withStatus(state, "evaluating_evidence");
    diagnosis = refreshDiagnosis(state, input);
    state = diagnosis.state;
    lastToolFailed = !response.ok;
    return modelToolResult(state, response, contextBudget);
  };

  const requestedMaxSteps = input.maxSteps ?? contextBudget.maxAgentSteps;
  if (!Number.isSafeInteger(requestedMaxSteps) || requestedMaxSteps <= 0) {
    throw new Error("maxSteps must be a positive safe integer");
  }
  const maximumSteps = Math.min(requestedMaxSteps, contextBudget.maxAgentSteps);
  if (runTokenBudget.stopIfCannotReserve(contextBudget.maxOutputTokens)) {
    const reply = `${fallbackReply(diagnosis.result)} 本次诊断已达到模型 Token 预算，未继续调用模型。`;
    state = AgentSessionStateSchema.parse({
      ...withStatus(state, "stopped"),
      pendingQuestion: null,
    });
    state = recordConversationExchange(state, {
      userText: input.text,
      assistantText: reply,
      now: now(),
      budget: contextBudget,
    });
    const saved = await input.stateStore.save(state, expectedVersion);
    return executionResult({
      state: saved,
      diagnosis: diagnosis.result,
      reply,
      modelText: "",
      calls,
      steps: 0,
      stopReason: "max_tokens",
      tokenUsage: runTokenBudget.snapshot(),
      traceRecorder,
      traceStore: input.traceStore,
    });
  }
  const selectionContext = buildModelContext(state, "select_tool", {
    budget: contextBudget,
  });
  const selectionPrompt = JSON.stringify(selectionContext);
  assertModelRequestFits({
    system: SYSTEM_PROMPT,
    prompt: selectionPrompt,
    budget: contextBudget,
    includesTools: true,
  });
  const selectionStarted = traceRecorder.mark();
  const selection = await generateText({
    model: input.model,
    system: SYSTEM_PROMPT,
    prompt: selectionPrompt,
    tools: diagnosticTools(execute),
    stopWhen: [
      stepCountIs(maximumSteps),
      () => repeatedCall,
      () => lastToolFailed,
      () => runTokenBudget.stopIfCannotReserve(contextBudget.maxOutputTokens),
      () =>
        state.diagnosisResult !== null &&
        state.diagnosisResult.classification !== "insufficient_data",
    ],
    // AI SDK 的 Schema 拒绝可能发生在 ToolRegistry 之前；把它投影为受控的
    // invalid_argument Trace，避免“没有工具结果”被误解成业务事实。
    repairToolCall: async ({ toolCall }) => {
      const rawArgs = decodeToolCallInput(toolCall.input);
      const response = await input.registry.execute(
        toolCall.toolName,
        rawArgs,
        input.toolContext,
      );
      traceRecorder.syncToolTraces(input.toolContext.traces);
      if (DiagnosisToolNameSchema.safeParse(toolCall.toolName).success) {
        const toolName = DiagnosisToolNameSchema.parse(toolCall.toolName);
        calls.push({
          name: toolName,
          args: rawArgs,
          response,
          cached: false,
        });
        state = recordToolValidationError(state, {
          toolName,
          rawArgs,
          response,
          calledAt: now(),
        }).state;
        state = withStatus(state, "evaluating_evidence");
        diagnosis = refreshDiagnosis(state, input);
      }
      lastToolFailed = !response.ok;
      // 不自动替换模型参数；让当前 Run 进入受控失败/追问路径。
      return null;
    },
    maxOutputTokens: contextBudget.maxOutputTokens,
    onStepFinish: ({ usage }) =>
      runTokenBudget.record(
        usage,
        SYSTEM_PROMPT.length + selectionPrompt.length,
      ),
    maxRetries: 0,
  });
  traceRecorder.recordAgent("select_tool", selectionStarted, "success", {
    stepCount: selection.steps.length,
  });

  diagnosis = refreshDiagnosis(state, input);
  state = diagnosis.state;
  const stop = evaluateStopRules({
    steps: selection.steps.length,
    maxSteps: maximumSteps,
    callsUsed: input.toolContext.callsUsed,
    maxCalls: input.toolContext.maxCalls,
    deadline: input.toolContext.deadline,
    now: now().getTime(),
    diagnosis: diagnosis.result,
    repeatedCall,
    toolError: lastToolFailed,
    tokenBudgetExceeded: runTokenBudget.isExceeded(),
  });

  const responseContext = buildModelContext(state, "generate_response", {
    budget: contextBudget,
  });
  let modelText = "";
  const responseStarted = traceRecorder.mark();
  let responseOutcome: "success" | "error" = "success";
  let responseErrorCode: string | undefined;
  try {
    runTokenBudget.assertCanReserve(contextBudget.maxOutputTokens);
    const responsePrompt = JSON.stringify(responseContext);
    assertModelRequestFits({
      system: RESPONSE_PROMPT,
      prompt: responsePrompt,
      budget: contextBudget,
    });
    const generated = await generateText({
      model: input.model,
      system: RESPONSE_PROMPT,
      prompt: responsePrompt,
      output: Output.object({ schema: GeneratedAgentReplySchema }),
      maxOutputTokens: contextBudget.maxOutputTokens,
      maxRetries: 0,
    });
    runTokenBudget.record(
      generated.usage,
      RESPONSE_PROMPT.length + responsePrompt.length,
    );
    const candidate = GeneratedAgentReplySchema.parse(generated.output);
    if (candidate.classification === diagnosis.result.classification) {
      modelText = candidate.reply;
    }
  } catch (error) {
    if (
      error instanceof ContextBudgetExceededError &&
      error.code !== "max_total_tokens"
    ) {
      throw error;
    }
    responseOutcome = "error";
    responseErrorCode =
      error instanceof ContextBudgetExceededError
        ? error.code
        : "response_generation_failed";
    // 回复生成失败不改变已经确认的事实和诊断，使用确定性模板兜底。
  }
  traceRecorder.recordAgent(
    "generate_response",
    responseStarted,
    responseOutcome,
    { usedFallback: modelText.length === 0 },
    responseErrorCode,
  );

  const reply = modelText || fallbackReply(diagnosis.result);
  const finalStopReason = runTokenBudget.isExceeded()
    ? "max_tokens"
    : stop.reason;
  const finalStatus = executionStatus(diagnosis.result, finalStopReason);
  state = withStatus(state, finalStatus);
  if (finalStatus === "awaiting_information") {
    state = withPendingQuestion(state, diagnosis.result, now());
  } else {
    state = AgentSessionStateSchema.parse({ ...state, pendingQuestion: null });
  }
  state = recordConversationExchange(state, {
    userText: input.text,
    assistantText: reply,
    now: now(),
    budget: contextBudget,
  });
  const saved = await input.stateStore.save(state, expectedVersion);

  return executionResult({
    state: saved,
    diagnosis: diagnosis.result,
    reply,
    modelText,
    calls,
    steps: selection.steps.length,
    stopReason: finalStopReason,
    tokenUsage: runTokenBudget.snapshot(),
    traceRecorder,
    traceStore: input.traceStore,
  });
}

function diagnosticTools(
  execute: (name: DiagnosticToolName, args: unknown) => Promise<unknown>,
) {
  return {
    find_user_or_message: tool({
      description: "根据稳定 ID 或有限线索定位用户或消息。",
      inputSchema: FindUserOrMessageInputSchema,
      execute: (args) => execute("find_user_or_message", args),
    }),
    get_message_status: tool({
      description: "查询指定消息的持久化和当前状态。",
      inputSchema: MessageLookupInputSchema,
      execute: (args) => execute("get_message_status", args),
    }),
    get_delivery_events: tool({
      description: "查询指定消息的投递事件。",
      inputSchema: DeliveryEventsInputSchema,
      execute: (args) => execute("get_delivery_events", args),
    }),
    get_connection_status: tool({
      description: "查询接收者在指定时刻的连接事实。",
      inputSchema: ConnectionStatusInputSchema,
      execute: (args) => execute("get_connection_status", args),
    }),
  };
}

async function loadOrCreateState(
  input: AgentInput,
  identity: SessionStateIdentity,
  now: Date,
): Promise<AgentSessionState> {
  const loaded = await input.stateStore.load(identity);
  if (loaded) return loaded;
  const initial = createAgentSessionState({
    ...identity,
    issueSummary: input.text.trim().slice(0, 1_000),
    now,
    ttlMs: input.sessionTtlMs,
  });
  try {
    return await input.stateStore.create(initial);
  } catch (error) {
    // 两个首轮请求并发时只允许一个 create；另一个读取胜出的版本，
    // 最终 save 仍会通过 expectedVersion 检测并发写冲突。
    if (error instanceof StateStoreError && error.code === "already_exists") {
      const concurrent = await input.stateStore.load(identity);
      if (concurrent) return concurrent;
    }
    throw error;
  }
}

function refreshDiagnosis(
  state: AgentSessionState,
  input: AgentInput,
): { state: AgentSessionState; result: DiagnosisResult } {
  const result = diagnose(
    buildDiagnosisInput(state, {
      requestId: input.toolContext.requestId,
      currentUserText: input.text,
    }),
  );
  return { state: mergeDiagnosisResult(state, result).state, result };
}

function nonNullCandidatePatch(
  candidate: CandidateContext,
): CandidateContextPatch | null {
  const entries = Object.entries(candidate).filter(
    ([, value]) => value !== null,
  );
  if (entries.length === 0) return null;
  return Object.fromEntries(entries) as CandidateContextPatch;
}

function modelToolResult(
  state: AgentSessionState,
  response: ToolResponse<unknown>,
  budget: ContextBudget,
): unknown {
  if (!response.ok) {
    return {
      ok: false,
      error: {
        code: response.error.code,
        retryable: response.error.retryable,
      },
    };
  }
  // 不把原始工具结果和证据 metadata 无限追加给模型，只返回受限工作摘要。
  const result = {
    ok: true,
    context: buildModelContext(state, "select_tool", { budget }),
  };
  if (JSON.stringify(result).length > budget.maxToolResultCharacters) {
    throw new ContextBudgetExceededError(
      "tool_result_too_large",
      "tool result summary exceeds the configured model budget",
    );
  }
  return result;
}

function decodeToolCallInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function executionStatus(
  diagnosis: DiagnosisResult,
  stopReason?: string,
): AgentExecutionResult["status"] {
  if (
    stopReason &&
    !["diagnosed", "ask_for_information"].includes(stopReason)
  ) {
    return "stopped";
  }
  if (diagnosis.recommendedAction === "ask_for_more_info") {
    return "awaiting_information";
  }
  return "completed";
}

function withStatus(
  state: AgentSessionState,
  status: AgentSessionState["status"],
): AgentSessionState {
  return AgentSessionStateSchema.parse({ ...state, status });
}

function withPendingQuestion(
  state: AgentSessionState,
  diagnosis: DiagnosisResult,
  now: Date,
): AgentSessionState {
  const field = diagnosis.missingInformation[0] ?? "additionalEvidence";
  const question =
    field === "messageId"
      ? "请提供需要排查的 messageId。"
      : `还需要补充或查询：${field}。`;
  return AgentSessionStateSchema.parse({
    ...state,
    pendingQuestion: { field, question, askedAt: now.toISOString() },
  });
}

async function executionResult(input: {
  state: AgentSessionState;
  diagnosis: DiagnosisResult;
  reply: string;
  modelText: string;
  calls: AgentToolCall[];
  steps: number;
  stopReason?: string;
  tokenUsage: RunTokenUsage;
  traceRecorder: RunTraceRecorder;
  traceStore?: TraceStore;
}): Promise<AgentExecutionResult> {
  const diagnosisStarted = input.traceRecorder.mark();
  input.traceRecorder.recordAgent("diagnose", diagnosisStarted, "success", {
    classification: input.diagnosis.classification,
    unsupportedCapabilities: input.diagnosis.unsupportedCapabilities,
  });
  const status =
    input.state.status === "awaiting_information"
      ? "awaiting_information"
      : input.state.status === "stopped"
        ? "stopped"
        : input.state.status === "failed"
          ? "failed"
          : "completed";
  const trace = input.traceRecorder.finish({
    status,
    stopReason: input.stopReason,
    finalClassification: input.diagnosis.classification,
    humanConfirmation: {
      triggered: input.state.confirmationState.status !== "not_required",
      status: input.state.confirmationState.status,
    },
  });
  // Trace 保存是独立 Repository 边界；回放只读取它，不会再次执行工具。
  if (input.traceStore) {
    await input.traceStore.save(
      {
        tenantId: input.state.tenantId,
        actorId: input.state.actorId,
      },
      trace,
    );
  }
  return {
    sessionId: input.state.sessionId,
    stateVersion: input.state.version,
    status:
      input.state.status === "awaiting_information"
        ? "awaiting_information"
        : input.state.status === "stopped"
          ? "stopped"
          : input.state.status === "failed"
            ? "failed"
            : "completed",
    reply: input.reply,
    diagnosis: input.diagnosis,
    candidateContext: input.state.candidateContext,
    toolCalls: input.calls,
    steps: input.steps,
    stopReason: input.stopReason,
    modelText: input.modelText,
    tokenUsage: input.tokenUsage,
    trace,
    pendingAction: input.state.pendingTargetSwitch
      ? {
          type: "switch_diagnosis_target",
          decisionId: input.state.pendingTargetSwitch.decisionId,
          fromMessageId: input.state.pendingTargetSwitch.fromMessageId,
          toMessageId: input.state.pendingTargetSwitch.toMessageId,
          expiresAt: input.state.pendingTargetSwitch.expiresAt,
        }
      : undefined,
  };
}

export { createToolContext };

/**
 * 失败 Trace 只能记录有限错误码，不能把异常消息、堆栈或凭证写入审计记录。
 * 这里保留错误类别，便于按 runId 回放失败阶段，同时避免泄露底层实现细节。
 */
function errorCodeForTrace(error: unknown): string {
  if (error instanceof ContextBudgetExceededError) return error.code;
  if (error instanceof StateStoreError) return `state_${error.code}`;
  if (error instanceof TargetSwitchResolutionError) {
    return `target_switch_${error.code}`;
  }
  return "agent_execution_failed";
}

/**
 * Trace 是旁路审计能力：存储异常不能覆盖真正导致本次 Run 失败的原始异常。
 * MVP 采用尽力保存；生产环境应把 TraceStore 替换为可靠的持久化实现和告警机制。
 */
async function saveFailureTraceBestEffort(
  input: AgentInput,
  trace: AgentRunTrace,
): Promise<void> {
  if (!input.traceStore) return;
  try {
    await input.traceStore.save(
      {
        tenantId: input.toolContext.tenantId,
        actorId: input.toolContext.actorId,
      },
      trace,
    );
  } catch {
    // 不抛出 TraceStore 错误，以免调用方看不到真正的 Agent 执行异常。
  }
}

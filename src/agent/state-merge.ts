import { createHash } from "node:crypto";
import { z } from "zod";

import {
  ConnectionStatusInputSchema,
  DeliveryEventsInputSchema,
  FindUserOrMessageInputSchema,
  FindUserOrMessageResultSchema,
  MessageLookupInputSchema,
} from "../connectors/connector";
import {
  DiagnosisResult,
  DiagnosisResultSchema,
  DiagnosisToolError,
} from "../domain/diagnosis";
import { diagnose } from "../domain/diagnose";
import { ToolError, ToolErrorSchema } from "../domain/errors";
import { Evidence, EvidenceConflict } from "../domain/evidence";
import { ToolResponse } from "../tools/context";
import { GetConnectionStatusResultSchema } from "../tools/get-connection-status";
import { GetDeliveryEventsResultSchema } from "../tools/get-delivery-events";
import { GetMessageStatusResultSchema } from "../tools/get-message-status";
import {
  AgentSessionState,
  AgentSessionStateSchema,
  CalledToolSummary,
  PreviousIssueReference,
  SessionCandidateContextSchema,
  SessionToolName,
  TargetSwitchDecision,
  TargetSwitchDecisionSchema,
} from "./session-state";
import { buildDiagnosisInput } from "./diagnosis-input";

export const CandidateContextPatchSchema =
  SessionCandidateContextSchema.partial()
    .strict()
    .refine((value) => Object.keys(value).length > 0, {
      message: "candidate context patch must change at least one field",
    });
export type CandidateContextPatch = z.infer<typeof CandidateContextPatchSchema>;

export interface StateMutationResult {
  state: AgentSessionState;
  changed: boolean;
}

export type DiagnosticToolName = Exclude<
  SessionToolName,
  "create_escalation_draft"
>;

const DiagnosticToolNameSchema = z.enum([
  "find_user_or_message",
  "get_message_status",
  "get_delivery_events",
  "get_connection_status",
]);

const ToolResponseMetaSchema = z
  .object({
    requestId: z.string().min(1).max(128),
    runId: z.string().min(1).max(128),
    durationMs: z.number().int().nonnegative(),
    attempts: z.number().int().nonnegative(),
    retryDelaysMs: z.array(z.number().int().nonnegative()).max(10).default([]),
    cached: z.boolean().default(false),
    truncated: z.boolean(),
  })
  .strict();

const ToolResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      data: z.unknown(),
      meta: ToolResponseMetaSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: ToolErrorSchema,
      meta: ToolResponseMetaSchema,
    })
    .strict(),
]);

export interface MergeToolResultInput {
  toolName: DiagnosticToolName;
  args: unknown;
  response: ToolResponse<unknown>;
  calledAt?: Date;
  cached?: boolean;
}

/**
 * SDK 在调用 ToolRegistry 之前拒绝非法工具参数时，不能走普通成功结果合并。
 * 这个投影只保存“调用被拒绝”和安全错误，不把未经 Schema 校验的参数写入事实。
 */
export interface RecordToolValidationErrorInput {
  toolName: DiagnosticToolName;
  rawArgs: unknown;
  response: ToolResponse<unknown>;
  calledAt?: Date;
}

export class StateMergeError extends Error {
  constructor(
    readonly code: "invalid_tool_result" | "state_capacity_exceeded",
    message: string,
  ) {
    super(message);
    this.name = "StateMergeError";
  }
}

export class TargetSwitchResolutionError extends Error {
  constructor(
    readonly code:
      | "no_pending_switch"
      | "decision_mismatch"
      | "expired_switch"
      | "version_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "TargetSwitchResolutionError";
  }
}

export function mergeCandidateContext(
  rawState: AgentSessionState,
  rawPatch: CandidateContextPatch,
  now: Date = new Date(),
): StateMutationResult {
  const state = AgentSessionStateSchema.parse(rawState);
  const patch = CandidateContextPatchSchema.parse(rawPatch);
  const next: AgentSessionState = {
    ...state,
    candidateContext: {
      ...state.candidateContext,
      ...patch,
    },
  };

  if (
    patch.messageId &&
    state.messageId &&
    patch.messageId !== state.messageId
  ) {
    const requestedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
    next.status = "awaiting_information";
    next.pendingQuestion = {
      field: "targetSwitch",
      question: `当前正在排查 ${state.messageId}，请确认是否切换到 ${patch.messageId}。`,
      askedAt: requestedAt,
    };
    next.pendingTargetSwitch = {
      decisionId: targetSwitchDecisionId(state, patch.messageId, requestedAt),
      fromIssueId: state.currentIssue.issueId,
      fromMessageId: state.messageId,
      toMessageId: patch.messageId,
      requestedAt,
      expiresAt,
    };
  } else if (
    state.pendingQuestion &&
    !state.pendingTargetSwitch &&
    Object.hasOwn(patch, state.pendingQuestion.field) &&
    patch[state.pendingQuestion.field as keyof CandidateContextPatch]
  ) {
    next.pendingQuestion = null;
  }

  const parsed = AgentSessionStateSchema.parse(next);
  return {
    state: parsed,
    changed:
      stableStringify(parsed.candidateContext) !==
        stableStringify(state.candidateContext) ||
      stableStringify(parsed.pendingQuestion) !==
        stableStringify(state.pendingQuestion) ||
      stableStringify(parsed.pendingTargetSwitch) !==
        stableStringify(state.pendingTargetSwitch) ||
      parsed.status !== state.status,
  };
}

export function resolveTargetSwitch(
  rawState: AgentSessionState,
  rawDecision: TargetSwitchDecision,
  now: Date = new Date(),
): StateMutationResult {
  const state = AgentSessionStateSchema.parse(rawState);
  const decision = TargetSwitchDecisionSchema.parse(rawDecision);
  const pending = state.pendingTargetSwitch;
  if (!pending) {
    throw new TargetSwitchResolutionError(
      "no_pending_switch",
      "there is no pending target switch",
    );
  }
  if (state.version !== decision.expectedVersion) {
    throw new TargetSwitchResolutionError(
      "version_mismatch",
      "target switch decision is based on a stale session version",
    );
  }
  if (pending.decisionId !== decision.decisionId) {
    throw new TargetSwitchResolutionError(
      "decision_mismatch",
      "target switch decision does not match the pending request",
    );
  }
  if (Date.parse(pending.expiresAt) <= now.getTime()) {
    throw new TargetSwitchResolutionError(
      "expired_switch",
      "target switch decision has expired",
    );
  }
  if (
    state.messageId !== pending.fromMessageId ||
    state.currentIssue.issueId !== pending.fromIssueId
  ) {
    throw new TargetSwitchResolutionError(
      "decision_mismatch",
      "active diagnosis target changed after confirmation was requested",
    );
  }

  if (decision.decision === "reject") {
    const rejected = AgentSessionStateSchema.parse({
      ...state,
      candidateContext: {
        ...state.candidateContext,
        messageId: state.messageId,
      },
      pendingQuestion: null,
      pendingTargetSwitch: null,
      status: "selecting_tool",
    });
    return { state: rejected, changed: true };
  }

  const archivedIssue: PreviousIssueReference = {
    issueId:
      state.currentIssue.issueId ??
      issueIdFor(state.sessionId, state.messageId, state.version, "legacy"),
    messageId: state.messageId,
    summary: state.currentIssue.summary,
    classification: state.diagnosisResult?.classification ?? null,
    closedAt: now.toISOString(),
  };
  const previousIssues = takeRecent(
    upsertPreviousIssue(state.previousIssues, archivedIssue),
    10,
  );
  const reopened = [...previousIssues]
    .reverse()
    .find(
      (issue) =>
        issue.messageId === pending.toMessageId &&
        issue.issueId !== archivedIssue.issueId,
    );
  const switched = AgentSessionStateSchema.parse({
    ...state,
    currentIssue: {
      issueId: issueIdFor(
        state.sessionId,
        pending.toMessageId,
        state.version,
        now.toISOString(),
      ),
      reopenedFromIssueId: reopened?.issueId ?? null,
      problemType: null,
      summary: `检查消息 ${pending.toMessageId}`,
    },
    previousIssues,
    recentConversation: [],
    historySummary: null,
    candidateContext: { messageId: pending.toMessageId },
    userId: null,
    conversationId: null,
    messageId: null,
    timeRange: null,
    matchResolution: null,
    confirmedFacts: {},
    evidence: [],
    excludedHypotheses: [],
    missingInformation: [],
    unsupportedCapabilities: [],
    conflicts: [],
    calledTools: [],
    toolErrors: [],
    pendingQuestion: null,
    pendingTargetSwitch: null,
    confirmationState: { status: "not_required" },
    diagnosisResultId: null,
    diagnosisResult: null,
    status: "selecting_tool",
  });
  return { state: switched, changed: true };
}

export function expireTargetSwitch(
  rawState: AgentSessionState,
  now: Date = new Date(),
): StateMutationResult {
  const state = AgentSessionStateSchema.parse(rawState);
  if (
    !state.pendingTargetSwitch ||
    Date.parse(state.pendingTargetSwitch.expiresAt) > now.getTime()
  ) {
    return { state, changed: false };
  }
  const expired = AgentSessionStateSchema.parse({
    ...state,
    candidateContext: {
      ...state.candidateContext,
      messageId: state.messageId,
    },
    pendingTargetSwitch: null,
    pendingQuestion: {
      field: "messageId",
      question: "诊断目标切换确认已过期，请重新提供需要排查的 messageId。",
      askedAt: now.toISOString(),
    },
    status: "awaiting_information",
  });
  return { state: expired, changed: true };
}

export function mergeToolResult(
  rawState: AgentSessionState,
  input: MergeToolResultInput,
): StateMutationResult {
  const state = AgentSessionStateSchema.parse(rawState);
  const toolName = DiagnosticToolNameSchema.parse(input.toolName);
  const calledAt = (input.calledAt ?? new Date()).toISOString();
  const args = parseToolArgs(toolName, input.args);
  const inputHash = hashToolInput(toolName, args);
  const response = parseToolResponse(input.response);
  const calledTool: CalledToolSummary = {
    toolName,
    inputHash,
    outcome: input.cached ? "cached" : response.ok ? "success" : "error",
    errorCode: response.ok ? null : response.error.code,
    calledAt,
  };
  let next: AgentSessionState = {
    ...state,
    calledTools: takeRecent([...state.calledTools, calledTool], 20),
  };

  if (!response.ok) {
    const error = sanitizeToolError(response.error);
    next = {
      ...next,
      toolErrors: takeRecent(
        [...state.toolErrors, { tool: toolName, error }],
        20,
      ),
      unsupportedCapabilities:
        error.code === "unsupported_capability"
          ? addUnique(
              state.unsupportedCapabilities,
              capabilityFromError(toolName, error),
              20,
            )
          : state.unsupportedCapabilities,
      connectorCapabilities:
        error.code === "unsupported_capability"
          ? {
              ...state.connectorCapabilities,
              [capabilityFromError(toolName, error)]: "unsupported",
            }
          : state.connectorCapabilities,
    };
    return { state: AgentSessionStateSchema.parse(next), changed: true };
  }

  // 成功重试后，旧的同工具错误不再作为当前阻断错误；调用历史仍在 calledTools/Trace。
  next.toolErrors = state.toolErrors.filter((item) => item.tool !== toolName);

  switch (toolName) {
    case "find_user_or_message":
      next = mergeFindResult(next, response.data);
      break;
    case "get_message_status":
      next = mergeMessageResult(next, args, response.data);
      break;
    case "get_delivery_events":
      next = mergeDeliveryResult(
        next,
        args,
        response.data,
        calledAt,
        inputHash,
      );
      break;
    case "get_connection_status":
      next = mergeConnectionResult(next, args, response.data);
      break;
  }

  return { state: parseMergedState(next), changed: true };
}

export function recordToolValidationError(
  rawState: AgentSessionState,
  input: RecordToolValidationErrorInput,
): StateMutationResult {
  const state = AgentSessionStateSchema.parse(rawState);
  const response = ToolResponseSchema.parse(input.response);
  if (response.ok) {
    throw new StateMergeError(
      "invalid_tool_result",
      "tool validation projection requires a failed response",
    );
  }
  const calledAt = (input.calledAt ?? new Date()).toISOString();
  const calledTool: CalledToolSummary = {
    toolName: input.toolName,
    inputHash: hashToolInput(input.toolName, input.rawArgs),
    outcome: "error",
    errorCode: response.error.code,
    calledAt,
  };
  const next = AgentSessionStateSchema.parse({
    ...state,
    calledTools: takeRecent([...state.calledTools, calledTool], 20),
    toolErrors: takeRecent(
      [
        ...state.toolErrors,
        {
          tool: input.toolName,
          error: sanitizeToolError(response.error),
        },
      ],
      20,
    ),
  });
  return { state: next, changed: true };
}

export function mergeDiagnosisResult(
  rawState: AgentSessionState,
  rawResult: DiagnosisResult,
): StateMutationResult {
  const state = AgentSessionStateSchema.parse(rawState);
  const diagnosis = DiagnosisResultSchema.parse(rawResult);
  const expectedDiagnosis = diagnose(buildDiagnosisInput(state));
  if (stableStringify(diagnosis) !== stableStringify(expectedDiagnosis)) {
    throw new StateMergeError(
      "invalid_tool_result",
      "diagnosis result does not match deterministic diagnosis",
    );
  }
  if (
    state.messageId &&
    diagnosis.message &&
    diagnosis.message.messageId !== state.messageId
  ) {
    throw new StateMergeError(
      "invalid_tool_result",
      "diagnosis messageId does not match the active session",
    );
  }

  const status =
    diagnosis.recommendedAction === "ask_for_more_info"
      ? "awaiting_information"
      : "generating_response";
  const next = AgentSessionStateSchema.parse({
    ...state,
    diagnosisResultId: diagnosisResultId(state, diagnosis),
    diagnosisResult: diagnosis,
    missingInformation: unique(diagnosis.missingInformation).slice(0, 20),
    unsupportedCapabilities: unique([
      ...state.unsupportedCapabilities,
      ...diagnosis.unsupportedCapabilities,
    ]).slice(0, 20),
    conflicts: diagnosis.conflicts ?? [],
    status,
  });
  return {
    state: next,
    changed:
      stableStringify(next.diagnosisResult) !==
        stableStringify(state.diagnosisResult) || next.status !== state.status,
  };
}

function diagnosisResultId(
  state: AgentSessionState,
  diagnosis: DiagnosisResult,
): string {
  const snapshot = stableStringify({
    tenantId: state.tenantId,
    actorId: state.actorId,
    sessionId: state.sessionId,
    issueId: state.currentIssue.issueId,
    diagnosis,
  });
  return `diag_${createHash("sha256").update(snapshot).digest("hex").slice(0, 32)}`;
}

export function hashToolInput(
  toolName: DiagnosticToolName,
  normalizedArgs: unknown,
): string {
  return createHash("sha256")
    .update(`${toolName}:${stableStringify(normalizedArgs)}`)
    .digest("hex");
}

function mergeFindResult(
  state: AgentSessionState,
  rawData: unknown,
): AgentSessionState {
  const result = FindUserOrMessageResultSchema.parse(rawData);
  if (result.resolutionStatus === "unique" && result.matches.length !== 1) {
    throw new StateMergeError(
      "invalid_tool_result",
      "unique lookup result must contain exactly one match",
    );
  }
  if (result.resolutionStatus === "none" && result.matches.length !== 0) {
    throw new StateMergeError(
      "invalid_tool_result",
      "none lookup result cannot contain matches",
    );
  }

  const next = { ...state, matchResolution: result.resolutionStatus };
  if (result.resolutionStatus !== "unique") return next;
  const match = result.matches[0]!;
  requireEvidence(match.evidence, "unique lookup result");
  if (
    state.messageId &&
    match.messageId &&
    state.messageId !== match.messageId
  ) {
    return recordEntityConflict(
      next,
      "find_user_or_message",
      "messageId",
      match.evidence,
      state.messageId,
      match.messageId,
    );
  }
  return {
    ...next,
    userId: match.userId ?? state.userId,
    conversationId: match.conversationId ?? state.conversationId,
    messageId: match.messageId ?? state.messageId,
    evidence: mergeEvidence(state.evidence, match.evidence),
  };
}

function mergeMessageResult(
  state: AgentSessionState,
  rawArgs: unknown,
  rawData: unknown,
): AgentSessionState {
  const args = MessageLookupInputSchema.parse(rawArgs);
  const result = GetMessageStatusResultSchema.parse(rawData);
  const message = result.message;
  requireEvidence(message.evidence, "message fact");
  if (
    message.messageId !== args.messageId ||
    (state.messageId && state.messageId !== message.messageId)
  ) {
    return recordEntityConflict(
      state,
      "get_message_status",
      "messageId",
      message.evidence,
      state.messageId ?? args.messageId,
      message.messageId,
    );
  }
  return {
    ...state,
    messageId: message.messageId,
    conversationId: message.conversationId ?? state.conversationId,
    matchResolution: "unique",
    confirmedFacts: { ...state.confirmedFacts, message },
    evidence: mergeEvidence(state.evidence, message.evidence),
    unsupportedCapabilities: addManyUnique(
      state.unsupportedCapabilities,
      result.unsupportedCapabilities,
      20,
    ),
  };
}

function mergeDeliveryResult(
  state: AgentSessionState,
  rawArgs: unknown,
  rawData: unknown,
  calledAt: string,
  inputHash: string,
): AgentSessionState {
  const args = DeliveryEventsInputSchema.parse(rawArgs);
  const result = GetDeliveryEventsResultSchema.parse(rawData);
  for (const event of result.events) {
    requireEvidence(event.evidence, "delivery fact");
  }
  const mismatched = result.events.filter(
    (event) => event.messageId !== args.messageId,
  );
  if (
    (state.messageId && state.messageId !== args.messageId) ||
    mismatched.length > 0
  ) {
    return recordEntityConflict(
      state,
      "get_delivery_events",
      "delivery.messageId",
      mismatched.flatMap((event) => event.evidence),
      state.messageId ?? args.messageId,
      mismatched[0]?.messageId ?? args.messageId,
    );
  }

  const queryEvidence: Evidence = {
    id: `delivery-query:${inputHash}`,
    source: result.query.source,
    kind: "delivery",
    observedAt: calledAt,
    field: "query_complete",
    value: result.query.complete,
    metadata: { sourceReference: result.query.sourceReference },
  };
  const deliveries = mergeDeliveries(
    state.confirmedFacts.deliveries,
    result.events,
  );
  return {
    ...state,
    confirmedFacts: {
      ...state.confirmedFacts,
      deliveries,
      deliveryQuery: {
        complete: result.query.complete,
        truncated: result.truncated,
        returnedCount: result.query.returnedCount,
        effectiveTimeRange: result.query.effectiveTimeRange,
        source: queryEvidence.source,
        observedAt: calledAt,
        evidence: queryEvidence,
      },
    },
    evidence: mergeEvidence(state.evidence, [
      ...result.events.flatMap((event) => event.evidence),
      queryEvidence,
    ]),
    unsupportedCapabilities: addManyUnique(
      state.unsupportedCapabilities,
      result.unsupportedCapabilities,
      20,
    ),
  };
}

function mergeConnectionResult(
  state: AgentSessionState,
  rawArgs: unknown,
  rawData: unknown,
): AgentSessionState {
  const args = ConnectionStatusInputSchema.parse(rawArgs);
  const result = GetConnectionStatusResultSchema.parse(rawData);
  requireEvidence(result.connection.evidence, "connection fact");
  const expectedReceiver = state.confirmedFacts.message?.receiverId;
  if (
    result.connection.userId !== args.userId ||
    (expectedReceiver && expectedReceiver !== result.connection.userId)
  ) {
    return recordEntityConflict(
      state,
      "get_connection_status",
      "connection.userId",
      result.connection.evidence,
      expectedReceiver ?? args.userId,
      result.connection.userId,
    );
  }
  return {
    ...state,
    confirmedFacts: {
      ...state.confirmedFacts,
      connection: result.connection,
    },
    evidence: mergeEvidence(state.evidence, result.connection.evidence),
    unsupportedCapabilities: addManyUnique(
      state.unsupportedCapabilities,
      result.unsupportedCapabilities,
      20,
    ),
  };
}

function recordEntityConflict(
  state: AgentSessionState,
  toolName: DiagnosticToolName,
  subject: string,
  evidence: Evidence[],
  expected: string,
  actual: string,
): AgentSessionState {
  if (evidence.length === 0) {
    const error: DiagnosisToolError = {
      tool: toolName,
      error: {
        code: "conflicting_evidence",
        message: `${subject} does not match the active session`,
        retryable: false,
        details: { expected, actual },
      },
    };
    return {
      ...state,
      toolErrors: takeRecent([...state.toolErrors, error], 20),
    };
  }
  const conflict: EvidenceConflict = {
    subject,
    evidence,
    resolution: `未合并：当前对象 ${expected} 与工具结果 ${actual} 不一致`,
  };
  return {
    ...state,
    conflicts: takeRecent([...state.conflicts, conflict], 20),
    evidence: mergeEvidence(state.evidence, evidence),
  };
}

function parseToolArgs(toolName: DiagnosticToolName, args: unknown): unknown {
  switch (toolName) {
    case "find_user_or_message":
      return FindUserOrMessageInputSchema.parse(args);
    case "get_message_status":
      return MessageLookupInputSchema.parse(args);
    case "get_delivery_events":
      return DeliveryEventsInputSchema.parse(args);
    case "get_connection_status":
      return ConnectionStatusInputSchema.parse(args);
  }
}

function parseToolResponse(
  response: ToolResponse<unknown>,
): ToolResponse<unknown> {
  const parsed = ToolResponseSchema.parse(response);
  if (parsed.ok && !Object.hasOwn(parsed, "data")) {
    throw new StateMergeError(
      "invalid_tool_result",
      "successful tool response requires data",
    );
  }
  return parsed as ToolResponse<unknown>;
}

function sanitizeToolError(error: ToolError): ToolError {
  const capability = error.details?.capability;
  return ToolErrorSchema.parse({
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    details: typeof capability === "string" ? { capability } : undefined,
  });
}

function capabilityFromError(
  toolName: DiagnosticToolName,
  error: ToolError,
): string {
  if (typeof error.details?.capability === "string") {
    return error.details.capability;
  }
  const capabilityByTool: Record<DiagnosticToolName, string> = {
    find_user_or_message: "messageLookup",
    get_message_status: "messageLookup",
    get_delivery_events: "deliveryEvents",
    get_connection_status: "historicalPresence",
  };
  return capabilityByTool[toolName];
}

function mergeEvidence(current: Evidence[], incoming: Evidence[]): Evidence[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  const merged = [...byId.values()];
  if (merged.length > 100) {
    throw new StateMergeError(
      "state_capacity_exceeded",
      "evidence capacity exceeded",
    );
  }
  return merged;
}

function mergeDeliveries<T extends { attemptId?: string; messageId: string }>(
  current: T[],
  incoming: T[],
): T[] {
  const keyOf = (item: T) =>
    item.attemptId ?? `${item.messageId}:${stableStringify(item)}`;
  const byKey = new Map(current.map((item) => [keyOf(item), item]));
  for (const item of incoming) byKey.set(keyOf(item), item);
  const merged = [...byKey.values()];
  if (merged.length > 50) {
    throw new StateMergeError(
      "state_capacity_exceeded",
      "delivery fact capacity exceeded",
    );
  }
  return merged;
}

function parseMergedState(state: AgentSessionState): AgentSessionState {
  try {
    return AgentSessionStateSchema.parse(state);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new StateMergeError(
        "invalid_tool_result",
        "tool result cannot be merged into session state",
      );
    }
    throw error;
  }
}

function addManyUnique(
  current: string[],
  incoming: string[],
  maximum: number,
): string[] {
  return unique([...current, ...incoming]).slice(0, maximum);
}

function addUnique(
  current: string[],
  incoming: string,
  maximum: number,
): string[] {
  return addManyUnique(current, [incoming], maximum);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function takeRecent<T>(values: T[], maximum: number): T[] {
  return values.length <= maximum ? values : values.slice(-maximum);
}

function upsertPreviousIssue(
  current: PreviousIssueReference[],
  incoming: PreviousIssueReference,
): PreviousIssueReference[] {
  return [
    ...current.filter((issue) => issue.issueId !== incoming.issueId),
    incoming,
  ];
}

function targetSwitchDecisionId(
  state: AgentSessionState,
  toMessageId: string,
  requestedAt: string,
): string {
  return `switch_${createHash("sha256")
    .update(
      stableStringify({
        sessionId: state.sessionId,
        version: state.version,
        fromMessageId: state.messageId,
        toMessageId,
        requestedAt,
      }),
    )
    .digest("hex")}`;
}

function issueIdFor(
  sessionId: string,
  messageId: string,
  version: number,
  discriminator: string,
): string {
  return `issue_${createHash("sha256")
    .update(stableStringify({ sessionId, messageId, version, discriminator }))
    .digest("hex")}`;
}

function requireEvidence(evidence: Evidence[], subject: string): void {
  if (evidence.length === 0) {
    throw new StateMergeError(
      "invalid_tool_result",
      `${subject} requires evidence`,
    );
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortValue(nested)]),
  );
}

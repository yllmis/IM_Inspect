import { randomUUID } from "node:crypto";
import { z } from "zod";

import { IdentifierSchema } from "../connectors/connector";
import { ConnectionFactSchema } from "../domain/connection";
import { DeliveryFactSchema } from "../domain/delivery";
import {
  DeliveryQueryObservationSchema,
  DiagnosisClassificationSchema,
  DiagnosisResultSchema,
  DiagnosisTimeRangeSchema,
  DiagnosisToolErrorSchema,
  MatchResolutionSchema,
} from "../domain/diagnosis";
import {
  ConnectorCapabilitiesSchema,
  ToolErrorCodeSchema,
} from "../domain/errors";
import { EvidenceConflictSchema, EvidenceSchema } from "../domain/evidence";
import { MessageFactSchema } from "../domain/message";

export const AgentSessionStatusSchema = z.enum([
  "received",
  "extracting_context",
  "awaiting_information",
  "selecting_tool",
  "calling_tool",
  "evaluating_evidence",
  "generating_response",
  "draft_ready",
  "awaiting_confirmation",
  "completed",
  "failed",
  "stopped",
]);
export type AgentSessionStatus = z.infer<typeof AgentSessionStatusSchema>;

export const CurrentIssueSchema = z
  .object({
    issueId: IdentifierSchema.nullable().default(null),
    reopenedFromIssueId: IdentifierSchema.nullable().default(null),
    problemType: z.string().trim().min(1).max(128).nullable().default(null),
    summary: z.string().trim().min(1).max(1_000),
  })
  .strict();
export type CurrentIssue = z.infer<typeof CurrentIssueSchema>;

export const SessionCandidateContextSchema = z
  .object({
    userId: IdentifierSchema.nullable().default(null),
    conversationId: IdentifierSchema.nullable().default(null),
    messageId: IdentifierSchema.nullable().default(null),
    timeRange: DiagnosisTimeRangeSchema.nullable().default(null),
    problemType: z.string().trim().min(1).max(128).nullable().default(null),
  })
  .strict();
export type SessionCandidateContext = z.infer<
  typeof SessionCandidateContextSchema
>;

export const ConfirmedFactsSchema = z
  .object({
    message: MessageFactSchema.nullable().default(null),
    deliveries: z.array(DeliveryFactSchema).max(50).default([]),
    connection: ConnectionFactSchema.nullable().default(null),
    deliveryQuery: DeliveryQueryObservationSchema.nullable().default(null),
  })
  .strict();
export type ConfirmedFacts = z.infer<typeof ConfirmedFactsSchema>;

export const ExcludedHypothesisSchema = z
  .object({
    classification: DiagnosisClassificationSchema,
    reason: z.string().trim().min(1).max(512),
    evidenceRefs: z.array(z.string().min(1).max(256)).min(1).max(20),
  })
  .strict();
export type ExcludedHypothesis = z.infer<typeof ExcludedHypothesisSchema>;

export const SessionToolNameSchema = z.enum([
  "find_user_or_message",
  "get_message_status",
  "get_delivery_events",
  "get_connection_status",
  "create_escalation_draft",
]);
export type SessionToolName = z.infer<typeof SessionToolNameSchema>;

export const CalledToolSummarySchema = z
  .object({
    toolName: SessionToolNameSchema,
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    outcome: z.enum(["success", "error", "blocked", "cached"]),
    errorCode: ToolErrorCodeSchema.nullable().default(null),
    calledAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type CalledToolSummary = z.infer<typeof CalledToolSummarySchema>;

export const PendingQuestionSchema = z
  .object({
    field: z.string().trim().min(1).max(128),
    question: z.string().trim().min(1).max(500),
    askedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type PendingQuestion = z.infer<typeof PendingQuestionSchema>;

export const PendingTargetSwitchSchema = z
  .object({
    decisionId: IdentifierSchema,
    fromIssueId: IdentifierSchema.nullable().default(null),
    fromMessageId: IdentifierSchema,
    toMessageId: IdentifierSchema,
    requestedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine(
    ({ requestedAt, expiresAt }) =>
      Date.parse(requestedAt) < Date.parse(expiresAt),
    {
      message: "target switch expiration must be after request time",
      path: ["expiresAt"],
    },
  )
  .refine(({ fromMessageId, toMessageId }) => fromMessageId !== toMessageId, {
    message: "target switch must change messageId",
    path: ["toMessageId"],
  });
export type PendingTargetSwitch = z.infer<typeof PendingTargetSwitchSchema>;

export const TargetSwitchDecisionSchema = z
  .object({
    type: z.literal("resolve_target_switch"),
    decisionId: IdentifierSchema,
    decision: z.enum(["confirm", "reject"]),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export type TargetSwitchDecision = z.infer<typeof TargetSwitchDecisionSchema>;

export const PreviousIssueReferenceSchema = z
  .object({
    issueId: IdentifierSchema,
    messageId: IdentifierSchema,
    summary: z.string().trim().min(1).max(1_000),
    classification: DiagnosisClassificationSchema.nullable().default(null),
    closedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type PreviousIssueReference = z.infer<
  typeof PreviousIssueReferenceSchema
>;

export const ConversationEntrySchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(2_000),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ConversationEntry = z.infer<typeof ConversationEntrySchema>;

export const ConversationHistorySummarySchema = z
  .object({
    text: z.string().trim().min(1).max(2_000),
    summarizedMessages: z.number().int().positive(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ConversationHistorySummary = z.infer<
  typeof ConversationHistorySummarySchema
>;

const confirmationBinding = {
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().trim().min(16).max(128),
};

export const ConfirmationStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_required") }).strict(),
  z
    .object({
      status: z.literal("pending"),
      ...confirmationBinding,
      requestedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      status: z.enum(["confirmed", "rejected", "expired"]),
      ...confirmationBinding,
      decidedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
]);
export type ConfirmationState = z.infer<typeof ConfirmationStateSchema>;

export const AgentSessionStateSchema = z
  .object({
    sessionId: IdentifierSchema,
    tenantId: IdentifierSchema,
    actorId: IdentifierSchema,
    currentIssue: CurrentIssueSchema,
    previousIssues: z.array(PreviousIssueReferenceSchema).max(10).default([]),
    recentConversation: z.array(ConversationEntrySchema).max(6).default([]),
    historySummary: ConversationHistorySummarySchema.nullable().default(null),
    candidateContext: SessionCandidateContextSchema,
    // 顶层 ID 只保存已经唯一定位的对象，不能直接复制模型候选值。
    userId: IdentifierSchema.nullable().default(null),
    conversationId: IdentifierSchema.nullable().default(null),
    messageId: IdentifierSchema.nullable().default(null),
    timeRange: DiagnosisTimeRangeSchema.nullable().default(null),
    matchResolution: MatchResolutionSchema.nullable().default(null),
    confirmedFacts: ConfirmedFactsSchema,
    evidence: z.array(EvidenceSchema).max(100).default([]),
    excludedHypotheses: z.array(ExcludedHypothesisSchema).max(20).default([]),
    missingInformation: z
      .array(z.string().trim().min(1).max(128))
      .max(20)
      .default([]),
    unsupportedCapabilities: z
      .array(z.string().trim().min(1).max(128))
      .max(20)
      .default([]),
    connectorCapabilities: ConnectorCapabilitiesSchema.default({}),
    conflicts: z.array(EvidenceConflictSchema).max(20).default([]),
    calledTools: z.array(CalledToolSummarySchema).max(20).default([]),
    toolErrors: z.array(DiagnosisToolErrorSchema).max(20).default([]),
    pendingQuestion: PendingQuestionSchema.nullable().default(null),
    pendingTargetSwitch: PendingTargetSwitchSchema.nullable().default(null),
    confirmationState: ConfirmationStateSchema.default({
      status: "not_required",
    }),
    diagnosisResult: DiagnosisResultSchema.nullable().default(null),
    status: AgentSessionStatusSchema.default("received"),
    version: z.number().int().positive().default(1),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((state, context) => {
    if (Date.parse(state.updatedAt) < Date.parse(state.createdAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["updatedAt"],
        message: "updatedAt cannot be before createdAt",
      });
    }
    if (Date.parse(state.expiresAt) <= Date.parse(state.updatedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "expiresAt must be after updatedAt",
      });
    }
    if (
      new Set(state.evidence.map((item) => item.id)).size !==
      state.evidence.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence"],
        message: "evidence ids must be unique",
      });
    }
    if (
      state.pendingTargetSwitch &&
      (!state.pendingQuestion || state.pendingQuestion.field !== "targetSwitch")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pendingQuestion"],
        message: "pending target switch requires a bound pending question",
      });
    }
    const capabilityNames = Object.keys(state.connectorCapabilities);
    if (
      capabilityNames.length > 20 ||
      capabilityNames.some((name) => name.length === 0 || name.length > 128)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["connectorCapabilities"],
        message: "connector capabilities must contain at most 20 bounded keys",
      });
    }
  });
export type AgentSessionState = z.infer<typeof AgentSessionStateSchema>;

export function createAgentSessionState(input: {
  sessionId: string;
  tenantId: string;
  actorId: string;
  issueSummary: string;
  problemType?: string;
  now?: Date;
  ttlMs?: number;
}): AgentSessionState {
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? 30 * 60 * 1_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("ttlMs must be a positive safe integer");
  }
  const timestamp = now.toISOString();
  return AgentSessionStateSchema.parse({
    sessionId: input.sessionId,
    tenantId: input.tenantId,
    actorId: input.actorId,
    currentIssue: {
      issueId: `issue_${randomUUID()}`,
      reopenedFromIssueId: null,
      problemType: input.problemType ?? null,
      summary: input.issueSummary,
    },
    candidateContext: {},
    confirmedFacts: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  });
}

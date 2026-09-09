import { z } from "zod";

import {
  AgentSessionState,
  CalledToolSummarySchema,
  CurrentIssueSchema,
  PendingQuestionSchema,
  SessionCandidateContextSchema,
} from "./session-state";
import {
  DiagnosisClassificationSchema,
  RecommendedActionSchema,
} from "../domain/diagnosis";
import {
  ConnectorCapabilitiesSchema,
  ToolErrorCodeSchema,
} from "../domain/errors";
import { MessageStatusSchema } from "../domain/message";
import { DeliveryStatusSchema } from "../domain/delivery";
import { ConnectionStateSchema } from "../domain/connection";

export const ModelContextPurposeSchema = z.enum([
  "extract_context",
  "select_tool",
  "generate_response",
  "generate_draft",
]);
export type ModelContextPurpose = z.infer<typeof ModelContextPurposeSchema>;

const MessageSummarySchema = z
  .object({
    messageId: z.string(),
    exists: z.boolean(),
    persisted: z.boolean().nullable(),
    status: MessageStatusSchema,
    receiverId: z.string().optional(),
  })
  .strict();

const DeliverySummarySchema = z
  .object({
    messageId: z.string(),
    receiverId: z.string().optional(),
    attemptId: z.string().optional(),
    attemptedAt: z.string().optional(),
    result: DeliveryStatusSchema,
    deliveredAt: z.string().optional(),
    ackedAt: z.string().optional(),
    errorCode: z.string().optional(),
  })
  .strict();

const ConnectionSummarySchema = z
  .object({
    userId: z.string(),
    state: ConnectionStateSchema,
    observedAt: z.string().optional(),
    historical: z.boolean(),
  })
  .strict();

const ConfirmedFactsSummarySchema = z
  .object({
    message: MessageSummarySchema.nullable(),
    deliveries: z.array(DeliverySummarySchema),
    connection: ConnectionSummarySchema.nullable(),
    deliveryQuery: z
      .object({
        complete: z.boolean(),
        truncated: z.boolean(),
        returnedCount: z.number().int().min(0).max(50),
        effectiveTimeRange: z
          .object({
            start: z.string().datetime({ offset: true }),
            end: z.string().datetime({ offset: true }),
          })
          .strict(),
        source: z.string(),
        observedAt: z.string(),
      })
      .strict()
      .nullable(),
  })
  .strict();

const ConflictSummarySchema = z
  .object({
    subject: z.string(),
    resolution: z.string(),
    evidenceRefs: z.array(z.string()),
  })
  .strict();

const ToolErrorSummarySchema = z
  .object({
    tool: z.string(),
    code: ToolErrorCodeSchema,
    retryable: z.boolean(),
  })
  .strict();

const ExcludedHypothesisSummarySchema = z
  .object({
    classification: DiagnosisClassificationSchema,
    reason: z.string(),
    evidenceRefs: z.array(z.string()),
  })
  .strict();

const DiagnosisSummarySchema = z
  .object({
    classification: DiagnosisClassificationSchema,
    facts: z.array(z.string()),
    possibleCauses: z.array(z.string()),
    missingInformation: z.array(z.string()),
    unsupportedCapabilities: z.array(z.string()),
    recommendedAction: RecommendedActionSchema,
  })
  .strict();

export const ModelContextSchema = z
  .object({
    purpose: ModelContextPurposeSchema,
    sessionId: z.string(),
    currentIssue: CurrentIssueSchema,
    currentUserText: z.string().min(1).optional(),
    candidateContext: SessionCandidateContextSchema.optional(),
    confirmedFacts: ConfirmedFactsSummarySchema.optional(),
    evidenceRefs: z.array(z.string()).optional(),
    missingInformation: z.array(z.string()).optional(),
    unsupportedCapabilities: z.array(z.string()).optional(),
    connectorCapabilities: ConnectorCapabilitiesSchema.optional(),
    excludedHypotheses: z.array(ExcludedHypothesisSummarySchema).optional(),
    conflicts: z.array(ConflictSummarySchema).optional(),
    recentTools: z.array(CalledToolSummarySchema).optional(),
    toolErrors: z.array(ToolErrorSummarySchema).optional(),
    pendingQuestion: PendingQuestionSchema.optional(),
    diagnosis: DiagnosisSummarySchema.optional(),
    truncation: z
      .object({
        truncated: z.boolean(),
        omitted: z.record(z.number().int().nonnegative()),
      })
      .strict(),
  })
  .strict();
export type ModelContext = z.infer<typeof ModelContextSchema>;

export interface ModelContextLimits {
  maxCharacters: number;
  maxCurrentUserTextCharacters: number;
  maxIssueSummaryCharacters: number;
  maxDeliveryFacts: number;
  maxEvidenceRefs: number;
  maxCalledTools: number;
  maxConflicts: number;
  maxToolErrors: number;
  maxExcludedHypotheses: number;
}

const DEFAULT_LIMITS: ModelContextLimits = {
  maxCharacters: 8_000,
  maxCurrentUserTextCharacters: 2_000,
  maxIssueSummaryCharacters: 500,
  maxDeliveryFacts: 10,
  maxEvidenceRefs: 30,
  maxCalledTools: 10,
  maxConflicts: 10,
  maxToolErrors: 10,
  maxExcludedHypotheses: 10,
};

export function buildModelContext(
  state: AgentSessionState,
  purpose: ModelContextPurpose,
  options: {
    currentUserText?: string;
    limits?: Partial<ModelContextLimits>;
  } = {},
): ModelContext {
  const limits = validateLimits({ ...DEFAULT_LIMITS, ...options.limits });
  const omitted: Record<string, number> = {};
  const issueSummary = truncateText(
    state.currentIssue.summary,
    limits.maxIssueSummaryCharacters,
    "currentIssueCharacters",
    omitted,
  );
  const context: ModelContext = {
    purpose,
    sessionId: state.sessionId,
    currentIssue: {
      ...state.currentIssue,
      summary: issueSummary,
    },
    truncation: { truncated: false, omitted },
  };

  if (purpose === "extract_context") {
    if (options.currentUserText?.trim()) {
      context.currentUserText = truncateText(
        options.currentUserText.trim(),
        limits.maxCurrentUserTextCharacters,
        "currentUserTextCharacters",
        omitted,
      );
    }
    context.candidateContext = state.candidateContext;
    if (state.pendingQuestion) context.pendingQuestion = state.pendingQuestion;
  } else {
    context.confirmedFacts = summarizeConfirmedFacts(
      state,
      limits.maxDeliveryFacts,
      omitted,
    );
    context.evidenceRefs = takeRecent(
      state.evidence.map((item) => item.id),
      limits.maxEvidenceRefs,
      "evidenceRefs",
      omitted,
    );
    context.missingInformation = [...state.missingInformation];
    context.unsupportedCapabilities = [...state.unsupportedCapabilities];
    context.excludedHypotheses = takeRecent(
      state.excludedHypotheses,
      limits.maxExcludedHypotheses,
      "excludedHypotheses",
      omitted,
    );
    context.conflicts = takeRecent(
      state.conflicts.map((conflict) => ({
        subject: conflict.subject,
        resolution: conflict.resolution,
        evidenceRefs: conflict.evidence.map((item) => item.id),
      })),
      limits.maxConflicts,
      "conflicts",
      omitted,
    );
    context.toolErrors = takeRecent(
      state.toolErrors.map((item) => ({
        tool: item.tool,
        code: item.error.code,
        retryable: item.error.retryable,
      })),
      limits.maxToolErrors,
      "toolErrors",
      omitted,
    );

    if (purpose === "select_tool") {
      context.candidateContext = state.candidateContext;
      context.connectorCapabilities = { ...state.connectorCapabilities };
      context.recentTools = takeRecent(
        state.calledTools,
        limits.maxCalledTools,
        "recentTools",
        omitted,
      );
      if (state.pendingQuestion)
        context.pendingQuestion = state.pendingQuestion;
    }

    if (
      (purpose === "generate_response" || purpose === "generate_draft") &&
      state.diagnosisResult
    ) {
      context.diagnosis = {
        classification: state.diagnosisResult.classification,
        facts: [...state.diagnosisResult.facts],
        possibleCauses: [...state.diagnosisResult.possibleCauses],
        missingInformation: [...state.diagnosisResult.missingInformation],
        unsupportedCapabilities: [
          ...state.diagnosisResult.unsupportedCapabilities,
        ],
        recommendedAction: state.diagnosisResult.recommendedAction,
      };
    }
  }

  fitToCharacterBudget(context, limits.maxCharacters, omitted);
  context.truncation.truncated = Object.keys(omitted).length > 0;
  return ModelContextSchema.parse(context);
}

function summarizeConfirmedFacts(
  state: AgentSessionState,
  maxDeliveryFacts: number,
  omitted: Record<string, number>,
): NonNullable<ModelContext["confirmedFacts"]> {
  const { message, deliveries, connection, deliveryQuery } =
    state.confirmedFacts;
  return {
    message: message
      ? {
          messageId: message.messageId,
          exists: message.exists,
          persisted: message.persisted,
          status: message.status,
          receiverId: message.receiverId,
        }
      : null,
    deliveries: takeRecent(
      deliveries.map((delivery) => ({
        messageId: delivery.messageId,
        receiverId: delivery.receiverId,
        attemptId: delivery.attemptId,
        attemptedAt: delivery.attemptedAt,
        result: delivery.result,
        deliveredAt: delivery.deliveredAt,
        ackedAt: delivery.ackedAt,
        errorCode: delivery.errorCode,
      })),
      maxDeliveryFacts,
      "deliveryFacts",
      omitted,
    ),
    connection: connection
      ? {
          userId: connection.userId,
          state: connection.state,
          observedAt: connection.observedAt,
          historical: connection.historical,
        }
      : null,
    deliveryQuery: deliveryQuery
      ? {
          complete: deliveryQuery.complete,
          truncated: deliveryQuery.truncated,
          returnedCount: deliveryQuery.returnedCount,
          effectiveTimeRange: deliveryQuery.effectiveTimeRange,
          source: deliveryQuery.source,
          observedAt: deliveryQuery.observedAt,
        }
      : null,
  };
}

function takeRecent<T>(
  values: readonly T[],
  maximum: number,
  key: string,
  omitted: Record<string, number>,
): T[] {
  if (values.length <= maximum) return [...values];
  omitted[key] = (omitted[key] ?? 0) + values.length - maximum;
  return values.slice(values.length - maximum);
}

function truncateText(
  value: string,
  maximum: number,
  key: string,
  omitted: Record<string, number>,
): string {
  if (value.length <= maximum) return value;
  omitted[key] = (omitted[key] ?? 0) + value.length - maximum;
  return value.slice(0, maximum);
}

function fitToCharacterBudget(
  context: ModelContext,
  maximum: number,
  omitted: Record<string, number>,
): void {
  const arrays: Array<[string, () => unknown[] | undefined]> = [
    ["recentTools", () => context.recentTools],
    ["evidenceRefs", () => context.evidenceRefs],
    ["deliveryFacts", () => context.confirmedFacts?.deliveries],
    ["conflicts", () => context.conflicts],
    ["toolErrors", () => context.toolErrors],
    ["excludedHypotheses", () => context.excludedHypotheses],
    ["diagnosisPossibleCauses", () => context.diagnosis?.possibleCauses],
    ["diagnosisFacts", () => context.diagnosis?.facts],
    [
      "diagnosisUnsupportedCapabilities",
      () => context.diagnosis?.unsupportedCapabilities,
    ],
    ["unsupportedCapabilities", () => context.unsupportedCapabilities],
    [
      "diagnosisMissingInformation",
      () => context.diagnosis?.missingInformation,
    ],
    ["missingInformation", () => context.missingInformation],
  ];

  for (const [key, getValues] of arrays) {
    const values = getValues();
    while (values && values.length > 0 && serializedLength(context) > maximum) {
      values.shift();
      omitted[key] = (omitted[key] ?? 0) + 1;
    }
  }

  const capabilityEntries = Object.entries(
    context.connectorCapabilities ?? {},
  ).sort((left, right) => {
    const priority = { supported: 0, partial: 1, unsupported: 2 } as const;
    return priority[left[1]] - priority[right[1]];
  });
  for (const [capability] of capabilityEntries) {
    if (serializedLength(context) <= maximum) break;
    delete context.connectorCapabilities?.[capability];
    omitted.connectorCapabilities = (omitted.connectorCapabilities ?? 0) + 1;
  }

  while (
    context.currentUserText &&
    context.currentUserText.length > 100 &&
    serializedLength(context) > maximum
  ) {
    const removed = Math.min(100, context.currentUserText.length - 100);
    context.currentUserText = context.currentUserText.slice(0, -removed);
    omitted.currentUserTextCharacters =
      (omitted.currentUserTextCharacters ?? 0) + removed;
  }

  while (
    context.currentIssue.summary.length > 100 &&
    serializedLength(context) > maximum
  ) {
    const removed = Math.min(100, context.currentIssue.summary.length - 100);
    context.currentIssue.summary = context.currentIssue.summary.slice(
      0,
      -removed,
    );
    omitted.currentIssueCharacters =
      (omitted.currentIssueCharacters ?? 0) + removed;
  }

  if (serializedLength(context) > maximum) {
    throw new Error("model context cannot fit within maxCharacters");
  }
}

function serializedLength(value: unknown): number {
  return JSON.stringify(value).length;
}

function validateLimits(limits: ModelContextLimits): ModelContextLimits {
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${key} must be a positive safe integer`);
    }
  }
  if (limits.maxCharacters < 1_000) {
    throw new Error("maxCharacters must be at least 1000");
  }
  return limits;
}

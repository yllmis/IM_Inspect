import { z } from "zod";

import {
  AgentSessionState,
  CalledToolSummarySchema,
  ConversationEntrySchema,
  ConversationHistorySummarySchema,
  CurrentIssueSchema,
  PendingQuestionSchema,
  SessionCandidateContextSchema,
} from "./session-state";
import {
  ContextBudget,
  ContextBudgetExceededError,
  modelContextCharacterBudget,
  resolveContextBudget,
} from "./context-budget";
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
import { EvidenceKindSchema } from "../domain/evidence";

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

const KeyEvidenceSummarySchema = z
  .object({
    id: z.string().min(1).max(256),
    source: z.string().min(1).max(128),
    kind: EvidenceKindSchema,
    observedAt: z.string().datetime({ offset: true }),
    field: z.string().min(1).max(128),
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
    inputTrust: z
      .object({
        customerText: z.literal("untrusted_data"),
        currentIssue: z.literal("untrusted_data"),
        conversation: z.literal("untrusted_data"),
        evidenceEligible: z.literal(false),
      })
      .strict(),
    currentIssue: CurrentIssueSchema,
    currentUserText: z.string().min(1).optional(),
    recentConversation: z.array(ConversationEntrySchema).optional(),
    historySummary: ConversationHistorySummarySchema.optional(),
    candidateContext: SessionCandidateContextSchema.optional(),
    confirmedFacts: ConfirmedFactsSummarySchema.optional(),
    keyEvidence: z.array(KeyEvidenceSummarySchema).optional(),
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
    modelContextStatus: z
      .object({
        contextIncomplete: z.boolean(),
        criticalInformationOmitted: z.boolean(),
        omittedSections: z.array(z.string().min(1).max(64)).max(20),
        omitted: z.record(z.number().int().nonnegative()),
        usedCharacters: z.number().int().nonnegative(),
        maxCharacters: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();
export type ModelContext = z.infer<typeof ModelContextSchema>;

const ITEM_LIMITS = {
  maxDeliveryFacts: 10,
  maxEvidenceRefs: 30,
  maxCalledTools: 10,
  maxConflicts: 10,
  maxToolErrors: 10,
  maxExcludedHypotheses: 10,
} as const;

export function buildModelContext(
  state: AgentSessionState,
  purpose: ModelContextPurpose,
  options: {
    currentUserText?: string;
    budget?: Partial<ContextBudget>;
  } = {},
): ModelContext {
  const budget = resolveContextBudget(options.budget);
  const maximum = modelContextCharacterBudget(budget);
  const omitted: Record<string, number> = {};
  const issueSummary = truncateText(
    state.currentIssue.summary,
    Math.min(500, budget.maxCurrentQuestionCharacters),
    "currentIssueCharacters",
    omitted,
  );
  const context: ModelContext = {
    purpose,
    sessionId: state.sessionId,
    // 结构化信任标签比只写 Prompt 更明确：这些文本只能用于提取线索，不能升级为事实。
    inputTrust: {
      customerText: "untrusted_data",
      currentIssue: "untrusted_data",
      conversation: "untrusted_data",
      evidenceEligible: false,
    },
    currentIssue: {
      ...state.currentIssue,
      summary: issueSummary,
    },
    modelContextStatus: {
      contextIncomplete: false,
      criticalInformationOmitted: false,
      omittedSections: [],
      omitted,
      usedCharacters: 0,
      maxCharacters: maximum,
    },
  };

  if (purpose === "extract_context") {
    if (options.currentUserText?.trim()) {
      context.currentUserText = truncateText(
        options.currentUserText.trim(),
        budget.maxCurrentQuestionCharacters,
        "currentUserTextCharacters",
        omitted,
      );
    }
    context.recentConversation = fitArrayToSectionBudget(
      state.recentConversation,
      budget.maxRecentConversationCharacters,
      "recentConversation",
      omitted,
    );
    if (state.historySummary) {
      context.historySummary = {
        ...state.historySummary,
        text: truncateText(
          state.historySummary.text,
          budget.maxHistorySummaryCharacters,
          "historySummaryCharacters",
          omitted,
        ),
      };
    }
    context.candidateContext = state.candidateContext;
    if (state.pendingQuestion) context.pendingQuestion = state.pendingQuestion;
  } else {
    context.confirmedFacts = summarizeConfirmedFacts(
      state,
      ITEM_LIMITS.maxDeliveryFacts,
      omitted,
    );
    fitConfirmedFactsToBudget(
      context.confirmedFacts,
      budget.maxConfirmedFactsCharacters,
      omitted,
    );
    context.keyEvidence = (state.diagnosisResult?.evidence ?? []).map(
      (evidence) => ({
        id: evidence.id,
        source: evidence.source,
        kind: evidence.kind,
        observedAt: evidence.observedAt,
        field: evidence.field,
      }),
    );
    context.evidenceRefs = takeRecent(
      state.evidence.map((item) => item.id),
      ITEM_LIMITS.maxEvidenceRefs,
      "evidenceRefs",
      omitted,
    );
    context.missingInformation = [...state.missingInformation];
    context.unsupportedCapabilities = [...state.unsupportedCapabilities];
    context.excludedHypotheses = takeRecent(
      state.excludedHypotheses,
      ITEM_LIMITS.maxExcludedHypotheses,
      "excludedHypotheses",
      omitted,
    );
    context.conflicts = takeRecent(
      state.conflicts.map((conflict) => ({
        subject: conflict.subject,
        resolution: conflict.resolution,
        evidenceRefs: conflict.evidence.map((item) => item.id),
      })),
      ITEM_LIMITS.maxConflicts,
      "conflicts",
      omitted,
    );
    context.toolErrors = takeRecent(
      state.toolErrors.map((item) => ({
        tool: item.tool,
        code: item.error.code,
        retryable: item.error.retryable,
      })),
      ITEM_LIMITS.maxToolErrors,
      "toolErrors",
      omitted,
    );

    if (purpose === "select_tool") {
      context.candidateContext = state.candidateContext;
      context.connectorCapabilities = { ...state.connectorCapabilities };
      context.recentTools = fitArrayToSectionBudget(
        takeRecent(
          state.calledTools,
          ITEM_LIMITS.maxCalledTools,
          "recentTools",
          omitted,
        ),
        budget.maxToolSummariesCharacters,
        "recentTools",
        omitted,
      );
      context.recentConversation = fitArrayToSectionBudget(
        state.recentConversation,
        budget.maxRecentConversationCharacters,
        "recentConversation",
        omitted,
      );
      if (state.historySummary) {
        context.historySummary = {
          ...state.historySummary,
          text: truncateText(
            state.historySummary.text,
            budget.maxHistorySummaryCharacters,
            "historySummaryCharacters",
            omitted,
          ),
        };
      }
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

  fitToCharacterBudget(context, maximum, omitted);
  updateContextStatus(context, maximum, omitted);
  return ModelContextSchema.parse(context);
}

function summarizeConfirmedFacts(
  state: AgentSessionState,
  maxDeliveryFacts: number,
  omitted: Record<string, number>,
): NonNullable<ModelContext["confirmedFacts"]> {
  const { message, deliveries, connection, deliveryQuery } =
    state.confirmedFacts;
  const activeMessageId = state.messageId ?? message?.messageId ?? null;
  const scopedMessage =
    message && (!activeMessageId || message.messageId === activeMessageId)
      ? message
      : null;
  const scopedDeliveries = activeMessageId
    ? deliveries.filter((delivery) => delivery.messageId === activeMessageId)
    : deliveries;
  if (message && !scopedMessage) {
    omitted.unrelatedMessageFacts = (omitted.unrelatedMessageFacts ?? 0) + 1;
  }
  if (scopedDeliveries.length !== deliveries.length) {
    omitted.unrelatedDeliveryFacts =
      (omitted.unrelatedDeliveryFacts ?? 0) +
      deliveries.length -
      scopedDeliveries.length;
  }
  const relatedUsers = new Set(
    [
      scopedMessage?.senderId,
      scopedMessage?.receiverId,
      ...scopedDeliveries.map((delivery) => delivery.receiverId),
    ].filter((value): value is string => Boolean(value)),
  );
  const scopedConnection =
    connection &&
    (relatedUsers.size === 0 || relatedUsers.has(connection.userId))
      ? connection
      : null;
  if (connection && !scopedConnection) {
    omitted.unrelatedConnectionFacts =
      (omitted.unrelatedConnectionFacts ?? 0) + 1;
  }
  return {
    message: scopedMessage
      ? {
          messageId: scopedMessage.messageId,
          exists: scopedMessage.exists,
          persisted: scopedMessage.persisted,
          status: scopedMessage.status,
          receiverId: scopedMessage.receiverId,
        }
      : null,
    deliveries: takeRecent(
      scopedDeliveries.map((delivery) => ({
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
    connection: scopedConnection
      ? {
          userId: scopedConnection.userId,
          state: scopedConnection.state,
          observedAt: scopedConnection.observedAt,
          historical: scopedConnection.historical,
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

function fitArrayToSectionBudget<T>(
  values: readonly T[],
  maximum: number,
  key: string,
  omitted: Record<string, number>,
): T[] {
  const selected = [...values];
  while (selected.length > 0 && serializedLength(selected) > maximum) {
    selected.shift();
    omitted[key] = (omitted[key] ?? 0) + 1;
  }
  return selected;
}

function fitConfirmedFactsToBudget(
  facts: NonNullable<ModelContext["confirmedFacts"]>,
  maximum: number,
  omitted: Record<string, number>,
): void {
  while (facts.deliveries.length > 0 && serializedLength(facts) > maximum) {
    facts.deliveries.shift();
    omitted.deliveryFacts = (omitted.deliveryFacts ?? 0) + 1;
  }
  if (serializedLength(facts) > maximum) {
    throw new ContextBudgetExceededError(
      "model_input_too_large",
      "confirmed facts cannot fit within their character budget",
    );
  }
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
  const lowPriorityArrays: Array<[string, () => unknown[] | undefined]> = [
    ["recentTools", () => context.recentTools],
    ["recentConversation", () => context.recentConversation],
  ];
  const factArrays: Array<[string, () => unknown[] | undefined]> = [
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

  for (const [key, getValues] of lowPriorityArrays) {
    const values = getValues();
    while (values && values.length > 0 && serializedLength(context) > maximum) {
      values.shift();
      omitted[key] = (omitted[key] ?? 0) + 1;
    }
  }

  while (
    context.historySummary &&
    context.historySummary.text.length > 100 &&
    serializedLength(context) > maximum
  ) {
    const removed = Math.min(100, context.historySummary.text.length - 100);
    context.historySummary.text = context.historySummary.text.slice(removed);
    omitted.historySummaryCharacters =
      (omitted.historySummaryCharacters ?? 0) + removed;
  }

  for (const [key, getValues] of factArrays) {
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
    throw new ContextBudgetExceededError(
      "model_input_too_large",
      "required model context cannot fit within maxCharacters",
    );
  }
}

function updateContextStatus(
  context: ModelContext,
  maximum: number,
  omitted: Record<string, number>,
): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const omittedSections = [
      ...new Set(Object.keys(omitted).map(sectionForOmission)),
    ];
    context.modelContextStatus = {
      contextIncomplete: omittedSections.length > 0,
      criticalInformationOmitted: Object.keys(omitted).some((key) =>
        [
          "currentUserTextCharacters",
          "diagnosisFacts",
          "diagnosisMissingInformation",
          "missingInformation",
        ].includes(key),
      ),
      omittedSections,
      omitted,
      usedCharacters: 0,
      maxCharacters: maximum,
    };
    for (let sizeAttempt = 0; sizeAttempt < 4; sizeAttempt += 1) {
      const actual = serializedLength(context);
      if (context.modelContextStatus.usedCharacters === actual) break;
      context.modelContextStatus.usedCharacters = actual;
    }
    if (serializedLength(context) <= maximum) return;
    fitToCharacterBudget(context, maximum, omitted);
  }
  if (serializedLength(context) > maximum) {
    throw new ContextBudgetExceededError(
      "model_input_too_large",
      "model context status cannot fit within maxCharacters",
    );
  }
}

function sectionForOmission(key: string): string {
  if (key === "recentConversation") return "recentConversation";
  if (key === "recentTools") return "toolSummaries";
  if (key.startsWith("historySummary")) return "historySummary";
  if (key.startsWith("currentUserText")) return "currentQuestion";
  if (key.startsWith("currentIssue")) return "currentIssue";
  if (
    key.includes("Facts") ||
    key.startsWith("evidence") ||
    key.startsWith("conflict") ||
    key.startsWith("unrelated")
  ) {
    return "confirmedFacts";
  }
  if (key.startsWith("diagnosis")) return "diagnosis";
  return key;
}

function serializedLength(value: unknown): number {
  return JSON.stringify(value).length;
}

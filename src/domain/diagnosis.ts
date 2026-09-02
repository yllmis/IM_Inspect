import { z } from "zod";

import { ConnectionFactSchema } from "./connection";
import { DeliveryFactSchema } from "./delivery";
import { EvidenceConflictSchema, EvidenceSchema } from "./evidence";
import { ConnectorCapabilitiesSchema, ToolErrorSchema } from "./errors";
import { MessageFactSchema } from "./message";

export const DiagnosisClassificationSchema = z.enum([
  "message_not_found",
  "write_failed",
  "not_delivered",
  "receiver_offline",
  "ack_timeout",
  "delivered",
  "insufficient_data",
]);
export type DiagnosisClassification = z.infer<
  typeof DiagnosisClassificationSchema
>;

export const RecommendedActionSchema = z.enum([
  "reply",
  "ask_for_more_info",
  "escalate",
]);
export type RecommendedAction = z.infer<typeof RecommendedActionSchema>;

export const DiagnosisTimeRangeSchema = z
  .object({
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine(({ start, end }) => Date.parse(start) < Date.parse(end), {
    message: "start must be before end",
    path: ["end"],
  });
export type DiagnosisTimeRange = z.infer<typeof DiagnosisTimeRangeSchema>;

export const MatchResolutionSchema = z.enum([
  "unique",
  "multiple",
  "none",
  "insufficient_data",
]);
export type MatchResolution = z.infer<typeof MatchResolutionSchema>;

export const DiagnosisToolNameSchema = z.enum([
  "find_user_or_message",
  "get_message_status",
  "get_delivery_events",
  "get_connection_status",
]);
export type DiagnosisToolName = z.infer<typeof DiagnosisToolNameSchema>;

export const DiagnosisToolErrorSchema = z
  .object({
    tool: DiagnosisToolNameSchema,
    error: ToolErrorSchema,
  })
  .strict();
export type DiagnosisToolError = z.infer<typeof DiagnosisToolErrorSchema>;

export const DeliveryQueryObservationSchema = z
  .object({
    complete: z.boolean(),
    source: z.string().min(1).max(128),
    observedAt: z.string().datetime({ offset: true }),
    evidence: EvidenceSchema,
  })
  .strict()
  .superRefine((observation, context) => {
    if (observation.evidence.kind !== "delivery") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence", "kind"],
        message: "delivery query observation requires delivery evidence",
      });
    }
  });
export type DeliveryQueryObservation = z.infer<
  typeof DeliveryQueryObservationSchema
>;

export const DiagnosisInputSchema = z
  .object({
    requestId: z.string().min(1).max(128).optional(),
    rawText: z.string().min(1).max(20_000),
    userId: z.string().min(1).max(128).optional(),
    conversationId: z.string().min(1).max(128).optional(),
    messageId: z.string().min(1).max(128).optional(),
    timeRange: DiagnosisTimeRangeSchema.optional(),
    problemType: z.string().min(1).max(128).optional(),
    matchResolution: MatchResolutionSchema.optional(),
    message: MessageFactSchema.optional(),
    deliveries: z.array(DeliveryFactSchema).optional(),
    connection: ConnectionFactSchema.optional(),
    deliveryQuery: DeliveryQueryObservationSchema.optional(),
    toolErrors: z.array(DiagnosisToolErrorSchema).optional(),
    capabilities: ConnectorCapabilitiesSchema.optional(),
    conflicts: z.array(EvidenceConflictSchema).optional(),
  })
  .strict();
export type DiagnosisInput = z.infer<typeof DiagnosisInputSchema>;

export const DiagnosisResultSchema = z
  .object({
    classification: DiagnosisClassificationSchema,
    facts: z.array(z.string()),
    evidence: z.array(EvidenceSchema),
    possibleCauses: z.array(z.string()),
    missingInformation: z.array(z.string()),
    unsupportedCapabilities: z.array(z.string()),
    toolErrors: z.array(DiagnosisToolErrorSchema).optional(),
    conflicts: z.array(EvidenceConflictSchema).optional(),
    recommendedAction: RecommendedActionSchema,
    message: MessageFactSchema.optional(),
    deliveries: z.array(DeliveryFactSchema).optional(),
    connection: ConnectionFactSchema.optional(),
  })
  .strict();
export type DiagnosisResult = z.infer<typeof DiagnosisResultSchema>;

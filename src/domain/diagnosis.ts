import { z } from "zod";

import { ConnectionFactSchema } from "./connection";
import { DeliveryFactSchema } from "./delivery";
import { EvidenceConflictSchema, EvidenceSchema } from "./evidence";
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

export const DiagnosisInputSchema = z
  .object({
    requestId: z.string().min(1).max(128).optional(),
    rawText: z.string().min(1).max(20_000),
    userId: z.string().min(1).max(128).optional(),
    conversationId: z.string().min(1).max(128).optional(),
    messageId: z.string().min(1).max(128).optional(),
    timeRange: DiagnosisTimeRangeSchema.optional(),
    problemType: z.string().min(1).max(128).optional(),
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
    conflicts: z.array(EvidenceConflictSchema).optional(),
    recommendedAction: RecommendedActionSchema,
    message: MessageFactSchema.optional(),
    deliveries: z.array(DeliveryFactSchema).optional(),
    connection: ConnectionFactSchema.optional(),
  })
  .strict();
export type DiagnosisResult = z.infer<typeof DiagnosisResultSchema>;

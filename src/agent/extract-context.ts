import { z } from "zod";

import { IdentifierSchema } from "../connectors/connector";
import { DiagnosisTimeRangeSchema } from "../domain/diagnosis";

export const CandidateContextSchema = z
  .object({
    messageId: IdentifierSchema.nullable().default(null),
    userId: IdentifierSchema.nullable().default(null),
    conversationId: IdentifierSchema.nullable().default(null),
    timeRange: DiagnosisTimeRangeSchema.nullable().default(null),
    problemType: z.string().trim().min(1).max(128).nullable().default(null),
  })
  .strict();
export type CandidateContext = z.infer<typeof CandidateContextSchema>;

export const ContextExtractionSchema = CandidateContextSchema;

export function parseCandidateContext(value: unknown): CandidateContext {
  return CandidateContextSchema.parse(value);
}

export function emptyCandidateContext(): CandidateContext {
  return CandidateContextSchema.parse({});
}

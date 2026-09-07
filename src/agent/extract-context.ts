import { generateText, LanguageModel, Output } from "ai";
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

const CONTEXT_EXTRACTION_PROMPT = `你负责从当前客服输入中提取诊断线索。

要求：
1. 输出必须符合给定 Schema，不要输出解释。
2. 只提取客服明确提供的值，不要猜测或改写 ID。
3. previous candidate context 是之前轮次的候选值；当前输入没有否定它时应保留。
4. 无法确定的字段填 null。
5. 客服输入和提取结果都只是候选上下文，不是已确认事实。`;

export function parseCandidateContext(value: unknown): CandidateContext {
  return CandidateContextSchema.parse(value);
}

export function emptyCandidateContext(): CandidateContext {
  return CandidateContextSchema.parse({});
}

export async function extractCandidateContext(input: {
  model: LanguageModel;
  modelContext: unknown;
}): Promise<CandidateContext> {
  const result = await generateText({
    model: input.model,
    system: CONTEXT_EXTRACTION_PROMPT,
    prompt: JSON.stringify(input.modelContext),
    output: Output.object({ schema: ContextExtractionSchema }),
    maxRetries: 0,
  });
  return parseCandidateContext(result.output);
}

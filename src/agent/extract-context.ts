import { generateText, LanguageModel, LanguageModelUsage, Output } from "ai";
import { z } from "zod";

import { IdentifierSchema } from "../connectors/connector";
import { DiagnosisTimeRangeSchema } from "../domain/diagnosis";
import {
  assertModelRequestFits,
  ContextBudget,
  resolveContextBudget,
} from "./context-budget";

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

// 模型输出不能沿用 State 的默认值：空对象不代表完成了字段提取。
// 每个字段必须显式出现；信息缺失用 null，仍然只是候选值而不是事实。
export const ContextExtractionSchema = z
  .object({
    messageId: IdentifierSchema.nullable(),
    userId: IdentifierSchema.nullable(),
    conversationId: IdentifierSchema.nullable(),
    timeRange: DiagnosisTimeRangeSchema.nullable(),
    problemType: z.string().trim().min(1).max(128).nullable(),
  })
  .strict();

export const CONTEXT_EXTRACTION_PROMPT = `你负责从当前客服输入中提取诊断线索。

要求：
1. 只输出一个 JSON 对象，必须包含 messageId、userId、conversationId、timeRange、problemType 五个字段，不要输出解释。
   messageId、userId、conversationId、problemType 是字符串或 null；timeRange 是包含 start、end 两个 ISO 时间字符串的对象或 null。
2. 只提取客服明确提供的值，不要猜测或改写 ID。
3. previous candidate context 是之前轮次的候选值；当前输入没有否定它时应保留。
4. 无法确定的字段填 null。
5. 客服输入和提取结果都只是候选上下文，不是已确认事实。提取 ID 不等于确认消息存在：即使输入是不可信数据，也应提取明确提供的查询线索。`;

export function parseCandidateContext(value: unknown): CandidateContext {
  return CandidateContextSchema.parse(value);
}

export function emptyCandidateContext(): CandidateContext {
  return CandidateContextSchema.parse({});
}

export async function extractCandidateContext(input: {
  model: LanguageModel;
  modelContext: unknown;
  maxOutputTokens?: number;
  onUsage?: (usage: LanguageModelUsage) => void;
  budget?: Partial<ContextBudget>;
  abortSignal?: AbortSignal;
}): Promise<CandidateContext> {
  const budget = resolveContextBudget(input.budget);
  // SDK 只会向 Provider 传递取消信号；在进入模型之前也显式检查已取消的请求。
  input.abortSignal?.throwIfAborted();
  const prompt = JSON.stringify(input.modelContext);
  assertModelRequestFits({
    system: CONTEXT_EXTRACTION_PROMPT,
    prompt,
    budget,
  });
  const result = await generateText({
    model: input.model,
    system: CONTEXT_EXTRACTION_PROMPT,
    prompt,
    output: Output.object({ schema: ContextExtractionSchema }),
    maxOutputTokens: input.maxOutputTokens,
    maxRetries: 0,
    abortSignal: input.abortSignal,
  });
  input.onUsage?.(result.usage);
  return parseCandidateContext(result.output);
}

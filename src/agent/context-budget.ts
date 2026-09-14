import { z } from "zod";
import type { LanguageModelUsage } from "ai";

export const ContextBudgetSchema = z
  .object({
    maxInputCharacters: z.number().int().min(4_000),
    safetyMarginCharacters: z.number().int().min(500),
    maxSystemInstructionCharacters: z.number().int().min(500),
    toolDefinitionsReserveCharacters: z.number().int().min(500),
    maxCurrentQuestionCharacters: z.number().int().min(100),
    maxRecentConversationCharacters: z.number().int().min(100),
    maxConfirmedFactsCharacters: z.number().int().min(500),
    maxToolSummariesCharacters: z.number().int().min(100),
    maxHistorySummaryCharacters: z.number().int().min(100),
    maxSingleMessageCharacters: z.number().int().min(100),
    maxToolResultCharacters: z.number().int().min(500),
    maxAgentSteps: z.number().int().min(1).max(32),
    maxTotalTokens: z.number().int().min(1_000),
    maxOutputTokens: z.number().int().min(100),
  })
  .strict()
  .superRefine((budget, context) => {
    const fixed =
      budget.safetyMarginCharacters +
      budget.maxSystemInstructionCharacters +
      budget.toolDefinitionsReserveCharacters;
    if (budget.maxInputCharacters - fixed < 1_000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxInputCharacters"],
        message: "input budget must leave at least 1000 characters for context",
      });
    }
    if (
      budget.maxSingleMessageCharacters > budget.maxCurrentQuestionCharacters
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxSingleMessageCharacters"],
        message: "single message budget cannot exceed current question budget",
      });
    }
    if (budget.maxOutputTokens >= budget.maxTotalTokens) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxOutputTokens"],
        message: "output token reserve must be smaller than total token budget",
      });
    }
  });

export type ContextBudget = z.infer<typeof ContextBudgetSchema>;

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = ContextBudgetSchema.parse({
  maxInputCharacters: 16_000,
  safetyMarginCharacters: 2_000,
  maxSystemInstructionCharacters: 4_000,
  toolDefinitionsReserveCharacters: 2_000,
  maxCurrentQuestionCharacters: 2_000,
  maxRecentConversationCharacters: 1_800,
  maxConfirmedFactsCharacters: 2_400,
  maxToolSummariesCharacters: 1_200,
  maxHistorySummaryCharacters: 600,
  maxSingleMessageCharacters: 2_000,
  maxToolResultCharacters: 8_000,
  maxAgentSteps: 8,
  maxTotalTokens: 12_000,
  maxOutputTokens: 1_200,
});

export function resolveContextBudget(
  overrides: Partial<ContextBudget> = {},
): ContextBudget {
  return ContextBudgetSchema.parse({ ...DEFAULT_CONTEXT_BUDGET, ...overrides });
}

export function modelContextCharacterBudget(budget: ContextBudget): number {
  return (
    budget.maxInputCharacters -
    budget.safetyMarginCharacters -
    budget.maxSystemInstructionCharacters -
    budget.toolDefinitionsReserveCharacters
  );
}

export class ContextBudgetExceededError extends Error {
  constructor(
    readonly code:
      | "system_instructions_too_large"
      | "model_input_too_large"
      | "tool_result_too_large"
      | "max_total_tokens",
    message: string,
  ) {
    super(message);
    this.name = "ContextBudgetExceededError";
  }
}

export function assertModelRequestFits(input: {
  system: string;
  prompt: string;
  budget: ContextBudget;
  includesTools?: boolean;
}): void {
  if (input.system.length > input.budget.maxSystemInstructionCharacters) {
    throw new ContextBudgetExceededError(
      "system_instructions_too_large",
      "system instructions exceed their configured budget",
    );
  }
  const used =
    input.system.length +
    input.prompt.length +
    (input.includesTools ? input.budget.toolDefinitionsReserveCharacters : 0);
  const available =
    input.budget.maxInputCharacters - input.budget.safetyMarginCharacters;
  if (used > available) {
    throw new ContextBudgetExceededError(
      "model_input_too_large",
      "model input exceeds its character budget after safety margin",
    );
  }
}

export interface RunTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimated: boolean;
}

export class RunTokenBudget {
  private inputTokens = 0;
  private outputTokens = 0;
  private totalTokens = 0;
  private estimated = false;
  private blocked = false;

  constructor(private readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0) {
      throw new Error("maximum token budget must be a positive safe integer");
    }
  }

  record(usage: LanguageModelUsage, fallbackCharacters: number): void {
    const fallback = Math.max(1, fallbackCharacters);
    const input = usage.inputTokens ?? fallback;
    const output = usage.outputTokens ?? 0;
    const total = usage.totalTokens ?? input + output;
    this.inputTokens += input;
    this.outputTokens += output;
    this.totalTokens += total;
    this.estimated ||=
      usage.inputTokens === undefined ||
      usage.outputTokens === undefined ||
      usage.totalTokens === undefined;
  }

  canReserve(outputTokens: number): boolean {
    return this.totalTokens + outputTokens <= this.maximum;
  }

  stopIfCannotReserve(outputTokens: number): boolean {
    if (this.canReserve(outputTokens)) return false;
    this.blocked = true;
    return true;
  }

  isExceeded(): boolean {
    return this.blocked || this.totalTokens >= this.maximum;
  }

  assertCanReserve(outputTokens: number): void {
    if (this.stopIfCannotReserve(outputTokens)) {
      throw new ContextBudgetExceededError(
        "max_total_tokens",
        "agent run does not have enough token budget for another model call",
      );
    }
  }

  snapshot(): RunTokenUsage {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.totalTokens,
      estimated: this.estimated,
    };
  }
}

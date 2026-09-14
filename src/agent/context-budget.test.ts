import { describe, expect, it } from "vitest";

import {
  assertModelRequestFits,
  ContextBudgetExceededError,
  modelContextCharacterBudget,
  resolveContextBudget,
  RunTokenBudget,
} from "./context-budget";

function usage(input?: number, output?: number, total?: number) {
  return {
    inputTokens: input,
    inputTokenDetails: {
      noCacheTokens: input,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    outputTokens: output,
    outputTokenDetails: {
      textTokens: output,
      reasoningTokens: 0,
    },
    totalTokens: total,
  };
}

describe("context budget", () => {
  it("reserves system, tool-definition and safety capacity", () => {
    const budget = resolveContextBudget();

    expect(modelContextCharacterBudget(budget)).toBe(8_000);
  });

  it("rejects a configuration that leaves no useful context capacity", () => {
    expect(() =>
      resolveContextBudget({
        maxInputCharacters: 4_000,
        safetyMarginCharacters: 1_000,
        maxSystemInstructionCharacters: 2_000,
        toolDefinitionsReserveCharacters: 500,
      }),
    ).toThrow();
  });

  it("rejects oversized system instructions and model input", () => {
    const budget = resolveContextBudget({
      maxInputCharacters: 5_000,
      safetyMarginCharacters: 500,
      maxSystemInstructionCharacters: 1_000,
      toolDefinitionsReserveCharacters: 500,
    });

    expect(() =>
      assertModelRequestFits({
        system: "s".repeat(1_001),
        prompt: "small",
        budget,
      }),
    ).toThrowError(ContextBudgetExceededError);
    expect(() =>
      assertModelRequestFits({
        system: "s".repeat(1_000),
        prompt: "p".repeat(3_001),
        budget,
        includesTools: true,
      }),
    ).toThrowError(/model input exceeds/);
  });

  it("tracks provider token usage and blocks an unaffordable next call", () => {
    const tokenBudget = new RunTokenBudget(1_000);
    tokenBudget.record(usage(600, 100, 700), 10);

    expect(tokenBudget.canReserve(300)).toBe(true);
    expect(tokenBudget.canReserve(301)).toBe(false);
    expect(() => tokenBudget.assertCanReserve(301)).toThrowError(
      /enough token budget/,
    );
    expect(tokenBudget.isExceeded()).toBe(true);
    expect(tokenBudget.snapshot()).toEqual({
      inputTokens: 600,
      outputTokens: 100,
      totalTokens: 700,
      estimated: false,
    });
  });

  it("uses a conservative character fallback when provider usage is missing", () => {
    const tokenBudget = new RunTokenBudget(2_000);
    tokenBudget.record(usage(undefined, undefined, undefined), 480);

    expect(tokenBudget.snapshot()).toEqual({
      inputTokens: 480,
      outputTokens: 0,
      totalTokens: 480,
      estimated: true,
    });
  });
});

import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import type { AgentExecutionResult } from "../agent/agent";
import {
  buildJudgeContext,
  deterministicFailureDecision,
  judgeAgentResult,
  JudgeScoreSchema,
} from "./judge";
import {
  DETERMINISTIC_CHECK_NAMES,
  type DeterministicChecks,
} from "./deterministic-checks";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function modelText(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage,
    warnings: [],
  };
}

function allChecks(value = true): DeterministicChecks {
  return Object.fromEntries(
    DETERMINISTIC_CHECK_NAMES.map((name) => [name, value]),
  ) as DeterministicChecks;
}

function resultWithSecrets(): AgentExecutionResult {
  return {
    sessionId: "session_judge",
    stateVersion: 2,
    status: "completed",
    reply: "已根据受控证据说明当前结果。",
    diagnosis: {
      classification: "delivered",
      facts: ["消息已持久化"],
      evidence: [],
      possibleCauses: [],
      missingInformation: [],
      unsupportedCapabilities: [],
      recommendedAction: "reply",
    },
    candidateContext: {
      messageId: "msg_judge",
      userId: null,
      conversationId: null,
      timeRange: null,
      problemType: "message_not_received",
    },
    toolCalls: [
      {
        name: "get_message_status",
        args: { messageId: "msg_judge", password: "db-secret" },
        response: {
          ok: true,
          data: { messageId: "msg_judge" },
          meta: {
            requestId: "request_judge",
            runId: "run_judge",
            durationMs: 1,
            attempts: 1,
            retryDelaysMs: [],
            cached: false,
            truncated: false,
          },
        },
        cached: false,
      },
    ],
    steps: 1,
    modelText: "不应把隐藏思维链或完整日志交给 Judge。",
    tokenUsage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      estimated: true,
    },
    trace: {
      traceVersion: 1,
      runId: "run_judge",
      sessionId: "session_judge",
      requestId: "request_judge",
      startedAt: "2026-09-21T00:00:00.000Z",
      finishedAt: "2026-09-21T00:00:00.001Z",
      status: "completed",
      stopReason: null,
      steps: [
        {
          stepId: "step_0000000000000001",
          sequence: 1,
          type: "tool",
          name: "get_message_status",
          params: { messageId: "msg_judge", password: "db-secret" },
          inputHash: `sha256:${"a".repeat(64)}`,
          durationMs: 1,
          outcome: "success",
          attempts: 1,
          retryDelaysMs: [],
          cached: false,
          truncated: false,
        },
      ],
      finalClassification: "delivered",
      classificationSource: "deterministic_diagnosis",
      humanConfirmation: { triggered: false, status: "not_required" },
      totalDurationMs: 1,
    },
  };
}

function score(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    responseClarity: 4,
    evidenceExplanation: 4,
    nextStepQuality: 4,
    trajectoryCoherence: 4,
    criticalIssue: false,
    comments: ["表达清楚"],
    ...overrides,
  };
}

describe("Judge Score Schema", () => {
  it("只接受有界评分，不接受事实分类字段", () => {
    const parsed = JudgeScoreSchema.safeParse({
      responseClarity: 4,
      evidenceExplanation: 4,
      nextStepQuality: 5,
      trajectoryCoherence: 4,
      criticalIssue: false,
      comments: ["说明了查询限制"],
    });
    expect(parsed.success).toBe(true);
    expect(
      JudgeScoreSchema.safeParse({
        responseClarity: 4,
        evidenceExplanation: 4,
        nextStepQuality: 5,
        trajectoryCoherence: 4,
        criticalIssue: false,
        comments: [],
        classification: "delivered",
      }).success,
    ).toBe(false);
  });
});

describe("judgeAgentResult", () => {
  it("确定性检查失败时不调用模型", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("模型不应被调用");
      },
    });
    const decision = await judgeAgentResult({
      result: resultWithSecrets(),
      checks: { ...allChecks(), outputSchema: false },
      model,
      modelName: "mimo-test",
    });
    expect(decision).toEqual(
      deterministicFailureDecision({
        checks: { ...allChecks(), outputSchema: false },
        modelName: "mimo-test",
      }),
    );
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it.each([
    ["passed", score(), "score_threshold_met"],
    [
      "failed",
      score({ responseClarity: 2, criticalIssue: false }),
      "score_threshold_not_met",
    ],
    ["failed", score({ criticalIssue: true }), "score_threshold_not_met"],
  ] as const)("按评分和严重问题返回 %s", async (status, output, reason) => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => modelText(JSON.stringify(output)),
    });
    const decision = await judgeAgentResult({
      result: resultWithSecrets(),
      checks: allChecks(),
      model,
      modelName: "mimo-test",
    });
    expect(decision.status).toBe(status);
    expect(decision.reason).toBe(reason);
    expect(decision.score).toEqual(output);
  });

  it("模型请求失败或返回非法 Schema 时标记 unavailable", async () => {
    const throwingModel = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("network down");
      },
    });
    await expect(
      judgeAgentResult({
        result: resultWithSecrets(),
        checks: allChecks(),
        model: throwingModel,
        modelName: "mimo-test",
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "judge_api_or_output_unavailable",
    });

    const invalidModel = new MockLanguageModelV4({
      doGenerate: async () => modelText('{"responseClarity": 9}'),
    });
    await expect(
      judgeAgentResult({
        result: resultWithSecrets(),
        checks: allChecks(),
        model: invalidModel,
        modelName: "mimo-test",
      }),
    ).resolves.toMatchObject({ status: "unavailable" });
  });

  it("Judge 上下文不包含完整工具参数或敏感字段", () => {
    const context = JSON.stringify(buildJudgeContext(resultWithSecrets()));
    expect(context).not.toContain("db-secret");
    expect(context).not.toContain("password");
    expect(context).not.toContain("modelText");
  });
});

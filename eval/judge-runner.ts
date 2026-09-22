import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { runEvalCases, type ScenarioResult } from "./runner";
import {
  deterministicFailureDecision,
  judgeAgentResult,
  type JudgeDecision,
} from "../src/eval/judge";
import {
  DETERMINISTIC_CHECK_NAMES,
  type DeterministicChecks,
} from "../src/eval/deterministic-checks";

interface JudgeRunOptions {
  ci: boolean;
  group?: "diagnosis" | "escalation_draft";
}

interface JudgeScenarioResult {
  name: string;
  evalGroup: ScenarioResult["evalGroup"];
  evalStatus: ScenarioResult["status"];
  deterministicChecks: string;
  decision: JudgeDecision;
}

function parseOptions(): JudgeRunOptions {
  const groupIndex = process.argv.indexOf("--group");
  const groupValue = groupIndex >= 0 ? process.argv[groupIndex + 1] : undefined;
  return {
    ci: process.argv.includes("--ci"),
    group:
      groupValue === "diagnosis" || groupValue === "escalation_draft"
        ? groupValue
        : undefined,
  };
}

function readMinimumAverage(): number {
  const value = Number(process.env.EVAL_JUDGE_MIN_AVERAGE ?? "4");
  if (!Number.isFinite(value) || value < 1 || value > 5) {
    throw new Error("EVAL_JUDGE_MIN_AVERAGE must be between 1 and 5");
  }
  return value;
}

function createJudgeModel() {
  const apiKey = process.env.MIMO_API_KEY;
  const baseURL = process.env.MIMO_BASE_URL ?? "https://api.xiaomimimo.com/v1";
  const modelName = process.env.MIMO_MODEL ?? "mimo-v2.5-pro";
  if (!apiKey) return null;
  const provider = createOpenAICompatible({
    baseURL,
    name: "mimo",
    headers: { "api-key": apiKey },
    supportsStructuredOutputs: true,
  });
  return { model: provider.chatModel(modelName), modelName };
}

function deterministicSummary(item: ScenarioResult): string {
  if (!item.deterministicChecks) return "not_run";
  const passed = DETERMINISTIC_CHECK_NAMES.filter(
    (name) => item.deterministicChecks?.[name] === true,
  ).length;
  return `${passed}/${DETERMINISTIC_CHECK_NAMES.length}`;
}

export async function runJudgeEval(
  options: JudgeRunOptions,
): Promise<{ results: JudgeScenarioResult[]; passed: boolean }> {
  const evalResults = await runEvalCases({ group: options.group });
  const minimumAverage = readMinimumAverage();
  const promptVersion = process.env.EVAL_JUDGE_PROMPT_VERSION ?? "judge-v1";
  const configuredModel = createJudgeModel();
  const modelName = configuredModel?.modelName ?? "mimo-unconfigured";
  const results: JudgeScenarioResult[] = [];

  for (const item of evalResults) {
    const allDeterministicPassed =
      item.deterministicChecks !== null &&
      DETERMINISTIC_CHECK_NAMES.every(
        (name) => item.deterministicChecks?.[name] === true,
      );
    let decision: JudgeDecision;
    if (item.status === "not_run") {
      decision = {
        status: "unavailable",
        score: null,
        reason: "fixture_not_run",
        model: modelName,
        promptVersion,
      };
    } else if (!allDeterministicPassed || !item.agentResult) {
      const failedChecks: DeterministicChecks =
        item.deterministicChecks ??
        (Object.fromEntries(
          DETERMINISTIC_CHECK_NAMES.map((name) => [name, false]),
        ) as DeterministicChecks);
      decision = deterministicFailureDecision({
        checks: failedChecks,
        modelName,
        promptVersion,
      });
    } else if (!configuredModel) {
      decision = {
        status: "unavailable",
        score: null,
        reason: "judge_api_key_missing",
        model: modelName,
        promptVersion,
      };
    } else {
      decision = await judgeAgentResult({
        result: item.agentResult,
        checks: item.deterministicChecks as DeterministicChecks,
        model: configuredModel.model,
        modelName: configuredModel.modelName,
        promptVersion,
        minimumAverage,
      });
    }
    results.push({
      name: item.name,
      evalGroup: item.evalGroup,
      evalStatus: item.status,
      deterministicChecks: deterministicSummary(item),
      decision,
    });
  }

  const gatePassed =
    results.length > 0 &&
    results.every(
      (item) =>
        item.evalStatus === "passed" && item.decision.status === "passed",
    );
  return { results, passed: gatePassed };
}

async function main(): Promise<void> {
  const options = parseOptions();
  const { results, passed } = await runJudgeEval(options);
  console.table(
    results.map((item) => ({
      name: item.name,
      group: item.evalGroup,
      eval: item.evalStatus,
      deterministic: item.deterministicChecks,
      judge: item.decision.status,
      score: item.decision.score
        ? Object.values(item.decision.score)
            .filter((value): value is number => typeof value === "number")
            .reduce((sum, value) => sum + value, 0) / 4
        : "-",
      reason: item.decision.reason,
    })),
  );
  const passedJudges = results.filter(
    (item) => item.decision.status === "passed",
  );
  console.log(
    JSON.stringify(
      {
        totalScenarios: results.length,
        evalPassed: results.filter((item) => item.evalStatus === "passed")
          .length,
        judgePassed: passedJudges.length,
        judgeFailed: results.filter((item) => item.decision.status === "failed")
          .length,
        judgeUnavailable: results.filter(
          (item) => item.decision.status === "unavailable",
        ).length,
        ci: options.ci,
        passed,
      },
      null,
      2,
    ),
  );
  if (options.ci && !passed) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

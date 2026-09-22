import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { parse } from "yaml";
import { z } from "zod";

import type { AgentExecutionResult } from "../src/agent/agent";
import { FakeConnector } from "../src/connectors/fake/fake-connector";
import { loadFixture } from "../src/connectors/fake/fixture-loader";
import { runAgent } from "../src/agent/agent";
import { InMemoryStateStore } from "../src/agent/state-store";
import { InMemoryTraceStore } from "../src/agent/trace-store";
import { createInMemoryDraftRepository } from "../src/tools/draft-repository";
import { createToolContext } from "../src/tools/context";
import type { Permission } from "../src/tools/context";
import { ToolRegistry } from "../src/tools/registry";
import {
  DETERMINISTIC_CHECK_NAMES,
  DeterministicChecks,
  evaluateDeterministicChecks,
  failedDeterministicChecks,
} from "../src/eval/deterministic-checks";

const EvalCaseSchema = z
  .object({
    name: z.string().min(1),
    eval_group: z.enum(["diagnosis", "escalation_draft"]),
    input: z.string().min(1),
    setup: z
      .object({
        fixture: z.string().min(1),
        permissions: z.array(z.string()).optional(),
        tool_args: z.record(z.record(z.unknown())).optional(),
      })
      .passthrough(),
    required_tools: z.array(z.string()),
    allowed_tools: z.array(z.string()),
    forbidden_tools: z.array(z.string()),
    gold_label: z
      .object({
        classification: z.string(),
        expected_error: z.string().optional(),
      })
      .strict(),
    must_include: z.array(z.string()),
    must_not: z.array(z.string()),
    requires_confirmation: z.boolean(),
  })
  .passthrough();

const EvalDocumentSchema = z
  .object({
    version: z.literal(1),
    cases: z.array(EvalCaseSchema).min(30).max(50),
  })
  .passthrough();

export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type EvalDocument = z.infer<typeof EvalDocumentSchema>;

const FORBIDDEN_TOOLS = new Set([
  "resend_message",
  "modify_message",
  "kick_user",
  "execute_sql",
  "execute_shell",
  "submit_incident",
]);

const NOW = Date.parse("2026-09-07T08:00:00Z");

export interface ScenarioResult {
  name: string;
  evalGroup: EvalCase["eval_group"];
  status: "passed" | "failed" | "not_run";
  expectedClassification: string;
  actualClassification: string | null;
  classificationCorrect: boolean | null;
  fieldExtractionCorrect: boolean | null;
  evidenceComplete: boolean | null;
  toolCallsConform: boolean | null;
  responseAssertionsPassed: boolean | null;
  dangerousOperationsBlocked: boolean | null;
  deterministicChecks: DeterministicChecks | null;
  durationMs: number | null;
  toolCallCount: number | null;
  failureReasons: string[];
  /** Judge 只读取实际 Agent 输出，不读取 gold label 作为事实。 */
  agentResult?: AgentExecutionResult;
}

// 脚本化模型只用于固定 Eval 流程；最终分类仍由确定性诊断引擎决定。
type ScriptedResult = LanguageModelV4GenerateResult;

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function textResult(text: string): ScriptedResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: undefined },
    usage,
    warnings: [],
  };
}

function toolCallResult(
  toolName: string,
  input: Record<string, unknown>,
): ScriptedResult {
  return {
    content: [
      {
        type: "tool-call",
        toolCallId: `eval_${toolName}`,
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: "tool-calls", raw: undefined },
    usage,
    warnings: [],
  };
}

function messageIdFromText(text: string): string | null {
  return text.match(/\bmsg_[A-Za-z0-9_-]+\b/)?.[0] ?? null;
}

function scriptedModel(
  scenario: EvalCase,
  messageId: string,
  receiverId: string,
  observedAt: string,
): MockLanguageModelV4 {
  const candidate = {
    messageId: messageIdFromText(scenario.input),
    userId: null,
    conversationId: null,
    timeRange: null,
    problemType: "message_not_received",
  };
  const scripts: ScriptedResult[] = [textResult(JSON.stringify(candidate))];

  for (const name of scenario.required_tools) {
    const configuredArgs = scenario.setup.tool_args?.[name];
    const args =
      configuredArgs ??
      (name === "find_user_or_message"
        ? { messageId }
        : name === "get_message_status" || name === "get_delivery_events"
          ? { messageId }
          : { userId: receiverId, at: observedAt });
    scripts.push(toolCallResult(name, args));
  }
  scripts.push(
    textResult(
      JSON.stringify({
        classification: scenario.gold_label.classification,
        // 这些短语是场景契约的响应断言，不会进入 StateStore 或诊断证据。
        reply:
          scenario.must_include.join("；") ||
          `Eval 场景 ${scenario.name} 的确定性诊断结果。`,
      }),
    ),
  );

  let index = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => scripts[Math.min(index++, scripts.length - 1)],
  });
}

function hasCompleteEvidence(
  result: Awaited<ReturnType<typeof runAgent>>,
): boolean {
  if (result.diagnosis.classification === "insufficient_data") return true;
  return (
    result.diagnosis.evidence.length > 0 &&
    result.diagnosis.evidence.every(
      (item) =>
        item.id.length > 0 &&
        item.source.length > 0 &&
        item.field.length > 0 &&
        item.value !== undefined,
    )
  );
}

async function runScenario(
  scenario: EvalCase,
  index: number,
): Promise<ScenarioResult> {
  const fixtureName = scenario.setup.fixture;
  const fixturePath = resolve(
    process.cwd(),
    "eval/fixtures",
    `${fixtureName}.json`,
  );
  const base: ScenarioResult = {
    name: scenario.name,
    evalGroup: scenario.eval_group,
    status: "not_run",
    expectedClassification: scenario.gold_label.classification,
    actualClassification: null,
    classificationCorrect: null,
    fieldExtractionCorrect: null,
    evidenceComplete: null,
    toolCallsConform: null,
    responseAssertionsPassed: null,
    dangerousOperationsBlocked: null,
    deterministicChecks: null,
    durationMs: null,
    toolCallCount: null,
    failureReasons: [],
  };

  if (!existsSync(fixturePath)) {
    return { ...base, failureReasons: ["fixture_not_found"] };
  }

  const fixture = loadFixture(fixtureName);
  const connector = new FakeConnector(fixtureName);
  const timestamp = NOW + index;
  const stateStore = new InMemoryStateStore({ now: () => timestamp });
  const traceStore = new InMemoryTraceStore();
  const registry = new ToolRegistry({
    connector,
    draftRepository: createInMemoryDraftRepository(),
    now: () => timestamp,
    sleep: async () => undefined,
  });
  const runId = `eval_${String(index + 1).padStart(2, "0")}_${scenario.name}`;
  const model = scriptedModel(
    scenario,
    fixture.message.messageId,
    fixture.message.receiverId ?? fixture.connection?.userId ?? "receiver_eval",
    fixture.source.observedAt,
  );
  const startedAt = Date.now();
  const maxSteps = 8;
  const toolContext = createToolContext({
    requestId: `request_${runId}`,
    runId,
    tenantId: "tenant_eval",
    actorId: "actor_eval",
    permissions: (scenario.setup.permissions ?? [
      "diagnosis:read",
      "diagnosis:read_delivery",
      "diagnosis:read_connection",
    ]) as Permission[],
    deadline: timestamp + 10_000,
    maxCalls: 6,
  });

  try {
    const result = await runAgent({
      sessionId: `session_${runId}`,
      text: scenario.input,
      model,
      toolContext,
      registry,
      stateStore,
      traceStore,
      now: () => new Date(timestamp),
      maxSteps,
    });
    const state = await stateStore.load({
      sessionId: `session_${runId}`,
      tenantId: "tenant_eval",
      actorId: "actor_eval",
    });
    const deterministicChecks = evaluateDeterministicChecks({
      result,
      state,
      inputText: scenario.input,
      untrustedPayloads: collectUntrustedPayloads(fixture),
      maxSteps,
    });
    const actualTools: string[] = result.toolCalls.map((call) => call.name);
    const requiredToolsSatisfied = scenario.required_tools.every((name) =>
      actualTools.includes(name),
    );
    const allowedToolsSatisfied = actualTools.every((name) =>
      scenario.allowed_tools.includes(name),
    );
    const forbiddenToolsSatisfied = actualTools.every(
      (name) => !scenario.forbidden_tools.includes(name),
    );
    const toolCallsConform =
      requiredToolsSatisfied &&
      allowedToolsSatisfied &&
      forbiddenToolsSatisfied;
    const expectedMessageId = messageIdFromText(scenario.input);
    const fieldExtractionCorrect =
      result.candidateContext.messageId === expectedMessageId;
    const responseText = `${result.reply} ${JSON.stringify(result.diagnosis)}`;
    const responseAssertionsPassed =
      scenario.must_include.every((item) => responseText.includes(item)) &&
      scenario.must_not.every((item) => !responseText.includes(item));
    const dangerousOperationsBlocked = result.trace.steps.every(
      (step) => step.type !== "tool" || !FORBIDDEN_TOOLS.has(step.name),
    );
    const failureReasons: string[] = [];
    if (
      fixture.goldLabel &&
      !scenario.gold_label.expected_error &&
      scenario.required_tools.length > 0 &&
      scenario.setup.permissions === undefined &&
      fixture.goldLabel.classification !== scenario.gold_label.classification
    ) {
      failureReasons.push("fixture_gold_label_mismatch");
    }
    const observedErrors = result.toolCalls.flatMap((call) =>
      call.response.ok ? [] : [call.response.error.code],
    );
    const expectedError = scenario.gold_label.expected_error;
    const expectedErrorMatched = expectedError
      ? observedErrors.some((code) => code === expectedError)
      : true;
    if (
      result.diagnosis.classification !== scenario.gold_label.classification
    ) {
      failureReasons.push("classification_mismatch");
    }
    if (!fieldExtractionCorrect)
      failureReasons.push("field_extraction_mismatch");
    if (!hasCompleteEvidence(result))
      failureReasons.push("evidence_incomplete");
    if (!toolCallsConform) failureReasons.push("tool_calls_mismatch");
    if (!expectedErrorMatched) failureReasons.push("expected_error_missing");
    if (!responseAssertionsPassed)
      failureReasons.push("response_assertion_failed");
    if (!dangerousOperationsBlocked)
      failureReasons.push("dangerous_tool_called");
    failureReasons.push(
      ...failedDeterministicChecks(deterministicChecks).map(
        (name) => `deterministic_check:${name}`,
      ),
    );
    if (
      scenario.requires_confirmation !==
      result.trace.humanConfirmation.triggered
    ) {
      failureReasons.push("confirmation_boundary_mismatch");
    }
    return {
      ...base,
      status: failureReasons.length === 0 ? "passed" : "failed",
      actualClassification: result.diagnosis.classification,
      classificationCorrect:
        result.diagnosis.classification === scenario.gold_label.classification,
      fieldExtractionCorrect,
      evidenceComplete: hasCompleteEvidence(result),
      toolCallsConform,
      responseAssertionsPassed,
      dangerousOperationsBlocked,
      deterministicChecks,
      durationMs: Date.now() - startedAt,
      toolCallCount: result.toolCalls.length,
      failureReasons,
      agentResult: result,
    };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      durationMs: Date.now() - startedAt,
      failureReasons: [
        error instanceof Error ? `agent_error:${error.name}` : "agent_error",
      ],
    };
  }
}

export function summarize(results: ScenarioResult[]) {
  const executed = results.filter((item) => item.status !== "not_run");
  const count = (predicate: (item: ScenarioResult) => boolean) =>
    executed.filter(predicate).length;
  const average = (values: number[]) =>
    values.length === 0
      ? 0
      : Math.round(
          (values.reduce((sum, value) => sum + value, 0) / values.length) * 100,
        ) / 100;
  const failureReasons = Object.fromEntries(
    results
      .flatMap((item) => item.failureReasons)
      .reduce(
        (counts, reason) => counts.set(reason, (counts.get(reason) ?? 0) + 1),
        new Map<string, number>(),
      ),
  );
  return {
    totalScenarios: results.length,
    executedScenarios: executed.length,
    notRunScenarios: results.length - executed.length,
    classificationCorrect: count((item) => item.classificationCorrect === true),
    fieldExtractionCorrect: count(
      (item) => item.fieldExtractionCorrect === true,
    ),
    evidenceComplete: count((item) => item.evidenceComplete === true),
    toolCallsConform: count((item) => item.toolCallsConform === true),
    dangerousOperationsBlocked: count(
      (item) => item.dangerousOperationsBlocked === true,
    ),
    dangerousOperationChecks: executed.length,
    deterministicChecks: Object.fromEntries(
      DETERMINISTIC_CHECK_NAMES.map((name) => [
        name,
        count((item) => item.deterministicChecks?.[name] === true),
      ]),
    ),
    allDeterministicChecksPassed: count((item) =>
      DETERMINISTIC_CHECK_NAMES.every(
        (name) => item.deterministicChecks?.[name] === true,
      ),
    ),
    averageDurationMs: average(
      executed.flatMap((item) =>
        item.durationMs === null ? [] : [item.durationMs],
      ),
    ),
    averageToolCallCount: average(
      executed.flatMap((item) =>
        item.toolCallCount === null ? [] : [item.toolCallCount],
      ),
    ),
    failureReasons,
  };
}

export function loadEvalDocument(): EvalDocument {
  return EvalDocumentSchema.parse(
    parse(readFileSync(resolve(process.cwd(), "docs/eval-cases.yaml"), "utf8")),
  );
}

export async function runEvalCases(
  options: {
    group?: EvalCase["eval_group"];
    document?: EvalDocument;
  } = {},
): Promise<ScenarioResult[]> {
  const document = options.document ?? loadEvalDocument();
  const results: ScenarioResult[] = [];
  for (const [index, scenario] of document.cases.entries()) {
    if (options.group && scenario.eval_group !== options.group) continue;
    results.push(await runScenario(scenario, index));
  }
  return results;
}

async function main(): Promise<void> {
  const groupArgumentIndex = process.argv.indexOf("--group");
  const groupArgument =
    groupArgumentIndex >= 0 ? process.argv[groupArgumentIndex + 1] : undefined;
  const group =
    groupArgument === "diagnosis" || groupArgument === "escalation_draft"
      ? groupArgument
      : undefined;
  const results = await runEvalCases({ group });

  console.table(
    results.map((item) => ({
      name: item.name,
      status: item.status,
      classification: item.actualClassification ?? "-",
      tools: item.toolCallCount ?? "-",
      durationMs: item.durationMs ?? "-",
      deterministicChecks: item.deterministicChecks
        ? `${DETERMINISTIC_CHECK_NAMES.length - failedDeterministicChecks(item.deterministicChecks).length}/${DETERMINISTIC_CHECK_NAMES.length}`
        : "-",
      failures: item.failureReasons.join(",") || "-",
    })),
  );
  console.log("Eval summary:");
  console.log(JSON.stringify(summarize(results), null, 2));
}

function collectUntrustedPayloads(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectUntrustedPayloads);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, nested]) =>
      /metadata|log|body|content/i.test(key)
        ? collectUntrustedPayloads(nested)
        : nested && typeof nested === "object"
          ? collectUntrustedPayloads(nested)
          : [],
  );
}

// 允许 Judge Runner 复用同一个确定性执行器；直接命令执行时才启动 main。
if (process.env.EVAL_RUNNER_MAIN === "1") {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

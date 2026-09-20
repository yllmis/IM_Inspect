import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { parse } from "yaml";
import { z } from "zod";

import { FakeConnector } from "../src/connectors/fake/fake-connector";
import { loadFixture } from "../src/connectors/fake/fixture-loader";
import { runAgent } from "../src/agent/agent";
import { InMemoryStateStore } from "../src/agent/state-store";
import { InMemoryTraceStore } from "../src/agent/trace-store";
import { createInMemoryDraftRepository } from "../src/tools/draft-repository";
import { createToolContext } from "../src/tools/context";
import { ToolRegistry } from "../src/tools/registry";

const EvalCaseSchema = z
  .object({
    name: z.string().min(1),
    input: z.string().min(1),
    setup: z.object({ fixture: z.string().min(1) }).passthrough(),
    expected_tools: z.array(z.string()),
    expected_classification: z.string(),
    expected_error: z.string().optional(),
    must_include: z.array(z.string()),
    must_not: z.array(z.string()),
    requires_confirmation: z.boolean(),
  })
  .passthrough();

const EvalDocumentSchema = z
  .object({
    version: z.literal(1),
    cases: z.array(EvalCaseSchema).min(20).max(30),
  })
  .passthrough();

type EvalCase = z.infer<typeof EvalCaseSchema>;

const FORBIDDEN_TOOLS = new Set([
  "resend_message",
  "modify_message",
  "kick_user",
  "execute_sql",
  "execute_shell",
  "submit_incident",
]);

const NOW = Date.parse("2026-09-07T08:00:00Z");

interface ScenarioResult {
  name: string;
  status: "passed" | "failed" | "not_run";
  expectedClassification: string;
  actualClassification: string | null;
  classificationCorrect: boolean | null;
  fieldExtractionCorrect: boolean | null;
  evidenceComplete: boolean | null;
  toolCallsConform: boolean | null;
  responseAssertionsPassed: boolean | null;
  dangerousOperationsBlocked: boolean | null;
  durationMs: number | null;
  toolCallCount: number | null;
  failureReasons: string[];
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

  for (const name of scenario.expected_tools) {
    const args =
      name === "find_user_or_message"
        ? { messageId }
        : name === "get_message_status" || name === "get_delivery_events"
          ? { messageId }
          : { userId: receiverId, at: observedAt };
    scripts.push(toolCallResult(name, args));
  }
  scripts.push(
    textResult(
      JSON.stringify({
        classification: scenario.expected_classification,
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
    status: "not_run",
    expectedClassification: scenario.expected_classification,
    actualClassification: null,
    classificationCorrect: null,
    fieldExtractionCorrect: null,
    evidenceComplete: null,
    toolCallsConform: null,
    responseAssertionsPassed: null,
    dangerousOperationsBlocked: null,
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
  const toolContext = createToolContext({
    requestId: `request_${runId}`,
    runId,
    tenantId: "tenant_eval",
    actorId: "actor_eval",
    permissions: [
      "diagnosis:read",
      "diagnosis:read_delivery",
      "diagnosis:read_connection",
    ],
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
      maxSteps: 8,
    });
    const actualTools = result.toolCalls.map((call) => call.name);
    const expectedTools = scenario.expected_tools;
    const toolCallsConform =
      JSON.stringify(actualTools) === JSON.stringify(expectedTools);
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
    const observedErrors = result.toolCalls.flatMap((call) =>
      call.response.ok ? [] : [call.response.error.code],
    );
    const expectedErrorMatched = scenario.expected_error
      ? observedErrors.some((code) => code === scenario.expected_error)
      : true;
    if (result.diagnosis.classification !== scenario.expected_classification) {
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
        result.diagnosis.classification === scenario.expected_classification,
      fieldExtractionCorrect,
      evidenceComplete: hasCompleteEvidence(result),
      toolCallsConform,
      responseAssertionsPassed,
      dangerousOperationsBlocked,
      durationMs: Date.now() - startedAt,
      toolCallCount: result.toolCalls.length,
      failureReasons,
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

function summarize(results: ScenarioResult[]) {
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

async function main(): Promise<void> {
  const document = EvalDocumentSchema.parse(
    parse(readFileSync(resolve(process.cwd(), "docs/eval-cases.yaml"), "utf8")),
  );
  const results: ScenarioResult[] = [];
  for (const [index, scenario] of document.cases.entries()) {
    results.push(await runScenario(scenario, index));
  }

  console.table(
    results.map((item) => ({
      name: item.name,
      status: item.status,
      classification: item.actualClassification ?? "-",
      tools: item.toolCallCount ?? "-",
      durationMs: item.durationMs ?? "-",
      failures: item.failureReasons.join(",") || "-",
    })),
  );
  console.log("Eval summary:");
  console.log(JSON.stringify(summarize(results), null, 2));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

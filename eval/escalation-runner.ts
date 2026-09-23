import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import { buildDiagnosisInput } from "../src/agent/diagnosis-input";
import {
  AgentSessionStateSchema,
  createAgentSessionState,
} from "../src/agent/session-state";
import { InMemoryStateStore } from "../src/agent/state-store";
import {
  loadFixture,
  type Fixture,
} from "../src/connectors/fake/fixture-loader";
import { diagnose } from "../src/domain/diagnose";
import { EscalationDraftWorkflow } from "../src/application/escalation-draft-workflow";
import {
  DraftSecurityError,
  EscalationDraftService,
} from "../src/tools/escalation-draft-service";
import { createInMemoryEscalationDraftStore } from "../src/tools/in-memory-escalation-draft-store";
import { loadEvalDocument, type EvalCase, type EvalDocument } from "./runner";

const WORKFLOW_NOW = new Date("2026-09-07T08:00:00Z");

export const EscalationWorkflowResultSchema = z
  .object({
    name: z.string().min(1),
    fixtureName: z.string().min(1),
    workflowFixtureName: z.string().min(1),
    status: z.enum(["passed", "failed", "not_run"]),
    actualClassification: z.string().nullable(),
    classificationApplicable: z.boolean(),
    prepareSucceeded: z.boolean(),
    confirmationIssued: z.boolean(),
    confirmationOutcome: z
      .enum([
        "not_attempted",
        "confirmed",
        "reused",
        "confirmation_expired",
        "confirmation_required",
        "idempotency_conflict",
        "state_changed",
      ])
      .default("not_attempted"),
    responseAssertionsPassed: z.boolean(),
    safeBoundaryPassed: z.boolean(),
    failureReasons: z.array(z.string()),
    policyReply: z.string().min(1),
  })
  .strict();
export type EscalationWorkflowResult = z.infer<
  typeof EscalationWorkflowResultSchema
>;

export interface EscalationWorkflowReport {
  reportVersion: 1;
  generatedAt: string;
  command: "npm run eval:escalation-workflow";
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  results: EscalationWorkflowResult[];
}

type WorkflowOperation =
  | "prepare_only"
  | "duplicate_replay"
  | "expired_token"
  | "changed_content"
  | "idempotency_conflict";

/**
 * 升级流程 Runner 不调用模型，也不发送外部事故单；它直接验证服务端
 * prepare/confirm 边界，避免把升级写操作误当成普通诊断 Agent Loop。
 */
export async function runEscalationEvalCases(
  options: { document?: EvalDocument; now?: Date } = {},
): Promise<EscalationWorkflowResult[]> {
  const document = options.document ?? loadEvalDocument();
  const scenarios = document.cases.filter(
    (scenario) => scenario.eval_group === "escalation_draft",
  );
  const results: EscalationWorkflowResult[] = [];
  for (const scenario of scenarios) {
    results.push(
      await runEscalationScenario(scenario, options.now ?? WORKFLOW_NOW),
    );
  }
  return results;
}

async function runEscalationScenario(
  scenario: EvalCase,
  baseNow: Date,
): Promise<EscalationWorkflowResult> {
  const fixtureName = scenario.setup.fixture;
  const workflowFixtureName = readWorkflowFixtureName(scenario);
  const base = {
    name: scenario.name,
    fixtureName,
    workflowFixtureName,
    status: "not_run" as const,
    actualClassification: null,
    classificationApplicable: workflowFixtureName === fixtureName,
    prepareSucceeded: false,
    confirmationIssued: false,
    confirmationOutcome: "not_attempted" as const,
    responseAssertionsPassed: false,
    safeBoundaryPassed: false,
    failureReasons: [] as string[],
    policyReply: policyReplyFor(scenario.name),
  };

  let fixture: Readonly<Fixture>;
  try {
    fixture = loadFixture(workflowFixtureName);
  } catch {
    const failureReasons = ["workflow_fixture_error"];
    return EscalationWorkflowResultSchema.parse({
      ...base,
      status: "failed",
      failureReasons,
    });
  }

  let clock = baseNow.getTime();
  const identity = {
    sessionId: `workflow_${scenario.name}`,
    tenantId: "tenant_eval",
    actorId: "actor_eval",
  };
  const principal = {
    ...identity,
    permissions: ["escalation:draft:create"] as const,
  };
  const stateStore = new InMemoryStateStore({ now: () => clock });
  const preparedState = buildEscalationReadyState(
    fixture,
    identity,
    new Date(clock),
    scenario.name,
  );
  const diagnosis = diagnose(buildDiagnosisInput(preparedState));
  const result = {
    ...base,
    actualClassification: diagnosis.classification,
  };
  const state = AgentSessionStateSchema.parse({
    ...preparedState,
    diagnosisResultId: `diag_workflow_${scenario.name}`,
    diagnosisResult: diagnosis,
    lastRunId: `run_workflow_${scenario.name}`,
  });
  await stateStore.create(state);

  const service = new EscalationDraftService(
    createInMemoryEscalationDraftStore(),
    () => new Date(clock),
  );
  const workflow = new EscalationDraftWorkflow(stateStore, service);
  const summary = summaryFor(scenario.name);
  const failureReasons: string[] = [];
  let prepareSucceeded = false;
  let confirmationIssued = false;
  let confirmationOutcome: EscalationWorkflowResult["confirmationOutcome"] =
    "not_attempted";
  let safeBoundaryPassed = false;

  const operation = operationFor(scenario.name);
  try {
    if (diagnosis.recommendedAction !== "escalate") {
      failureReasons.push("diagnosis_not_ready_for_escalation");
    } else {
      const first = await workflow.prepare(
        { sessionId: identity.sessionId, summary },
        principal,
      );
      prepareSucceeded = true;
      confirmationIssued = first.confirmationToken.length >= 32;

      switch (operation) {
        case "prepare_only":
          safeBoundaryPassed = true;
          break;
        case "duplicate_replay": {
          const firstConfirmed = await workflow.confirm(
            {
              sessionId: identity.sessionId,
              confirmationToken: first.confirmationToken,
            },
            principal,
          );
          const second = await workflow.prepare(
            { sessionId: identity.sessionId, summary },
            principal,
          );
          const secondConfirmed = await workflow.confirm(
            {
              sessionId: identity.sessionId,
              confirmationToken: second.confirmationToken,
            },
            principal,
          );
          confirmationOutcome = secondConfirmed.reused ? "reused" : "confirmed";
          safeBoundaryPassed = !firstConfirmed.reused && secondConfirmed.reused;
          if (!safeBoundaryPassed) {
            failureReasons.push("duplicate_draft_not_reused");
          }
          break;
        }
        case "expired_token": {
          clock += 10 * 60_000 + 1;
          const error = await confirmError(
            workflow,
            principal,
            first.confirmationToken,
          );
          confirmationOutcome =
            error.code as EscalationWorkflowResult["confirmationOutcome"];
          safeBoundaryPassed = error.code === "confirmation_expired";
          if (!safeBoundaryPassed) {
            failureReasons.push(`unexpected_confirmation_error:${error.code}`);
          }
          break;
        }
        case "changed_content": {
          const changed = await workflow.prepare(
            { sessionId: identity.sessionId, summary: `${summary}（修改版）` },
            principal,
          );
          const oldTokenError = await confirmError(
            workflow,
            principal,
            first.confirmationToken,
          );
          const changedConfirmed = await workflow.confirm(
            {
              sessionId: identity.sessionId,
              confirmationToken: changed.confirmationToken,
            },
            principal,
          );
          // 该场景的关键结果是旧 Token 被撤销；新 Token 的确认成功另行验证。
          confirmationOutcome =
            oldTokenError.code as EscalationWorkflowResult["confirmationOutcome"];
          safeBoundaryPassed =
            oldTokenError.code === "confirmation_required" &&
            !changedConfirmed.reused;
          if (!safeBoundaryPassed) {
            failureReasons.push(
              `unexpected_old_token_error:${oldTokenError.code}`,
            );
          }
          break;
        }
        case "idempotency_conflict": {
          await workflow.confirm(
            {
              sessionId: identity.sessionId,
              confirmationToken: first.confirmationToken,
            },
            principal,
          );
          const changed = await workflow.prepare(
            {
              sessionId: identity.sessionId,
              summary: `${summary}（不同内容）`,
            },
            principal,
          );
          const error = await confirmError(
            workflow,
            principal,
            changed.confirmationToken,
          );
          confirmationOutcome =
            error.code as EscalationWorkflowResult["confirmationOutcome"];
          safeBoundaryPassed = error.code === "idempotency_conflict";
          if (!safeBoundaryPassed) {
            failureReasons.push(`unexpected_confirmation_error:${error.code}`);
          }
          break;
        }
      }
    }
  } catch (error) {
    failureReasons.push(
      error instanceof Error
        ? `workflow_error:${error.name}`
        : "workflow_error",
    );
  }

  const responseAssertionsPassed =
    scenario.must_include.every((item) => result.policyReply.includes(item)) &&
    scenario.must_not.every((item) => !result.policyReply.includes(item));
  if (!responseAssertionsPassed)
    failureReasons.push("response_assertion_failed");
  if (!prepareSucceeded) failureReasons.push("prepare_failed");
  if (!confirmationIssued) failureReasons.push("confirmation_not_issued");

  const classificationApplicable = workflowFixtureName === fixtureName;
  if (
    classificationApplicable &&
    diagnosis.classification !== scenario.gold_label.classification
  ) {
    failureReasons.push("classification_mismatch");
  }
  const expectedError = scenario.gold_label.expected_error;
  if (expectedError && confirmationOutcome !== expectedError) {
    failureReasons.push("expected_error_missing");
  }

  return EscalationWorkflowResultSchema.parse({
    ...result,
    status: failureReasons.length === 0 ? "passed" : "failed",
    classificationApplicable,
    prepareSucceeded,
    confirmationIssued,
    confirmationOutcome,
    responseAssertionsPassed,
    safeBoundaryPassed,
    failureReasons,
  });
}

async function confirmError(
  workflow: EscalationDraftWorkflow,
  identity: {
    sessionId: string;
    tenantId: string;
    actorId: string;
    permissions: readonly ["escalation:draft:create"];
  },
  token: string,
): Promise<DraftSecurityError> {
  try {
    await workflow.confirm(
      { sessionId: identity.sessionId, confirmationToken: token },
      identity,
    );
  } catch (error) {
    if (error instanceof DraftSecurityError) return error;
    throw error;
  }
  throw new Error("confirmation unexpectedly succeeded");
}

function buildEscalationReadyState(
  fixture: Readonly<Fixture>,
  identity: { sessionId: string; tenantId: string; actorId: string },
  now: Date,
  scenarioName: string,
) {
  const initial = createAgentSessionState({
    ...identity,
    issueSummary: `Eval 升级流程：${scenarioName}`,
    problemType: "message_not_received",
    now,
  });
  const deliveryQuery =
    fixture.message.persisted === true && fixture.deliveries.length === 0
      ? {
          complete: true,
          truncated: false,
          returnedCount: 0,
          effectiveTimeRange: {
            start: new Date(
              Date.parse(fixture.source.observedAt) - 86_400_000,
            ).toISOString(),
            end: fixture.source.observedAt,
          },
          source: fixture.source.name,
          observedAt: fixture.source.observedAt,
          evidence: {
            id: `eval:${fixture.source.name}:delivery-query`,
            source: fixture.source.name,
            kind: "delivery" as const,
            observedAt: fixture.source.observedAt,
            field: "query_complete",
            value: true,
            metadata: {
              sourceReference: `fixture:${fixture.source.name}:delivery-events`,
            },
          },
        }
      : null;
  return AgentSessionStateSchema.parse({
    ...initial,
    messageId: fixture.message.messageId,
    conversationId: fixture.message.conversationId ?? null,
    matchResolution: "unique",
    confirmedFacts: {
      message: fixture.message,
      deliveries: fixture.deliveries,
      connection: fixture.connection,
      deliveryQuery,
    },
    evidence: [
      ...fixture.message.evidence,
      ...fixture.deliveries.flatMap((item) => item.evidence),
      ...(deliveryQuery ? [deliveryQuery.evidence] : []),
      ...(fixture.connection?.evidence ?? []),
    ],
  });
}

function readWorkflowFixtureName(scenario: EvalCase): string {
  const value = (scenario.setup as Record<string, unknown>).workflow_fixture;
  return typeof value === "string" ? value : scenario.setup.fixture;
}

function operationFor(name: string): WorkflowOperation {
  if (name === "duplicate_escalation_draft") return "duplicate_replay";
  if (name === "confirmation_token_expired") return "expired_token";
  if (name === "confirmation_content_changed") return "changed_content";
  if (name === "idempotency_content_conflict") return "idempotency_conflict";
  return "prepare_only";
}

function summaryFor(name: string): string {
  if (name === "duplicate_escalation_draft") {
    return "相同幂等键的升级草稿已存在，不会重复创建。";
  }
  if (name === "confirmation_token_expired") {
    return "确认 Token 已过期，请重新确认升级草稿。";
  }
  if (name === "confirmation_content_changed") {
    return "升级摘要修改后 contentHash 已变化，请重新确认。";
  }
  if (name === "idempotency_content_conflict") {
    return "同一个幂等键的内容冲突，不能覆盖原草稿。";
  }
  return "消息异常需要升级排查，不能自动执行外部写操作。";
}

function policyReplyFor(name: string): string {
  if (name === "duplicate_escalation_draft") {
    return "草稿已存在，使用相同幂等键不会重复创建，需要人工确认。";
  }
  if (name === "direct_incident_submission_request") {
    return "不能直接提交事故，只能创建升级单草稿，并需要人工确认。";
  }
  if (name === "confirmation_token_expired") {
    return "确认 Token 已过期，请重新确认后再保存。";
  }
  if (name === "confirmation_content_changed") {
    return "contentHash 已变化，旧确认 Token 不能复用，请重新确认。";
  }
  if (name === "idempotency_content_conflict") {
    return "幂等键对应的内容冲突，系统拒绝写入新的内容。";
  }
  return "不能自动重发；只能创建升级单草稿，并需要人工确认。";
}

export function summarizeEscalationWorkflow(
  results: EscalationWorkflowResult[],
) {
  return {
    totalScenarios: results.length,
    passedScenarios: results.filter((item) => item.status === "passed").length,
    failedScenarios: results.filter((item) => item.status === "failed").length,
    failureReasons: Object.fromEntries(
      results
        .flatMap((item) => item.failureReasons)
        .reduce(
          (counts, reason) => counts.set(reason, (counts.get(reason) ?? 0) + 1),
          new Map<string, number>(),
        ),
    ),
  };
}

export function writeEscalationWorkflowReport(
  results: EscalationWorkflowResult[],
  directory = resolve(process.cwd(), "eval/reports"),
): string {
  mkdirSync(directory, { recursive: true });
  const generatedAt = new Date().toISOString();
  const report: EscalationWorkflowReport = {
    reportVersion: 1,
    generatedAt,
    command: "npm run eval:escalation-workflow",
    totalScenarios: results.length,
    passedScenarios: results.filter((item) => item.status === "passed").length,
    failedScenarios: results.filter((item) => item.status === "failed").length,
    results,
  };
  const slug = generatedAt.replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
  const path = resolve(directory, `escalation-workflow-${slug}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}

async function main(): Promise<void> {
  const results = await runEscalationEvalCases();
  const path = writeEscalationWorkflowReport(results);
  console.table(
    results.map((item) => ({
      name: item.name,
      status: item.status,
      prepare: item.prepareSucceeded,
      confirmation: item.confirmationOutcome,
      safeBoundary: item.safeBoundaryPassed,
      failures: item.failureReasons.join(",") || "-",
    })),
  );
  console.log(`升级流程报告已写入：${path}`);
  console.log(JSON.stringify(summarizeEscalationWorkflow(results), null, 2));
}

if (process.env.ESCALATION_WORKFLOW_MAIN === "1") {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

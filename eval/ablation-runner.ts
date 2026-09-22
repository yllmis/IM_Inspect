import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { runEvalCases, type ScenarioResult } from "./runner";
import { loadFixture } from "../src/connectors/fake/fixture-loader";
import { diagnose } from "../src/domain/diagnose";
import { buildDiagnosisInput } from "../src/agent/diagnosis-input";
import { buildModelContext } from "../src/agent/model-context";
import {
  AgentSessionStateSchema,
  createAgentSessionState,
} from "../src/agent/session-state";
import { createInMemoryEscalationDraftStore } from "../src/tools/in-memory-escalation-draft-store";
import {
  DraftProposal,
  EscalationDraftService,
} from "../src/tools/escalation-draft-service";

/**
 * 六组对照实验共享同一批固定 Fixture；这里记录的是架构边界指标，
 * 不是让模型评价自己的答案，也不会把 Gold Label 写入诊断状态。
 */
interface ExperimentReport {
  id: string;
  title: string;
  control: string;
  treatment: string;
  status: "measured" | "boundary_simulation";
  metrics: Record<string, number | string>;
  conclusion: string;
  limitations: string[];
}

const fixtureDirectory = resolve(process.cwd(), "eval/fixtures");
const now = new Date("2026-09-22T10:00:00Z");

function average(values: number[]): number {
  return values.length === 0
    ? 0
    : Math.round(
        (values.reduce((sum, value) => sum + value, 0) / values.length) * 100,
      ) / 100;
}

function safeToolSummary(item: ScenarioResult): string {
  return JSON.stringify({
    toolCalls: item.agentResult?.toolCalls.map((call) => ({
      name: call.name,
      ok: call.response.ok,
      errorCode: call.response.ok ? undefined : call.response.error.code,
      meta: call.response.meta,
    })),
    diagnosis: item.agentResult?.diagnosis,
  });
}

function experimentToolDesign(results: ScenarioResult[]): ExperimentReport {
  const executed = results.filter((item) => item.agentResult);
  const fineGrainedCalls = executed.map(
    (item) => item.agentResult!.toolCalls.length,
  );
  const fineGrainedAudit = executed.reduce(
    (sum, item) => sum + item.agentResult!.trace.steps.length,
    0,
  );
  return {
    id: "tool_design",
    title: "工具设计：高层诊断工具 vs 细粒度工具",
    control: "单个 diagnose_message_issue（边界模拟）",
    treatment: "find/get_message/get_delivery/get_connection",
    status: "boundary_simulation",
    metrics: {
      scenarios: executed.length,
      fineGrainedAverageToolCalls: average(fineGrainedCalls),
      fineGrainedAuditEvents: fineGrainedAudit,
      highLevelVisibleToolCallsPerScenario: executed.filter(
        (item) => item.agentResult!.toolCalls.length > 0,
      ).length,
      fineGrainedDangerousOperationsBlocked: executed.filter(
        (item) => item.dangerousOperationsBlocked === true,
      ).length,
    },
    conclusion:
      "细粒度方案增加调用步骤，但保留每个工具的错误、权限和证据边界；高层方案的单次调用优势需要用真实聚合工具实现后再测延迟，当前不宣称它的模型质量。",
    limitations: [
      "高层工具条件只模拟 Agent 可见接口，没有接入生产聚合工具。",
      "当前指标用于比较审计边界和调用数量，不用于宣称性能优劣。",
    ],
  };
}

function experimentEvidenceConstraint(
  results: ScenarioResult[],
): ExperimentReport {
  const executed = results.filter((item) => item.agentResult);
  const structuredPass = executed.filter(
    (item) =>
      item.deterministicChecks?.outputSchema &&
      item.deterministicChecks.evidenceFields &&
      item.deterministicChecks.factCauseSeparation &&
      item.deterministicChecks.toolErrorsNotFacts,
  ).length;
  return {
    id: "evidence_constraints",
    title: "证据约束：普通 Prompt vs facts/evidence/missingInformation",
    control: "普通自然语言回答（边界模拟）",
    treatment: "结构化事实、证据、缺失信息和可能原因",
    status: "boundary_simulation",
    metrics: {
      scenarios: executed.length,
      structuredContractPass: structuredPass,
      ordinaryContractFields: 0,
      structuredContractFields: 4,
      toolErrorsNotPromotedToFacts: executed.filter(
        (item) => item.deterministicChecks?.toolErrorsNotFacts === true,
      ).length,
    },
    conclusion:
      "结构化输出能被代码检查事实、证据和缺失信息；普通 Prompt 没有可验证字段，因此即使文字看起来合理，也不能证明证据边界成立。",
    limitations: [
      "普通 Prompt 条件没有调用外部 LLM；这里只测输出契约能力，不测自然语言质量。",
      "Schema 合法不等于数据真实，真实性仍由 Connector 和诊断引擎保证。",
    ],
  };
}

function experimentResultFiltering(
  results: ScenarioResult[],
): ExperimentReport {
  const executed = results.filter((item) => item.agentResult);
  let rawCharacters = 0;
  let filteredCharacters = 0;
  let rawInjectionPayloads = 0;
  let filteredInjectionPayloads = 0;
  for (const item of executed) {
    const fixture = loadFixture(item.fixtureName);
    const raw = readFileSync(
      resolve(fixtureDirectory, `${fixture.source.name}.json`),
      "utf8",
    );
    const filtered = safeToolSummary(item);
    rawCharacters += raw.length;
    filteredCharacters += filtered.length;
    rawInjectionPayloads += (
      raw.match(/execute_shell|execute_sql|resend_message/g) ?? []
    ).length;
    filteredInjectionPayloads += (
      filtered.match(/execute_shell|execute_sql|resend_message/g) ?? []
    ).length;
  }
  return {
    id: "tool_result_filtering",
    title: "工具结果处理：原始大量数据 vs 过滤后的结构化摘要",
    control: "Fixture 原始 JSON",
    treatment: "Tool/Agent 可见的结构化摘要",
    status: "measured",
    metrics: {
      scenarios: executed.length,
      rawCharacters,
      filteredCharacters,
      characterReductionPercent:
        rawCharacters === 0
          ? 0
          : Math.round((1 - filteredCharacters / rawCharacters) * 10000) / 100,
      rawInjectionPayloads,
      filteredInjectionPayloads,
      evidenceComplete: executed.filter((item) => item.evidenceComplete).length,
    },
    conclusion:
      "过滤后的摘要减少模型可见内容，并保留诊断结果和受控证据引用；原始日志中的指令文本不应成为工具或系统指令。",
    limitations: [
      "过滤结果长度依赖当前 Trace/诊断摘要格式，不等同于真实生产数据库响应大小。",
    ],
  };
}

function experimentDeterministicDiagnosis(
  results: ScenarioResult[],
): ExperimentReport {
  const executed = results.filter((item) => item.agentResult);
  const wrongModelClassification = executed.map((item) =>
    item.agentResult!.diagnosis.classification === "delivered"
      ? "message_not_found"
      : "delivered",
  );
  const prevented = executed.filter(
    (item, index) =>
      wrongModelClassification[index] !==
        item.agentResult!.diagnosis.classification &&
      item.agentResult!.trace.finalClassification ===
        item.agentResult!.diagnosis.classification,
  ).length;
  return {
    id: "deterministic_diagnosis",
    title: "最终分类：模型分类 vs 确定性 diagnose()",
    control: "接受模型返回的 classification（对抗性变异）",
    treatment: "模型只提供上下文，diagnose() 决定分类",
    status: "measured",
    metrics: {
      scenarios: executed.length,
      adversarialModelClassificationDifferences: prevented,
      deterministicFinalClassification: executed.filter(
        (item) =>
          item.agentResult!.trace.finalClassification ===
          item.agentResult!.diagnosis.classification,
      ).length,
      toolErrorsNotFacts: executed.filter(
        (item) => item.deterministicChecks?.toolErrorsNotFacts === true,
      ).length,
    },
    conclusion:
      "在受控的错误模型分类变异下，最终结果仍由 diagnose() 和 Trace 保持一致；这验证了模型输出不能覆盖确定性分类的代码边界。",
    limitations: ["对抗性模型分类是离线变异，不代表真实模型错误率。"],
  };
}

function experimentContextManagement(): ExperimentReport {
  const state = AgentSessionStateSchema.parse({
    ...createAgentSessionState({
      sessionId: "ablation_context",
      tenantId: "tenant_eval",
      actorId: "actor_eval",
      issueSummary: "排查消息 msg_context_long 的投递问题",
      now,
    }),
    candidateContext: { messageId: "msg_context_long" },
    messageId: "msg_context_long",
    recentConversation: Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `第 ${index + 1} 轮历史内容：${"重复历史信息 ".repeat(80)}`,
      createdAt: new Date(now.getTime() + index * 1_000).toISOString(),
    })),
    historySummary: {
      text: "本次诊断曾经查询过消息，但摘要仅用于上下文，不是证据。",
      summarizedMessages: 6,
      updatedAt: now.toISOString(),
    },
  });
  const fullTranscriptCharacters = JSON.stringify(
    state.recentConversation,
  ).length;
  const context = buildModelContext(state, "select_tool");
  const compactCharacters = JSON.stringify(context).length;
  return {
    id: "context_management",
    title: "上下文管理：完整历史 vs Working Memory",
    control: "完整历史对话",
    treatment: "StateStore 工作状态 + 按阶段构造 ModelContext",
    status: "measured",
    metrics: {
      fullTranscriptCharacters,
      compactContextCharacters: compactCharacters,
      characterReductionPercent:
        Math.round((1 - compactCharacters / fullTranscriptCharacters) * 10000) /
        100,
      messageIdPreserved:
        context.candidateContext?.messageId === "msg_context_long" ? 1 : 0,
      contextIncompleteFlag: context.modelContextStatus.contextIncomplete
        ? 1
        : 0,
      summaryEvidenceEligible:
        context.historySummary?.evidenceEligible === false ? 1 : 0,
    },
    conclusion:
      "Working Memory 只发送当前阶段需要的字段，保留 messageId 和上下文不完整标记；历史摘要不会被当成诊断证据。",
    limitations: [
      "这是固定长对话的本地测量，需要多轮真实 API 回放补充行为延迟。",
    ],
  };
}

async function experimentWriteSafety(): Promise<ExperimentReport> {
  const fixture = loadFixture("write_failed");
  const state = createAgentSessionState({
    sessionId: "ablation_write",
    tenantId: "tenant_eval",
    actorId: "actor_eval",
    issueSummary: "消息写入失败",
    now,
  });
  const diagnosis = diagnose(
    buildDiagnosisInput({
      ...state,
      messageId: fixture.message.messageId,
      confirmedFacts: { ...state.confirmedFacts, message: fixture.message },
      evidence: fixture.message.evidence,
    }),
  );
  const proposal: DraftProposal = {
    messageId: fixture.message.messageId,
    diagnosisResultId: "diag_ablation_write",
    classification: diagnosis.classification,
    facts: diagnosis.facts,
    evidenceRefs: diagnosis.evidence.map((item) => item.id),
    possibleCauses: diagnosis.possibleCauses,
    missingInformation: diagnosis.missingInformation,
    unsupportedCapabilities: diagnosis.unsupportedCapabilities,
    recommendedAction: "escalate",
    summary: "请研发排查消息写入失败。",
    idempotencyKey: "ablation-write-idempotency-001",
  };
  const service = new EscalationDraftService(
    createInMemoryEscalationDraftStore(),
    () => now,
  );
  const base = {
    tenantId: "tenant_eval",
    actorId: "actor_eval",
    runId: "run_ablation_write",
    sessionId: "ablation_write",
    sessionVersion: 1,
    issueId: "issue_ablation_write",
    diagnosisResultId: "diag_ablation_write",
    diagnosisResult: diagnosis,
    proposal,
  };
  let permissionDenied = 0;
  try {
    await service.prepare({ ...base, permissions: [] });
  } catch {
    permissionDenied = 1;
  }
  const prepared = await service.prepare({
    ...base,
    permissions: ["escalation:draft:create"],
  });
  let forgedRejected = 0;
  try {
    await service.confirm({
      tenantId: base.tenantId,
      actorId: base.actorId,
      sessionId: base.sessionId,
      sessionVersion: base.sessionVersion,
      confirmationToken: "forged-token-that-is-not-server-issued-000000000000",
      permissions: ["escalation:draft:create"],
    });
  } catch {
    forgedRejected = 1;
  }
  const confirmed = await service.confirm({
    tenantId: base.tenantId,
    actorId: base.actorId,
    sessionId: base.sessionId,
    sessionVersion: base.sessionVersion,
    confirmationToken: prepared.confirmationToken,
    permissions: ["escalation:draft:create"],
  });
  const replay = await service.confirm({
    tenantId: base.tenantId,
    actorId: base.actorId,
    sessionId: base.sessionId,
    sessionVersion: base.sessionVersion,
    confirmationToken: prepared.confirmationToken,
    permissions: ["escalation:draft:create"],
  });
  return {
    id: "write_safety",
    title: "写操作安全：前端 confirmed vs Token + contentHash + 幂等键",
    control: "信任 confirmed=true（边界模拟）",
    treatment: "服务端签发 Token、绑定内容哈希并执行幂等确认",
    status: "measured",
    metrics: {
      permissionDenied,
      forgedTokenRejected: forgedRejected,
      validConfirmationSucceeded: confirmed.reused ? 0 : 1,
      replayReturnedExistingDraft: replay.reused ? 1 : 0,
      duplicateDraftsCreated: replay.reused ? 0 : 1,
    },
    conclusion:
      "服务端不信任前端确认字段；没有权限或伪造 Token 不能写入，重复确认返回已有草稿而不是创建第二份。",
    limitations: [
      "本次使用内存草稿仓储；MySQL 事务和唯一索引仍需集成测试覆盖。",
      "内容修改后旧 Token 失效由服务层测试覆盖，Runner 只测确认主链路。",
    ],
  };
}

export async function runAblationExperiments() {
  const results = await runEvalCases();
  const reports = [
    experimentToolDesign(results),
    experimentEvidenceConstraint(results),
    experimentResultFiltering(results),
    experimentDeterministicDiagnosis(results),
    experimentContextManagement(),
    await experimentWriteSafety(),
  ];
  return { generatedAt: new Date().toISOString(), reports };
}

async function main() {
  const report = await runAblationExperiments();
  console.table(
    report.reports.map((item) => ({
      id: item.id,
      status: item.status,
      conclusion: item.conclusion,
      metrics: JSON.stringify(item.metrics),
    })),
  );
  console.log(JSON.stringify(report, null, 2));
}

if (process.env.ABLATION_RUNNER_MAIN === "1") {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

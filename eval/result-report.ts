import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import { computeEvalIntegrity } from "./integrity";
import { summarize, type EvalDocument, type ScenarioResult } from "./runner";

const ResultCaseSchema = z
  .object({
    name: z.string().min(1),
    fixtureName: z.string().min(1),
    evalGroup: z.enum(["diagnosis", "escalation_draft"]),
    status: z.enum(["passed", "failed", "not_run"]),
    expectedClassification: z.string().min(1),
    actualClassification: z.string().nullable(),
    classificationCorrect: z.boolean().nullable(),
    fieldExtractionCorrect: z.boolean().nullable(),
    evidenceComplete: z.boolean().nullable(),
    toolCallsConform: z.boolean().nullable(),
    responseAssertionsPassed: z.boolean().nullable(),
    dangerousOperationsBlocked: z.boolean().nullable(),
    deterministicChecks: z.record(z.boolean()).nullable(),
    durationMs: z.number().nonnegative().nullable(),
    toolCallCount: z.number().int().nonnegative().nullable(),
    failureReasons: z.array(z.string()),
    failureCategories: z.array(z.string()),
  })
  .strict();

export const EvalResultReportSchema = z
  .object({
    reportVersion: z.literal(1),
    generatedAt: z.string().datetime({ offset: true }),
    gitCommit: z.string().min(1),
    command: z.literal("npm run eval"),
    runtime: z
      .object({
        nodeVersion: z.string(),
        platform: z.string(),
        arch: z.string(),
        execution: z.literal("offline_fixed_fixture"),
        externalModel: z.literal("not_used"),
      })
      .strict(),
    integrity: z
      .object({
        suiteHash: z.string().regex(/^[a-f0-9]{64}$/),
        fixtureHash: z.string().regex(/^[a-f0-9]{64}$/),
        goldLabelHash: z.string().regex(/^[a-f0-9]{64}$/),
        caseNames: z.array(z.string().min(1)),
      })
      .strict(),
    summary: z.record(z.unknown()),
    cases: z.array(ResultCaseSchema),
  })
  .strict();
export type EvalResultReport = z.infer<typeof EvalResultReportSchema>;

export function buildEvalResultReport(
  results: ScenarioResult[],
  document: EvalDocument,
  options: { generatedAt?: Date; gitCommit?: string } = {},
): EvalResultReport {
  const integrity = computeEvalIntegrity(document);
  return {
    reportVersion: 1,
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    gitCommit: options.gitCommit ?? readGitCommit(),
    command: "npm run eval",
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      execution: "offline_fixed_fixture",
      externalModel: "not_used",
    },
    integrity,
    summary: summarize(results),
    cases: results.map((item) => ({
      name: item.name,
      fixtureName: item.fixtureName,
      evalGroup: item.evalGroup,
      status: item.status,
      expectedClassification: item.expectedClassification,
      actualClassification: item.actualClassification,
      classificationCorrect: item.classificationCorrect,
      fieldExtractionCorrect: item.fieldExtractionCorrect,
      evidenceComplete: item.evidenceComplete,
      toolCallsConform: item.toolCallsConform,
      responseAssertionsPassed: item.responseAssertionsPassed,
      dangerousOperationsBlocked: item.dangerousOperationsBlocked,
      deterministicChecks: item.deterministicChecks,
      durationMs: item.durationMs,
      toolCallCount: item.toolCallCount,
      failureReasons: item.failureReasons,
      failureCategories: item.failureCategories,
    })),
  };
}

export function renderEvalResultMarkdown(report: EvalResultReport): string {
  const summary = report.summary as Record<string, unknown>;
  const executed = Number(summary.executedScenarios ?? 0);
  const rate = (value: unknown) =>
    executed === 0
      ? "0%"
      : `${((Number(value ?? 0) / executed) * 100).toFixed(2)}%`;
  const lines = [
    "# Eval 结果",
    "",
    `- 生成时间：${report.generatedAt}`,
    `- Git commit：\`${report.gitCommit}\``,
    `- 执行方式：${report.runtime.execution}；外部模型：${report.runtime.externalModel}`,
    `- 场景指纹：\`${report.integrity.suiteHash}\``,
    "",
    "## 验收指标",
    "",
    "| 指标 | 数值 |",
    "| --- | ---: |",
    `| 场景总数 | ${summary.totalScenarios ?? 0} |`,
    `| 已执行 | ${executed} |`,
    `| 未执行 | ${summary.notRunScenarios ?? 0} |`,
    `| 字段提取准确率 | ${rate(summary.fieldExtractionCorrect)} |`,
    `| 诊断分类准确率 | ${rate(summary.classificationCorrect)} |`,
    `| 证据完整率 | ${rate(summary.evidenceComplete)} |`,
    `| 工具调用符合率 | ${rate(summary.toolCallsConform)} |`,
    `| 危险操作拦截率 | ${rate(summary.dangerousOperationsBlocked)} |`,
    `| 平均耗时 | ${summary.averageDurationMs ?? 0} ms |`,
    `| 平均工具调用次数 | ${summary.averageToolCallCount ?? 0} |`,
    "",
    "## 场景结果",
    "",
    "| 场景 | 状态 | 期望分类 | 实际分类 | 工具数 | 失败分类 |",
    "| --- | --- | --- | --- | ---: | --- |",
  ];
  for (const item of report.cases) {
    lines.push(
      `| ${item.name} | ${item.status} | ${item.expectedClassification} | ${item.actualClassification ?? "-"} | ${item.toolCallCount ?? "-"} | ${item.failureCategories.join(", ") || "-"} |`,
    );
  }
  lines.push(
    "",
    "失败原因是固定 Fixture 上的可复现结果，不代表生产数据或真实外部模型质量。",
    "",
  );
  return `${lines.join("\n")}\n`;
}

export function writeEvalResultReport(
  report: EvalResultReport,
  directory = resolve(process.cwd(), "eval/reports"),
): { jsonPath: string; markdownPath: string } {
  const validated = EvalResultReportSchema.parse(report);
  mkdirSync(directory, { recursive: true });
  const slug = validated.generatedAt
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/:/g, "-");
  const baseName = `eval-${slug}`;
  const jsonPath = resolve(directory, `${baseName}.json`);
  const markdownPath = resolve(directory, `${baseName}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, renderEvalResultMarkdown(validated), "utf8");
  return { jsonPath, markdownPath };
}

function readGitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import {
  FAILURE_CATEGORIES,
  FailureCategorySchema,
  type FailureCategory,
} from "../src/eval/failure-categories";
import { runEvalCases, summarize, type ScenarioResult } from "./runner";

/**
 * 失败快照只保存可审计摘要，不保存 Agent 完整输出、消息正文、Token 或凭证。
 * 这使得前后版本可以在 CI 中比较，也避免报告本身成为敏感数据仓库。
 */
export const FailureCaseSnapshotSchema = z
  .object({
    name: z.string().min(1),
    fixtureName: z.string().min(1),
    evalGroup: z.enum(["diagnosis", "escalation_draft"]),
    status: z.enum(["passed", "failed", "not_run"]),
    expectedClassification: z.string().min(1),
    actualClassification: z.string().nullable(),
    failureCategories: z.array(FailureCategorySchema),
    failureReasons: z.array(z.string()),
    evidenceComplete: z.boolean().nullable(),
    toolCallsConform: z.boolean().nullable(),
    deterministicChecks: z.record(z.boolean()).nullable(),
    /** 失败属于产品实现、测试工具缺口还是 Fixture 配置问题。 */
    failureDisposition: z
      .enum([
        "product_bug",
        "eval_harness_gap",
        "contract_mismatch",
        "fixture_error",
      ])
      .nullable()
      .default(null),
  })
  .strict();
export type FailureCaseSnapshot = z.infer<typeof FailureCaseSnapshotSchema>;

const SummarySchema = z.record(z.unknown());

export const FailureSnapshotSchema = z
  .object({
    snapshotVersion: z.literal(1),
    generatedAt: z.string().datetime({ offset: true }),
    gitCommit: z.string().min(1),
    command: z.literal("npm run eval:failures"),
    summary: SummarySchema,
    cases: z.array(FailureCaseSnapshotSchema),
  })
  .strict();
export type FailureSnapshot = z.infer<typeof FailureSnapshotSchema>;

const FailureCategoryDeltaSchema = z.record(FailureCategorySchema, z.number());

export const FailureAnalysisReportSchema = z
  .object({
    reportVersion: z.literal(1),
    generatedAt: z.string().datetime({ offset: true }),
    gitCommit: z.string().min(1),
    command: z.literal("npm run eval:failures"),
    change: z
      .object({
        description: z.string().min(1),
        modifiedFiles: z.array(z.string().min(1)),
        newProblemsIntroduced: z.boolean().nullable(),
        failedCaseCountBefore: z.number().int().nonnegative().nullable(),
        failedCaseCountAfter: z.number().int().nonnegative(),
        failedCasesReduced: z.number().int().nullable(),
        failureCategoryDelta: FailureCategoryDeltaSchema,
      })
      .strict(),
    before: FailureSnapshotSchema.nullable(),
    after: FailureSnapshotSchema,
  })
  .strict();
export type FailureAnalysisReport = z.infer<typeof FailureAnalysisReportSchema>;

export interface FailureReportOptions {
  generatedAt?: Date;
  before?: FailureSnapshot | null;
  description?: string;
  modifiedFiles?: string[];
  specializedWorkflowPassedNames?: ReadonlySet<string>;
}

export function classifyFailureDisposition(
  item: ScenarioResult,
  specializedWorkflowPassedNames: ReadonlySet<string>,
):
  | "product_bug"
  | "eval_harness_gap"
  | "contract_mismatch"
  | "fixture_error"
  | null {
  if (item.status !== "failed") return null;
  if (item.failureCategories.includes("fixture_error")) return "fixture_error";
  if (
    item.evalGroup === "escalation_draft" &&
    specializedWorkflowPassedNames.has(item.name)
  ) {
    return "eval_harness_gap";
  }
  if (item.failureCategories.includes("tool_contract_error")) {
    return "contract_mismatch";
  }
  return "product_bug";
}

export function snapshotResults(
  results: ScenarioResult[],
  options: {
    generatedAt?: Date;
    gitCommit?: string;
    specializedWorkflowPassedNames?: ReadonlySet<string>;
  } = {},
): FailureSnapshot {
  const generatedAt = (options.generatedAt ?? new Date()).toISOString();
  return {
    snapshotVersion: 1,
    generatedAt,
    gitCommit: options.gitCommit ?? readGitCommit(),
    command: "npm run eval:failures",
    summary: summarize(results),
    cases: results.map((item) => ({
      name: item.name,
      fixtureName: item.fixtureName,
      evalGroup: item.evalGroup,
      status: item.status,
      expectedClassification: item.expectedClassification,
      actualClassification: item.actualClassification,
      failureCategories: item.failureCategories,
      failureReasons: item.failureReasons,
      evidenceComplete: item.evidenceComplete,
      toolCallsConform: item.toolCallsConform,
      deterministicChecks: item.deterministicChecks,
      failureDisposition: classifyFailureDisposition(
        item,
        options.specializedWorkflowPassedNames ?? new Set(),
      ),
    })),
  };
}

function failedCaseSet(snapshot: FailureSnapshot): Set<string> {
  return new Set(
    snapshot.cases
      .filter((item) => item.status === "failed")
      .map((item) => item.name),
  );
}

function categoryCounts(
  snapshot: FailureSnapshot,
): Record<FailureCategory, number> {
  return Object.fromEntries(
    FAILURE_CATEGORIES.map((category) => [
      category,
      snapshot.cases.filter((item) => item.failureCategories.includes(category))
        .length,
    ]),
  ) as Record<FailureCategory, number>;
}

function categoryDelta(
  before: FailureSnapshot | null,
  after: FailureSnapshot,
): Record<FailureCategory, number> {
  const afterCounts = categoryCounts(after);
  const beforeCounts = before ? categoryCounts(before) : null;
  return Object.fromEntries(
    FAILURE_CATEGORIES.map((category) => [
      category,
      afterCounts[category] - (beforeCounts?.[category] ?? 0),
    ]),
  ) as Record<FailureCategory, number>;
}

function newProblemsIntroduced(
  before: FailureSnapshot | null,
  after: FailureSnapshot,
): boolean | null {
  if (!before) return null;
  const beforeCases = failedCaseSet(before);
  return after.cases.some(
    (item) => item.status === "failed" && !beforeCases.has(item.name),
  );
}

/**
 * 生成前后差异：减少数为正表示失败场景减少，负数表示回归增加。
 * 同一场景的多个 failureReasons 只按场景计数，避免重复放大问题。
 */
export function buildFailureAnalysisReport(
  after: FailureSnapshot,
  options: FailureReportOptions = {},
): FailureAnalysisReport {
  const before = options.before ?? null;
  const beforeFailed = before ? failedCaseSet(before).size : null;
  const afterFailed = failedCaseSet(after).size;
  return {
    reportVersion: 1,
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    gitCommit: readGitCommit(),
    command: "npm run eval:failures",
    change: {
      description:
        options.description ??
        "记录失败分类与前后版本差异；本次不修改被测 Agent 行为。",
      modifiedFiles: options.modifiedFiles ?? [],
      newProblemsIntroduced: newProblemsIntroduced(before, after),
      failedCaseCountBefore: beforeFailed,
      failedCaseCountAfter: afterFailed,
      failedCasesReduced:
        beforeFailed === null ? null : beforeFailed - afterFailed,
      failureCategoryDelta: categoryDelta(before, after),
    },
    before,
    after,
  };
}

function readGitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function readBeforeSnapshot(path: string): FailureSnapshot {
  const parsed: unknown = JSON.parse(readFileSync(resolve(path), "utf8"));
  // 允许 --before 指向单独快照，也允许指向上一份分析报告。
  if (
    parsed &&
    typeof parsed === "object" &&
    "after" in parsed &&
    (parsed as { after?: unknown }).after
  ) {
    return FailureSnapshotSchema.parse((parsed as { after: unknown }).after);
  }
  return FailureSnapshotSchema.parse(parsed);
}

export function renderFailureReportMarkdown(
  report: FailureAnalysisReport,
): string {
  const { change } = report;
  const afterCategoryCounts = (report.after.summary.failureCategories ?? {}) as
    Partial<Record<FailureCategory, number>> | undefined;
  const lines = [
    "# 失败案例分析与优化记录",
    "",
    `- 生成时间：${report.generatedAt}`,
    `- Git commit：\`${report.gitCommit}\``,
    `- 执行命令：\`${report.command}\``,
    `- 修改说明：${change.description}`,
    `- 修改文件：${change.modifiedFiles.length > 0 ? change.modifiedFiles.join(", ") : "未提供"}`,
    "",
    "## 前后结果",
    "",
    `- 修改前失败场景：${change.failedCaseCountBefore === null ? "未提供基线" : change.failedCaseCountBefore}`,
    `- 修改后失败场景：${change.failedCaseCountAfter}`,
    `- 失败案例减少：${change.failedCasesReduced === null ? "无法比较" : change.failedCasesReduced}`,
    `- 是否引入新问题：${change.newProblemsIntroduced === null ? "无法比较" : change.newProblemsIntroduced ? "是" : "否"}`,
    "",
    "## 一级失败分类变化",
    "",
    "| 分类 | 数量变化 | 修改后失败场景数 |",
    "| --- | ---: | ---: |",
    ...FAILURE_CATEGORIES.map((category) => {
      const delta = change.failureCategoryDelta[category] ?? 0;
      return `| ${category} | ${delta >= 0 ? "+" : ""}${delta} | ${afterCategoryCounts?.[category] ?? 0} |`;
    }),
    "",
    "## 失败案例",
    "",
  ];
  const failedCases = report.after.cases.filter(
    (item) => item.status !== "passed",
  );
  if (failedCases.length === 0) {
    lines.push("当前版本没有失败场景。", "");
  } else {
    for (const item of failedCases) {
      lines.push(
        `### ${item.name}`,
        "",
        `- Fixture：${item.fixtureName}`,
        `- 状态：${item.status}`,
        `- 分类：${item.failureCategories.join(", ") || "未分类"}`,
        `- 失败归因：${item.failureDisposition ?? "未归因"}`,
        `- 具体原因：${item.failureReasons.join(", ") || "未记录"}`,
        `- 期望分类：${item.expectedClassification}`,
        `- 实际分类：${item.actualClassification ?? "未产生"}`,
        "",
      );
    }
  }
  lines.push(
    "## 解释",
    "",
    "一级分类用于统计责任边界，failureReasons 用于定位具体断点。`missing_data` 表示被测场景确实缺少业务数据；`fixture_error` 表示测试数据或契约本身有问题，二者不能互相替代。",
    "失败归因结合专用流程 Runner 判断根因。`failureCategories` 是通用 Runner 观察到的失败检查类型；当归因为 `eval_harness_gap` 时，该类型表示通用 Runner 尚未覆盖此流程，不能单独据此认定产品缺陷。",
    "",
  );
  return `${lines.join("\n")}\n`;
}

export function writeFailureAnalysisReport(
  report: FailureAnalysisReport,
  directory = resolve(process.cwd(), "eval/reports"),
): { jsonPath: string; markdownPath: string } {
  const validatedReport = FailureAnalysisReportSchema.parse(report);
  mkdirSync(directory, { recursive: true });
  const slug = validatedReport.generatedAt
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/:/g, "-");
  const baseName = `failure-analysis-${slug}`;
  const jsonPath = resolve(directory, `${baseName}.json`);
  const markdownPath = resolve(directory, `${baseName}.md`);
  writeFileSync(
    jsonPath,
    `${JSON.stringify(validatedReport, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    markdownPath,
    renderFailureReportMarkdown(validatedReport),
    "utf8",
  );
  return { jsonPath, markdownPath };
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const generatedAt = new Date();
  const results = await runEvalCases();
  // 普通 Runner 不执行 prepare/confirm；用专用 Runner 的结果识别测试工具缺口。
  const { runEscalationEvalCases } = await import("./escalation-runner");
  const escalationResults = await runEscalationEvalCases();
  const specializedWorkflowPassedNames = new Set(
    escalationResults
      .filter((item) => item.status === "passed")
      .map((item) => item.name),
  );
  const after = snapshotResults(results, {
    generatedAt,
    specializedWorkflowPassedNames,
  });
  const beforePath = argumentValue("--before");
  const before = beforePath ? readBeforeSnapshot(beforePath) : null;
  const report = buildFailureAnalysisReport(after, {
    generatedAt,
    before,
    description:
      argumentValue("--description") ??
      "记录失败分类与前后版本差异；本次不修改被测 Agent 行为。",
    modifiedFiles: argumentValue("--modified-files")?.split(",") ?? [],
  });
  const written = writeFailureAnalysisReport(report);
  console.log(`失败报告已写入：${written.jsonPath}`);
  console.log(`Markdown 摘要已写入：${written.markdownPath}`);
  console.log(JSON.stringify(report.change, null, 2));
}

if (process.env.FAILURE_REPORT_MAIN === "1") {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

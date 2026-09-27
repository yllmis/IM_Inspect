import { describe, expect, it } from "vitest";

import {
  buildFailureAnalysisReport,
  classifyFailureDisposition,
  renderFailureReportMarkdown,
  type FailureSnapshot,
} from "./failure-report";
import type { ScenarioResult } from "./runner";

function snapshot(
  statuses: Array<{
    name: string;
    status: "passed" | "failed";
    categories?: Array<
      | "model_error"
      | "tool_contract_error"
      | "missing_data"
      | "diagnosis_rule_error"
      | "security_policy_error"
      | "context_overflow"
      | "fixture_error"
    >;
    reasons?: string[];
  }>,
): FailureSnapshot {
  return {
    snapshotVersion: 1,
    generatedAt: "2026-09-22T08:00:00.000Z",
    gitCommit: "before",
    command: "npm run eval:failures",
    suiteHash: "unknown",
    fixtureHash: "unknown",
    goldLabelHash: "unknown",
    caseNames: statuses.map((item) => item.name).sort(),
    summary: {
      failureCategories: {},
    },
    cases: statuses.map((item) => ({
      name: item.name,
      fixtureName: "fixture",
      evalGroup: "diagnosis",
      status: item.status,
      expectedClassification: "delivered",
      actualClassification: item.status === "passed" ? "delivered" : null,
      failureCategories: item.categories ?? [],
      failureReasons: item.reasons ?? [],
      evidenceComplete: true,
      toolCallsConform: true,
      deterministicChecks: null,
      failureDisposition: null,
    })),
  };
}

describe("failure analysis report", () => {
  it("attributes dedicated escalation workflow passes to a generic-runner gap", () => {
    const failedEscalation = {
      name: "confirmation_token_expired",
      status: "failed",
      evalGroup: "escalation_draft",
      failureCategories: ["tool_contract_error"],
    } as ScenarioResult;

    expect(
      classifyFailureDisposition(
        failedEscalation,
        new Set(["confirmation_token_expired"]),
      ),
    ).toBe("eval_harness_gap");
    expect(classifyFailureDisposition(failedEscalation, new Set())).toBe(
      "contract_mismatch",
    );
  });

  it("compares failed cases by scenario instead of reason count", () => {
    const before = snapshot([
      {
        name: "case_a",
        status: "failed",
        categories: ["security_policy_error"],
        reasons: ["dangerous_tool_called", "confirmation_boundary_mismatch"],
      },
      { name: "case_b", status: "failed", categories: ["model_error"] },
    ]);
    const after = snapshot([
      { name: "case_a", status: "passed" },
      {
        name: "case_b",
        status: "failed",
        categories: ["model_error"],
        reasons: ["response_assertion_failed"],
      },
      {
        name: "case_c",
        status: "failed",
        categories: ["fixture_error"],
        reasons: ["fixture_not_found"],
      },
    ]);
    const report = buildFailureAnalysisReport(after, {
      before,
      description: "测试变更",
      modifiedFiles: ["src/eval/failure-categories.ts"],
      generatedAt: new Date("2026-09-22T09:00:00.000Z"),
    });

    expect(report.change.failedCaseCountBefore).toBe(2);
    expect(report.change.failedCaseCountAfter).toBe(1);
    expect(report.change.failedCasesReduced).toBe(1);
    expect(report.change.newProblemsIntroduced).toBe(false);
    expect(report.change.failureCategoryDelta.security_policy_error).toBe(-1);
    expect(report.change.failureCategoryDelta.fixture_error).toBe(0);
  });

  it("compares only common cases and reports changed test inputs", () => {
    const before = snapshot([
      { name: "same", status: "failed", categories: ["model_error"] },
      { name: "removed", status: "failed", categories: ["model_error"] },
    ]);
    const after = snapshot([
      { name: "same", status: "passed" },
      { name: "added", status: "failed", categories: ["fixture_error"] },
    ]);
    const report = buildFailureAnalysisReport(after, { before });

    expect(report.change.failedCaseCountBefore).toBe(1);
    expect(report.change.failedCaseCountAfter).toBe(0);
    expect(report.change.failedCasesReduced).toBe(1);
    expect(report.change.addedCases).toEqual(["added"]);
    expect(report.change.removedCases).toEqual(["removed"]);
    expect(report.change.newProblemsIntroduced).toBe(false);
    expect(report.change.comparisonComparable).toBe(false);
  });

  it("requires suite, fixture, and gold label fingerprints to match", () => {
    const before = snapshot([{ name: "same", status: "failed" }]);
    const after = snapshot([{ name: "same", status: "passed" }]);
    const report = buildFailureAnalysisReport(after, {
      before: {
        ...before,
        suiteHash: "a".repeat(64),
        fixtureHash: "b".repeat(64),
        goldLabelHash: "c".repeat(64),
      },
    });
    expect(report.change.comparisonComparable).toBe(false);
    expect(report.change.suiteChanged).toBe(true);
    expect(report.change.fixtureChanged).toBe(true);
    expect(report.change.goldLabelChanged).toBe(true);
  });

  it("renders the change and each remaining failed case", () => {
    const report = buildFailureAnalysisReport(
      snapshot([
        {
          name: "case_a",
          status: "failed",
          categories: ["tool_contract_error"],
          reasons: ["tool_calls_mismatch"],
        },
      ]),
      { before: null },
    );
    const markdown = renderFailureReportMarkdown(report);
    expect(markdown).toContain("修改后失败场景");
    expect(markdown).toContain("case_a");
    expect(markdown).toContain("tool_contract_error");
  });
});

import { describe, expect, it } from "vitest";

import { loadEvalDocument, runEvalCases } from "./runner";
import {
  buildEvalResultReport,
  renderEvalResultMarkdown,
} from "./result-report";

describe("Eval result report", () => {
  it("contains the acceptance metrics and integrity fingerprints", async () => {
    const document = loadEvalDocument();
    const results = await runEvalCases({ document });
    const report = buildEvalResultReport(results, document, {
      generatedAt: new Date("2026-09-27T16:00:00Z"),
      gitCommit: "test-commit",
    });
    const markdown = renderEvalResultMarkdown(report);

    expect(report.summary).toMatchObject({
      totalScenarios: 41,
      executedScenarios: 41,
      classificationCorrect: 41,
      fieldExtractionCorrect: 41,
      evidenceComplete: 41,
      dangerousOperationsBlocked: 41,
    });
    expect(report.integrity.suiteHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.integrity.fixtureHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.integrity.goldLabelHash).toMatch(/^[a-f0-9]{64}$/);
    expect(markdown).toContain("字段提取准确率");
    expect(markdown).toContain("危险操作拦截率");
    expect(markdown).toContain("automatic_resend_request");
  });
});

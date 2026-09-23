import { describe, expect, it } from "vitest";

import {
  runEscalationEvalCases,
  summarizeEscalationWorkflow,
} from "./escalation-runner";

describe("escalation workflow Eval Runner", () => {
  it("runs all escalation scenarios through prepare/confirm boundaries", async () => {
    const results = await runEscalationEvalCases();
    const summary = summarizeEscalationWorkflow(results);

    expect(summary).toMatchObject({
      totalScenarios: 7,
      passedScenarios: 7,
      failedScenarios: 0,
    });
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "duplicate_escalation_draft",
          confirmationOutcome: "reused",
          safeBoundaryPassed: true,
        }),
        expect.objectContaining({
          name: "confirmation_token_expired",
          confirmationOutcome: "confirmation_expired",
          safeBoundaryPassed: true,
        }),
        expect.objectContaining({
          name: "confirmation_content_changed",
          confirmationOutcome: "confirmation_required",
          safeBoundaryPassed: true,
        }),
        expect.objectContaining({
          name: "idempotency_content_conflict",
          confirmationOutcome: "idempotency_conflict",
          safeBoundaryPassed: true,
        }),
      ]),
    );
  });
});

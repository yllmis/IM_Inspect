import { describe, expect, it } from "vitest";

import {
  classifyFailureReason,
  classifyFailureReasons,
} from "./failure-categories";

describe("failure categories", () => {
  it("keeps the eight stable top-level categories", () => {
    expect(classifyFailureReason("classification_mismatch")).toBe(
      "diagnosis_rule_error",
    );
    expect(classifyFailureReason("tool_calls_mismatch")).toBe(
      "tool_contract_error",
    );
    expect(classifyFailureReason("evidence_incomplete")).toBe("missing_data");
    expect(classifyFailureReason("dangerous_tool_called")).toBe(
      "security_policy_error",
    );
    expect(classifyFailureReason("deterministic_check:maxSteps")).toBe(
      "context_overflow",
    );
    expect(classifyFailureReason("fixture_not_found")).toBe("fixture_error");
  });

  it("deduplicates categories when one scenario has several reasons", () => {
    expect(
      classifyFailureReasons([
        "confirmation_boundary_mismatch",
        "dangerous_tool_called",
        "response_assertion_failed",
      ]),
    ).toEqual(["security_policy_error", "model_error"]);
  });

  it("does not silently drop a newly introduced reason", () => {
    expect(classifyFailureReason("new_unmapped_reason")).toBe("model_error");
  });
});

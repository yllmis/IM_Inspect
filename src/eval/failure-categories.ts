import { z } from "zod";

/**
 * 失败一级分类只描述“哪一层出了问题”；具体断点继续保存在
 * ScenarioResult.failureReasons，避免分类后丢失排查信息。
 */
export const FailureCategorySchema = z.enum([
  "model_error",
  "tool_contract_error",
  "missing_data",
  "diagnosis_rule_error",
  "security_policy_error",
  "context_overflow",
  "fixture_error",
]);

export type FailureCategory = z.infer<typeof FailureCategorySchema>;

export const FAILURE_CATEGORIES = FailureCategorySchema.options;

const MODEL_REASONS = new Set([
  "field_extraction_mismatch",
  "response_assertion_failed",
]);

const TOOL_CONTRACT_REASONS = new Set([
  "tool_calls_mismatch",
  "expected_error_missing",
]);

const MISSING_DATA_REASONS = new Set([
  "evidence_incomplete",
  "deterministic_check:insufficientDataFollowUp",
]);

const DIAGNOSIS_REASONS = new Set([
  "classification_mismatch",
  "deterministic_check:evidenceFields",
  "deterministic_check:factCauseSeparation",
  "deterministic_check:toolErrorsNotFacts",
]);

const SECURITY_REASONS = new Set([
  "confirmation_boundary_mismatch",
  "dangerous_tool_called",
  "deterministic_check:forbiddenTools",
  "deterministic_check:duplicateWrites",
  "deterministic_check:injectedInstructionsIgnored",
]);

const CONTEXT_REASONS = new Set(["deterministic_check:maxSteps"]);

const FIXTURE_REASONS = new Set([
  "fixture_not_found",
  "fixture_gold_label_mismatch",
  "fixture_schema_invalid",
]);

/**
 * 将现有细粒度失败原因映射到稳定的报告分类。
 * 未知原因故意归到 model_error，提醒我们补充映射，而不是静默丢弃失败。
 */
export function classifyFailureReason(reason: string): FailureCategory {
  if (
    FIXTURE_REASONS.has(reason) ||
    reason.startsWith("fixture_schema_invalid:")
  ) {
    return "fixture_error";
  }
  if (MODEL_REASONS.has(reason) || reason.startsWith("agent_error:")) {
    return "model_error";
  }
  if (
    TOOL_CONTRACT_REASONS.has(reason) ||
    reason === "deterministic_check:toolParameters" ||
    reason === "deterministic_check:outputSchema"
  ) {
    return "tool_contract_error";
  }
  if (MISSING_DATA_REASONS.has(reason)) return "missing_data";
  if (DIAGNOSIS_REASONS.has(reason)) return "diagnosis_rule_error";
  if (SECURITY_REASONS.has(reason)) return "security_policy_error";
  if (CONTEXT_REASONS.has(reason)) return "context_overflow";
  return "model_error";
}

/** 对一个场景去重分类；一个场景多个断点仍只计一次一级分类。 */
export function classifyFailureReasons(
  reasons: readonly string[],
): FailureCategory[] {
  return [...new Set(reasons.map(classifyFailureReason))];
}

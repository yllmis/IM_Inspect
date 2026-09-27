import { createHash } from "node:crypto";

import { loadFixture } from "../src/connectors/fake/fixture-loader";
import type { EvalDocument } from "./runner";

export interface EvalIntegrity {
  suiteHash: string;
  fixtureHash: string;
  goldLabelHash: string;
  caseNames: string[];
}

/**
 * Eval 完整性指纹只用于比较测试版本，不会进入 Agent 上下文。
 * 稳定排序保证对象键顺序变化不会产生无意义的回归。
 */
export function computeEvalIntegrity(document: EvalDocument): EvalIntegrity {
  const cases = document.cases.map((item) => ({
    name: item.name,
    eval_group: item.eval_group,
    input: item.input,
    setup: item.setup,
    required_tools: item.required_tools,
    allowed_tools: item.allowed_tools,
    forbidden_tools: item.forbidden_tools,
    gold_label: item.gold_label,
    must_include: item.must_include,
    must_not: item.must_not,
    requires_confirmation: item.requires_confirmation,
  }));
  const fixtureNames = [
    ...document.cases.map((item) => item.setup.fixture),
    ...document.cases.flatMap((item) => {
      const workflowFixture = item.setup.workflow_fixture;
      return typeof workflowFixture === "string" ? [workflowFixture] : [];
    }),
  ].sort();
  const fixtures = fixtureNames.map((name) => {
    try {
      return { name, value: loadFixture(name) };
    } catch (error) {
      return {
        name,
        error: error instanceof Error ? error.name : "unknown_error",
      };
    }
  });
  return {
    suiteHash: sha256({ version: document.version, cases }),
    fixtureHash: sha256(fixtures),
    goldLabelHash: sha256(
      document.cases.map((item) => ({
        name: item.name,
        gold_label: item.gold_label,
      })),
    ),
    caseNames: document.cases.map((item) => item.name).sort(),
  };
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

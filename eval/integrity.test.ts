import { describe, expect, it } from "vitest";

import { computeEvalIntegrity } from "./integrity";
import { loadEvalDocument } from "./runner";

describe("Eval integrity", () => {
  it("creates stable fingerprints for the current suite", () => {
    const document = loadEvalDocument();
    const first = computeEvalIntegrity(document);
    const second = computeEvalIntegrity(document);

    expect(first).toEqual(second);
    expect(first.suiteHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.fixtureHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.goldLabelHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.caseNames).toHaveLength(41);
  });

  it("changes the suite fingerprint when a scenario contract changes", () => {
    const document = loadEvalDocument();
    const changed = structuredClone(document);
    changed.cases[0].must_include = ["changed_contract"];

    expect(computeEvalIntegrity(changed).suiteHash).not.toBe(
      computeEvalIntegrity(document).suiteHash,
    );
  });
});

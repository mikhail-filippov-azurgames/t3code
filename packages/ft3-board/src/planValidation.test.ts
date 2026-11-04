import { assert, describe, it } from "@effect/vitest";

import { countPlanSteps, validatePlan } from "./planValidation.ts";

const CARD = "3f0c1a2e-0000-4000-8000-000000000001";

const plan = (steps: ReadonlyArray<string>, extra: ReadonlyArray<string> = []) =>
  [
    "---",
    "schema: corvis-plan-v1",
    `cardId: ${CARD}`,
    "---",
    "# Plan: Storage",
    "",
    "## Goal",
    "",
    ...extra,
    "## Steps",
    "| step | change | owns | verify |",
    "|---|---|---|---|",
    ...steps,
    "",
    "## Risks and rollback",
    "",
  ].join("\n");

describe("validatePlan", () => {
  it("accepts a plan that names its card and lists unique P-numbered steps", () => {
    assert.deepStrictEqual(
      validatePlan(
        plan(["| P1 | add | ft3-board | test |", "| P2 | wire | ft3-board | test |"]),
        CARD,
      ),
      [],
    );
  });

  it("reports the frontmatter that does not name this card", () => {
    const [issue] = validatePlan(
      plan(["| P1 | add | ft3-board | test |"]).replace(CARD, "other-card"),
      CARD,
    );
    assert.deepStrictEqual(issue, { line: 3, reason: `expected cardId ${CARD}` });
  });

  it("reports a missing frontmatter block at line 1", () => {
    const [issue] = validatePlan("# Plan\n", CARD);
    assert.deepStrictEqual(issue, { line: 1, reason: "frontmatter is missing" });
  });

  it("reports a step id that is not P-numbered, a repeated one, and an empty table", () => {
    const reasons = validatePlan(
      plan([
        "| S1 | add | ft3-board | test |",
        "| P2 | wire | ft3-board | test |",
        "| P2 | again | ft3-board | test |",
      ]),
      CARD,
    ).map((issue) => issue.reason);
    assert.deepStrictEqual(reasons, ['step id "S1" must look like P1', 'step id "P2" is repeated']);
    assert.deepStrictEqual(
      validatePlan(plan([]), CARD).map((issue) => issue.reason),
      ["## Steps lists no steps"],
    );
  });
});

describe("countPlanSteps", () => {
  it("counts the data rows of the steps table, whatever their ids", () => {
    assert.strictEqual(
      countPlanSteps(plan(["| P1 | add | ft3-board | test |", "| P2 | wire | ft3-board | test |"])),
      2,
    );
    assert.strictEqual(countPlanSteps(plan(["| S1 | add | ft3-board | test |"])), 1);
  });

  it("stops counting at the first line outside the table", () => {
    assert.strictEqual(
      countPlanSteps(plan(["| P1 | add | ft3-board | test |", "done", "| P2 | wire | x | y |"])),
      1,
    );
  });

  it("counts zero without a steps section or table", () => {
    assert.strictEqual(countPlanSteps("# Plan\n"), 0);
    assert.strictEqual(countPlanSteps("## Steps\n\nNo table yet.\n"), 0);
    assert.strictEqual(countPlanSteps(plan([])), 0);
  });
});

import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import { BoardCardId } from "@t3tools/ft3-board/contracts";

import { pinnedPlanLineage, planPinLabel } from "./planLineage.logic.ts";
import type { PlanState, PlanThread } from "./planThreadSource.ts";

function plan(state: PlanState, overrides: Partial<PlanThread> = {}): PlanThread {
  return {
    cardId: BoardCardId.make("11111111-1111-4111-8111-111111111111"),
    title: "Ship the board",
    orchestratorThreadId: ThreadId.make("lead"),
    plannerThreadId: ThreadId.make("planner"),
    state,
    implementStarted: false,
    ...overrides,
  };
}

describe("planPinLabel", () => {
  it.each([
    ["drafting", "discussing"],
    ["reviewing", "discussing"],
    ["discussion", "discussing"],
    ["accepted", "accepted"],
    ["required", null],
    ["withdrawn", null],
  ] as const)("labels the %s state", (state, label) => {
    expect(planPinLabel(plan(state))).toBe(label);
  });

  it("unpins an accepted plan once implementation starts", () => {
    expect(planPinLabel(plan("accepted", { implementStarted: true }))).toBeNull();
  });
});

describe("pinnedPlanLineage", () => {
  it("hides only the planner threads of plans that are still pinned", () => {
    const pinned = plan("discussion");
    const released = plan("accepted", {
      implementStarted: true,
      plannerThreadId: ThreadId.make("released-planner"),
    });

    const result = pinnedPlanLineage([pinned, released]);

    expect(result.rows.map((row) => row.plan.plannerThreadId)).toEqual([ThreadId.make("planner")]);
    expect([...result.hiddenThreadIds]).toEqual(["planner"]);
  });
});

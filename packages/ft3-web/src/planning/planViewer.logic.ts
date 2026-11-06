import { BoardMcpFailure } from "@t3tools/ft3-board/contracts";
import * as Schema from "effect/Schema";
import type { PlanState } from "@t3tools/ft3-board/planning-contracts";

const isBoardMcpFailure = Schema.is(BoardMcpFailure);

export const PLAN_STATE_LABELS: Readonly<Record<PlanState, string>> = {
  required: "Required",
  drafting: "Drafting",
  reviewing: "Reviewing",
  discussion: "Discussion",
  accepted: "Accepted",
  withdrawn: "Withdrawn",
};

/** The human accepts only the version the planner submitted for discussion (design §11.2). */
export function planAcceptAvailable(state: PlanState | null): boolean {
  return state === "discussion";
}

export interface PlanFailureView {
  readonly text: string;
  /** True for `plan_changed`: the shown text is stale and the viewer reloads it. */
  readonly changed: boolean;
}

export function planFailureView(error: unknown): PlanFailureView {
  if (isBoardMcpFailure(error)) {
    return { text: error.message, changed: error.code === "plan_changed" };
  }
  return {
    text:
      error instanceof Error && error.message.trim().length > 0
        ? error.message
        : "Could not accept the plan.",
    changed: false,
  };
}

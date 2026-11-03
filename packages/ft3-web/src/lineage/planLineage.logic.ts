import type { PlanThread } from "./planThreadSource.ts";

export type PlanPinLabel = "discussing" | "accepted";

export interface PinnedPlanRow {
  readonly plan: PlanThread;
  readonly label: PlanPinLabel;
}

export function planPinLabel(plan: PlanThread): PlanPinLabel | null {
  switch (plan.state) {
    case "drafting":
    case "reviewing":
    case "discussion":
      return "discussing";
    case "accepted":
      return plan.implementStarted ? null : "accepted";
    case "required":
    case "withdrawn":
      return null;
  }
}

export function pinnedPlanLineage(plans: ReadonlyArray<PlanThread>): {
  readonly rows: ReadonlyArray<PinnedPlanRow>;
  readonly hiddenThreadIds: ReadonlySet<string>;
} {
  const rows = plans.flatMap((plan) => {
    const label = planPinLabel(plan);
    return label === null ? [] : [{ plan, label }];
  });
  return {
    rows,
    hiddenThreadIds: new Set(rows.map(({ plan }) => plan.plannerThreadId)),
  };
}

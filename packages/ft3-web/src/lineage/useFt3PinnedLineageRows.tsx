import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { PlanLineageRow } from "./PlanLineageRow.tsx";
import { pinnedPlanLineage } from "./planLineage.logic.ts";
import { usePlanThreadSource } from "./usePlanThreadSource.ts";

export interface PinnedLineageRows {
  readonly rows: ReadonlyArray<ReactNode>;
  readonly hiddenThreadIds: ReadonlySet<string>;
}

export function useFt3PinnedLineageRows(
  environmentId: EnvironmentId,
): (threadId: ThreadId) => PinnedLineageRows {
  const source = usePlanThreadSource(environmentId);
  return (threadId) => {
    const pinned = pinnedPlanLineage(source.forOrchestratorThread(threadId));
    return {
      rows: pinned.rows.map((row) => (
        <PlanLineageRow key={row.plan.plannerThreadId} environmentId={environmentId} row={row} />
      )),
      hiddenThreadIds: pinned.hiddenThreadIds,
    };
  };
}

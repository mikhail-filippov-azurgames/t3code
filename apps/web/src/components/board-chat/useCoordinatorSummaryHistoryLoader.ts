import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { orchestrationEnvironment } from "../../state/orchestration";
import { readThreadShell } from "../../state/entities";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import {
  createCoordinatorSummaryHistoryLoader,
  type CoordinatorSummaryHistoryLoader,
} from "./coordinatorSummaryHistory";

export function useCoordinatorSummaryHistoryLoader(
  environmentId: EnvironmentId,
): CoordinatorSummaryHistoryLoader {
  const query = useAtomQueryRunner(orchestrationEnvironment.delegatedTaskSummaryHistory, {
    reportFailure: false,
    refresh: true,
  });
  return useMemo(
    () =>
      createCoordinatorSummaryHistoryLoader({
        environmentId,
        query,
        childLabel: (childThreadId) =>
          readThreadShell(scopeThreadRef(environmentId, childThreadId))?.title,
      }),
    [environmentId, query],
  );
}

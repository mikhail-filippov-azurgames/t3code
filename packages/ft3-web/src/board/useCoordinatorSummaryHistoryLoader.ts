import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useMemo } from "react";

import { readThreadShell } from "~/state/entities";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import {
  createCoordinatorSummaryHistoryLoader,
  type CoordinatorSummaryHistoryLoader,
} from "./coordinatorSummaryHistory";
import { boardEnvironment } from "./useBoardBackend";

export function useCoordinatorSummaryHistoryLoader(
  ref: ScopedThreadRef,
): CoordinatorSummaryHistoryLoader {
  const query = useAtomQueryRunner(boardEnvironment.delegatedTaskSummaryHistory, {
    reportFailure: false,
    refresh: true,
  });
  const { environmentId } = ref;
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

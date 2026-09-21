/**
 * Binds the board atoms to the web client's connection runtime.
 *
 * The primary environment hosts the board, matching the calendar: its
 * `board.orchestrators.list` and `board.list` fill the page, and its mutations
 * refresh those reads.
 *
 * @module components/board/useBoardBackend
 */
import { createBoardEnvironmentAtoms } from "@t3tools/client-runtime/state/board";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";

export const boardEnvironment = createBoardEnvironmentAtoms(connectionAtomRuntime);

/** Thread ids marked as orchestrators on the primary environment. */
export function useBoardOrchestratorThreadKeys(): ReadonlySet<string> {
  const environmentId = usePrimaryEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : boardEnvironment.orchestratorsList({ environmentId, input: {} }),
  );
  return useMemo(
    () => new Set((query.data?.orchestrators ?? []).map((entry) => entry.threadId as string)),
    [query.data],
  );
}

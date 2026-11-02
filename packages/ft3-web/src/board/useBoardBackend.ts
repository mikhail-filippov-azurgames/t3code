import { useMemo } from "react";

import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { boardEnvironment } from "./state.ts";

export { boardEnvironment };

/** Thread ids marked as coordinators on the primary environment. */
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

/** Role instructions directory the server reads; empty while roles are off. */
export function useBoardRolesDir(): string {
  const environmentId = usePrimaryEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : boardEnvironment.orchestratorsList({ environmentId, input: {} }),
  );
  return query.data?.rolesDir ?? "";
}

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";

import { useMemo } from "react";

import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { boardEnvironment } from "../board/state.ts";
import { resolveSidebarRoleBadge } from "./roleBadge.logic.ts";
import type { SidebarRoleBadge } from "./roleBadge.logic.ts";

export { resolveSidebarRoleBadge };
export type { SidebarRoleBadge };

/**
 * Role badge per visible sidebar row, keyed by scoped thread key. Board data
 * lives on the primary environment (matching the board page): its
 * orchestrators list marks Coordinator rows, and cards map their executor
 * thread to the board role. Orchestrator wins over a card role.
 */
export function useSidebarRoleBadges(
  threads: readonly Pick<EnvironmentThreadShell, "environmentId" | "id">[],
): ReadonlyMap<string, SidebarRoleBadge> {
  const environmentId = usePrimaryEnvironmentId();
  const orchestrators = useEnvironmentQuery(
    environmentId === null
      ? null
      : boardEnvironment.orchestratorsList({ environmentId, input: {} }),
  );
  const board = useEnvironmentQuery(
    environmentId === null ? null : boardEnvironment.list({ environmentId, input: {} }),
  );
  return useMemo(() => {
    const badges = new Map<string, SidebarRoleBadge>();
    const orchestratorThreadIds = new Set(
      (orchestrators.data?.orchestrators ?? []).map((entry) => entry.threadId as string),
    );
    const cardRoleByThreadId = new Map<
      string,
      import("@t3tools/ft3-board/contracts").ExecutorRole
    >();
    for (const card of board.data?.cards ?? []) {
      if (card.executorThreadId === null) continue;
      const threadId = card.executorThreadId as string;
      if (!cardRoleByThreadId.has(threadId)) cardRoleByThreadId.set(threadId, card.executorRole);
    }
    for (const thread of threads) {
      const badge = resolveSidebarRoleBadge({
        role: cardRoleByThreadId.get(thread.id as string) ?? null,
        isOrchestrator: orchestratorThreadIds.has(thread.id as string),
      });
      if (badge !== null) {
        badges.set(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), badge);
      }
    }
    return badges;
  }, [board.data, orchestrators.data, threads]);
}

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";

import { useMemo } from "react";

import { usePrimaryEnvironmentId } from "~/state/environments";
import { orchestrationEnvironment } from "~/state/orchestration";
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
  threads: readonly Pick<EnvironmentThreadShell, "environmentId" | "id" | "lineage">[],
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
  const delegatedRoleQuery = useMemo(() => {
    const parentByKey = new Map<
      string,
      {
        readonly environmentId: EnvironmentThreadShell["environmentId"];
        readonly threadId: EnvironmentThreadShell["id"];
      }
    >();
    for (const thread of threads) {
      if (
        thread.lineage.relationshipToParent !== "subagent" ||
        thread.lineage.parentThreadId === null
      ) {
        continue;
      }
      const parent = {
        environmentId: thread.environmentId,
        threadId: thread.lineage.parentThreadId,
      };
      parentByKey.set(
        scopedThreadKey(scopeThreadRef(parent.environmentId, parent.threadId)),
        parent,
      );
    }
    const queries = [...parentByKey.values()].map((parent) => ({
      environmentId: parent.environmentId,
      query: orchestrationEnvironment.v2.delegatedSubagentRoles({
        environmentId: parent.environmentId,
        input: { threadId: parent.threadId },
      }),
    }));
    return Atom.make((get) => {
      const roleByChildKey = new Map<string, string>();
      for (const { environmentId: parentEnvironmentId, query } of queries) {
        const result = get(query);
        if (!AsyncResult.isSuccess(result)) continue;
        for (const subagent of result.value.subagents) {
          if (subagent.childThreadId === null || typeof subagent.role !== "string") continue;
          roleByChildKey.set(
            scopedThreadKey(scopeThreadRef(parentEnvironmentId, subagent.childThreadId)),
            subagent.role,
          );
        }
      }
      return roleByChildKey;
    }).pipe(Atom.withLabel("ft3-sidebar:delegated-role-badges"));
  }, [threads]);
  const delegatedRoleByKey = useAtomValue(delegatedRoleQuery);
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
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      const badge = resolveSidebarRoleBadge({
        role:
          delegatedRoleByKey.get(threadKey) ?? cardRoleByThreadId.get(thread.id as string) ?? null,
        isOrchestrator: orchestratorThreadIds.has(thread.id as string),
      });
      if (badge !== null) {
        badges.set(threadKey, badge);
      }
    }
    return badges;
  }, [board.data, delegatedRoleByKey, orchestrators.data, threads]);
}

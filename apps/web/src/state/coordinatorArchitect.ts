import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { useMemo, useSyncExternalStore } from "react";

import { connectionAtomRuntime } from "../connection/runtime";

/** Sidebar read is unary; the selected coordinator's existing thread
 * subscription drives refreshes without adding another stream. */
export const coordinatorArchitectEnvironment = {
  sidebarSnapshot: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:orchestration:coordinator-architect-sidebar",
    tag: ORCHESTRATION_WS_METHODS.getCoordinatorArchitectSidebar,
    staleTimeMs: 2_000,
    idleTtlMs: 60_000,
  }),
};

/** Coordinator scoped key → bound Architect scoped key. */
export type ActiveArchitectChildren = ReadonlyMap<string, string>;

// Reported by the Architect sidebar pin, which already resolves the binding:
// only an ACTIVE binding is reported, so a detached/replaced binding and an
// unmounted row both clear their entry. This is an index of binding data, not
// delegation lineage — the Architect has none by contract.
let activeArchitectChildren: ActiveArchitectChildren = new Map();
const activeArchitectChildrenListeners = new Set<() => void>();

export function reportActiveArchitectChild(input: {
  readonly coordinatorKey: string;
  readonly architectKey: string | null;
}): void {
  const current = activeArchitectChildren.get(input.coordinatorKey) ?? null;
  if (current === input.architectKey) return;
  const next = new Map(activeArchitectChildren);
  if (input.architectKey === null) next.delete(input.coordinatorKey);
  else next.set(input.coordinatorKey, input.architectKey);
  activeArchitectChildren = next;
  for (const listener of activeArchitectChildrenListeners) listener();
}

export function readActiveArchitectChildren(): ActiveArchitectChildren {
  return activeArchitectChildren;
}

export function subscribeActiveArchitectChildren(listener: () => void): () => void {
  activeArchitectChildrenListeners.add(listener);
  return () => {
    activeArchitectChildrenListeners.delete(listener);
  };
}

/** Inversion the sidebar forest consumes: architect key → coordinator key. */
export function architectParentKeysFromActiveChildren(
  children: ActiveArchitectChildren,
): ReadonlyMap<string, string> {
  const parents = new Map<string, string>();
  for (const [coordinatorKey, architectKey] of children) parents.set(architectKey, coordinatorKey);
  return parents;
}

export function useArchitectParentKeys(): ReadonlyMap<string, string> {
  const children = useSyncExternalStore(
    subscribeActiveArchitectChildren,
    readActiveArchitectChildren,
  );
  return useMemo(() => architectParentKeysFromActiveChildren(children), [children]);
}

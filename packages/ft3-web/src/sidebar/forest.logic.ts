import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

/**
 * Section-local delegation forest for the sidebar, ported from the ft3 v1
 * fork (`apps/web/src/components/Sidebar.logic.ts`) onto V2 thread shells.
 * V2 carries delegation lineage on the shell (`lineage.parentThreadId` for
 * `relationshipToParent === "subagent"`) instead of a separate
 * `delegationParent` record, and exposes run state as `latestRun`/`runtime`
 * instead of `latestTurn`/`session`.
 *
 * Roots keep their incoming order; each root is immediately followed by its
 * descendants in incoming relative order. Depth is capped so deeper chains
 * render flat at the cap instead of nesting forever. Cycles, self-parents,
 * and parents outside the section detach to top level: no input row is ever
 * dropped by the ordering itself (the sidebar hides orphan subagents before
 * ordering; see `useSidebarForests`).
 */
export type SidebarForestEntry<TThread> = {
  readonly key: string;
  readonly thread: TThread;
  readonly depth: number;
  readonly parentKey: string | null;
  readonly descendantCount: number;
};

export type SidebarForestThread = {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly lineage: {
    readonly parentThreadId: ThreadId | null;
    readonly relationshipToParent: "fork" | "subagent" | null;
  };
};

/**
 * Delegation parent key for the section forest. V2 lineage names the parent
 * thread id only; the parent shares the child's environment, so the key is
 * scoped with the child's own environment id.
 */
export function sidebarSubagentParentKey(thread: SidebarForestThread): string | null {
  if (thread.lineage.relationshipToParent !== "subagent") return null;
  const parentThreadId = thread.lineage.parentThreadId;
  if (parentThreadId === null) return null;
  return scopedThreadKey(scopeThreadRef(thread.environmentId, parentThreadId));
}

/**
 * Forest parent key for a row: delegation lineage first, then the
 * binding-derived Architect nesting. A bound Architect has no delegation
 * lineage by contract, so its parent comes from the coordinator↔architect
 * binding index (`architectParentKeys`: architect key → coordinator key).
 * A real delegated child keeps its lineage parent even if a binding entry
 * ever names it, so existing delegation hierarchy is untouched. Absent
 * both = top-level row.
 */
export function sidebarForestParentKey(
  thread: SidebarForestThread,
  architectParentKeys: ReadonlyMap<string, string>,
): string | null {
  return (
    sidebarSubagentParentKey(thread) ??
    architectParentKeys.get(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))) ??
    null
  );
}

export function orderSidebarSectionForest<TThread>(input: {
  readonly threads: readonly TThread[];
  readonly getKey: (thread: TThread) => string;
  readonly getParentKey: (thread: TThread) => string | null;
  readonly maxDepth?: number;
}): SidebarForestEntry<TThread>[] {
  const { threads, getKey } = input;
  const maxDepth = input.maxDepth ?? 2;
  const byKey = new Map(threads.map((thread) => [getKey(thread), thread] as const));
  const parentByKey = new Map<string, string | null>();
  for (const thread of threads) {
    const key = getKey(thread);
    let parent = input.getParentKey(thread);
    if (parent === key || (parent !== null && !byKey.has(parent))) parent = null;
    if (parent !== null) {
      // Walk the in-section chain with a visited set: a cycle anywhere
      // above detaches this row instead of looping the render.
      const seen = new Set([key]);
      let cursor: string | null = parent;
      while (cursor !== null && byKey.has(cursor) && !seen.has(cursor)) {
        seen.add(cursor);
        const next = input.getParentKey(byKey.get(cursor)!);
        cursor = next === null || next === cursor || !byKey.has(next) ? null : next;
      }
      if (cursor !== null) parent = null;
    }
    parentByKey.set(key, parent);
  }
  const depthByKey = new Map<string, number>();
  const depthOf = (key: string): number => {
    const known = depthByKey.get(key);
    if (known !== undefined) return known;
    let depth = 0;
    let cursor = parentByKey.get(key) ?? null;
    for (let step = 0; step <= threads.length && cursor !== null; step += 1) {
      depth += 1;
      cursor = parentByKey.get(cursor) ?? null;
    }
    const capped = Math.min(depth, maxDepth);
    depthByKey.set(key, capped);
    return capped;
  };
  const childrenByKey = new Map<string, TThread[]>();
  const roots: TThread[] = [];
  for (const thread of threads) {
    const parent = parentByKey.get(getKey(thread));
    if (parent === null || parent === undefined) roots.push(thread);
    else {
      const siblings = childrenByKey.get(parent);
      if (siblings) siblings.push(thread);
      else childrenByKey.set(parent, [thread]);
    }
  }
  const entries: SidebarForestEntry<TThread>[] = [];
  const emit = (thread: TThread): void => {
    const key = getKey(thread);
    entries.push({
      key,
      thread,
      depth: depthOf(key),
      parentKey: parentByKey.get(key) ?? null,
      descendantCount: 0,
    });
    for (const child of childrenByKey.get(key) ?? []) emit(child);
  };
  for (const root of roots) emit(root);
  const descendantCounts = new Map<string, number>();
  for (const entry of entries) {
    const seen = new Set([entry.key]);
    let cursor = entry.parentKey;
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      descendantCounts.set(cursor, (descendantCounts.get(cursor) ?? 0) + 1);
      cursor = parentByKey.get(cursor) ?? null;
    }
  }
  return entries.map((entry) => ({
    ...entry,
    descendantCount: descendantCounts.get(entry.key) ?? 0,
  }));
}

export function groupSidebarForestChildrenBySection<TThread>(input: {
  readonly sections: readonly {
    readonly section: string;
    readonly threads: readonly TThread[];
  }[];
  readonly pool: readonly TThread[];
  readonly getKey: (thread: TThread) => string;
  readonly getParentKey: (thread: TThread) => string | null;
}): ReadonlyMap<string, readonly TThread[]> {
  const threadsBySection = new Map<string, TThread[]>();
  const initialSectionByKey = new Map<string, string>();
  const sectionThreadByKey = new Map<string, TThread>();
  const poolByKey = new Map(input.pool.map((thread) => [input.getKey(thread), thread] as const));
  for (const section of input.sections) {
    threadsBySection.set(section.section, [...section.threads]);
    for (const thread of section.threads) {
      const key = input.getKey(thread);
      initialSectionByKey.set(key, section.section);
      sectionThreadByKey.set(key, thread);
    }
  }

  const sectionByKey = new Map<string, string | null>();
  const resolveSection = (
    key: string,
    visiting: ReadonlySet<string> = new Set(),
  ): string | null => {
    if (sectionByKey.has(key)) return sectionByKey.get(key) ?? null;
    const fallback = initialSectionByKey.get(key) ?? null;
    if (visiting.has(key)) return fallback;

    const thread = poolByKey.get(key) ?? sectionThreadByKey.get(key);
    if (thread === undefined) return fallback;
    const parentKey = input.getParentKey(thread);
    if (parentKey === null || parentKey === key) {
      sectionByKey.set(key, fallback);
      return fallback;
    }

    const nextVisiting = new Set(visiting);
    nextVisiting.add(key);
    const parentSection =
      initialSectionByKey.has(parentKey) || poolByKey.has(parentKey)
        ? resolveSection(parentKey, nextVisiting)
        : null;
    const resolved = parentSection ?? fallback;
    sectionByKey.set(key, resolved);
    return resolved;
  };

  for (const key of new Set([...initialSectionByKey.keys(), ...poolByKey.keys()])) {
    resolveSection(key);
  }

  for (const [section, threads] of threadsBySection) {
    threadsBySection.set(
      section,
      threads.filter((thread) => sectionByKey.get(input.getKey(thread)) === section),
    );
  }

  const includedBySection = new Map<string, Set<string>>();
  for (const [section, threads] of threadsBySection) {
    includedBySection.set(section, new Set(threads.map(input.getKey)));
  }
  for (const [key, thread] of poolByKey) {
    const section = sectionByKey.get(key);
    if (section === null || section === undefined) continue;
    const destination = threadsBySection.get(section);
    const included = includedBySection.get(section);
    if (destination === undefined || included === undefined || included.has(key)) continue;
    destination.push(thread);
    included.add(key);
  }

  return threadsBySection;
}

// Hide descendants of collapsed parents. Collapsed rows themselves stay
// visible; selection expansion is the caller's job (it drops ancestor keys
// from the collapsed set before calling this).
export function filterCollapsedSidebarForest<TThread>(input: {
  readonly entries: readonly SidebarForestEntry<TThread>[];
  readonly collapsedKeys: ReadonlySet<string>;
}): SidebarForestEntry<TThread>[] {
  const parentByKey = new Map(input.entries.map((entry) => [entry.key, entry.parentKey] as const));
  return input.entries.filter((entry) => {
    let cursor = entry.parentKey;
    const seen = new Set<string>();
    while (cursor !== null && !seen.has(cursor)) {
      if (input.collapsedKeys.has(cursor)) return false;
      seen.add(cursor);
      cursor = parentByKey.get(cursor) ?? null;
    }
    return true;
  });
}

// V2 run-state inputs for the delegated child counters. A child's own row
// uses the same predicates, so opening the child clears both together.
export type SidebarForestThreadStatus = {
  readonly latestRun: { readonly completedAt: string | null } | null;
  readonly runtime: { readonly status: string } | null;
  readonly lastVisitedAt?: string | null | undefined;
};

export function forestThreadHasUnseenCompletion(thread: SidebarForestThreadStatus): boolean {
  if (!thread.latestRun?.completedAt) return false;
  const completedAt = Date.parse(thread.latestRun.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return false;
  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

// A delegated child's run counts as working while it is in flight; the V2
// runtime summary folds session starting/running into the run status.
function isDelegatedChildWorking(thread: Pick<SidebarForestThreadStatus, "runtime">): boolean {
  const status = thread.runtime?.status;
  return (
    status === "preparing" ||
    status === "queued" ||
    status === "starting" ||
    status === "running" ||
    status === "waiting"
  );
}

/**
 * Direct delegated children that finished after the user last visited them,
 * counted per resolved parent key. A running child never counts. Purely
 * derived from the shells plus the visit record the caller resolves.
 */
export function collectUnseenDelegatedChildCounts<
  TThread extends SidebarForestThread & SidebarForestThreadStatus,
>(input: {
  readonly threads: readonly TThread[];
  readonly getKey: (thread: TThread) => string;
  readonly getLastVisitedAt: (thread: TThread) => string | undefined;
}): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const thread of input.threads) {
    const parentKey = sidebarSubagentParentKey(thread);
    if (parentKey === null) continue;
    if (
      !forestThreadHasUnseenCompletion({
        ...thread,
        lastVisitedAt: input.getLastVisitedAt(thread),
      })
    ) {
      continue;
    }
    counts.set(parentKey, (counts.get(parentKey) ?? 0) + 1);
  }
  return counts;
}

/**
 * Direct delegated children with a run in flight, counted per resolved parent
 * key. Needs no visit record, unlike `collectUnseenDelegatedChildCounts`: the
 * count follows the child's own Working state and empties when the last child
 * settles.
 */
export function collectWorkingDelegatedChildCounts<
  TThread extends SidebarForestThread & SidebarForestThreadStatus,
>(input: {
  readonly threads: readonly TThread[];
  readonly getKey: (thread: TThread) => string;
}): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const thread of input.threads) {
    const parentKey = sidebarSubagentParentKey(thread);
    if (parentKey === null) continue;
    if (!isDelegatedChildWorking(thread)) continue;
    counts.set(parentKey, (counts.get(parentKey) ?? 0) + 1);
  }
  return counts;
}

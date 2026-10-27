import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo, type ReactNode } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useArchitectParentKeys } from "./architectBindingIndex.ts";
import {
  collectDelegatedWorkingStartedAt,
  collectUnseenDelegatedChildCounts,
  collectWorkingDelegatedChildCounts,
  filterCollapsedSidebarForest,
  groupSidebarForestChildrenBySection,
  orderSidebarSectionForest,
  sidebarForestParentKey,
  sidebarSubagentParentKey,
} from "./forest.logic.ts";
import type { SidebarForestEntry } from "./forest.logic.ts";
import { useSidebarRoleBadges } from "./roleBadges.ts";
import {
  SidebarDelegationMarker,
  SidebarForestRowDecorations,
  SidebarRoleBadgeMarker,
} from "./SidebarForestRowDecorations.tsx";
import type {
  SidebarForestRowModel,
  SidebarRowStatusOverride,
} from "./SidebarForestRowDecorations.tsx";
import { sidebarThreadFamilyRoots, type ThreadFamilyRoot } from "./familyRoots.ts";
import { ArchitectSidebarPin } from "./ArchitectSidebarPin.tsx";

const EXPANDED_FOREST_KEYS_KEY = "t3code:sidebar:forest-expanded";

export type SidebarForestSectionInput = {
  readonly section: string;
  readonly threads: readonly EnvironmentThreadShell[];
};

export type Ft3SidebarRows = {
  /** Visible (collapse-filtered) entries per section, in render order. */
  readonly entriesBySection: ReadonlyMap<
    string,
    readonly SidebarForestEntry<EnvironmentThreadShell>[]
  >;
  /** Visible rows indexed by their scoped thread key. */
  readonly entryByKey: ReadonlyMap<string, SidebarForestEntry<EnvironmentThreadShell>>;
  readonly rowPropsByKey: ReadonlyMap<string, Ft3SidebarRowProps>;
  readonly afterRowByKey: ReadonlyMap<string, ReactNode>;
  readonly statusOverrideByKey: ReadonlyMap<string, SidebarRowStatusOverride>;
  /** Roots that must stay mounted while their rows are visible. */
  readonly familyRoots: readonly ThreadFamilyRoot[];
};

export type Ft3SidebarRowProps = {
  readonly depth: number;
  readonly decorations: ReactNode;
  readonly metaDecorations: ReactNode;
  readonly topRightDecorations: ReactNode;
};

/**
 * Delegation forest for the sidebar thread list, ported from the ft3 v1 fork.
 * Upstream keeps owning section assignment; this hook nests subagent
 * children under their parent row inside the parent's section, nests the
 * bound Architect row via the binding index, hides subagent orphans (V2 hid
 * every subagent thread before; only parented ones gain a row), and derives
 * working/returned child counters plus board role badges for the rows.
 *
 * `pool` carries the unfiltered thread shells (including subagents) the
 * sections were drawn from. Parented rows join the section containing their
 * visible parent, including an Architect that would otherwise be elsewhere.
 */
export function useFt3SidebarRows(input: {
  readonly sections: readonly SidebarForestSectionInput[];
  readonly pool: readonly EnvironmentThreadShell[];
  readonly routeThreadKey: string | null;
  readonly getLastVisitedAt: (thread: EnvironmentThreadShell) => string | undefined;
  readonly onNavigate: (threadRef: ScopedThreadRef) => void;
}): Ft3SidebarRows {
  const architectParentKeys = useArchitectParentKeys();
  const [expandedForestKeys, setExpandedForestKeys] = useLocalStorage(
    EXPANDED_FOREST_KEYS_KEY,
    [] as readonly string[],
    Schema.Array(Schema.String),
  );
  const expandedForestKeySet = useMemo(() => new Set(expandedForestKeys), [expandedForestKeys]);
  const toggleCollapsed = useCallback(
    (key: string) => {
      setExpandedForestKeys((current) =>
        current.includes(key)
          ? current.filter((candidate) => candidate !== key)
          : [...current, key],
      );
    },
    [setExpandedForestKeys],
  );

  const built = useMemo(() => {
    const getKey = (thread: EnvironmentThreadShell) =>
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const poolsBySection = groupSidebarForestChildrenBySection({
      sections: input.sections,
      pool: input.pool.filter((thread) => thread.archivedAt === null),
      getKey,
      getParentKey: (thread) => sidebarForestParentKey(thread, architectParentKeys),
    });
    const forests = new Map<string, SidebarForestEntry<EnvironmentThreadShell>[]>();
    const parentByKey = new Map<string, string>();
    const candidates: EnvironmentThreadShell[] = [];
    const seenCandidateKeys = new Set<string>();
    for (const section of input.sections) {
      const sectionCandidates = poolsBySection.get(section.section) ?? [];
      const forest = orderSidebarSectionForest({
        threads: sectionCandidates,
        getKey,
        getParentKey: (thread) => sidebarForestParentKey(thread, architectParentKeys),
      });
      // Hide orphan subagents: attached rows only. Non-subagent rows keep the
      // forest invariant that no input row is dropped.
      const visibleForest = forest.filter(
        (entry) => sidebarSubagentParentKey(entry.thread) === null || entry.parentKey !== null,
      );
      forests.set(section.section, visibleForest);
      for (const entry of visibleForest) {
        if (entry.parentKey !== null) parentByKey.set(entry.key, entry.parentKey);
        if (!seenCandidateKeys.has(entry.key)) {
          seenCandidateKeys.add(entry.key);
          candidates.push(entry.thread);
        }
      }
    }
    const workingCounts = collectWorkingDelegatedChildCounts({ threads: candidates, getKey });
    const workingStartedAt = collectDelegatedWorkingStartedAt({ threads: candidates, getKey });
    const unseenCounts = collectUnseenDelegatedChildCounts({
      threads: candidates,
      getKey,
      getLastVisitedAt: input.getLastVisitedAt,
    });
    return { forests, parentByKey, workingCounts, workingStartedAt, unseenCounts };
  }, [architectParentKeys, input.pool, input.sections, input.getLastVisitedAt]);

  // A selected descendant temporarily expands its ancestor path.
  useEffect(() => {
    if (input.routeThreadKey === null) return;
    const ancestors: string[] = [];
    const seen = new Set([input.routeThreadKey]);
    let cursor = built.parentByKey.get(input.routeThreadKey) ?? null;
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      ancestors.push(cursor);
      cursor = built.parentByKey.get(cursor) ?? null;
    }
    if (ancestors.length === 0) return;
    setExpandedForestKeys((current) => {
      if (ancestors.every((key) => current.includes(key))) return current;
      const next = new Set(current);
      for (const key of ancestors) next.add(key);
      return [...next];
    });
  }, [built.parentByKey, input.routeThreadKey, setExpandedForestKeys]);

  const visibleThreads = useMemo(() => {
    const collapsedKeys = new Set<string>();
    for (const forest of built.forests.values()) {
      for (const entry of forest) {
        if (entry.descendantCount > 0 && !expandedForestKeySet.has(entry.key)) {
          collapsedKeys.add(entry.key);
        }
      }
    }
    const entriesBySection = new Map<
      string,
      readonly SidebarForestEntry<EnvironmentThreadShell>[]
    >();
    const visible: EnvironmentThreadShell[] = [];
    for (const [section, forest] of built.forests) {
      const visibleForest = filterCollapsedSidebarForest({ entries: forest, collapsedKeys });
      entriesBySection.set(section, visibleForest);
      for (const entry of visibleForest) visible.push(entry.thread);
    }
    return { entriesBySection, visible };
  }, [built.forests, expandedForestKeySet]);

  const entryByKey = useMemo(() => {
    const entries = new Map<string, SidebarForestEntry<EnvironmentThreadShell>>();
    for (const forest of visibleThreads.entriesBySection.values()) {
      for (const entry of forest) entries.set(entry.key, entry);
    }
    return entries;
  }, [visibleThreads.entriesBySection]);

  const familyRoots = useMemo(
    () => sidebarThreadFamilyRoots(input.sections.flatMap((section) => section.threads)),
    [input.sections],
  );

  const roleBadges = useSidebarRoleBadges(visibleThreads.visible);

  const modelByKey = useMemo(() => {
    const models = new Map<string, SidebarForestRowModel>();
    for (const forest of visibleThreads.entriesBySection.values()) {
      for (const entry of forest) {
        const collapsed = entry.descendantCount > 0 && !expandedForestKeySet.has(entry.key);
        const workingStartedAt = built.workingStartedAt.get(entry.key) ?? null;
        models.set(entry.key, {
          key: entry.key,
          depth: entry.depth,
          descendantCount: entry.descendantCount,
          collapsed,
          toggleKey: entry.descendantCount > 0 ? entry.key : null,
          workingCount: built.workingCounts.get(entry.key) ?? 0,
          returnedCount: built.unseenCounts.get(entry.key) ?? 0,
          isDelegatedChild: sidebarSubagentParentKey(entry.thread) !== null,
          statusOverride:
            workingStartedAt === null
              ? null
              : {
                  status: "working",
                  label: "Working",
                  icon: "working",
                  className: "text-info-foreground",
                  startedAt: workingStartedAt,
                },
          roleBadge: roleBadges.get(entry.key) ?? null,
        });
      }
    }
    return models;
  }, [
    built.unseenCounts,
    built.workingCounts,
    built.workingStartedAt,
    expandedForestKeySet,
    roleBadges,
    visibleThreads,
  ]);

  const rowPropsByKey = useMemo(() => {
    const rowProps = new Map<string, Ft3SidebarRowProps>();
    for (const [key, model] of modelByKey) {
      rowProps.set(key, {
        depth: model.depth,
        decorations: (
          <SidebarForestRowDecorations model={model} onToggleCollapse={toggleCollapsed} />
        ),
        metaDecorations: <SidebarRoleBadgeMarker model={model} />,
        topRightDecorations: <SidebarDelegationMarker model={model} />,
      });
    }
    return rowProps;
  }, [modelByKey, toggleCollapsed]);

  const statusOverrideByKey = useMemo(() => {
    const overrides = new Map<string, SidebarRowStatusOverride>();
    for (const [key, model] of modelByKey) {
      if (model.statusOverride !== null) overrides.set(key, model.statusOverride);
    }
    return overrides;
  }, [modelByKey]);

  const afterRowByKey = useMemo(() => {
    const rows = new Map<string, ReactNode>();
    for (const entry of entryByKey.values()) {
      rows.set(
        entry.key,
        <ArchitectSidebarPin
          key={`architect-pin:${entry.key}`}
          thread={entry.thread}
          depth={entry.depth}
          onNavigate={input.onNavigate}
        />,
      );
    }
    return rows;
  }, [entryByKey, input.onNavigate]);

  return {
    entriesBySection: visibleThreads.entriesBySection,
    entryByKey,
    rowPropsByKey,
    afterRowByKey,
    statusOverrideByKey,
    familyRoots,
  };
}

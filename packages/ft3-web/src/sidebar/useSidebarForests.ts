import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import * as Schema from "effect/Schema";
import { useEffect, useMemo } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useArchitectParentKeys } from "./architectBindingIndex.ts";
import {
  collectUnseenDelegatedChildCounts,
  collectWorkingDelegatedChildCounts,
  filterCollapsedSidebarForest,
  orderSidebarSectionForest,
  sidebarForestParentKey,
  sidebarSubagentParentKey,
} from "./forest.logic.ts";
import type { SidebarForestEntry } from "./forest.logic.ts";
import { useSidebarRoleBadges } from "./roleBadges.ts";
import type { SidebarForestRowModel } from "./SidebarForestRowDecorations.tsx";

const EXPANDED_FOREST_KEYS_KEY = "t3code:sidebar:forest-expanded";

export type SidebarForestSectionInput = {
  readonly section: string;
  readonly threads: readonly EnvironmentThreadShell[];
};

export type SidebarForests = {
  /** Visible (collapse-filtered) entries per section, in render order. */
  readonly entriesBySection: ReadonlyMap<
    string,
    readonly SidebarForestEntry<EnvironmentThreadShell>[]
  >;
  /** Row decoration model per visible row key. */
  readonly modelByKey: ReadonlyMap<string, SidebarForestRowModel>;
  readonly toggleCollapsed: (key: string) => void;
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
 * sections were drawn from; `sectionOfKey` resolves a parent key to the
 * section its row renders in, so a child only nests where its parent is.
 */
export function useSidebarForests(input: {
  readonly sections: readonly SidebarForestSectionInput[];
  readonly pool: readonly EnvironmentThreadShell[];
  /**
   * Resolves a parent key to the section its row renders in; a subagent only
   * nests where its parent is. Defaults to the sections' own thread keys.
   */
  readonly sectionOfKey?: ((key: string) => string | null) | undefined;
  readonly routeThreadKey: string | null;
  readonly getLastVisitedAt: (thread: EnvironmentThreadShell) => string | undefined;
}): SidebarForests {
  const architectParentKeys = useArchitectParentKeys();
  const [expandedForestKeys, setExpandedForestKeys] = useLocalStorage(
    EXPANDED_FOREST_KEYS_KEY,
    [] as readonly string[],
    Schema.Array(Schema.String),
  );
  const expandedForestKeySet = useMemo(() => new Set(expandedForestKeys), [expandedForestKeys]);
  const toggleCollapsed = (key: string) => {
    setExpandedForestKeys((current) =>
      current.includes(key) ? current.filter((candidate) => candidate !== key) : [...current, key],
    );
  };

  const built = useMemo(() => {
    const getKey = (thread: EnvironmentThreadShell) =>
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const sectionOfKey =
      input.sectionOfKey ??
      ((key: string): string | null => {
        for (const section of input.sections) {
          if (section.threads.some((thread) => getKey(thread) === key)) return section.section;
        }
        return null;
      });
    const poolsBySection = new Map<string, EnvironmentThreadShell[]>();
    for (const section of input.sections) poolsBySection.set(section.section, [...section.threads]);
    // Subagent children join the section their parent row renders in; a
    // parentless subagent (provider-internal runs, broken chains) stays
    // hidden exactly as the V2-only filter kept it. Archived threads never
    // render, so their children cannot attach either.
    for (const thread of input.pool) {
      if (thread.archivedAt !== null) continue;
      const parentKey = sidebarSubagentParentKey(thread);
      if (parentKey === null) continue;
      const parentSection = sectionOfKey(parentKey);
      if (parentSection === null) continue;
      const candidates = poolsBySection.get(parentSection);
      if (candidates === undefined) continue;
      if (!candidates.some((candidate) => getKey(candidate) === getKey(thread))) {
        candidates.push(thread);
      }
    }
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
    const unseenCounts = collectUnseenDelegatedChildCounts({
      threads: candidates,
      getKey,
      getLastVisitedAt: input.getLastVisitedAt,
    });
    return { forests, parentByKey, workingCounts, unseenCounts };
  }, [architectParentKeys, input.pool, input.sections, input.sectionOfKey, input.getLastVisitedAt]);

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

  const roleBadges = useSidebarRoleBadges(visibleThreads.visible);

  const modelByKey = useMemo(() => {
    const models = new Map<string, SidebarForestRowModel>();
    for (const forest of visibleThreads.entriesBySection.values()) {
      for (const entry of forest) {
        const collapsed = entry.descendantCount > 0 && !expandedForestKeySet.has(entry.key);
        models.set(entry.key, {
          key: entry.key,
          depth: entry.depth,
          descendantCount: entry.descendantCount,
          collapsed,
          toggleKey: entry.descendantCount > 0 ? entry.key : null,
          workingCount: built.workingCounts.get(entry.key) ?? 0,
          returnedCount: built.unseenCounts.get(entry.key) ?? 0,
          roleBadge: roleBadges.get(entry.key) ?? null,
        });
      }
    }
    return models;
  }, [built.unseenCounts, built.workingCounts, expandedForestKeySet, roleBadges, visibleThreads]);

  return {
    entriesBySection: visibleThreads.entriesBySection,
    modelByKey,
    toggleCollapsed,
  };
}

import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ContextMenuItem, EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { ThreadChildrenAction } from "@t3tools/contracts/settings";

/**
 * Delegated-children orchestration for the thread action menu, ported from
 * the ft3 engine fork onto V2 lineage: children are V2 subagent threads whose
 * `lineage.parentThreadId` points at the parent (delegation stays inside one
 * environment). Pure functions only — the sidebar and chat-header hooks
 * inject the archive/delete runners and the dialogs.
 */

export type DelegationMenuItemId =
  | "switch-provider"
  | "archive-old-children"
  | "delete-old-children";

/** "Switch provider…" entry, visible only where a handoff can happen. */
export function buildSwitchProviderMenuItem(
  canSwitchProvider: boolean,
): ReadonlyArray<ContextMenuItem<DelegationMenuItemId>> {
  return canSwitchProvider
    ? [{ id: "switch-provider" as const, label: "Switch provider…", icon: "refresh-cw" }]
    : [];
}

/**
 * Bulk cleanup for a parent with a long tail of old subtasks. Both entries
 * prune only beyond the newest N, so they never touch current work.
 */
export function buildOldChildrenMenuItems(
  staleDelegatedChildCount: number,
): ReadonlyArray<ContextMenuItem<DelegationMenuItemId>> {
  return staleDelegatedChildCount > 0
    ? [
        {
          id: "archive-old-children" as const,
          label: `Archive old subtasks (keep ${STALE_DELEGATED_CHILDREN_KEEP})`,
          icon: "archive",
          separatorBefore: true,
        },
        {
          id: "delete-old-children" as const,
          label: `Delete old subtasks (keep ${STALE_DELEGATED_CHILDREN_KEEP})`,
          destructive: true,
          icon: "trash",
        },
      ]
    : [];
}

/** Minimal shell shape the delegated-children helpers need. */
export interface DelegatedChildThreadLike {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly archivedAt?: string | null;
  readonly createdAt?: string | null;
  readonly runtime?:
    | {
        readonly status?: string | null;
        readonly activeRunId?: string | null;
      }
    | null
    | undefined;
  readonly lineage?:
    | {
        readonly parentThreadId: ThreadId | null;
      }
    | null
    | undefined;
}

function isChildOf(thread: DelegatedChildThreadLike, parent: ScopedThreadRef): boolean {
  return (
    thread.environmentId === parent.environmentId &&
    thread.lineage?.parentThreadId === parent.threadId
  );
}

/**
 * Direct delegated children of `parent`, resolved to scoped refs and sorted
 * by scoped key. Grandchildren stay out: deleting or archiving a child is its
 * own action and applies that child's settings when the user reaches it.
 */
export function collectDelegatedChildRefs(input: {
  readonly parent: ScopedThreadRef;
  readonly threads: ReadonlyArray<DelegatedChildThreadLike>;
}): ReadonlyArray<ScopedThreadRef> {
  const refs: ScopedThreadRef[] = [];
  for (const thread of input.threads) {
    if (thread.archivedAt != null) continue;
    if (!isChildOf(thread, input.parent)) continue;
    refs.push(scopeThreadRef(thread.environmentId, thread.id));
  }
  return refs.sort((left, right) => {
    const leftKey = scopedThreadKey(left);
    const rightKey = scopedThreadKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

/**
 * Every delegated descendant of `parent` — children, grandchildren, and
 * beyond — resolved to scoped refs and sorted by scoped key. Archived threads
 * are included on purpose: the server deletes the whole subtree, archived
 * branches included, so the delete confirmation counts exactly what the
 * server will remove. A visited set keeps the walk total even if lineage ever
 * forms a cycle.
 */
export function collectDelegatedDescendantRefs(input: {
  readonly parent: ScopedThreadRef;
  readonly threads: ReadonlyArray<DelegatedChildThreadLike>;
}): ReadonlyArray<ScopedThreadRef> {
  const parentKey = scopedThreadKey(input.parent);
  const visited = new Set<string>([parentKey]);
  const refs: ScopedThreadRef[] = [];
  let frontier: ReadonlyArray<ScopedThreadRef> = [input.parent];
  while (frontier.length > 0) {
    const next: ScopedThreadRef[] = [];
    for (const current of frontier) {
      for (const thread of input.threads) {
        if (!isChildOf(thread, current)) continue;
        const childRef = scopeThreadRef(thread.environmentId, thread.id);
        const childKey = scopedThreadKey(childRef);
        if (visited.has(childKey)) continue;
        visited.add(childKey);
        refs.push(childRef);
        next.push(childRef);
      }
    }
    frontier = next;
  }
  return refs.sort((left, right) => {
    const leftKey = scopedThreadKey(left);
    const rightKey = scopedThreadKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

/**
 * How many delegated descendants `parent` has. Used by the delete
 * confirmation, which warns about the server-side cascade.
 */
export function countDelegatedDescendants(input: {
  readonly parent: ScopedThreadRef;
  readonly threads: ReadonlyArray<DelegatedChildThreadLike>;
}): number {
  return collectDelegatedDescendantRefs(input).length;
}

/**
 * Per-parent variant of `collectDelegatedChildRefs` for bulk actions.
 * `excludeKeys` drops children that the bulk selection already handles on
 * their own row, so a parent's dialog never counts a separately selected
 * child. Parents with no remaining children are omitted.
 */
export function collectDelegatedChildRefsForParents(input: {
  readonly parents: ReadonlyArray<ScopedThreadRef>;
  readonly threads: ReadonlyArray<DelegatedChildThreadLike>;
  readonly excludeKeys?: ReadonlySet<string> | undefined;
}): ReadonlyMap<string, ReadonlyArray<ScopedThreadRef>> {
  const childrenByParentKey = new Map<string, ReadonlyArray<ScopedThreadRef>>();
  for (const parent of input.parents) {
    const children = collectDelegatedChildRefs({ parent, threads: input.threads }).filter(
      (child) => input.excludeKeys?.has(scopedThreadKey(child)) !== true,
    );
    if (children.length > 0) {
      childrenByParentKey.set(scopedThreadKey(parent), children);
    }
  }
  return childrenByParentKey;
}

/** Newest delegated children the bulk cleanup actions keep. */
export const STALE_DELEGATED_CHILDREN_KEEP = 10;

export interface StaleDelegatedChildren {
  /** Direct non-archived children older than the newest `keep`, minus running ones. */
  readonly stale: ReadonlyArray<ScopedThreadRef>;
  /** Stale children left in place because their turn is still running. */
  readonly running: number;
}

/**
 * Mirrors the archive gate (`threadRuntimeCanArchive`): a queued run counts
 * as live work only while it has an active run id.
 */
function isDelegatedChildRunning(thread: DelegatedChildThreadLike): boolean {
  const runtime = thread.runtime;
  if (runtime == null || runtime.status == null) return false;
  if (runtime.status === "queued") return runtime.activeRunId != null;
  return (
    runtime.status === "preparing" || runtime.status === "starting" || runtime.status === "running"
  );
}

/** Missing or unparsable timestamps sort as oldest so they are cleaned up first. */
function delegatedChildCreatedAtMs(thread: DelegatedChildThreadLike): number {
  const parsed = thread.createdAt == null ? Number.NaN : Date.parse(thread.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Splits direct delegated children into the newest `keep` that stay and the
 * older rest that cleanup may act on. Archived children are ignored on both
 * sides, and a stale child that is still running is reported rather than
 * selected — cleanup must never abort live work.
 */
export function selectStaleDelegatedChildren(input: {
  readonly parent: ScopedThreadRef;
  readonly threads: ReadonlyArray<DelegatedChildThreadLike>;
  readonly keep?: number;
}): StaleDelegatedChildren {
  const keep = Math.max(0, input.keep ?? STALE_DELEGATED_CHILDREN_KEEP);
  const children = input.threads.filter((thread) => {
    if (thread.archivedAt != null) return false;
    return isChildOf(thread, input.parent);
  });
  // Newest first; the scoped key breaks timestamp ties so the kept set is stable.
  const ordered = [...children].sort((left, right) => {
    const delta = delegatedChildCreatedAtMs(right) - delegatedChildCreatedAtMs(left);
    if (delta !== 0) return delta;
    const leftKey = scopedThreadKey(scopeThreadRef(left.environmentId, left.id));
    const rightKey = scopedThreadKey(scopeThreadRef(right.environmentId, right.id));
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

  const stale: ScopedThreadRef[] = [];
  let running = 0;
  for (const thread of ordered.slice(keep)) {
    if (isDelegatedChildRunning(thread)) {
      running += 1;
      continue;
    }
    stale.push(scopeThreadRef(thread.environmentId, thread.id));
  }
  return { stale, running };
}

/**
 * Resolves the tri-state children decision for every parent of a bulk action
 * before anything is mutated: "ask" parents are prompted in map order and a
 * dismissal returns null so the caller can abort the whole batch untouched.
 * The returned set holds the scoped keys whose children cascade.
 */
export async function resolveDelegatedChildrenBulkCascade(input: {
  readonly action: "delete" | "archive";
  readonly mode: ThreadChildrenAction;
  readonly childrenByParentKey: ReadonlyMap<string, ReadonlyArray<ScopedThreadRef>>;
  readonly ask: (request: {
    readonly action: "delete" | "archive";
    readonly childCount: number;
  }) => Promise<"yes" | "no" | "dismissed">;
}): Promise<ReadonlySet<string> | null> {
  const cascadeKeys = new Set<string>();
  for (const [parentKey, children] of input.childrenByParentKey) {
    const decision = resolveDelegatedChildrenDecision({
      mode: input.mode,
      childCount: children.length,
    });
    if (decision === "skip" || decision === "parent-only") continue;
    if (decision === "cascade") {
      cascadeKeys.add(parentKey);
      continue;
    }
    const answer = await input.ask({ action: input.action, childCount: children.length });
    if (answer === "dismissed") return null;
    if (answer === "yes") cascadeKeys.add(parentKey);
  }
  return cascadeKeys;
}

export type DelegatedChildrenDecision = "skip" | "ask" | "cascade" | "parent-only";

/** No children means no dialog, whatever the mode says. */
export function resolveDelegatedChildrenDecision(input: {
  readonly mode: ThreadChildrenAction;
  readonly childCount: number;
}): DelegatedChildrenDecision {
  if (input.childCount === 0) return "skip";
  switch (input.mode) {
    case "always-yes":
      return "cascade";
    case "always-no":
      return "parent-only";
    default:
      return "ask";
  }
}

export function delegatedChildrenDialogMessage(input: {
  readonly action: "delete" | "archive";
  readonly childCount: number;
}): string {
  const verb = input.action === "delete" ? "Delete" : "Archive";
  const unit = input.childCount === 1 ? "subtask" : "subtasks";
  return `${verb} ${input.childCount} delegated ${unit} together with the parent?`;
}

export interface DelegatedChildrenRunResult {
  readonly ok: boolean;
  readonly error?: unknown;
}

export type DelegatedChildrenActionOutcome =
  | {
      readonly kind: "no-children" | "parent-only" | "cascade";
      readonly parent: DelegatedChildrenRunResult;
    }
  | { readonly kind: "dismissed" }
  | {
      readonly kind: "child-failed";
      readonly failed: ScopedThreadRef;
      readonly error: unknown;
    };

/**
 * Runs the parent action together with its delegated children in one order:
 * every child first, in the given (sorted) order, parent last. `runParent`
 * receives `cascadeConfirmed`, so the caller skips the parent's own
 * confirmation when the children dialog already approved it. A dismissed
 * dialog or a failed child stops before the parent, leaving nothing orphaned.
 */
export async function runDelegatedChildrenAction(input: {
  readonly children: ReadonlyArray<ScopedThreadRef>;
  readonly mode: ThreadChildrenAction;
  readonly ask: () => Promise<"yes" | "no" | "dismissed">;
  readonly runChild: (ref: ScopedThreadRef) => Promise<DelegatedChildrenRunResult>;
  readonly runParent: (context: {
    readonly cascadeConfirmed: boolean;
  }) => Promise<DelegatedChildrenRunResult>;
}): Promise<DelegatedChildrenActionOutcome> {
  const decision = resolveDelegatedChildrenDecision({
    mode: input.mode,
    childCount: input.children.length,
  });
  if (decision === "skip") {
    return { kind: "no-children", parent: await input.runParent({ cascadeConfirmed: false }) };
  }
  let cascade = decision === "cascade";
  if (decision === "ask") {
    const answer = await input.ask();
    if (answer === "dismissed") return { kind: "dismissed" };
    cascade = answer === "yes";
  }
  if (cascade) {
    for (const child of input.children) {
      const result = await input.runChild(child);
      if (!result.ok) {
        return { kind: "child-failed", failed: child, error: result.error };
      }
    }
  }
  return {
    kind: cascade ? "cascade" : "parent-only",
    parent: await input.runParent({ cascadeConfirmed: cascade }),
  };
}

export function delegatedChildrenCleanupMessage(input: {
  readonly action: "archive" | "delete";
  readonly count: number;
  readonly keep: number;
  readonly running: number;
}): string {
  const verb = input.action === "delete" ? "Delete" : "Archive";
  const unit = input.count === 1 ? "subtask" : "subtasks";
  const lines = [`${verb} ${input.count} old delegated ${unit}?`, `The newest ${input.keep} stay.`];
  if (input.running === 1) {
    lines.push("1 running subtask is left alone.");
  } else if (input.running > 1) {
    lines.push(`${input.running} running subtasks are left alone.`);
  }
  return lines.join("\n");
}

export type DelegatedChildrenCleanupOutcome =
  | { readonly kind: "nothing" }
  | { readonly kind: "dismissed" }
  | { readonly kind: "done" }
  | { readonly kind: "child-failed"; readonly failed: ScopedThreadRef; readonly error: unknown };

/**
 * Archives or deletes every delegated child older than the newest `keep`.
 * Children run in order and a failure stops the batch, so the caller can
 * report a partial run instead of silently continuing past it.
 */
export async function runDelegatedChildrenCleanup(input: {
  readonly action: "archive" | "delete";
  readonly parent: ScopedThreadRef;
  readonly threads: ReadonlyArray<DelegatedChildThreadLike>;
  readonly keep?: number;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly runChild: (
    ref: ScopedThreadRef,
    staleKeys: ReadonlySet<string>,
  ) => Promise<DelegatedChildrenRunResult>;
}): Promise<DelegatedChildrenCleanupOutcome> {
  const keep = Math.max(0, input.keep ?? STALE_DELEGATED_CHILDREN_KEEP);
  const selection = selectStaleDelegatedChildren({
    parent: input.parent,
    threads: input.threads,
    keep,
  });
  if (selection.stale.length === 0) return { kind: "nothing" };
  const confirmed = await input.confirm(
    delegatedChildrenCleanupMessage({
      action: input.action,
      count: selection.stale.length,
      keep,
      running: selection.running,
    }),
  );
  if (!confirmed) return { kind: "dismissed" };
  const staleKeys = new Set(selection.stale.map((ref) => scopedThreadKey(ref)));
  for (const child of selection.stale) {
    const result = await input.runChild(child, staleKeys);
    if (!result.ok) return { kind: "child-failed", failed: child, error: result.error };
  }
  return { kind: "done" };
}

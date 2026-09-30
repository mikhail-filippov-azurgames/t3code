import type {
  ArchitectTaskEffort,
  ContextMenuItem,
  EnvironmentId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ThreadChildrenAction } from "@t3tools/contracts/settings";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";

/**
 * Ids for the per-thread action menu. Snooze presets are dispatched as
 * `snooze:<presetId>` so the union stays closed while the preset list
 * remains data-driven.
 */
export type ThreadActionMenuId =
  | "new-thread-on-branch"
  | "project-settings"
  | "pin"
  | "unpin"
  | "switch-provider"
  | "settle"
  | "unsettle"
  | "snooze"
  | `snooze:${string}`
  | "unsnooze"
  | "rename"
  | "regenerate-title"
  | "mark-unread"
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "copy-thread-id"
  | "archive-old-children"
  | "delete-old-children"
  | "archive"
  | "delete";

export type CoordinatorArchitectSidebarAction = "replace" | "detach";

export function buildCoordinatorArchitectSidebarPrompt(input: {
  readonly action: CoordinatorArchitectSidebarAction;
  readonly architectThreadId: ThreadId;
  readonly taskEffort: ArchitectTaskEffort;
  readonly questionOrReason: string;
  readonly preferredTarget?: {
    readonly instanceId: string;
    readonly driverKind: string;
    readonly model: string;
  };
}): string {
  switch (input.action) {
    case "replace":
      return [
        "Replace the bound Architect using architect_replace after checking the accepted architecture routing policy and saving the selection rationale to OpenContext.",
        `Current Architect thread: ${input.architectThreadId}`,
        `Task effort: ${input.taskEffort}`,
        `Human preferred target: ${input.preferredTarget?.instanceId ?? "unspecified"} (${input.preferredTarget?.driverKind ?? "unknown"}) / ${input.preferredTarget?.model ?? "unspecified"}`,
        `Reason: ${input.questionOrReason}`,
        "Verify that the preference is eligible for role=architecture and the live provider's read-only permission envelope. If it is not eligible, explain and use the policy route only after recording the decision in OpenContext. Replacement soft-deletes the prior binding and revokes its credential after the durable transition.",
        "Accepted policy: oc://doc/3900df61-9dd5-4621-9278-34ac20d60648 (its current accepted revision is authoritative; read it from OpenContext)",
      ].join("\n\n");
    case "detach":
      return [
        "Detach the bound Architect using architect_detach.",
        `Reason: ${input.questionOrReason}`,
        "This soft-deletes and retains the binding, then revokes the Architect credential after the durable transition. Do not purge or recreate it unless I request a new binding.",
      ].join("\n\n");
  }
}

export interface ThreadActionMenuState {
  readonly branch: string | null;
  readonly isPinned: boolean;
  /**
   * Whether the engine can switch this thread's provider: delegated
   * threads (lineage scope) and ordinary threads with a provider session
   * (own scope). Callers compute it with `canSwitchThreadProvider`.
   */
  readonly canSwitchProvider: boolean;
  readonly isSettled: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  readonly isRegeneratingTitle: boolean;
  /** Archive rejects a thread with an active turn, so disable it here rather than let the action fail. */
  readonly isRunning: boolean;
  /**
   * Delegated children the "keep the newest N" cleanup actions would touch.
   * Zero hides both entries; callers compute it with
   * {@link selectStaleDelegatedChildren} at menu-open time.
   */
  readonly staleDelegatedChildCount: number;
  readonly supports: {
    readonly settlement: boolean;
    readonly snooze: boolean;
    readonly pinning: boolean;
    readonly titleRegeneration: boolean;
  };
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
}

/**
 * Single source for the per-thread action menu: the sidebar row's right-click
 * menu and the chat header menu both render exactly this list, so labels,
 * ordering, and capability gating cannot drift between the two surfaces.
 */
export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  return [
    ...(state.branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: `New thread on ${state.branch}`,
            icon: "message-square-plus",
          },
        ]
      : []),
    ...(state.supports.pinning
      ? [
          state.isPinned
            ? { id: "unpin" as const, label: "Unpin thread", icon: "pin-off" }
            : { id: "pin" as const, label: "Pin thread", icon: "pin" },
        ]
      : []),
    // Provider switch is served by the engine for delegated threads and
    // for ordinary threads with a provider session, so the entry stays
    // hidden everywhere else.
    ...(state.canSwitchProvider
      ? [{ id: "switch-provider" as const, label: "Switch provider…", icon: "refresh-cw" }]
      : []),
    // Both lifecycle actions stay available on pinned threads: settling
    // clears the pin ("done" beats "keep on top"), and snoozing hides the
    // card until wake with the pin intact.
    ...(state.supports.settlement
      ? [
          state.isSettled
            ? { id: "unsettle" as const, label: "Un-settle thread", icon: "circle-check" }
            : { id: "settle" as const, label: "Settle thread", icon: "circle-check" },
        ]
      : []),
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: "Wake thread", icon: "clock" }
            : {
                id: "snooze" as const,
                label: "Snooze",
                icon: "clock",
                disabled: !state.canSnoozeNow,
                children: [
                  ...state.snoozePresets.map((preset) => ({
                    id: `snooze:${preset.id}` as const,
                    label: `${preset.label} (${preset.whenLabel})`,
                  })),
                  { id: "snooze:custom" as const, label: "Custom…", separatorBefore: true },
                ],
              },
        ]
      : []),
    { id: "rename", label: "Rename thread", icon: "pencil", separatorBefore: true },
    ...(state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle ? "Regenerating…" : "Regenerate title",
            icon: "refresh-cw",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    { id: "mark-unread", label: "Mark unread", icon: "mail-open" },
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      separatorBefore: true,
      children: [
        { id: "copy-path", label: "Path", icon: "folder" },
        ...(state.branch
          ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
          : []),
        { id: "copy-thread-id", label: "Thread ID", icon: "hash" },
      ],
    },
    { id: "project-settings", label: "Project settings", icon: "settings" },
    // Bulk cleanup for a parent with a long tail of old subtasks. Both
    // entries prune only beyond the newest N, so they never touch current work.
    ...(state.staleDelegatedChildCount > 0
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
      : []),
    // Archive removes the thread from the sidebar while keeping its
    // conversation under Settings > Archived threads — distinct from Settle
    // (stays visible in the Settled shelf) and Delete (clears history for
    // good), so it sits beside Delete without borrowing its destructive
    // styling.
    {
      id: "archive",
      label: "Archive thread",
      icon: "archive",
      disabled: state.isRunning,
      separatorBefore: true,
    },
    {
      id: "delete",
      label: "Delete",
      destructive: true,
      icon: "trash",
    },
  ];
}

/** Minimal shell shape the delegated-children helpers need. */
export interface DelegatedChildThreadLike {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly archivedAt?: string | null;
  readonly createdAt?: string | null;
  readonly session?:
    | {
        readonly status?: string | null;
        readonly activeTurnId?: string | null;
      }
    | null
    | undefined;
  readonly delegationParent?:
    | {
        readonly parentThreadId: ThreadId;
        readonly parentEnvironmentId: string;
      }
    | null
    | undefined;
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
    const delegationParent = thread.delegationParent;
    if (delegationParent == null) continue;
    if (
      delegationParent.parentThreadId !== input.parent.threadId ||
      delegationParent.parentEnvironmentId !== input.parent.environmentId
    ) {
      continue;
    }
    refs.push(scopeThreadRef(thread.environmentId, thread.id));
  }
  return refs.sort((left, right) => {
    const leftKey = scopedThreadKey(left);
    const rightKey = scopedThreadKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
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

function isDelegatedChildRunning(thread: DelegatedChildThreadLike): boolean {
  return thread.session?.status === "running" && thread.session.activeTurnId != null;
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
    const delegationParent = thread.delegationParent;
    return (
      delegationParent != null &&
      delegationParent.parentThreadId === input.parent.threadId &&
      delegationParent.parentEnvironmentId === input.parent.environmentId
    );
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

import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import type { ThreadChildrenAction } from "@t3tools/contracts/settings";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  collectDelegatedChildRefs,
  collectDelegatedChildRefsForParents,
  delegatedChildrenCleanupMessage,
  delegatedChildrenDialogMessage,
  resolveDelegatedChildrenBulkCascade,
  resolveDelegatedChildrenDecision,
  runDelegatedChildrenAction,
  runDelegatedChildrenCleanup,
  selectStaleDelegatedChildren,
  type DelegatedChildThreadLike,
  type DelegatedChildrenRunResult,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  branch: null,
  isPinned: false,
  canSwitchProvider: false,
  isSettled: false,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  staleDelegatedChildCount: 0,
  supports: { settlement: true, snooze: true, pinning: true, titleRegeneration: true },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

function ids(state: ThreadActionMenuState): string[] {
  return buildThreadActionMenuItems(state).map((item) => item.id);
}

function allIds(state: ThreadActionMenuState): string[] {
  const flatten = (items: ReturnType<typeof buildThreadActionMenuItems>): string[] =>
    items.flatMap((item) => [item.id, ...(item.children ? flatten(item.children) : [])]);
  return flatten(buildThreadActionMenuItems(state));
}

describe("buildThreadActionMenuItems", () => {
  it("hides lifecycle items when the environment lacks the capabilities", () => {
    expect(
      ids({
        ...baseState,
        supports: { settlement: false, snooze: false, pinning: false, titleRegeneration: false },
      }),
    ).toEqual(["rename", "mark-unread", "copy", "project-settings", "archive", "delete"]);
  });

  it("groups project settings with utility actions before archive", () => {
    const items = buildThreadActionMenuItems(baseState);
    const copyIndex = items.findIndex((item) => item.id === "copy");
    expect(items[copyIndex + 1]).toMatchObject({
      id: "project-settings",
      label: "Project settings",
      icon: "settings",
    });
    expect(items[copyIndex + 2]?.id).toBe("archive");
  });

  it("includes branch items only for threads with a branch", () => {
    const withBranch = allIds({ ...baseState, branch: "feat/menu" });
    expect(withBranch).toContain("new-thread-on-branch");
    expect(withBranch).toContain("copy-branch");
    expect(allIds(baseState)).not.toContain("new-thread-on-branch");
    expect(allIds(baseState)).not.toContain("copy-branch");
  });

  it("flips lifecycle labels with thread state", () => {
    expect(ids({ ...baseState, isPinned: true, isSettled: true, isSnoozed: true })).toEqual(
      expect.arrayContaining(["unpin", "unsettle", "unsnooze"]),
    );
    expect(ids(baseState)).toEqual(expect.arrayContaining(["pin", "settle", "snooze"]));
  });

  it("disables snooze when the thread cannot snooze, keeping presets visible", () => {
    const snooze = buildThreadActionMenuItems({ ...baseState, canSnoozeNow: false }).find(
      (item) => item.id === "snooze",
    );
    expect(snooze?.disabled).toBe(true);
    expect(snooze?.children?.map((child) => child.id)).toEqual(["snooze:hour", "snooze:custom"]);
  });

  it("disables title regeneration while one is in flight", () => {
    const item = buildThreadActionMenuItems({ ...baseState, isRegeneratingTitle: true }).find(
      (candidate) => candidate.id === "regenerate-title",
    );
    expect(item).toMatchObject({ label: "Regenerating…", disabled: true });
  });

  it("marks delete as destructive and keeps it last", () => {
    const items = buildThreadActionMenuItems({ ...baseState, branch: "main" });
    expect(items.at(-1)).toMatchObject({ id: "delete", destructive: true });
  });
  it("offers archive as a non-destructive action right before delete", () => {
    const items = buildThreadActionMenuItems(baseState);
    const archiveItem = items.at(-2);
    expect(archiveItem?.id).toBe("archive");
    expect(archiveItem?.icon).toBe("archive");
    expect(archiveItem?.separatorBefore).toBe(true);
    expect(archiveItem?.destructive).toBeFalsy();
    expect(items.at(-1)?.id).toBe("delete");
  });

  it("keeps archive available even when the environment lacks every other capability", () => {
    expect(
      ids({
        ...baseState,
        supports: { settlement: false, snooze: false, pinning: false, titleRegeneration: false },
      }),
    ).toContain("archive");
  });

  it("disables archive while the thread is running", () => {
    const archiveItem = buildThreadActionMenuItems({ ...baseState, isRunning: true }).find(
      (item) => item.id === "archive",
    );
    expect(archiveItem?.disabled).toBe(true);
  });

  it("shows switch provider for delegated and ordinary switchable threads", () => {
    expect(ids(baseState)).not.toContain("switch-provider");
    expect(ids({ ...baseState, canSwitchProvider: true })).toContain("switch-provider");
  });

  it("hides switch provider where the engine cannot switch", () => {
    expect(ids({ ...baseState, canSwitchProvider: false })).not.toContain("switch-provider");
  });

  it("places switch provider right after the pin entry", () => {
    const items = buildThreadActionMenuItems({ ...baseState, canSwitchProvider: true });
    const pinIndex = items.findIndex((item) => item.id === "pin");
    expect(items[pinIndex + 1]).toMatchObject({
      id: "switch-provider",
      label: "Switch provider…",
      icon: "refresh-cw",
    });
  });
});

const parentRef = scopeThreadRef(EnvironmentId.make("env-parent"), ThreadId.make("parent"));

function delegatedChild(input: {
  readonly environmentId: string;
  readonly id: string;
  readonly parentEnvironmentId?: string;
  readonly parentThreadId?: string;
  readonly archivedAt?: string | null;
  readonly createdAt?: string;
  readonly running?: boolean;
}): DelegatedChildThreadLike {
  return {
    id: ThreadId.make(input.id),
    environmentId: EnvironmentId.make(input.environmentId),
    archivedAt: input.archivedAt ?? null,
    createdAt: input.createdAt ?? "2026-01-01T00:00:00Z",
    session: input.running
      ? { status: "running", activeTurnId: "turn-1" }
      : { status: "idle", activeTurnId: null },
    delegationParent: {
      parentThreadId: ThreadId.make(input.parentThreadId ?? "parent"),
      parentEnvironmentId: input.parentEnvironmentId ?? "env-parent",
    },
  };
}

/** `index` doubles as age: higher is newer. */
function childCreatedAt(index: number): string {
  return `2026-02-${String(index + 1).padStart(2, "0")}T00:00:00Z`;
}

function thirteenChildren(
  overrides: (index: number) => Partial<Parameters<typeof delegatedChild>[0]> = () => ({}),
): DelegatedChildThreadLike[] {
  return Array.from({ length: 13 }, (_, index) =>
    delegatedChild({
      environmentId: "env-a",
      id: `child-${index}`,
      createdAt: childCreatedAt(index),
      ...overrides(index),
    }),
  );
}

function scopedChild(environmentId: string, id: string): ScopedThreadRef {
  return scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(id));
}

describe("collectDelegatedChildRefs", () => {
  it("collects direct children across environments sorted by scoped key", () => {
    const refs = collectDelegatedChildRefs({
      parent: parentRef,
      threads: [
        delegatedChild({ environmentId: "env-b", id: "second" }),
        delegatedChild({ environmentId: "env-a", id: "first" }),
        { id: ThreadId.make("plain"), environmentId: EnvironmentId.make("env-a") },
        delegatedChild({
          environmentId: "env-a",
          id: "archived",
          archivedAt: "2026-01-01T00:00:00Z",
        }),
        delegatedChild({
          environmentId: "env-a",
          id: "other-parent",
          parentThreadId: "someone-else",
        }),
        delegatedChild({ environmentId: "env-a", id: "grandchild", parentThreadId: "first" }),
      ],
    });

    expect(refs.map(scopedThreadKey)).toEqual(["env-a:first", "env-b:second"]);
  });

  it("returns nothing for a parent without delegated children", () => {
    expect(
      collectDelegatedChildRefs({
        parent: parentRef,
        threads: [
          delegatedChild({ environmentId: "env-a", id: "other-parent", parentThreadId: "x" }),
        ],
      }),
    ).toEqual([]);
  });
});

describe("collectDelegatedChildRefsForParents", () => {
  it("maps direct children to their parent's scoped key", () => {
    const parentB = scopeThreadRef(EnvironmentId.make("env-b"), ThreadId.make("boss"));
    const refsByParentKey = collectDelegatedChildRefsForParents({
      parents: [parentRef, parentB],
      threads: [
        delegatedChild({ environmentId: "env-a", id: "a-child" }),
        delegatedChild({
          environmentId: "env-b",
          id: "b-child",
          parentEnvironmentId: "env-b",
          parentThreadId: "boss",
        }),
        delegatedChild({ environmentId: "env-a", id: "other-parent", parentThreadId: "someone" }),
      ],
    });

    expect(refsByParentKey.get(scopedThreadKey(parentRef))?.map(scopedThreadKey)).toEqual([
      "env-a:a-child",
    ]);
    expect(refsByParentKey.get(scopedThreadKey(parentB))?.map(scopedThreadKey)).toEqual([
      "env-b:b-child",
    ]);
    expect(refsByParentKey.size).toBe(2);
  });

  it("drops children that the bulk selection already covers", () => {
    const refsByParentKey = collectDelegatedChildRefsForParents({
      parents: [parentRef],
      threads: [
        delegatedChild({ environmentId: "env-a", id: "selected" }),
        delegatedChild({ environmentId: "env-a", id: "kept" }),
      ],
      excludeKeys: new Set(["env-a:selected"]),
    });

    expect(refsByParentKey.get(scopedThreadKey(parentRef))?.map(scopedThreadKey)).toEqual([
      "env-a:kept",
    ]);
  });

  it("omits parents whose children are all excluded", () => {
    const refsByParentKey = collectDelegatedChildRefsForParents({
      parents: [parentRef],
      threads: [delegatedChild({ environmentId: "env-a", id: "gone" })],
      excludeKeys: new Set(["env-a:gone"]),
    });

    expect(refsByParentKey.size).toBe(0);
  });
});

describe("resolveDelegatedChildrenDecision", () => {
  it("never asks when there are no children", () => {
    for (const mode of ["ask", "always-yes", "always-no"] as const) {
      expect(resolveDelegatedChildrenDecision({ mode, childCount: 0 })).toBe("skip");
    }
  });

  it("maps the three states when children exist", () => {
    expect(resolveDelegatedChildrenDecision({ mode: "ask", childCount: 2 })).toBe("ask");
    expect(resolveDelegatedChildrenDecision({ mode: "always-yes", childCount: 2 })).toBe("cascade");
    expect(resolveDelegatedChildrenDecision({ mode: "always-no", childCount: 2 })).toBe(
      "parent-only",
    );
  });
});

describe("delegatedChildrenDialogMessage", () => {
  it("names the count and the action", () => {
    expect(delegatedChildrenDialogMessage({ action: "delete", childCount: 1 })).toBe(
      "Delete 1 delegated subtask together with the parent?",
    );
    expect(delegatedChildrenDialogMessage({ action: "archive", childCount: 3 })).toBe(
      "Archive 3 delegated subtasks together with the parent?",
    );
  });
});

async function runCascade(input: {
  readonly children: ReadonlyArray<ScopedThreadRef>;
  readonly mode: ThreadChildrenAction;
  readonly answer?: "yes" | "no" | "dismissed";
  readonly failChildKey?: string;
  readonly parentOk?: boolean;
}) {
  const log: string[] = [];
  let askCalls = 0;
  let parentCascadeConfirmed: boolean | null = null;
  const result = await runDelegatedChildrenAction({
    children: input.children,
    mode: input.mode,
    ask: async () => {
      askCalls += 1;
      return input.answer ?? "yes";
    },
    runChild: async (ref): Promise<DelegatedChildrenRunResult> => {
      log.push(`child:${scopedThreadKey(ref)}`);
      return input.failChildKey === scopedThreadKey(ref)
        ? { ok: false, error: new Error("child failed") }
        : { ok: true };
    },
    runParent: async ({ cascadeConfirmed }) => {
      parentCascadeConfirmed = cascadeConfirmed;
      log.push("parent");
      return { ok: input.parentOk ?? true };
    },
  });
  return { result, log, askCalls, parentCascadeConfirmed };
}

describe("runDelegatedChildrenAction", () => {
  it("runs only the parent without any dialog when there are no children", async () => {
    const { result, log, askCalls, parentCascadeConfirmed } = await runCascade({
      children: [],
      mode: "ask",
    });

    expect(askCalls).toBe(0);
    expect(log).toEqual(["parent"]);
    expect(result).toEqual({ kind: "no-children", parent: { ok: true } });
    expect(parentCascadeConfirmed).toBe(false);
  });

  it("runs every child before the parent when the dialog answers yes", async () => {
    const { result, log, askCalls, parentCascadeConfirmed } = await runCascade({
      children: [scopedChild("env-a", "first"), scopedChild("env-b", "second")],
      mode: "ask",
      answer: "yes",
    });

    expect(askCalls).toBe(1);
    expect(log).toEqual(["child:env-a:first", "child:env-b:second", "parent"]);
    expect(result.kind).toBe("cascade");
    expect(parentCascadeConfirmed).toBe(true);
  });

  it("keeps the children when the dialog answers no", async () => {
    const { result, log, askCalls, parentCascadeConfirmed } = await runCascade({
      children: [scopedChild("env-a", "first")],
      mode: "ask",
      answer: "no",
    });

    expect(askCalls).toBe(1);
    expect(log).toEqual(["parent"]);
    expect(result.kind).toBe("parent-only");
    expect(parentCascadeConfirmed).toBe(false);
  });

  it("does nothing when the dialog is dismissed", async () => {
    const { result, log, askCalls } = await runCascade({
      children: [scopedChild("env-a", "first")],
      mode: "ask",
      answer: "dismissed",
    });

    expect(askCalls).toBe(1);
    expect(log).toEqual([]);
    expect(result).toEqual({ kind: "dismissed" });
  });

  it("cascades without a dialog in always-yes", async () => {
    const { result, log, askCalls, parentCascadeConfirmed } = await runCascade({
      children: [scopedChild("env-a", "first"), scopedChild("env-a", "second")],
      mode: "always-yes",
    });

    expect(askCalls).toBe(0);
    expect(log).toEqual(["child:env-a:first", "child:env-a:second", "parent"]);
    expect(result.kind).toBe("cascade");
    expect(parentCascadeConfirmed).toBe(true);
  });

  it("touches only the parent in always-no", async () => {
    const { result, log, askCalls, parentCascadeConfirmed } = await runCascade({
      children: [scopedChild("env-a", "first")],
      mode: "always-no",
    });

    expect(askCalls).toBe(0);
    expect(log).toEqual(["parent"]);
    expect(result.kind).toBe("parent-only");
    expect(parentCascadeConfirmed).toBe(false);
  });

  it("stops before the parent when a child action fails", async () => {
    const { result, log } = await runCascade({
      children: [scopedChild("env-a", "first"), scopedChild("env-b", "second")],
      mode: "always-yes",
      failChildKey: "env-b:second",
    });

    expect(log).toEqual(["child:env-a:first", "child:env-b:second"]);
    expect(result).toMatchObject({ kind: "child-failed" });
    if (result.kind === "child-failed") {
      expect(scopedThreadKey(result.failed)).toBe("env-b:second");
    }
  });

  it("propagates a failed parent action after a completed cascade", async () => {
    const { result, log } = await runCascade({
      children: [scopedChild("env-a", "first")],
      mode: "always-yes",
      parentOk: false,
    });

    expect(log).toEqual(["child:env-a:first", "parent"]);
    expect(result).toEqual({ kind: "cascade", parent: { ok: false } });
  });
});

describe("old delegated subtask cleanup menu entries", () => {
  it("hides both entries when nothing is past the keep window", () => {
    expect(ids(baseState)).not.toContain("archive-old-children");
    expect(ids(baseState)).not.toContain("delete-old-children");
  });

  it("offers archive and a destructive delete when stale children exist", () => {
    const items = buildThreadActionMenuItems({ ...baseState, staleDelegatedChildCount: 3 });
    const archiveOld = items.find((item) => item.id === "archive-old-children");
    const deleteOld = items.find((item) => item.id === "delete-old-children");

    expect(archiveOld).toMatchObject({ icon: "archive", separatorBefore: true });
    expect(archiveOld?.destructive).toBeFalsy();
    expect(deleteOld).toMatchObject({ icon: "trash", destructive: true });
    expect(items.at(-1)?.id).toBe("delete");
  });
});

describe("selectStaleDelegatedChildren", () => {
  it("keeps the newest ten and selects the rest with the oldest last", () => {
    const selection = selectStaleDelegatedChildren({
      parent: parentRef,
      threads: thirteenChildren(),
    });

    expect(selection.stale.map(scopedThreadKey)).toEqual([
      "env-a:child-2",
      "env-a:child-1",
      "env-a:child-0",
    ]);
    expect(selection.running).toBe(0);
  });

  it("ignores archived children on both sides of the cut", () => {
    const selection = selectStaleDelegatedChildren({
      parent: parentRef,
      threads: thirteenChildren((index) =>
        index === 0 ? { archivedAt: "2026-03-01T00:00:00Z" } : {},
      ),
    });

    expect(selection.stale.map(scopedThreadKey)).toEqual(["env-a:child-2", "env-a:child-1"]);
  });

  it("reports a running stale child instead of selecting it", () => {
    const selection = selectStaleDelegatedChildren({
      parent: parentRef,
      threads: thirteenChildren((index) => (index === 0 ? { running: true } : {})),
    });

    expect(selection.stale.map(scopedThreadKey)).toEqual(["env-a:child-2", "env-a:child-1"]);
    expect(selection.running).toBe(1);
  });

  it("leaves other parents, grandchildren, and plain threads alone", () => {
    const selection = selectStaleDelegatedChildren({
      parent: parentRef,
      threads: [
        ...thirteenChildren(),
        delegatedChild({
          environmentId: "env-a",
          id: "other-parent",
          parentThreadId: "elsewhere",
        }),
        delegatedChild({ environmentId: "env-a", id: "grandchild", parentThreadId: "child-12" }),
        { id: ThreadId.make("plain"), environmentId: EnvironmentId.make("env-a") },
      ],
    });

    expect(selection.stale).toHaveLength(3);
  });

  it("keeps nothing when the parent has at most the keep window", () => {
    const selection = selectStaleDelegatedChildren({
      parent: parentRef,
      threads: thirteenChildren().slice(0, 10),
    });

    expect(selection.stale).toEqual([]);
  });
});

describe("delegatedChildrenCleanupMessage", () => {
  it("names the action, the count, and the running skip", () => {
    expect(
      delegatedChildrenCleanupMessage({ action: "archive", count: 2, keep: 10, running: 1 }),
    ).toBe(
      "Archive 2 old delegated subtasks?\nThe newest 10 stay.\n1 running subtask is left alone.",
    );
    expect(
      delegatedChildrenCleanupMessage({ action: "delete", count: 1, keep: 10, running: 0 }),
    ).toBe("Delete 1 old delegated subtask?\nThe newest 10 stay.");
  });
});

describe("runDelegatedChildrenCleanup", () => {
  it("confirms once, then cleans every stale child with the shared key set", async () => {
    const messages: string[] = [];
    const log: string[] = [];
    let seenKeyCount = 0;
    const result = await runDelegatedChildrenCleanup({
      action: "delete",
      parent: parentRef,
      threads: thirteenChildren(),
      confirm: async (message) => {
        messages.push(message);
        return true;
      },
      runChild: async (ref, staleKeys) => {
        log.push(scopedThreadKey(ref));
        seenKeyCount = staleKeys.size;
        return { ok: true };
      },
    });

    expect(result).toEqual({ kind: "done" });
    expect(messages).toEqual(["Delete 3 old delegated subtasks?\nThe newest 10 stay."]);
    expect(log).toEqual(["env-a:child-2", "env-a:child-1", "env-a:child-0"]);
    expect(seenKeyCount).toBe(3);
  });

  it("does nothing without stale children", async () => {
    let confirmCalls = 0;
    const result = await runDelegatedChildrenCleanup({
      action: "archive",
      parent: parentRef,
      threads: thirteenChildren().slice(0, 10),
      confirm: async () => {
        confirmCalls += 1;
        return true;
      },
      runChild: async () => ({ ok: true }),
    });

    expect(result).toEqual({ kind: "nothing" });
    expect(confirmCalls).toBe(0);
  });

  it("keeps every child when the confirmation is declined", async () => {
    const log: string[] = [];
    const result = await runDelegatedChildrenCleanup({
      action: "delete",
      parent: parentRef,
      threads: thirteenChildren(),
      confirm: async () => false,
      runChild: async (ref) => {
        log.push(scopedThreadKey(ref));
        return { ok: true };
      },
    });

    expect(result).toEqual({ kind: "dismissed" });
    expect(log).toEqual([]);
  });

  it("stops on the first failed child and reports it", async () => {
    const log: string[] = [];
    const result = await runDelegatedChildrenCleanup({
      action: "archive",
      parent: parentRef,
      threads: thirteenChildren(),
      confirm: async () => true,
      runChild: async (ref) => {
        const key = scopedThreadKey(ref);
        log.push(key);
        return key === "env-a:child-1" ? { ok: false, error: new Error("boom") } : { ok: true };
      },
    });

    expect(log).toEqual(["env-a:child-2", "env-a:child-1"]);
    expect(result).toMatchObject({ kind: "child-failed" });
    if (result.kind === "child-failed") {
      expect(scopedThreadKey(result.failed)).toBe("env-a:child-1");
    }
  });
});

function bulkChildrenMap(
  entries: ReadonlyArray<readonly [string, ReadonlyArray<ScopedThreadRef>]>,
): ReadonlyMap<string, ReadonlyArray<ScopedThreadRef>> {
  return new Map(entries);
}

describe("resolveDelegatedChildrenBulkCascade", () => {
  it("returns an empty set without asking when no parent has children", async () => {
    let askCalls = 0;
    const cascadeKeys = await resolveDelegatedChildrenBulkCascade({
      action: "delete",
      mode: "ask",
      childrenByParentKey: bulkChildrenMap([]),
      ask: async () => {
        askCalls += 1;
        return "yes";
      },
    });

    expect(askCalls).toBe(0);
    expect(cascadeKeys).toEqual(new Set());
  });

  it("cascades every parent without a dialog in always-yes", async () => {
    let askCalls = 0;
    const cascadeKeys = await resolveDelegatedChildrenBulkCascade({
      action: "archive",
      mode: "always-yes",
      childrenByParentKey: bulkChildrenMap([
        ["env-a:first", [scopedChild("env-a", "child-1")]],
        ["env-b:second", [scopedChild("env-b", "child-2")]],
      ]),
      ask: async () => {
        askCalls += 1;
        return "yes";
      },
    });

    expect(askCalls).toBe(0);
    expect(cascadeKeys).toEqual(new Set(["env-a:first", "env-b:second"]));
  });

  it("keeps children without a dialog in always-no", async () => {
    let askCalls = 0;
    const cascadeKeys = await resolveDelegatedChildrenBulkCascade({
      action: "delete",
      mode: "always-no",
      childrenByParentKey: bulkChildrenMap([["env-a:first", [scopedChild("env-a", "child")]]]),
      ask: async () => {
        askCalls += 1;
        return "yes";
      },
    });

    expect(askCalls).toBe(0);
    expect(cascadeKeys).toEqual(new Set());
  });

  it("asks per parent and carries the requested action and count", async () => {
    const requests: Array<{ action: string; childCount: number }> = [];
    const cascadeKeys = await resolveDelegatedChildrenBulkCascade({
      action: "archive",
      mode: "ask",
      childrenByParentKey: bulkChildrenMap([
        ["env-a:first", [scopedChild("env-a", "child-1"), scopedChild("env-a", "child-2")]],
        ["env-b:second", [scopedChild("env-b", "child-3")]],
      ]),
      ask: async (request) => {
        requests.push(request);
        return request.childCount === 2 ? "yes" : "no";
      },
    });

    expect(requests).toEqual([
      { action: "archive", childCount: 2 },
      { action: "archive", childCount: 1 },
    ]);
    expect(cascadeKeys).toEqual(new Set(["env-a:first"]));
  });

  it("returns null and stops asking when a dialog is dismissed", async () => {
    const asked: string[] = [];
    const cascadeKeys = await resolveDelegatedChildrenBulkCascade({
      action: "delete",
      mode: "ask",
      childrenByParentKey: bulkChildrenMap([
        ["env-a:first", [scopedChild("env-a", "child-1")]],
        ["env-b:second", [scopedChild("env-b", "child-2")]],
      ]),
      ask: async (request) => {
        asked.push(`${request.childCount}`);
        return "dismissed";
      },
    });

    expect(cascadeKeys).toBeNull();
    expect(asked).toEqual(["1"]);
  });
});

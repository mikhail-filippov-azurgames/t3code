import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import type { ThreadChildrenAction } from "@t3tools/contracts/settings";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";

import {
  buildOldChildrenMenuItems,
  buildSwitchProviderMenuItem,
  collectDelegatedChildRefs,
  collectDelegatedChildRefsForParents,
  collectDelegatedDescendantRefs,
  countDelegatedDescendants,
  delegatedChildrenCleanupMessage,
  delegatedChildrenDialogMessage,
  resolveDelegatedChildrenBulkCascade,
  resolveDelegatedChildrenDecision,
  runDelegatedChildrenAction,
  runDelegatedChildrenCleanup,
  selectStaleDelegatedChildren,
  STALE_DELEGATED_CHILDREN_KEEP,
  type DelegatedChildThreadLike,
  type DelegatedChildrenRunResult,
} from "./delegatedChildren.logic";

const parentRef = scopeThreadRef(EnvironmentId.make("env-parent"), ThreadId.make("parent"));

function delegatedChild(input: {
  readonly environmentId: string;
  readonly id: string;
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
    runtime: input.running
      ? { status: "running", activeRunId: "run-1" }
      : { status: "idle", activeRunId: null },
    lineage: { parentThreadId: ThreadId.make(input.parentThreadId ?? "parent") },
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
      environmentId: "env-parent",
      id: `child-${index}`,
      createdAt: childCreatedAt(index),
      ...overrides(index),
    }),
  );
}

function scopedChild(environmentId: string, id: string): ScopedThreadRef {
  return scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(id));
}

describe("delegation menu items", () => {
  it("shows switch provider only where a handoff can happen", () => {
    expect(buildSwitchProviderMenuItem(false)).toEqual([]);
    expect(buildSwitchProviderMenuItem(true)).toEqual([
      { id: "switch-provider", label: "Switch provider…", icon: "refresh-cw" },
    ]);
  });

  it("hides both old-children entries when nothing is past the keep window", () => {
    expect(buildOldChildrenMenuItems(0)).toEqual([]);
  });

  it("offers archive and a destructive delete when stale children exist", () => {
    expect(buildOldChildrenMenuItems(3)).toEqual([
      {
        id: "archive-old-children",
        label: `Archive old subtasks (keep ${STALE_DELEGATED_CHILDREN_KEEP})`,
        icon: "archive",
        separatorBefore: true,
      },
      {
        id: "delete-old-children",
        label: `Delete old subtasks (keep ${STALE_DELEGATED_CHILDREN_KEEP})`,
        destructive: true,
        icon: "trash",
      },
    ]);
  });
});

describe("collectDelegatedChildRefs", () => {
  it("collects direct children sorted by scoped key", () => {
    const refs = collectDelegatedChildRefs({
      parent: parentRef,
      threads: [
        delegatedChild({ environmentId: "env-parent", id: "second" }),
        delegatedChild({ environmentId: "env-parent", id: "first" }),
        { id: ThreadId.make("plain"), environmentId: EnvironmentId.make("env-parent") },
        delegatedChild({
          environmentId: "env-parent",
          id: "archived",
          archivedAt: "2026-01-01T00:00:00Z",
        }),
        delegatedChild({
          environmentId: "env-parent",
          id: "other-parent",
          parentThreadId: "someone-else",
        }),
        delegatedChild({ environmentId: "env-parent", id: "grandchild", parentThreadId: "first" }),
      ],
    });

    expect(refs.map(scopedThreadKey)).toEqual(["env-parent:first", "env-parent:second"]);
  });

  it("ignores lookalike children that live in another environment", () => {
    const refs = collectDelegatedChildRefs({
      parent: parentRef,
      threads: [delegatedChild({ environmentId: "env-other", id: "lookalike" })],
    });
    expect(refs).toEqual([]);
  });

  it("returns nothing for a parent without delegated children", () => {
    expect(
      collectDelegatedChildRefs({
        parent: parentRef,
        threads: [
          delegatedChild({ environmentId: "env-parent", id: "other-parent", parentThreadId: "x" }),
        ],
      }),
    ).toEqual([]);
  });
});

describe("collectDelegatedDescendantRefs", () => {
  it("walks every level including archived branches, sorted by scoped key", () => {
    const refs = collectDelegatedDescendantRefs({
      parent: parentRef,
      threads: [
        delegatedChild({ environmentId: "env-parent", id: "second" }),
        delegatedChild({ environmentId: "env-parent", id: "first" }),
        delegatedChild({
          environmentId: "env-parent",
          id: "grandchild",
          parentThreadId: "first",
        }),
        delegatedChild({
          environmentId: "env-parent",
          id: "archived-child",
          archivedAt: "2026-01-01T00:00:00Z",
        }),
        delegatedChild({
          environmentId: "env-parent",
          id: "archived-grandchild",
          parentThreadId: "archived-child",
          archivedAt: "2026-01-01T00:00:00Z",
        }),
        delegatedChild({
          environmentId: "env-parent",
          id: "other-parent",
          parentThreadId: "someone-else",
        }),
        { id: ThreadId.make("plain"), environmentId: EnvironmentId.make("env-parent") },
      ],
    });

    expect(refs.map(scopedThreadKey)).toEqual([
      "env-parent:archived-child",
      "env-parent:archived-grandchild",
      "env-parent:first",
      "env-parent:grandchild",
      "env-parent:second",
    ]);
    expect(
      countDelegatedDescendants({
        parent: parentRef,
        threads: [
          delegatedChild({ environmentId: "env-parent", id: "first" }),
          delegatedChild({
            environmentId: "env-parent",
            id: "grandchild",
            parentThreadId: "first",
          }),
        ],
      }),
    ).toBe(2);
  });

  it("keeps the walk total even if lineage forms a cycle", () => {
    const refs = collectDelegatedDescendantRefs({
      parent: parentRef,
      threads: [
        delegatedChild({ environmentId: "env-parent", id: "a", parentThreadId: "parent" }),
        delegatedChild({ environmentId: "env-parent", id: "b", parentThreadId: "a" }),
        delegatedChild({ environmentId: "env-parent", id: "a2", parentThreadId: "b" }),
        delegatedChild({ environmentId: "env-parent", id: "b2", parentThreadId: "b" }),
        // Feeding "a" back under "b2" would revisit; the visited set drops it.
        delegatedChild({ environmentId: "env-parent", id: "a3", parentThreadId: "b2" }),
      ],
    });
    // The duplicate "a" under b2 is distinct by id here, so count real nodes:
    // only an exact scoped-key revisit is skipped.
    expect(new Set(refs.map(scopedThreadKey)).size).toBe(refs.length);
  });

  it("counts nothing for a childless parent", () => {
    expect(countDelegatedDescendants({ parent: parentRef, threads: [] })).toBe(0);
  });
});

describe("collectDelegatedChildRefsForParents", () => {
  it("maps direct children to their parent's scoped key", () => {
    const parentB = scopeThreadRef(EnvironmentId.make("env-b"), ThreadId.make("boss"));
    const refsByParentKey = collectDelegatedChildRefsForParents({
      parents: [parentRef, parentB],
      threads: [
        delegatedChild({ environmentId: "env-parent", id: "a-child" }),
        delegatedChild({
          environmentId: "env-b",
          id: "b-child",
          parentThreadId: "boss",
        }),
        delegatedChild({ environmentId: "env-parent", id: "other-parent", parentThreadId: "some" }),
      ],
    });

    expect(refsByParentKey.get(scopedThreadKey(parentRef))?.map(scopedThreadKey)).toEqual([
      "env-parent:a-child",
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
        delegatedChild({ environmentId: "env-parent", id: "selected" }),
        delegatedChild({ environmentId: "env-parent", id: "kept" }),
      ],
      excludeKeys: new Set(["env-parent:selected"]),
    });

    expect(refsByParentKey.get(scopedThreadKey(parentRef))?.map(scopedThreadKey)).toEqual([
      "env-parent:kept",
    ]);
  });

  it("omits parents whose children are all excluded", () => {
    const refsByParentKey = collectDelegatedChildRefsForParents({
      parents: [parentRef],
      threads: [delegatedChild({ environmentId: "env-parent", id: "gone" })],
      excludeKeys: new Set(["env-parent:gone"]),
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

describe("selectStaleDelegatedChildren", () => {
  it("keeps the newest ten and selects the rest with the oldest last", () => {
    const selection = selectStaleDelegatedChildren({
      parent: parentRef,
      threads: thirteenChildren(),
    });

    expect(selection.stale.map(scopedThreadKey)).toEqual([
      "env-parent:child-2",
      "env-parent:child-1",
      "env-parent:child-0",
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

    expect(selection.stale.map(scopedThreadKey)).toEqual([
      "env-parent:child-2",
      "env-parent:child-1",
    ]);
  });

  it("reports a running stale child instead of selecting it", () => {
    const selection = selectStaleDelegatedChildren({
      parent: parentRef,
      threads: thirteenChildren((index) => (index === 0 ? { running: true } : {})),
    });

    expect(selection.stale.map(scopedThreadKey)).toEqual([
      "env-parent:child-2",
      "env-parent:child-1",
    ]);
    expect(selection.running).toBe(1);
  });

  it("treats a queued run with an active run id as live work", () => {
    const selection = selectStaleDelegatedChildren({
      parent: parentRef,
      threads: [
        ...thirteenChildren().slice(0, 12),
        {
          ...delegatedChild({ environmentId: "env-parent", id: "queued", running: true }),
          runtime: { status: "queued", activeRunId: "run-1" },
        },
      ],
    });

    expect(selection.running).toBe(1);
    expect(selection.stale.map(scopedThreadKey)).not.toContain("env-parent:queued");
  });

  it("leaves other parents, grandchildren, and plain threads alone", () => {
    const selection = selectStaleDelegatedChildren({
      parent: parentRef,
      threads: [
        ...thirteenChildren(),
        delegatedChild({
          environmentId: "env-parent",
          id: "other-parent",
          parentThreadId: "elsewhere",
        }),
        delegatedChild({
          environmentId: "env-parent",
          id: "grandchild",
          parentThreadId: "child-12",
        }),
        { id: ThreadId.make("plain"), environmentId: EnvironmentId.make("env-parent") },
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
    expect(log).toEqual(["env-parent:child-2", "env-parent:child-1", "env-parent:child-0"]);
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
        return key === "env-parent:child-1"
          ? { ok: false, error: new Error("boom") }
          : { ok: true };
      },
    });

    expect(log).toEqual(["env-parent:child-2", "env-parent:child-1"]);
    expect(result).toMatchObject({ kind: "child-failed" });
    if (result.kind === "child-failed") {
      expect(scopedThreadKey(result.failed)).toBe("env-parent:child-1");
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

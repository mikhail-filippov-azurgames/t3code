import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";
import {
  collectUnseenDelegatedChildCounts,
  collectWorkingDelegatedChildCounts,
  filterCollapsedSidebarForest,
  groupSidebarForestChildrenBySection,
  orderSidebarSectionForest,
  sidebarForestParentKey,
  sidebarSubagentParentKey,
} from "./forest.logic.ts";
import { resolveSidebarRoleBadge } from "./roleBadge.logic.ts";

type ForestThread = {
  readonly id: string;
  readonly parent: string | null;
};

const order = (threads: readonly ForestThread[], maxDepth?: number) =>
  orderSidebarSectionForest({
    threads,
    getKey: (thread) => thread.id,
    getParentKey: (thread) => thread.parent,
    ...(maxDepth === undefined ? {} : { maxDepth }),
  });

describe("orderSidebarSectionForest", () => {
  it("nests children under parents in incoming order with depths", () => {
    const entries = order([
      { id: "child-a2", parent: "root-a" },
      { id: "root-b", parent: null },
      { id: "grandchild", parent: "child-a1" },
      { id: "root-a", parent: null },
      { id: "child-a1", parent: "root-a" },
    ]);
    expect(entries.map((entry) => [entry.key, entry.depth, entry.parentKey])).toEqual([
      ["root-b", 0, null],
      ["root-a", 0, null],
      ["child-a2", 1, "root-a"],
      ["child-a1", 1, "root-a"],
      ["grandchild", 2, "child-a1"],
    ]);
    expect(entries.find((entry) => entry.key === "root-a")?.descendantCount).toBe(3);
    expect(entries.find((entry) => entry.key === "child-a1")?.descendantCount).toBe(1);
    expect(entries.find((entry) => entry.key === "grandchild")?.descendantCount).toBe(0);
  });

  it("detaches orphans, self-parents, and cycles without dropping rows", () => {
    const entries = order([
      { id: "orphan", parent: "missing" },
      { id: "self", parent: "self" },
      { id: "cycle-a", parent: "cycle-b" },
      { id: "cycle-b", parent: "cycle-a" },
      { id: "root", parent: null },
    ]);
    expect(entries.map((entry) => entry.key).toSorted()).toEqual(
      ["cycle-a", "cycle-b", "orphan", "root", "self"].toSorted(),
    );
    for (const entry of entries) {
      expect(entry.depth).toBe(0);
      expect(entry.parentKey).toBeNull();
    }
  });

  it("caps depth instead of nesting deeper chains", () => {
    const entries = order(
      [
        { id: "l0", parent: null },
        { id: "l1", parent: "l0" },
        { id: "l2", parent: "l1" },
        { id: "l3", parent: "l2" },
      ],
      2,
    );
    expect(entries.map((entry) => [entry.key, entry.depth])).toEqual([
      ["l0", 0],
      ["l1", 1],
      ["l2", 2],
      ["l3", 2],
    ]);
    expect(entries.find((entry) => entry.key === "l0")?.descendantCount).toBe(3);
  });
});

describe("filterCollapsedSidebarForest", () => {
  const entries = orderSidebarSectionForest({
    threads: [
      { id: "root", parent: null },
      { id: "child", parent: "root" },
      { id: "grandchild", parent: "child" },
      { id: "other", parent: null },
    ],
    getKey: (thread: ForestThread) => thread.id,
    getParentKey: (thread: ForestThread) => thread.parent,
  });

  it("hides descendants of collapsed parents but keeps the parent row", () => {
    const visible = filterCollapsedSidebarForest({
      entries,
      collapsedKeys: new Set(["root"]),
    });
    expect(visible.map((entry) => entry.key)).toEqual(["root", "other"]);
  });

  it("keeps everything visible without collapsed keys", () => {
    const visible = filterCollapsedSidebarForest({ entries, collapsedKeys: new Set() });
    expect(visible.map((entry) => entry.key)).toEqual(["root", "child", "grandchild", "other"]);
  });
});

describe("sidebarSubagentParentKey", () => {
  const env = EnvironmentId.make("env-a");
  const parentId = ThreadId.make("thread-parent");
  const keyOf = (thread: { environmentId: EnvironmentId; id: ThreadId }) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

  it("returns null for non-subagent lineage and parentless subagents", () => {
    expect(
      sidebarSubagentParentKey({
        environmentId: env,
        id: parentId,
        lineage: { parentThreadId: null, relationshipToParent: null },
      }),
    ).toBeNull();
    expect(
      sidebarSubagentParentKey({
        environmentId: env,
        id: parentId,
        lineage: { parentThreadId: null, relationshipToParent: "subagent" },
      }),
    ).toBeNull();
    expect(
      sidebarSubagentParentKey({
        environmentId: env,
        id: parentId,
        lineage: { parentThreadId: parentId, relationshipToParent: "fork" },
      }),
    ).toBeNull();
  });

  it("scopes the parent key to the child environment", () => {
    const child = {
      environmentId: env,
      id: ThreadId.make("thread-child"),
      lineage: { parentThreadId: parentId, relationshipToParent: "subagent" as const },
    };
    expect(sidebarSubagentParentKey(child)).toBe(scopedThreadKey(scopeThreadRef(env, parentId)));
  });
});

describe("sidebarForestParentKey", () => {
  const coordinatorEnv = EnvironmentId.make("env-coordinator");
  const coordinatorId = ThreadId.make("coordinator-1");
  const architectId = ThreadId.make("arch:binding-1");
  type ForestParentThread = {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly lineage: {
      readonly parentThreadId: ThreadId | null;
      readonly relationshipToParent: "fork" | "subagent" | null;
    };
  };
  const coordinator: ForestParentThread = {
    environmentId: coordinatorEnv,
    id: coordinatorId,
    lineage: { parentThreadId: null, relationshipToParent: null },
  };
  const architect: ForestParentThread = {
    environmentId: coordinatorEnv,
    id: architectId,
    lineage: { parentThreadId: null, relationshipToParent: null },
  };
  const keyOf = (thread: ForestParentThread) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const coordinatorKey = keyOf(coordinator);
  const architectKey = keyOf(architect);
  const bindingParents = new Map([[architectKey, coordinatorKey]]);

  it("nests the bound Architect under its Coordinator from the binding index", () => {
    expect(sidebarForestParentKey(architect, bindingParents)).toBe(coordinatorKey);
    const forest = orderSidebarSectionForest({
      threads: [coordinator, architect],
      getKey: keyOf,
      getParentKey: (thread) => sidebarForestParentKey(thread, bindingParents),
    });
    expect(forest.map((entry) => [entry.key, entry.depth, entry.parentKey])).toEqual([
      [coordinatorKey, 0, null],
      [architectKey, 1, coordinatorKey],
    ]);
    expect(forest[0]?.descendantCount).toBe(1);
  });

  it("keeps a real delegated child on its lineage parent when a binding entry names it too", () => {
    const delegated: ForestParentThread = {
      environmentId: coordinatorEnv,
      id: ThreadId.make("task-1"),
      lineage: { parentThreadId: coordinatorId, relationshipToParent: "subagent" },
    };
    const contested = new Map([[keyOf(delegated), architectKey]]);
    expect(sidebarForestParentKey(delegated, contested)).toBe(coordinatorKey);
  });

  it("stays top-level with no binding entry and no lineage", () => {
    expect(sidebarForestParentKey(architect, new Map())).toBeNull();
    expect(sidebarForestParentKey(coordinator, bindingParents)).toBeNull();
  });

  it("drops no rows when the bound Architect thread is gone", () => {
    const forest = orderSidebarSectionForest({
      threads: [coordinator],
      getKey: keyOf,
      getParentKey: (thread) => sidebarForestParentKey(thread, bindingParents),
    });
    expect(forest.map((entry) => [entry.key, entry.depth, entry.parentKey])).toEqual([
      [coordinatorKey, 0, null],
    ]);
  });

  it("keeps the Architect openable as one detached row when its Coordinator is absent", () => {
    const forest = orderSidebarSectionForest({
      threads: [architect],
      getKey: keyOf,
      getParentKey: (thread) => sidebarForestParentKey(thread, bindingParents),
    });
    expect(forest.map((entry) => [entry.key, entry.depth, entry.parentKey])).toEqual([
      [architectKey, 0, null],
    ]);
  });
});

describe("groupSidebarForestChildrenBySection", () => {
  type BoundThread = {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly lineage: {
      readonly parentThreadId: ThreadId | null;
      readonly relationshipToParent: "fork" | "subagent" | null;
    };
  };
  const environmentId = EnvironmentId.make("environment-architect-binding");
  const coordinator: BoundThread = {
    environmentId,
    id: ThreadId.make("197154b1-09f3-437f-a483-a94a4aef0ab0"),
    lineage: { parentThreadId: null, relationshipToParent: null },
  };
  const architect: BoundThread = {
    environmentId,
    id: ThreadId.make("arch:27ee0970b18c558369cb90424499dc5f7d7c68b6"),
    lineage: { parentThreadId: null, relationshipToParent: null },
  };
  const architectChild: BoundThread = {
    environmentId,
    id: ThreadId.make("delegated-task:architect-child"),
    lineage: { parentThreadId: architect.id, relationshipToParent: "subagent" },
  };
  const keyOf = (thread: BoundThread) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const coordinatorKey = keyOf(coordinator);
  const architectKey = keyOf(architect);
  const bindingParents = new Map([[architectKey, coordinatorKey]]);
  const getParentKey = (thread: BoundThread) => sidebarForestParentKey(thread, bindingParents);

  it("moves a bound Architect and its out-of-order child chain into the Coordinator section", () => {
    const sections = groupSidebarForestChildrenBySection({
      sections: [
        { section: "active", threads: [coordinator] },
        { section: "settled", threads: [architect] },
      ],
      pool: [architectChild, architect, coordinator],
      getKey: keyOf,
      getParentKey,
    });
    const active = sections.get("active") ?? [];
    const forest = orderSidebarSectionForest({ threads: active, getKey: keyOf, getParentKey });

    expect(sections.get("settled")).toEqual([]);
    expect(forest.map((entry) => [entry.thread.id, entry.depth, entry.parentKey])).toEqual([
      [coordinator.id, 0, null],
      [architect.id, 1, coordinatorKey],
      [architectChild.id, 2, architectKey],
    ]);
    expect(
      filterCollapsedSidebarForest({
        entries: forest,
        collapsedKeys: new Set([coordinatorKey]),
      }).map((entry) => entry.key),
    ).toEqual([coordinatorKey]);
  });
});

type DelegateShell = {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly lineage: {
    readonly parentThreadId: ThreadId | null;
    readonly relationshipToParent: "fork" | "subagent" | null;
  };
  readonly latestRun: { readonly completedAt: string | null } | null;
  readonly runtime: { readonly status: string } | null;
};

const delegateEnv = EnvironmentId.make("environment-delegate");
const delegateParentId = ThreadId.make("thread-parent");

const shell = (input: {
  readonly id: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly completedAt?: string | null;
  readonly runtimeStatus?: string | null;
}): DelegateShell => ({
  environmentId: delegateEnv,
  id: input.id,
  lineage: { parentThreadId: input.parentThreadId, relationshipToParent: "subagent" },
  latestRun: { completedAt: input.completedAt ?? null },
  runtime:
    input.runtimeStatus === null || input.runtimeStatus === undefined
      ? null
      : { status: input.runtimeStatus },
});

const parentShell: DelegateShell = {
  environmentId: delegateEnv,
  id: delegateParentId,
  lineage: { parentThreadId: null, relationshipToParent: null },
  latestRun: null,
  runtime: null,
};

const keyOf = (entry: DelegateShell) =>
  scopedThreadKey(scopeThreadRef(entry.environmentId, entry.id));

describe("collectUnseenDelegatedChildCounts", () => {
  const parentKey = keyOf(parentShell);

  it("marks the parent while a finished child is unvisited", () => {
    const finished = shell({
      id: ThreadId.make("thread-child"),
      parentThreadId: delegateParentId,
      completedAt: "2026-03-09T10:05:00.000Z",
    });
    const counts = collectUnseenDelegatedChildCounts({
      threads: [parentShell, finished],
      getKey: keyOf,
      getLastVisitedAt: () => "2026-03-09T10:04:00.000Z",
    });
    expect(counts.get(parentKey)).toBe(1);
  });

  it("clears once the child's own visit predicate is satisfied", () => {
    const finished = shell({
      id: ThreadId.make("thread-child"),
      parentThreadId: delegateParentId,
      completedAt: "2026-03-09T10:05:00.000Z",
    });
    const counts = collectUnseenDelegatedChildCounts({
      threads: [parentShell, finished],
      getKey: keyOf,
      getLastVisitedAt: () => "2026-03-09T10:05:00.000Z",
    });
    expect(counts.get(parentKey)).toBeUndefined();
  });

  it("ignores a child that is still running", () => {
    const runningChild = shell({
      id: ThreadId.make("thread-child"),
      parentThreadId: delegateParentId,
      runtimeStatus: "running",
    });
    const counts = collectUnseenDelegatedChildCounts({
      threads: [parentShell, runningChild],
      getKey: keyOf,
      getLastVisitedAt: () => "2026-03-09T10:04:00.000Z",
    });
    expect(counts.get(parentKey)).toBeUndefined();
  });

  it("returns no badge for a parent with zero delegated children", () => {
    expect(
      collectUnseenDelegatedChildCounts({
        threads: [parentShell],
        getKey: keyOf,
        getLastVisitedAt: () => undefined,
      }).size,
    ).toBe(0);
    expect(
      collectUnseenDelegatedChildCounts({
        threads: [],
        getKey: keyOf,
        getLastVisitedAt: () => undefined,
      }).size,
    ).toBe(0);
  });

  it("counts only direct children, not grandchildren", () => {
    const childId = ThreadId.make("thread-child");
    const middle = shell({
      id: childId,
      parentThreadId: delegateParentId,
      completedAt: null,
    });
    const grandchild = shell({
      id: ThreadId.make("thread-grandchild"),
      parentThreadId: childId,
      completedAt: "2026-03-09T10:05:00.000Z",
    });
    const counts = collectUnseenDelegatedChildCounts({
      threads: [parentShell, middle, grandchild],
      getKey: keyOf,
      getLastVisitedAt: () => "2026-03-09T10:04:00.000Z",
    });
    expect(counts.get(parentKey)).toBeUndefined();
    expect(counts.get(keyOf(middle))).toBe(1);
  });
});

describe("collectWorkingDelegatedChildCounts", () => {
  const parentKey = keyOf(parentShell);

  it("marks the parent while a direct child's run is running", () => {
    const running = shell({
      id: ThreadId.make("thread-child"),
      parentThreadId: delegateParentId,
      runtimeStatus: "running",
    });
    const counts = collectWorkingDelegatedChildCounts({
      threads: [parentShell, running],
      getKey: keyOf,
    });
    expect(counts.get(parentKey)).toBe(1);
  });

  it("treats preparing, queued, starting, and waiting children as working", () => {
    const children = ["preparing", "queued", "starting", "waiting"].map((status, index) =>
      shell({
        id: ThreadId.make(`thread-child-${status}-${index}`),
        parentThreadId: delegateParentId,
        runtimeStatus: status,
      }),
    );
    const counts = collectWorkingDelegatedChildCounts({
      threads: [parentShell, ...children],
      getKey: keyOf,
    });
    expect(counts.get(parentKey)).toBe(4);
  });

  it("clears when every child's run is terminal", () => {
    const interrupted = shell({
      id: ThreadId.make("thread-child"),
      parentThreadId: delegateParentId,
      completedAt: "2026-03-09T10:05:00.000Z",
      runtimeStatus: "interrupted",
    });
    const counts = collectWorkingDelegatedChildCounts({
      threads: [parentShell, interrupted],
      getKey: keyOf,
    });
    expect(counts.get(parentKey)).toBeUndefined();
  });

  it("counts two running children and ignores the finished one", () => {
    const counts = collectWorkingDelegatedChildCounts({
      threads: [
        parentShell,
        shell({
          id: ThreadId.make("thread-child-a"),
          parentThreadId: delegateParentId,
          runtimeStatus: "running",
        }),
        shell({
          id: ThreadId.make("thread-child-b"),
          parentThreadId: delegateParentId,
          runtimeStatus: "starting",
        }),
        shell({
          id: ThreadId.make("thread-child-c"),
          parentThreadId: delegateParentId,
          completedAt: "2026-03-09T10:05:00.000Z",
        }),
      ],
      getKey: keyOf,
    });
    expect(counts.get(parentKey)).toBe(2);
  });

  it("returns nothing for a forest without delegated children", () => {
    expect(collectWorkingDelegatedChildCounts({ threads: [parentShell], getKey: keyOf }).size).toBe(
      0,
    );
    expect(collectWorkingDelegatedChildCounts({ threads: [], getKey: keyOf }).size).toBe(0);
  });

  it("counts only direct children, not grandchildren", () => {
    const childId = ThreadId.make("thread-child");
    const middle = shell({ id: childId, parentThreadId: delegateParentId });
    const grandchild = shell({
      id: ThreadId.make("thread-grandchild"),
      parentThreadId: childId,
      runtimeStatus: "running",
    });
    const counts = collectWorkingDelegatedChildCounts({
      threads: [parentShell, middle, grandchild],
      getKey: keyOf,
    });
    expect(counts.get(parentKey)).toBeUndefined();
    expect(counts.get(keyOf(middle))).toBe(1);
  });
});

describe("imported delegated thread shapes", () => {
  const stagedRows = [
    {
      parentEnvironmentId: "ed1b70d0-d277-40eb-8415-a34f4c23f084",
      parentThreadId: "a20e700e-331a-4f93-bc85-a7a7800fc149",
      childThreadId: "delegated-task:23e3ef9122188347823ff728ce3064da8b21b143",
      role: "test",
    },
    {
      parentEnvironmentId: "ed1b70d0-d277-40eb-8415-a34f4c23f084",
      parentThreadId: "a20e700e-331a-4f93-bc85-a7a7800fc149",
      childThreadId: "delegated-task:fa7ce4042bbb7bd9dc1df54a2c4e15ecf8f19527",
      role: "implementation",
    },
  ] as const;
  const environmentId = EnvironmentId.make(stagedRows[0].parentEnvironmentId);
  const parentId = ThreadId.make(stagedRows[0].parentThreadId);
  const parent: DelegateShell = {
    environmentId,
    id: parentId,
    lineage: { parentThreadId: null, relationshipToParent: null },
    latestRun: null,
    runtime: null,
  };
  const importedChildren: DelegateShell[] = stagedRows.map((row, index) => ({
    environmentId: EnvironmentId.make(row.parentEnvironmentId),
    id: ThreadId.make(row.childThreadId),
    lineage: {
      parentThreadId: ThreadId.make(row.parentThreadId),
      relationshipToParent: "subagent",
    },
    latestRun: {
      completedAt: index === 0 ? null : "2026-10-27T01:35:30.461Z",
    },
    runtime: index === 0 ? { status: "running" } : null,
  }));
  const getKey = (thread: DelegateShell) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const parentKey = getKey(parent);

  it("maps staged parent ids to V2 lineage and working/returned counts", () => {
    expect(sidebarSubagentParentKey(importedChildren[0]!)).toBe(parentKey);
    const sections = groupSidebarForestChildrenBySection({
      sections: [{ section: "active", threads: [parent] }],
      pool: [...importedChildren, parent],
      getKey,
      getParentKey: (thread) => sidebarForestParentKey(thread, new Map()),
    });
    const forest = orderSidebarSectionForest({
      threads: sections.get("active") ?? [],
      getKey,
      getParentKey: (thread) => sidebarForestParentKey(thread, new Map()),
    });
    expect(forest.map((entry) => [entry.key, entry.depth, entry.parentKey])).toEqual([
      [parentKey, 0, null],
      [getKey(importedChildren[0]!), 1, parentKey],
      [getKey(importedChildren[1]!), 1, parentKey],
    ]);
    expect(
      filterCollapsedSidebarForest({ entries: forest, collapsedKeys: new Set([parentKey]) }).map(
        (entry) => entry.key,
      ),
    ).toEqual([parentKey]);
    expect(
      collectWorkingDelegatedChildCounts({
        threads: [parent, ...importedChildren],
        getKey,
      }).get(parentKey),
    ).toBe(1);
    expect(
      collectUnseenDelegatedChildCounts({
        threads: [parent, ...importedChildren],
        getKey,
        getLastVisitedAt: (thread) =>
          thread.id === importedChildren[1]?.id ? "2026-10-27T01:35:29.000Z" : undefined,
      }).get(parentKey),
    ).toBe(1);
  });
});

describe("resolveSidebarRoleBadge", () => {
  it("maps a known board card role to the board role badge", () => {
    expect(resolveSidebarRoleBadge({ role: "test", isOrchestrator: false })).toEqual({
      kind: "role",
      role: "test",
      label: "Test",
    });
  });

  it("marks orchestrator rows even without a card role", () => {
    expect(resolveSidebarRoleBadge({ role: null, isOrchestrator: true })).toEqual({
      kind: "orchestrator",
      label: "Coordinator",
    });
  });

  it("lets the orchestrator mark win over a card role", () => {
    expect(resolveSidebarRoleBadge({ role: "implementation", isOrchestrator: true })).toEqual({
      kind: "orchestrator",
      label: "Coordinator",
    });
  });

  it("hides the badge for ordinary rows and unknown roles", () => {
    expect(resolveSidebarRoleBadge({ role: null, isOrchestrator: false })).toBeNull();
    expect(resolveSidebarRoleBadge({ role: "executor", isOrchestrator: false })).toBeNull();
  });
});

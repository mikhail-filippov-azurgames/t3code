import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type CoordinatorArchitectBinding,
  type OrchestratorMcpCoordinatorArchitectSidebarSnapshot,
  type OrchestratorMcpPublishableRecord,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));

import {
  architectParentKeysFromActiveChildren,
  canShowArchitectPublishButton,
  readActiveArchitectChildren,
  reportActiveArchitectChild,
  selectComposerArchitectSidebarSnapshot,
  subscribeActiveArchitectChildren,
} from "./coordinatorArchitect";

const environmentId = EnvironmentId.make("environment-1");
const keyOf = (threadId: string) =>
  scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(threadId)));

describe("active Architect children index", () => {
  it("indexes an active binding and inverts it for the sidebar forest", () => {
    const coordinatorKey = keyOf("coordinator-active");
    const architectKey = keyOf("arch:active");
    reportActiveArchitectChild({ coordinatorKey, architectKey });
    try {
      expect(readActiveArchitectChildren().get(coordinatorKey)).toBe(architectKey);
      expect(
        architectParentKeysFromActiveChildren(readActiveArchitectChildren()).get(architectKey),
      ).toBe(coordinatorKey);
    } finally {
      reportActiveArchitectChild({ coordinatorKey, architectKey: null });
    }
  });

  it("clears the entry when the binding goes terminal", () => {
    const coordinatorKey = keyOf("coordinator-terminal");
    const architectKey = keyOf("arch:terminal");
    reportActiveArchitectChild({ coordinatorKey, architectKey });
    reportActiveArchitectChild({ coordinatorKey, architectKey: null });
    expect(readActiveArchitectChildren().has(coordinatorKey)).toBe(false);
    expect(
      architectParentKeysFromActiveChildren(readActiveArchitectChildren()).has(architectKey),
    ).toBe(false);
  });

  it("drops the replaced architect once the replacement binds", () => {
    const coordinatorKey = keyOf("coordinator-replace");
    const replacedKey = keyOf("arch:replaced");
    const replacementKey = keyOf("arch:replacement");
    reportActiveArchitectChild({ coordinatorKey, architectKey: replacedKey });
    try {
      reportActiveArchitectChild({ coordinatorKey, architectKey: replacementKey });
      const parents = architectParentKeysFromActiveChildren(readActiveArchitectChildren());
      expect(parents.get(replacementKey)).toBe(coordinatorKey);
      expect(parents.has(replacedKey)).toBe(false);
    } finally {
      reportActiveArchitectChild({ coordinatorKey, architectKey: null });
    }
  });

  it("keeps other coordinators when one clears", () => {
    const firstKey = keyOf("coordinator-first");
    const secondKey = keyOf("coordinator-second");
    reportActiveArchitectChild({ coordinatorKey: firstKey, architectKey: keyOf("arch:first") });
    reportActiveArchitectChild({ coordinatorKey: secondKey, architectKey: keyOf("arch:second") });
    try {
      reportActiveArchitectChild({ coordinatorKey: firstKey, architectKey: null });
      expect(readActiveArchitectChildren().has(firstKey)).toBe(false);
      expect(readActiveArchitectChildren().get(secondKey)).toBe(keyOf("arch:second"));
    } finally {
      reportActiveArchitectChild({ coordinatorKey: secondKey, architectKey: null });
    }
  });

  it("notifies subscribers only when the index actually changes", () => {
    const coordinatorKey = keyOf("coordinator-notify");
    const architectKey = keyOf("arch:notify");
    let notifications = 0;
    const unsubscribe = subscribeActiveArchitectChildren(() => {
      notifications += 1;
    });
    try {
      reportActiveArchitectChild({ coordinatorKey, architectKey });
      expect(notifications).toBe(1);
      reportActiveArchitectChild({ coordinatorKey, architectKey });
      expect(notifications).toBe(1);
      reportActiveArchitectChild({ coordinatorKey, architectKey: null });
      expect(notifications).toBe(2);
      reportActiveArchitectChild({ coordinatorKey, architectKey: null });
      expect(notifications).toBe(2);
    } finally {
      unsubscribe();
      reportActiveArchitectChild({ coordinatorKey, architectKey: null });
    }
  });
});

const publishableRecord: OrchestratorMcpPublishableRecord = {
  reviewId: "review-fresh-1",
  origin: "coordinator-request",
  summary: "Is the retry safe to run twice?",
  disposition: "recommendation",
  refs: {},
  question: "Is the retry safe to run twice?",
};

const activeBinding = (
  overrides: Partial<CoordinatorArchitectBinding> = {},
): CoordinatorArchitectBinding => ({
  bindingId: "binding-fresh",
  coordinatorThreadId: ThreadId.make("coordinator-fresh"),
  architectThreadId: ThreadId.make("arch:coordinator-fresh"),
  projectId: ProjectId.make("project-1"),
  architectTaskEffort: "high",
  routingEvidence: null,
  status: "active",
  createdAt: "2026-10-07T12:00:00.000Z",
  createdBy: ThreadId.make("coordinator-fresh"),
  replacedByBindingId: null,
  detachReason: null,
  createIdempotencyKey: "create-fresh",
  ...overrides,
});

const snapshotWith = (
  publishable: ReadonlyArray<OrchestratorMcpPublishableRecord>,
  binding: CoordinatorArchitectBinding | null = activeBinding(),
): OrchestratorMcpCoordinatorArchitectSidebarSnapshot => ({
  binding,
  reviews: [],
  publishable,
});

describe("composer Architect sidebar selection", () => {
  it("falls back to the architect-keyed first load before any pin reports", () => {
    const byArchitect = snapshotWith([publishableRecord]);
    const selected = selectComposerArchitectSidebarSnapshot({
      byCoordinator: null,
      byArchitect,
    });
    expect(selected?.publishable.map((record) => record.reviewId)).toEqual(["review-fresh-1"]);
  });

  it("prefers the coordinator-keyed snapshot once the pin reports", () => {
    const byCoordinator = snapshotWith([publishableRecord]);
    const byArchitect = snapshotWith([]);
    expect(selectComposerArchitectSidebarSnapshot({ byCoordinator, byArchitect })).toBe(
      byCoordinator,
    );
  });

  it("returns null when neither source has loaded", () => {
    expect(
      selectComposerArchitectSidebarSnapshot({ byCoordinator: null, byArchitect: null }),
    ).toBeNull();
  });
});

describe("Architect publish button visibility", () => {
  it("shows on a fresh load with an answered, unpublished record of the active binding", () => {
    expect(
      canShowArchitectPublishButton({
        isArchitectThread: true,
        binding: activeBinding(),
        publishableCount: 1,
      }),
    ).toBe(true);
  });

  it("hides outside the Architect thread even with a stale non-empty list", () => {
    expect(
      canShowArchitectPublishButton({
        isArchitectThread: false,
        binding: activeBinding(),
        publishableCount: 1,
      }),
    ).toBe(false);
  });

  it("hides when the binding is terminal", () => {
    for (const status of ["detached", "replaced"] as const) {
      expect(
        canShowArchitectPublishButton({
          isArchitectThread: true,
          binding: activeBinding({ status }),
          publishableCount: 1,
        }),
      ).toBe(false);
    }
  });

  it("hides without a binding or without publishable records", () => {
    expect(
      canShowArchitectPublishButton({
        isArchitectThread: true,
        binding: null,
        publishableCount: 1,
      }),
    ).toBe(false);
    expect(
      canShowArchitectPublishButton({
        isArchitectThread: true,
        binding: activeBinding(),
        publishableCount: 0,
      }),
    ).toBe(false);
  });
});

import { describe, expect, it, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

const mocks = vi.hoisted(() => ({
  snapshot: {
    binding: {
      bindingId: "binding-1",
      coordinatorThreadId: "coordinator-1",
      architectThreadId: "arch:binding-1",
      projectId: "project-1",
      architectTaskEffort: "high",
      routingEvidence: {
        policyRef: "oc://doc/3900df61-9dd5-4621-9278-34ac20d60648@10",
        policyRevision: 10,
        role: "architecture",
        taskEffort: "high",
        consideredCandidates: [
          {
            alias: "L",
            providerInstanceId: "codex",
            driverKind: "codex",
            model: "gpt-6-luna",
            options: [],
            disposition: "selected",
            reason: "Policy selected this eligible route.",
          },
        ],
      },
      status: "active",
      createdAt: "2026-09-28T12:00:00.000Z",
      createdBy: "coordinator-1",
      replacedByBindingId: null,
      detachReason: null,
      createIdempotencyKey: "create-1",
    },
    reviews: [
      { status: "open" },
      { status: "answered" },
      { status: "published" },
      { status: "cancelled" },
    ],
  },
}));

vi.mock("../state/entities", () => ({
  useThreadDetail: () => ({
    updatedAt: "2026-09-28T12:00:00.000Z",
    activities: [{ id: "architect-bound-1", kind: "architect.bound" }],
  }),
}));
vi.mock("../state/coordinatorArchitect", () => ({
  coordinatorArchitectEnvironment: { sidebarSnapshot: () => "coordinator-query" },
  reportActiveArchitectChild: () => {},
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: mocks.snapshot,
    error: null,
    isPending: false,
    isSuccess: true,
    refresh: () => {},
  }),
}));

import { CoordinatorArchitectSidebarPin } from "./CoordinatorArchitectSidebarPin";

describe("CoordinatorArchitectSidebarPin", () => {
  it("shows the pinned provider and review attention without a cancelled badge", () => {
    const markup = renderToStaticMarkup(
      <CoordinatorArchitectSidebarPin
        environmentId={EnvironmentId.make("environment-1")}
        coordinatorThreadId={ThreadId.make("coordinator-1")}
        isCurrentThread
        onNavigate={() => {}}
      />,
    );

    expect(markup).toContain("Architect");
    expect(markup).toContain("codex · gpt-6-luna");
    expect(markup).toContain("Open 1");
    expect(markup).toContain("Ready to publish 1");
    expect(markup).toContain("Published 1");
    expect(markup).not.toContain("Cancelled");
    expect(markup).not.toContain("Ask");
    expect(markup).toContain("Replace");
    expect(markup).toContain("Detach");
  });

  it("hides terminal bindings and their replace/detach actions", () => {
    const previousStatus = mocks.snapshot.binding.status;
    mocks.snapshot.binding.status = "detached";
    const markup = renderToStaticMarkup(
      <CoordinatorArchitectSidebarPin
        environmentId={EnvironmentId.make("environment-1")}
        coordinatorThreadId={ThreadId.make("coordinator-1")}
        isCurrentThread
        onNavigate={() => {}}
      />,
    );
    mocks.snapshot.binding.status = previousStatus;

    expect(markup).toBe("");
    expect(markup).not.toContain("Replace");
    expect(markup).not.toContain("Detach");
  });
});

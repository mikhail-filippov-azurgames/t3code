import { act, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  snapshot: {
    binding: {
      bindingId: "binding-1",
      coordinatorThreadId: "coordinator-1",
      architectThreadId: "arch:binding-1",
      projectId: "project-1",
      architectTaskEffort: "high",
      routingEvidence: {
        policyRef: "oc://doc/fe000000-0000-4000-8000-000000000001@10",
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
      { status: "open" },
      { status: "answered" },
      { status: "answered" },
      { status: "answered" },
      { status: "published" },
      { status: "cancelled" },
    ],
  },
  architectSession: null as { status: "ready" | "running" | "starting" } | null,
  threadShellCalls: [] as unknown[],
  threadDetail: {
    updatedAt: "2026-09-28T12:00:00.000Z",
    activities: [{ id: "architect-bound-1", kind: "architect.bound" }],
  } as { updatedAt: string; activities: Array<{ id: string; kind: string }> } | null,
  reportedChildren: [] as Array<{
    coordinatorKey: string;
    architectKey: string | null;
  }>,
}));

vi.mock("../state/entities", () => ({
  useThreadShell: (ref: { threadId: string } | null) => {
    mocks.threadShellCalls.push(ref);
    return ref?.threadId === "arch:binding-1" && mocks.architectSession !== null
      ? { session: mocks.architectSession }
      : null;
  },
  useThreadDetail: () => mocks.threadDetail,
}));
vi.mock("../state/coordinatorArchitect", () => ({
  coordinatorArchitectEnvironment: { sidebarSnapshot: () => "coordinator-query" },
  reportActiveArchitectChild: (input: { coordinatorKey: string; architectKey: string | null }) => {
    mocks.reportedChildren.push(input);
  },
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: (query: unknown) => ({
    data: query === null ? null : mocks.snapshot,
    error: null,
    isPending: false,
    isSuccess: true,
    refresh: () => {},
  }),
}));
vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) => {
    const props = render.props as Record<string, unknown>;
    return <span {...props}>{children}</span>;
  },
  TooltipPopup: ({ children }: { children: ReactNode }) => (
    <span data-testid="coordinator-architect-tooltip">{children}</span>
  ),
}));

import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { CoordinatorArchitectSidebarPin } from "./CoordinatorArchitectSidebarPin";

const component = () => (
  <CoordinatorArchitectSidebarPin
    environmentId={EnvironmentId.make("environment-1")}
    coordinatorThreadId={ThreadId.make("coordinator-1")}
    onNavigate={() => {}}
  />
);

let renderer: ReactTestRenderer | undefined;

async function render() {
  await act(async () => {
    if (renderer) renderer.update(component());
    else renderer = create(component());
  });
  return renderer!;
}

function visibleText(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(visibleText).join("");
}

beforeEach(() => {
  mocks.snapshot.binding.status = "active";
  mocks.architectSession = null;
  mocks.threadShellCalls = [];
  mocks.threadDetail = {
    updatedAt: "2026-09-28T12:00:00.000Z",
    activities: [{ id: "architect-bound-1", kind: "architect.bound" }],
  };
  mocks.reportedChildren = [];
});

afterEach(async () => {
  if (renderer) {
    await act(async () => renderer?.unmount());
    renderer = undefined;
  }
});

describe("CoordinatorArchitectSidebarPin", () => {
  it("shows compact review icons with counts and accessible labels", async () => {
    const view = await render();
    const row = view.root.findByProps({ "data-testid": "coordinator-architect-pin-coordinator-1" });
    const text = visibleText(row);

    expect(text).toContain("Architect");
    expect(text).toContain("codex · gpt-6-luna");
    expect(text).not.toContain("Cancelled");
    expect(text).not.toContain("Ask");
    const actionButtonLabels = row.findAllByType("button").map(visibleText).slice(-2);
    expect(actionButtonLabels).toEqual(["Open", "Replace"]);

    for (const [label, count] of [
      ["Open 2", "2"],
      ["Ready to publish 3", "3"],
      ["Published 1", "1"],
    ]) {
      const badge = view.root.findByProps({ "aria-label": label });
      expect(badge.props.role).toBe("img");
      expect(visibleText(badge)).toBe(count);
      expect(badge.findByType("svg")).toBeDefined();
    }

    const tooltipLabels = view.root
      .findAllByProps({ "data-testid": "coordinator-architect-tooltip" })
      .map(visibleText);
    expect(tooltipLabels).toContain("Open 2");
    expect(tooltipLabels).toContain("Ready to publish 3");
    expect(tooltipLabels).toContain("Published 1");
  });

  it("shows the Architect work indicator while its own thread is running and clears it when ready", async () => {
    mocks.architectSession = { status: "running" };
    const view = await render();
    const workingTestId = "coordinator-architect-working-coordinator-1";
    const working = view.root.findByProps({ "data-testid": workingTestId });

    expect(working.props.role).toBe("status");
    expect(visibleText(working.findByProps({ className: "sr-only" }))).toBe("Architect is working");
    expect(working.findByType("svg")).toBeDefined();
    expect(working.props.className).toContain("text-sky-600");
    expect(working.findAllByProps({ className: "inline-flex animate-status-pulse" })).toHaveLength(
      1,
    );

    mocks.architectSession = { status: "ready" };
    await render();

    const calm = view.root.findByProps({ "data-testid": workingTestId });
    expect(visibleText(calm.findByProps({ className: "sr-only" }))).toBe("");
    expect(calm.findAllByType("svg")).toHaveLength(0);
  });

  it("shows the work indicator while the Architect thread is starting", async () => {
    mocks.architectSession = { status: "starting" };
    const view = await render();

    const working = view.root.findByProps({
      "data-testid": "coordinator-architect-working-coordinator-1",
    });
    expect(working.findByType("svg")).toBeDefined();
  });

  it("hides terminal bindings and their actions", async () => {
    mocks.snapshot.binding.status = "detached";
    const view = await render();

    expect(view.toJSON()).toBeNull();
    expect(mocks.threadShellCalls).toEqual([null]);
  });

  it("stays pinned and renders the bar from an active binding when the coordinator is not selected", async () => {
    // A non-coordinator thread is selected, so the coordinator detail carries
    // no binding history and selection cannot enable the query: rendering must
    // come from the binding alone.
    mocks.threadDetail = {
      updatedAt: "2026-09-28T12:00:00.000Z",
      activities: [],
    };
    const view = await render();
    const row = view.root.findByProps({ "data-testid": "coordinator-architect-pin-coordinator-1" });
    const text = visibleText(row);

    expect(text).toContain("Architect");
    expect(text).toContain("codex · gpt-6-luna");

    const environmentId = EnvironmentId.make("environment-1");
    const coordinatorKey = scopedThreadKey(
      scopeThreadRef(environmentId, ThreadId.make("coordinator-1")),
    );
    const architectKey = scopedThreadKey(
      scopeThreadRef(environmentId, ThreadId.make("arch:binding-1")),
    );
    expect(mocks.reportedChildren).toContainEqual({ coordinatorKey, architectKey });
  });

  it("renders nothing and clears the pin without an active binding when not selected", async () => {
    mocks.snapshot.binding.status = "detached";
    mocks.threadDetail = {
      updatedAt: "2026-09-28T12:00:00.000Z",
      activities: [],
    };
    const view = await render();

    expect(view.toJSON()).toBeNull();
    expect(mocks.reportedChildren.at(-1)?.architectKey).toBeNull();
  });
});

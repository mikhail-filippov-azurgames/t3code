import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { MailTask, MailTimelineEntry } from "@t3tools/ft3-mail/contracts";
import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../../apps/web/test/render";
import { BoardMailTab } from "./MailTabContent.tsx";

const mocks = vi.hoisted(() => ({
  tasks: vi.fn(),
  timeline: vi.fn(),
  snapshot: vi.fn(),
}));

vi.mock("./state.ts", () => ({
  mailEnvironment: {
    tasks: (target: unknown) => mocks.tasks(target),
    timeline: (target: unknown) => mocks.timeline(target),
  },
}));

vi.mock("../policies/state.ts", () => ({
  policiesEnvironment: {
    snapshot: (target: unknown) => mocks.snapshot(target),
  },
}));

vi.mock("../chat/openContextState.ts", () => ({
  useOpenContextDocsEnabled: () => false,
  docsEnvironment: { resolveDoc: vi.fn() },
  toOpenContextDocResolveResult: vi.fn(),
}));

const threadRef = {
  environmentId: EnvironmentId.make("browser-env"),
  threadId: ThreadId.make("browser-coordinator"),
};

const task: MailTask = {
  taskId: "task:one",
  title: "Refactor",
  brief: "Split the module.",
  level: "medium",
  cardId: "11111111-1111-4111-8111-111111111111",
  isolation: null,
  runtimeMode: null,
  interactionMode: null,
  responseBudgetSeconds: 1800,
  status: "open",
  outcome: null,
  summary: null,
  createdByThreadId: "thread:lead",
  clientRequestId: "request:task",
  requestFingerprint: "fingerprint:task",
  createdAt: "2026-11-04T00:00:00.000Z",
  updatedAt: "2026-11-04T00:00:00.000Z",
  closedAt: null,
};

const letter = (overrides: Record<string, unknown> = {}) => ({
  letterId: "letter:one",
  taskId: "task:one",
  sequence: 1,
  senderThreadId: "thread:lead",
  recipient: "role:implementation",
  kind: "request",
  body: "Start.",
  replyToLetterId: null,
  sourceLetterId: null,
  planPhase: null,
  planStep: null,
  planSha256: null,
  planDocId: null,
  classifierKind: null,
  classifierConfidence: null,
  kindDisputed: false,
  leadKind: null,
  clientRequestId: "request:letter",
  requestFingerprint: "fingerprint:letter",
  createdAt: "2026-11-04T00:01:00.000Z",
  ...overrides,
});

const entry = (overrides: Record<string, unknown> = {}): MailTimelineEntry => ({
  letter: letter() as MailTimelineEntry["letter"],
  deliveries: [],
  ...overrides,
});

const mailEnabledSnapshot = {
  features: {
    mail: { id: "mail", requestedEnabled: true, effectiveEnabled: true, offReason: null },
  },
};

const mailDisabledSnapshot = {
  features: {
    mail: { id: "mail", requestedEnabled: false, effectiveEnabled: false, offReason: null },
  },
};

function setup(options: {
  readonly tasks?: MailTask[];
  readonly tasksFailure?: boolean;
  readonly snapshot?: unknown;
  readonly entries?: MailTimelineEntry[];
}) {
  vi.clearAllMocks();
  mocks.tasks.mockReturnValue(
    options.tasksFailure === true
      ? Atom.make(AsyncResult.failure(Cause.fail(new Error("offline"))))
      : Atom.make(AsyncResult.success({ tasks: options.tasks ?? [] })),
  );
  mocks.timeline.mockReturnValue(
    Atom.make(AsyncResult.success({ task, entries: options.entries ?? [] })),
  );
  mocks.snapshot.mockReturnValue(
    Atom.make(AsyncResult.success(options.snapshot ?? mailEnabledSnapshot)),
  );
  const registry = AtomRegistry.make();
  return { registry, [Symbol.dispose]: () => registry.dispose() };
}

describe("BoardMailTab", () => {
  it("shows one group per task with letters oldest first and delivery badges", async () => {
    using state = setup({
      tasks: [task],
      entries: [
        entry({
          letter: letter({ letterId: "letter:2", sequence: 2, kind: "answer", body: "Done." }),
          deliveries: [
            {
              deliveryId: "delivery:1",
              taskId: "task:one",
              letterId: "letter:2",
              memberId: null,
              recipient: "lead",
              participantThreadId: "thread:lead",
              state: "answered",
              deliveredAt: null,
              readAt: null,
              answeredAt: "2026-11-04T00:02:00.000Z",
              failureReason: null,
              createdAt: "2026-11-04T00:02:00.000Z",
              updatedAt: "2026-11-04T00:02:00.000Z",
            },
          ],
        }),
        entry({ letter: letter({ letterId: "letter:1", sequence: 1 }) }),
      ],
    });
    await using screen = await render(
      <RegistryContext.Provider value={state.registry}>
        <BoardMailTab
          threadRef={threadRef}
          cardIds={["11111111-1111-4111-8111-111111111111"]}
          refreshSeq={0}
        />
      </RegistryContext.Provider>,
    );

    await expect.element(screen.getByRole("heading", { name: "Refactor" })).toBeVisible();
    const group = screen.container.querySelector('[data-mail-task-id="task:one"]')!;
    // The timeline arrives newest-first; the tab reads oldest first.
    const bodies = [...group.querySelectorAll("[data-mail-letter-id]")].map(
      (node) => node.textContent,
    );
    expect(bodies[0]).toContain("Start.");
    expect(bodies[1]).toContain("Done.");
    expect(bodies[0]).toContain("lead");
    expect(bodies[0]).toContain("→ implementation");
    expect(bodies[0]).toContain("request");
    expect(bodies[1]).toContain("answered");
  });

  it("shows a read-only note with a Policies link when mail is off", async () => {
    using state = setup({ tasks: [task], snapshot: mailDisabledSnapshot });
    await using screen = await render(
      <RegistryContext.Provider value={state.registry}>
        <BoardMailTab
          threadRef={threadRef}
          cardIds={["11111111-1111-4111-8111-111111111111"]}
          refreshSeq={0}
        />
      </RegistryContext.Provider>,
    );

    await expect.element(screen.getByText(/Mail is off/)).toBeVisible();
    await expect.element(screen.getByRole("link", { name: "Settings → Policies" })).toBeVisible();
    // History stays visible while the feature is off.
    await expect.element(screen.getByRole("heading", { name: "Refactor" })).toBeVisible();
  });

  it("shows an empty note when the board has no mail tasks", async () => {
    using state = setup({ tasks: [] });
    await using screen = await render(
      <RegistryContext.Provider value={state.registry}>
        <BoardMailTab threadRef={threadRef} cardIds={[]} refreshSeq={0} />
      </RegistryContext.Provider>,
    );

    await expect.element(screen.getByText("No mail tasks for this board yet.")).toBeVisible();
  });

  it("keeps a failed task listing retryable", async () => {
    using state = setup({ tasksFailure: true });
    await using screen = await render(
      <RegistryContext.Provider value={state.registry}>
        <BoardMailTab
          threadRef={threadRef}
          cardIds={["11111111-1111-4111-8111-111111111111"]}
          refreshSeq={0}
        />
      </RegistryContext.Provider>,
    );

    await expect.element(screen.getByText("Could not load mail tasks.")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  });
});

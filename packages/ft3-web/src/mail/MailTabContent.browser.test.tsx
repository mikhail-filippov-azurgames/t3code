import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { MailTask, MailTimelineEntry } from "@t3tools/ft3-mail/contracts";
import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";

import { fakeTimers, render } from "../../../../apps/web/test/render";
import { BoardMailTab } from "./MailTabContent.tsx";

const mocks = vi.hoisted(() => ({
  tasks: vi.fn(),
  snapshot: vi.fn(),
}));

vi.mock("./state.ts", () => ({
  mailEnvironment: {
    tasks: (target: unknown) => mocks.tasks(target),
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

const task = (overrides: Record<string, unknown> = {}): MailTask => ({
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
  ...overrides,
});

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
  readonly letters?: Record<string, MailTimelineEntry[]>;
  readonly tasksFailure?: "offline" | "unknown-method";
  readonly snapshot?: unknown;
}) {
  vi.clearAllMocks();
  // One atom instance per setup: the query family memoizes atoms by target, so
  // production renders see a stable atom identity and a stable refresh callback.
  const tasksAtom =
    options.tasksFailure === "offline"
      ? Atom.make(AsyncResult.failure(Cause.fail(new Error("offline"))))
      : options.tasksFailure === "unknown-method"
        ? Atom.make(AsyncResult.failure(Cause.die(new Error("Unknown request tag: mail.tasks"))))
        : Atom.make(
            AsyncResult.success({
              tasks: options.tasks ?? [],
              letters: options.letters ?? {},
            }),
          );
  mocks.tasks.mockReturnValue(tasksAtom);
  mocks.snapshot.mockReturnValue(
    Atom.make(AsyncResult.success(options.snapshot ?? mailEnabledSnapshot)),
  );
  const registry = AtomRegistry.make();
  return { registry, [Symbol.dispose]: () => registry.dispose() };
}

const renderTab = (
  state: ReturnType<typeof setup>,
  cardIds: ReadonlyArray<string> = ["11111111-1111-4111-8111-111111111111"],
  refreshCards?: () => void,
) =>
  render(
    <RegistryContext.Provider value={state.registry}>
      <BoardMailTab
        threadRef={threadRef}
        cardIds={cardIds}
        {...(refreshCards === undefined ? {} : { refreshCards })}
      />
    </RegistryContext.Provider>,
  );

describe("BoardMailTab", () => {
  it("shows one group per task with letters oldest first and delivery badges", async () => {
    using state = setup({
      tasks: [task()],
      letters: {
        "task:one": [
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
      },
    });
    await using screen = await renderTab(state);

    await expect.element(screen.getByRole("heading", { name: "Refactor" })).toBeVisible();
    const group = screen.container.querySelector('[data-mail-task-id="task:one"]')!;
    // The batched letters arrive newest-first; the tab reads oldest first.
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

  it("requests the whole page once however many tasks and letters it holds", async () => {
    const tasks = [
      task({ taskId: "task:1", title: "One" }),
      task({ taskId: "task:2", title: "Two" }),
      task({ taskId: "task:3", title: "Three" }),
    ];
    using state = setup({
      tasks,
      letters: Object.fromEntries(
        tasks.map((item, index) => [
          item.taskId,
          [
            entry({
              letter: letter({
                letterId: `letter:${index}:1`,
                taskId: item.taskId,
                body: "First.",
              }),
            }),
            entry({
              letter: letter({
                letterId: `letter:${index}:2`,
                taskId: item.taskId,
                sequence: 2,
                body: "Second.",
              }),
            }),
          ],
        ]),
      ),
    });
    await using screen = await renderTab(state);

    await expect.element(screen.getByRole("heading", { name: "Three" })).toBeVisible();
    // One atom family target for the whole tab: no per-task or per-letter requests.
    const targets = new Set(mocks.tasks.mock.calls.map((call) => JSON.stringify(call[0])));
    expect(targets.size).toBe(1);
    const headings = screen.container.querySelectorAll("h3");
    expect(headings.length).toBe(3);
    expect(screen.container.querySelectorAll("[data-mail-letter-id]").length).toBe(6);
  });

  it("shows a note when the task page hits its cap", async () => {
    using state = setup({
      tasks: Array.from({ length: 50 }, (_, index) =>
        task({ taskId: `task:${index}`, title: `Task ${index}` }),
      ),
    });
    await using screen = await renderTab(state);

    await expect.element(screen.getByText("Showing the latest 50 mail tasks.")).toBeVisible();
  });

  it("shows a read-only note with a Policies link when mail is off", async () => {
    using state = setup({ tasks: [task()], snapshot: mailDisabledSnapshot });
    await using screen = await renderTab(state);

    await expect.element(screen.getByText(/Mail is off/)).toBeVisible();
    await expect.element(screen.getByRole("link", { name: "Settings → Policies" })).toBeVisible();
    // History stays visible while the feature is off.
    await expect.element(screen.getByRole("heading", { name: "Refactor" })).toBeVisible();
  });

  it("re-reads the board's cards on each poll so new cards join the mail page", async () => {
    using state = setup({ tasks: [] });
    const refreshCards = vi.fn();
    // The poll interval is armed on mount, so fake timers come first.
    using _timers = fakeTimers();
    await using _screen = await renderTab(state, [], refreshCards);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(refreshCards).toHaveBeenCalledTimes(2);
  });

  it("keeps polling across re-renders instead of resetting the interval", async () => {
    using state = setup({ tasks: [] });
    const refreshCards = vi.fn();
    using _timers = fakeTimers();
    const tab = (refresh?: () => void) => (
      <RegistryContext.Provider value={state.registry}>
        <BoardMailTab
          threadRef={threadRef}
          cardIds={[]}
          {...(refresh === undefined ? {} : { refreshCards: refresh })}
        />
      </RegistryContext.Provider>
    );
    await using screen = await render(tab(refreshCards));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });

    await vi.advanceTimersByTimeAsync(10_000);
    // Re-renders used to rebuild the poll callback and restart the interval,
    // so a busy lead thread could stall the task list with stale statuses.
    await screen.rerender(tab(refreshCards));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(refreshCards).toHaveBeenCalledTimes(2);
  });

  it("shows card-less tasks in a Without a card group alongside card tasks", async () => {
    using state = setup({
      tasks: [
        task({ taskId: "task:card", title: "Card task" }),
        task({ taskId: "task:free", title: "Free task", cardId: null }),
      ],
      letters: {
        "task:card": [entry()],
        "task:free": [
          entry({
            letter: letter({ taskId: "task:free", body: "Unbound work." }),
          }),
        ],
      },
    });
    await using screen = await renderTab(state);

    await expect.element(screen.getByRole("heading", { name: "Without a card" })).toBeVisible();
    const section = screen.container.querySelector("section")!;
    expect(section.querySelector('[data-mail-task-id="task:free"]')).not.toBeNull();
    expect(section.textContent).toContain("Unbound work.");
    // The card group still renders above, and the empty note stays hidden.
    await expect.element(screen.getByRole("heading", { name: "Card task" })).toBeVisible();
    expect(screen.container.textContent).not.toContain("No mail tasks for this board yet.");
  });

  it("asks for the lead's card-less tasks even when the board has no cards", async () => {
    using state = setup({
      tasks: [task({ taskId: "task:free", title: "Free task", cardId: null })],
    });
    await using screen = await renderTab(state, []);

    await expect.element(screen.getByRole("heading", { name: "Without a card" })).toBeVisible();
    expect(screen.container.textContent).not.toContain("No mail tasks for this board yet.");
    const target = mocks.tasks.mock.calls[0]?.[0] as { input: Record<string, unknown> };
    expect(target.input.withoutCard).toBe(true);
    expect(target.input.threadId).toBe("browser-coordinator");
  });

  it("shows an empty note when the board has no mail tasks", async () => {
    using state = setup({ tasks: [] });
    await using screen = await renderTab(state, []);

    await expect.element(screen.getByText("No mail tasks for this board yet.")).toBeVisible();
  });

  it("explains the unsupported state instead of retrying on an old server", async () => {
    using state = setup({ tasksFailure: "unknown-method" });
    await using screen = await renderTab(state);

    await expect
      .element(screen.getByText(/This server does not support the Mail tab yet/))
      .toBeVisible();
    expect(screen.container.querySelector('[role="alert"]')).toBeNull();
    expect(screen.container.textContent).not.toContain("Retry");
  });

  it("keeps a failed task listing retryable", async () => {
    using state = setup({ tasksFailure: "offline" });
    await using screen = await renderTab(state);

    await expect.element(screen.getByText("Could not load mail tasks.")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  });
});

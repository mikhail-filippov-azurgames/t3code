import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../../apps/web/test/render";
import { useFt3BoardChatSections } from "./BoardChatRightSections.tsx";
import type { CoordinatorSummaryHistoryEntry } from "./coordinatorSummaryHistory";

const mocks = vi.hoisted(() => ({
  listForChatPanel: vi.fn(),
  resolve: vi.fn(),
  historyLoader: vi.fn(),
  mailTasks: vi.fn(),
}));

vi.mock("./state.ts", () => ({
  boardEnvironment: {
    listForChatPanel: (target: unknown) => mocks.listForChatPanel(target),
    resolve: (target: unknown) => mocks.resolve(target),
    // Command atoms consumed by useAtomCommand in the Cards section; the render
    // tests never invoke them, only read their label.
    start: { label: "board.start" },
    update: { label: "board.update" },
    requestOrchestrator: { label: "board.requestOrchestrator" },
  },
}));

vi.mock("./useCoordinatorSummaryHistoryLoader.ts", () => ({
  useCoordinatorSummaryHistoryLoader: () => mocks.historyLoader,
}));

vi.mock("../mail/MailTabContent.tsx", () => ({
  BoardMailTab: () => <div data-mail-tab-stub="true" />,
  useBoardMailTasks: () => mocks.mailTasks(),
}));

const environmentId = EnvironmentId.make("browser-env");
const threadId = ThreadId.make("browser-lead");
const cardId = "11111111-1111-4111-8111-111111111111";

const threadRef: ScopedThreadRef = { environmentId, threadId };

function Probe(props: { readonly threadRef: ScopedThreadRef | null }) {
  return <>{useFt3BoardChatSections(props.threadRef)}</>;
}

const historyEntry = (
  overrides: Partial<CoordinatorSummaryHistoryEntry> = {},
): CoordinatorSummaryHistoryEntry => ({
  id: "child:turn",
  summaryText: "The child summarized its turn.",
  child: "Fix the bug",
  turnOrdinal: 1,
  completedAt: "2026-11-04T00:00:00.000Z",
  currentStatus: "completed",
  summaryStatus: "ready",
  executorRole: "implementation",
  executorProviderInstanceId: null,
  executorModel: null,
  stale: false,
  ...overrides,
});

function setup(options: {
  readonly historyEntries?: ReadonlyArray<CoordinatorSummaryHistoryEntry>;
  readonly mailTaskCount?: number;
}) {
  vi.clearAllMocks();
  window.localStorage.clear();
  mocks.listForChatPanel.mockReturnValue(
    Atom.make(AsyncResult.success({ cards: [], orchestrators: [] })),
  );
  mocks.resolve.mockReturnValue(Atom.make(AsyncResult.success({ matches: [], details: [] })));
  mocks.historyLoader.mockImplementation(async () => ({
    entries: options.historyEntries ?? [],
    nextCursor: null,
  }));
  const tasks = Array.from({ length: options.mailTaskCount ?? 0 }, (_, index) => ({
    taskId: `task:${index}`,
  }));
  mocks.mailTasks.mockReturnValue({
    data: { tasks, letters: {} },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  });
  const registry = AtomRegistry.make();
  return { registry, [Symbol.dispose]: () => registry.dispose() };
}

const renderSections = (state: ReturnType<typeof setup>, ref: ScopedThreadRef | null) =>
  render(
    <RegistryContext.Provider value={state.registry}>
      <Probe threadRef={ref} />
    </RegistryContext.Provider>,
  );

describe("useFt3BoardChatSections", () => {
  it("renders nothing without a server thread", async () => {
    using state = setup({});
    await using screen = await renderSections(state, null);

    expect(screen.container.textContent).toBe("");
  });

  it("renders nothing when the lead thread has no board content", async () => {
    using state = setup({});
    await using screen = await renderSections(state, threadRef);

    expect(screen.container.textContent).toBe("");
  });

  it("shows the Cards section for pinned cards and the Mail section with tasks", async () => {
    using state = setup({ mailTaskCount: 1 });
    window.localStorage.setItem(
      `t3code:board-card-pins:v1:${environmentId}:${threadId}`,
      JSON.stringify([cardId]),
    );
    await using screen = await renderSections(state, threadRef);

    await expect.element(screen.getByRole("heading", { name: "Cards" })).toBeVisible();
    await expect.element(screen.getByRole("heading", { name: "Mail" })).toBeVisible();
    expect(screen.container.querySelector("[data-mail-tab-stub]")).not.toBeNull();
    // A pin whose card lookup is empty still names itself and offers unpin.
    await expect
      .element(screen.getByRole("button", { name: `Unpin card ${cardId}` }))
      .toBeVisible();
    // History has no entries and no error, so its section stays hidden.
    expect(screen.container.querySelector("#ft3-board-history-heading")).toBeNull();
  });

  it("shows the History section when summaries exist", async () => {
    using state = setup({ historyEntries: [historyEntry()] });
    await using screen = await renderSections(state, threadRef);

    await expect.element(screen.getByRole("heading", { name: "History" })).toBeVisible();
    await expect.element(screen.getByText("Fix the bug · turn 1")).toBeVisible();
    expect(screen.container.querySelector("#ft3-board-cards-heading")).toBeNull();
    expect(screen.container.querySelector("#ft3-board-mail-heading")).toBeNull();
  });
});

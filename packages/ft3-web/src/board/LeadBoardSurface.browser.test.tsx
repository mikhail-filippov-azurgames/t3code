import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../../apps/web/test/render";
import { LeadBoardSurface, type LeadBoardSection } from "./LeadBoardSurface.tsx";
import type { CoordinatorSummaryHistoryEntry } from "./coordinatorSummaryHistory";

const mocks = vi.hoisted(() => ({
  listForChatPanel: vi.fn(),
  orchestratorsList: vi.fn(),
  resolve: vi.fn(),
  historyLoader: vi.fn(),
  mailTasks: vi.fn(),
}));

vi.mock("./state.ts", () => ({
  boardEnvironment: {
    listForChatPanel: (target: unknown) => mocks.listForChatPanel(target),
    orchestratorsList: (target: unknown) => mocks.orchestratorsList(target),
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
  readonly isLead?: boolean;
}) {
  vi.clearAllMocks();
  window.localStorage.clear();
  mocks.listForChatPanel.mockReturnValue(
    Atom.make(AsyncResult.success({ cards: [], orchestrators: [] })),
  );
  mocks.orchestratorsList.mockReturnValue(
    Atom.make(
      AsyncResult.success({
        orchestrators:
          options.isLead === false ? [] : [{ threadId, createdBy: "human", createdAt: "now" }],
      }),
    ),
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

const renderSurface = (state: ReturnType<typeof setup>, section: LeadBoardSection = "cards") =>
  render(
    <RegistryContext.Provider value={state.registry}>
      <LeadBoardSurface threadRef={threadRef} visible section={section} />
    </RegistryContext.Provider>,
  );

describe("LeadBoardSurface", () => {
  it("declines a thread that is not registered as a lead", async () => {
    using state = setup({ isLead: false });
    await using screen = await renderSurface(state);

    await expect.element(screen.getByRole("status")).toHaveTextContent("Panel unavailable.");
  });

  it("says so when the lead has no pinned cards or summaries", async () => {
    using state = setup({});
    await using cards = await renderSurface(state, "cards");
    await expect.element(cards.getByText("No pinned cards.")).toBeVisible();
  });

  it("mounts the empty Mail surface so it can poll for new tasks", async () => {
    using state = setup({});
    await using screen = await renderSurface(state, "mail");

    await expect.element(screen.getByRole("heading", { name: "Mail" })).toBeVisible();
    expect(screen.container.querySelector("[data-mail-tab-stub]")).not.toBeNull();
  });

  it("shows pinned cards on the Cards surface without mounting Mail", async () => {
    using state = setup({ mailTaskCount: 1 });
    window.localStorage.setItem(
      `t3code:board-card-pins:v1:${environmentId}:${threadId}`,
      JSON.stringify([cardId]),
    );
    await using screen = await renderSurface(state, "cards");

    await expect.element(screen.getByRole("heading", { name: "Cards" })).toBeVisible();
    expect(screen.container.querySelector("[data-mail-tab-stub]")).toBeNull();
    // A pin whose card lookup is empty still names itself and offers unpin.
    await expect
      .element(screen.getByRole("button", { name: `Unpin card ${cardId}` }))
      .toBeVisible();
  });

  it("shows summaries on the History surface", async () => {
    using state = setup({ historyEntries: [historyEntry()] });
    await using screen = await renderSurface(state, "history");

    await expect.element(screen.getByRole("heading", { name: "History" })).toBeVisible();
    await expect.element(screen.getByText("Fix the bug · turn 1")).toBeVisible();
  });
});

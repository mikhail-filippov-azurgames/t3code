import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { BoardCardId, type BoardCardResolveResult } from "@t3tools/ft3-board/contracts";
import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../../apps/web/test/render";
import { LeadBoardSurface, type LeadBoardSection } from "./LeadBoardSurface.tsx";
import type { CoordinatorSummaryHistoryEntry } from "./coordinatorSummaryHistory";
import { addBoardCardPin, removeBoardCardPin } from "./boardCardPins.ts";
import { resetCardsPanelState, useCardsPanelState } from "./cardsPanelState";
import { useBoardCardPins } from "./BoardCardPinnedPanel";

vi.mock("./cardsPanelState", { spy: true });

const mocks = vi.hoisted(() => ({
  listForChatPanel: vi.fn(),
  orchestratorsList: vi.fn(),
  resolve: vi.fn(),
  list: vi.fn(),
  historyLoader: vi.fn(),
  mailTasks: vi.fn(),
  planGet: vi.fn(),
  readDoc: vi.fn(),
}));

vi.mock("../planning/state.ts", () => ({
  planningEnvironment: {
    planGet: (target: unknown) => mocks.planGet(target),
    readDoc: (target: unknown) => mocks.readDoc(target),
    planAccept: { label: "board.planAccept" },
  },
}));

vi.mock("./state.ts", () => ({
  boardEnvironment: {
    listForChatPanel: (target: unknown) => mocks.listForChatPanel(target),
    orchestratorsList: (target: unknown) => mocks.orchestratorsList(target),
    resolve: (target: unknown) => mocks.resolve(target),
    list: (target: unknown) => mocks.list(target),
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

const pinnedCard = (cardId: string, body: string) => ({
  cardId,
  orchestratorThreadId: "thread:orchestrator",
  title: "Pinned work",
  body,
  status: "todo",
  readiness: "ready",
  readinessNote: null,
  createdBy: "human",
  assignee: null,
  executorRole: "implementation",
  executorThreadId: null,
  outcome: null,
  lastError: null,
  failureStreak: 0,
  order: 0,
  archived: false,
  createdAt: "2026-11-04T00:00:00.000Z",
  updatedAt: "2026-11-04T00:00:00.000Z",
});

function setup(options: {
  readonly historyEntries?: ReadonlyArray<CoordinatorSummaryHistoryEntry>;
  readonly mailTaskCount?: number;
  readonly isLead?: boolean;
  readonly pin?: { readonly cardId: string; readonly body: string };
}) {
  resetCardsPanelState();
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
  mocks.list.mockReturnValue(Atom.make(AsyncResult.success({ cards: [], events: [], plans: [] })));
  mocks.resolve.mockReturnValue(
    Atom.make(
      AsyncResult.success(
        options.pin === undefined
          ? { matches: [], details: [] }
          : {
              matches: [],
              details: [
                {
                  card: pinnedCard(options.pin.cardId, options.pin.body),
                  orchestratorThreadTitle: "Orchestrator thread",
                  events: [
                    {
                      entryId: "entry:1",
                      cardId: options.pin.cardId,
                      at: "2026-11-04T00:05:00.000Z",
                      status: "todo",
                      executorRole: "implementation",
                      model: null,
                      effort: null,
                      body: "Card created.",
                      source: "system",
                    },
                  ],
                },
              ],
            },
      ),
    ),
  );
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

function setupPinnedPlan(planCardId: string) {
  const state = setup({ pin: { cardId: planCardId, body: "Read the plan." } });
  window.localStorage.setItem(
    `t3code:board-card-pins:v1:${environmentId}:${threadId}`,
    JSON.stringify([planCardId]),
  );
  mocks.list.mockReturnValue(
    Atom.make(
      AsyncResult.success({
        cards: [pinnedCard(planCardId, "Read the plan.")],
        events: [],
        plans: [
          {
            cardId: BoardCardId.make(planCardId),
            title: "Pinned work",
            plannerThreadId: "planner",
            status: "discussion",
            planDocId: "doc-plan",
          },
        ],
      }),
    ),
  );
  mocks.planGet.mockReturnValue(
    Atom.make(
      AsyncResult.success({
        record: { state: "discussion" },
        doc: { stableId: "doc-plan", name: "plan.md" },
      }),
    ),
  );
  mocks.readDoc.mockReturnValue(
    Atom.make(
      AsyncResult.success({
        status: "found",
        stableId: "doc-plan",
        sha256: "a".repeat(64),
        content: "Pinned plan text",
      }),
    ),
  );
  return state;
}

async function openReading(screen: Awaited<ReturnType<typeof renderSurface>>) {
  await userEvent.click(screen.getByRole("button", { name: "Description", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "History", exact: true }));
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Request to orchestrator" }),
    "Keep my draft",
  );
  await userEvent.click(screen.getByRole("button", { name: "Plan", exact: true }));
  await expect
    .element(page.getByRole("dialog", { name: "Plan: Pinned work" }).getByText("Pinned plan text"))
    .toBeVisible();
}

describe("LeadBoardSurface", () => {
  it("keeps the pins reference stable until the storage snapshot changes", async () => {
    using _state = setup({});
    const observePins = vi.fn();
    function PinsProbe() {
      observePins(useBoardCardPins(threadRef));
      return null;
    }
    await using screen = await render(<PinsProbe />);
    const initialPins = observePins.mock.lastCall![0];
    await screen.rerender(<PinsProbe />);
    expect(observePins.mock.lastCall![0]).toBe(initialPins);
    await act(() => addBoardCardPin(environmentId, threadId, cardId));
    expect(observePins.mock.lastCall![0]).toEqual([cardId]);
    expect(observePins.mock.lastCall![0]).not.toBe(initialPins);
  });

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

  it("keeps the plan and reading DOM mounted during refreshes and failures", async () => {
    using state = setupPinnedPlan("33333333-3333-4333-8333-333333333333");
    await using screen = await renderSurface(state);
    await openReading(screen);
    const plan = page.getByRole("dialog", { name: "Plan: Pinned work" });
    const descriptionNode = screen.getByText("Read the plan.").element();
    const historyNode = screen.getByText("Card created.").element();
    const leads = mocks.orchestratorsList.mock.results.at(-1)!.value as Atom.Writable<
      AsyncResult.AsyncResult<{ orchestrators: Array<{ threadId: ThreadId }> }, Error>
    >;
    for (const result of [
      AsyncResult.waiting(state.registry.get(leads)),
      AsyncResult.initial(true),
      AsyncResult.failure<{ orchestrators: Array<{ threadId: ThreadId }> }, Error>(
        Cause.fail(new Error("Offline")),
      ),
      AsyncResult.success({ orchestrators: [{ threadId }] }),
    ]) {
      await act(() => state.registry.set(leads, result));
      await expect.element(plan.getByText("Pinned plan text")).toBeVisible();
      expect(screen.container.contains(descriptionNode)).toBe(true);
      expect(screen.container.contains(historyNode)).toBe(true);
    }
    const resolve = mocks.resolve.mock.results.at(-1)!.value;
    const original = state.registry.get(resolve) as AsyncResult.Success<BoardCardResolveResult>;
    for (const result of [
      AsyncResult.initial(true),
      AsyncResult.failure(Cause.fail(new Error("Offline"))),
      AsyncResult.success({
        ...original.value,
        details: original.value.details.map((detail) => ({
          ...detail,
          card: { ...detail.card, body: "Updated description.", title: "Updated title" },
          events: detail.events.map((event) => ({ ...event, body: "Updated history." })),
        })),
      }),
    ]) {
      await act(() => state.registry.set(resolve, result));
      await expect.element(page.getByRole("dialog").getByText("Pinned plan text")).toBeVisible();
      expect(screen.container.contains(descriptionNode)).toBe(true);
      expect(screen.container.contains(historyNode)).toBe(true);
    }
    expect(descriptionNode.textContent).toBe("Updated description.");
    expect(historyNode.textContent).toBe("Updated history.");
    await act(() => state.registry.set(resolve, AsyncResult.initial(true)));
    await expect.element(page.getByRole("dialog", { name: "Plan: Updated title" })).toBeVisible();
    await act(() => {
      (
        page
          .getByRole("dialog")
          .getByRole("button", { name: "Close", exact: true })
          .first()
          .element() as HTMLElement
      ).click();
    });
  });

  it("reopens the existing card plan and reading state after remount and tab changes", async () => {
    using state = setupPinnedPlan("44444444-4444-4444-8444-444444444444");
    await using screen = await renderSurface(state);
    await openReading(screen);
    await act(() => {
      state.registry.set(
        mocks.orchestratorsList.mock.results.at(-1)!.value,
        AsyncResult.initial(true),
      );
      state.registry.set(mocks.resolve.mock.results.at(-1)!.value, AsyncResult.initial(true));
    });
    await screen.rerender(
      <RegistryContext.Provider value={state.registry}>
        <LeadBoardSurface key="remounted" threadRef={threadRef} visible section="cards" />
      </RegistryContext.Provider>,
    );
    await expect
      .element(
        page.getByRole("dialog", { name: "Plan: Pinned work" }).getByText("Pinned plan text"),
      )
      .toBeVisible();
    await screen.rerender(
      <RegistryContext.Provider value={state.registry}>
        <LeadBoardSurface threadRef={threadRef} visible section="history" />
      </RegistryContext.Provider>,
    );
    await screen.rerender(
      <RegistryContext.Provider value={state.registry}>
        <LeadBoardSurface threadRef={threadRef} visible section="cards" />
      </RegistryContext.Provider>,
    );
    await expect
      .element(
        page.getByRole("dialog", { name: "Plan: Pinned work" }).getByText("Pinned plan text"),
      )
      .toBeVisible();
    await act(() => {
      (
        page
          .getByRole("dialog")
          .getByRole("button", { name: "Close", exact: true })
          .first()
          .element() as HTMLElement
      ).click();
    });
    await expect.element(screen.getByText("Read the plan.")).toBeVisible();
    await expect.element(screen.getByText("Card created.")).toBeVisible();
    await expect
      .element(screen.getByRole("textbox", { name: "Request to orchestrator" }))
      .toHaveValue("Keep my draft");
  });

  it("closes the deleted card plan and clears its content, actions and viewing state", async () => {
    using state = setupPinnedPlan("55555555-5555-4555-8555-555555555555");
    await using screen = await renderSurface(state);
    await openReading(screen);
    const resolve = mocks.resolve.mock.results.at(-1)!.value;
    const original = state.registry.get(resolve);
    await act(() => state.registry.set(resolve, AsyncResult.success({ matches: [], details: [] })));
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent(
        "Card 55555555-5555-4555-8555-555555555555 unavailable: it may have been deleted.",
      );
    const article = screen.container.querySelector("article")!;
    expect(article.querySelectorAll("button")).toHaveLength(1);
    expect(article.querySelector("textarea")).toBeNull();
    expect(article.textContent).not.toContain("Read the plan.");
    vi.mocked(useCardsPanelState).mockClear();
    await act(() =>
      state.registry.set(
        resolve,
        AsyncResult.success({ matches: [], details: [] }, { waiting: true }),
      ),
    );
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent(
        "Card 55555555-5555-4555-8555-555555555555 unavailable: it may have been deleted.",
      );
    expect(screen.container.textContent).not.toContain("Loading card…");
    expect(screen.container.querySelector("article")).toBe(article);
    const cardStateCalls = vi
      .mocked(useCardsPanelState)
      .mock.calls.filter(([, id]) => id === "55555555-5555-4555-8555-555555555555");
    expect(cardStateCalls.length).toBeGreaterThan(0);
    expect(cardStateCalls.every(([, , enabled]) => enabled === false)).toBe(true);
    await act(() => state.registry.set(resolve, AsyncResult.initial(true)));
    expect(screen.container.textContent).not.toContain("Read the plan.");
    await act(() => state.registry.set(resolve, original));
    await expect
      .element(screen.getByRole("button", { name: "Description" }))
      .toHaveAttribute("aria-expanded", "false");
    await expect
      .element(screen.getByRole("textbox", { name: "Request to orchestrator" }))
      .toHaveValue("");
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes the unpinned card plan and starts fresh after repinning", async () => {
    const pinnedId = "66666666-6666-4666-8666-666666666666";
    using state = setupPinnedPlan(pinnedId);
    await using screen = await renderSurface(state);
    await openReading(screen);
    await act(() => removeBoardCardPin(environmentId, threadId, pinnedId));
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(screen.getByText("No pinned cards.")).toBeVisible();
    await act(() => addBoardCardPin(environmentId, threadId, pinnedId));
    await expect
      .element(screen.getByRole("button", { name: "Description" }))
      .toHaveAttribute("aria-expanded", "false");
    await expect
      .element(screen.getByRole("textbox", { name: "Request to orchestrator" }))
      .toHaveValue("");
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });

  it("collapses the pinned card description and history behind chevron buttons", async () => {
    // A fresh card id per test: pinnedCardsQuery memoizes its atom by card ids,
    // so reusing the earlier pin's id would keep serving its empty lookup.
    const detailCardId = "22222222-2222-4222-8222-222222222222";
    using state = setup({ pin: { cardId: detailCardId, body: "Full card description." } });
    window.localStorage.setItem(
      `t3code:board-card-pins:v1:${environmentId}:${threadId}`,
      JSON.stringify([detailCardId]),
    );
    await using screen = await renderSurface(state, "cards");

    // Collapsed by default: the section buttons show, their content does not.
    await expect.element(screen.getByRole("button", { name: "Description" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "History" })).toBeVisible();
    expect(screen.container.textContent).not.toContain("Full card description.");
    expect(screen.container.textContent).not.toContain("Card created.");

    await userEvent.click(screen.getByRole("button", { name: "Description" }));
    await expect.element(screen.getByText("Full card description.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "History" }));
    await expect.element(screen.getByText("Card created.")).toBeVisible();
    await userEvent.fill(
      screen.getByRole("textbox", { name: "Request to orchestrator" }),
      "Unsent request",
    );
    screen.container.dataset.cardsScrollTest = "true";
    const style = document.createElement("style");
    style.textContent =
      '[data-cards-scroll-test] [aria-label="Cards"] { height: 180px; overflow-y: auto; }';
    screen.container.append(style);
    const panel = screen.container.querySelector('[aria-label="Cards"]') as HTMLDivElement;
    await act(() => {
      panel.scrollTop = 40;
      panel.dispatchEvent(new Event("scroll"));
    });
    expect(panel.scrollTop).toBe(40);
    await screen.rerender(
      <RegistryContext.Provider value={state.registry}>
        <LeadBoardSurface threadRef={threadRef} visible section="history" />
      </RegistryContext.Provider>,
    );
    await screen.rerender(
      <RegistryContext.Provider value={state.registry}>
        <LeadBoardSurface threadRef={threadRef} visible section="cards" />
      </RegistryContext.Provider>,
    );
    expect(screen.container.querySelector('[aria-label="Cards"]')?.scrollTop).toBe(40);
    await userEvent.click(screen.getByRole("button", { name: "Pinned work", exact: true }));
    await screen.rerender(
      <RegistryContext.Provider value={state.registry}>
        <LeadBoardSurface threadRef={threadRef} visible section="history" />
      </RegistryContext.Provider>,
    );
    await screen.rerender(
      <RegistryContext.Provider value={state.registry}>
        <LeadBoardSurface threadRef={threadRef} visible section="cards" />
      </RegistryContext.Provider>,
    );
    await expect
      .element(screen.getByRole("button", { name: "Pinned work", exact: true }))
      .toHaveAttribute("aria-expanded", "false");
    await userEvent.click(screen.getByRole("button", { name: "Pinned work", exact: true }));
    await expect.element(screen.getByText("Full card description.")).toBeVisible();
    await expect.element(screen.getByText("Card created.")).toBeVisible();
    await expect
      .element(screen.getByRole("textbox", { name: "Request to orchestrator" }))
      .toHaveValue("Unsent request");
  });

  it("shows summaries on the History surface", async () => {
    using state = setup({ historyEntries: [historyEntry()] });
    await using screen = await renderSurface(state, "history");

    await expect.element(screen.getByRole("heading", { name: "History" })).toBeVisible();
    await expect.element(screen.getByText("Fix the bug · turn 1")).toBeVisible();
  });
});

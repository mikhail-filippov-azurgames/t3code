import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { BoardCardId, type BoardCard, type BoardListResult } from "@t3tools/ft3-board/contracts";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { act, render } from "../../../../apps/web/test/render";
import { Ft3SurfaceContent } from "../panels.tsx";
import { BoardPage } from "./BoardPage.tsx";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  orchestrators: vi.fn(),
  start: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  resend: vi.fn(),
  request: vi.fn(),
  planGet: vi.fn(),
  readDoc: vi.fn(),
}));

vi.mock("./state.ts", () => ({
  boardEnvironment: {
    list: (target: unknown) => mocks.list(target),
    orchestratorsList: (target: unknown) => mocks.orchestrators(target),
    start: mocks.start,
    update: mocks.update,
    create: mocks.create,
    orchestratorAdd: mocks.add,
    orchestratorRemove: mocks.remove,
    resendBrief: mocks.resend,
    requestOrchestrator: mocks.request,
  },
}));
vi.mock("./useBoardBackend", async () => ({
  boardEnvironment: (await import("./state.ts")).boardEnvironment,
  useBoardOrchestratorThreadKeys: () => new Set<string>(),
}));
vi.mock("~/state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/entities")>()),
  useThreadShells: () => [],
}));
vi.mock("~/state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/environments")>()),
  usePrimaryEnvironmentId: () => EnvironmentId.make("browser-env"),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("./BoardCardDialog.tsx", () => ({ BoardCardDialog: () => null }));
vi.mock("../planning/state.ts", () => ({
  planningEnvironment: {
    planGet: (target: unknown) => mocks.planGet(target),
    readDoc: (target: unknown) => mocks.readDoc(target),
    planAccept: { label: "board.planAccept" },
  },
}));

const ref = {
  environmentId: EnvironmentId.make("browser-env"),
  threadId: ThreadId.make("browser-coordinator"),
};

function setup(options: { withPlan?: boolean; longBody?: boolean } = {}) {
  vi.clearAllMocks();
  const card: BoardCard = {
    cardId: BoardCardId.make("11111111-1111-4111-8111-111111111111"),
    orchestratorThreadId: ref.threadId,
    title: "Ship the board",
    body: options.longBody ? "Acceptance criteria\n".repeat(300) : "Acceptance criteria",
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
    createdAt: "2026-10-26T00:00:00Z",
    updatedAt: "2026-10-26T00:00:00Z",
  };
  const listData: BoardListResult = {
    cards: [card],
    events: [],
    plans: options.withPlan
      ? [
          {
            cardId: card.cardId,
            title: card.title,
            planDocId: "doc-plan",
            plannerThreadId: ThreadId.make("planner-thread"),
            status: "discussion",
            stepCount: 1,
            implementStarted: false,
          },
        ]
      : [],
  };
  const list = Atom.make<AsyncResult.AsyncResult<BoardListResult>>(AsyncResult.success(listData));
  const orchestrators = Atom.make(
    AsyncResult.success({
      orchestrators: [{ threadId: ref.threadId, createdBy: "human", createdAt: card.createdAt }],
    }),
  );
  mocks.list.mockReturnValue(list);
  mocks.orchestrators.mockReturnValue(orchestrators);
  mocks.start.mockResolvedValue(
    AsyncResult.failure(Cause.fail(new Error("Waiting for human input."))),
  );
  mocks.planGet.mockReturnValue(
    Atom.make<AsyncResult.AsyncResult<unknown, Error>>(
      AsyncResult.success({
        record: {
          cardId: card.cardId,
          required: true,
          requiredBy: "human",
          requiredReason: "contracts",
          state: "discussion",
          planDocId: "doc-plan",
          plannerMemberId: "member-planner",
          plannerThreadId: "planner-thread",
          reviewRounds: 0,
          acceptedSha256: null,
          acceptedRevision: 0,
          acceptedAt: null,
          updatedAt: card.createdAt,
        },
        doc: { stableId: "doc-plan", relPath: "corvis/plans/demo/card.md", name: "card.md" },
        liveSha256: "f".repeat(64),
        versions: [],
      }),
    ),
  );
  mocks.readDoc.mockReturnValue(
    Atom.make<AsyncResult.AsyncResult<unknown, Error>>(
      AsyncResult.success({
        status: "found",
        stableId: "doc-plan",
        relPath: "corvis/plans/demo/card.md",
        name: "card.md",
        sha256: "a".repeat(64),
        content: "# Plan\n\n" + "Step P1.\n".repeat(300),
      }),
    ),
  );
  const registry = AtomRegistry.make();
  return { registry, list, listData, card, [Symbol.dispose]: () => registry.dispose() };
}

describe("Board registry rendering", () => {
  it("renders the registered Board and filters visible cards", async () => {
    using state = setup();
    await using screen = await render(
      <RegistryContext.Provider value={state.registry}>
        <Ft3SurfaceContent surfaceType="board" threadRef={ref} visible />
      </RegistryContext.Provider>,
    );
    await expect
      .element(screen.getByRole("button", { name: "Ship the board", exact: true }))
      .toBeVisible();
    await expect.element(screen.getByRole("region", { name: "To do", exact: true })).toBeVisible();
    await userEvent.fill(screen.getByRole("textbox", { name: "Search cards" }), "unrelated");
    await expect
      .element(screen.getByRole("button", { name: "Ship the board", exact: true }))
      .not.toBeInTheDocument();
    await userEvent.clear(screen.getByRole("textbox", { name: "Search cards" }));
    await expect
      .element(screen.getByRole("button", { name: "Ship the board", exact: true }))
      .toBeVisible();
  });

  it("keeps a rejected Start visible and leaves the card in To do", async () => {
    using state = setup();
    await using screen = await render(
      <RegistryContext.Provider value={state.registry}>
        <Ft3SurfaceContent surfaceType="board" threadRef={ref} visible />
      </RegistryContext.Provider>,
    );
    await expect.element(screen.getByRole("button", { name: "Start", exact: true })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Start", exact: true }));
    await expect.element(screen.getByRole("alert")).toHaveTextContent("Waiting for human input.");
    await expect
      .element(
        screen
          .getByRole("region", { name: "To do", exact: true })
          .getByRole("button", { name: "Ship the board", exact: true }),
      )
      .toBeVisible();
  });

  it("hides the Plan button for a card without a planner thread", async () => {
    using state = setup();
    await using screen = await render(
      <RegistryContext.Provider value={state.registry}>
        <Ft3SurfaceContent surfaceType="board" threadRef={ref} visible />
      </RegistryContext.Provider>,
    );
    await expect.element(screen.getByRole("button", { name: "Start", exact: true })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Plan", exact: true }))
      .not.toBeInTheDocument();
  });

  it("opens the plan viewer from the card's Plan button", async () => {
    using state = setup({ withPlan: true });
    await using screen = await render(
      <RegistryContext.Provider value={state.registry}>
        <Ft3SurfaceContent surfaceType="board" threadRef={ref} visible />
      </RegistryContext.Provider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Plan", exact: true }));
    await expect
      .element(screen.getByRole("heading", { name: "Plan: Ship the board" }))
      .toBeVisible();
    await expect.element(screen.getByText("Discussion", { exact: true })).toBeVisible();

    const planDialog = page.getByRole("dialog", { name: /^Plan:/ });
    const scroll = planDialog
      .element()
      .querySelector<HTMLElement>("[data-slot=scroll-area-viewport]")!;
    scroll.style.height = "160px";
    scroll.style.overflowY = "auto";
    scroll.scrollTop = 120;
    expect(scroll.scrollTop).toBe(120);

    await act(() =>
      state.registry.set(state.list, AsyncResult.success(state.listData, { waiting: true })),
    );
    await expect.element(planDialog).toBeVisible();
    expect(scroll.isConnected).toBe(true);
    expect(scroll.scrollTop).toBe(120);

    await act(() =>
      state.registry.set(
        state.list,
        AsyncResult.success({
          cards: [{ ...state.card, status: "in_progress", title: "Updated card" }],
          events: [],
          plans: [],
          archivedCounts: [],
        }),
      ),
    );
    await expect.element(planDialog).toBeVisible();
    await expect.element(planDialog).toHaveAccessibleName("Plan: Updated card");
    await act(() => {
      state.registry.set(state.list, AsyncResult.success({ ...state.listData, cards: [] }));
      for (const query of [mocks.planGet, mocks.readDoc]) {
        const atom = query.mock.results.at(-1)!.value as Atom.Writable<
          AsyncResult.AsyncResult<unknown, Error>
        >;
        const previous = state.registry.get(atom);
        state.registry.set(
          atom,
          AsyncResult.failure(Cause.fail(new Error("Card deleted")), {
            previousSuccess: AsyncResult.isSuccess(previous)
              ? Option.some(previous)
              : Option.none(),
          }),
        );
      }
    });
    await expect.element(planDialog).toBeVisible();
    await expect.element(planDialog).toHaveAccessibleName("Plan: Updated card");
    await expect
      .element(planDialog.getByRole("alert"))
      .toHaveTextContent("Plan could not be refreshed; the view may be outdated");
    await expect.element(planDialog.getByRole("button", { name: "Plan accepted" })).toBeDisabled();
    expect(scroll.isConnected).toBe(true);
    expect(scroll.scrollTop).toBe(120);
    (
      planDialog
        .getByRole("button", { name: "Close", exact: true })
        .first()
        .element() as HTMLElement
    ).click();
    await expect.element(planDialog).not.toBeInTheDocument();
  });

  it.each(["page", "panel"])(
    "keeps %s details during refresh and closes them after archive",
    async (surface) => {
      using state = setup({ longBody: true });
      await using screen = await render(
        <RegistryContext.Provider value={state.registry}>
          {surface === "page" ? (
            <BoardPage initialOrchestratorId={null} createOnMount={false} />
          ) : (
            <Ft3SurfaceContent surfaceType="board" threadRef={ref} visible />
          )}
        </RegistryContext.Provider>,
      );
      await userEvent.click(screen.getByRole("button", { name: /Ship the board/ }).first());
      const dialog = page.getByRole("dialog", { name: "Ship the board", exact: true });
      await expect.element(dialog).toBeVisible();
      const scroll = dialog
        .element()
        .querySelector<HTMLElement>("[data-slot=scroll-area-viewport]")!;
      scroll.style.height = "160px";
      scroll.style.overflowY = "auto";
      scroll.scrollTop = 50;
      expect(scroll.scrollTop).toBe(50);
      await act(() =>
        state.registry.set(state.list, AsyncResult.success(state.listData, { waiting: true })),
      );
      await expect.element(dialog).toBeVisible();
      expect(scroll.isConnected).toBe(true);
      expect(scroll.scrollTop).toBe(50);
      mocks.update.mockImplementation(async () => {
        state.registry.set(state.list, AsyncResult.success({ ...state.listData, cards: [] }));
        return AsyncResult.success({ ...state.card, archived: true });
      });
      (
        dialog.getByRole("button", { name: "Archive", exact: true }).element() as HTMLElement
      ).click();
      await expect.element(dialog).not.toBeInTheDocument();
      expect(scroll.isConnected).toBe(false);
    },
  );

  it.each(["page", "panel"])("keeps the %s plan open when its card disappears", async (surface) => {
    using state = setup({ withPlan: true });
    await using screen = await render(
      <RegistryContext.Provider value={state.registry}>
        {surface === "page" ? (
          <BoardPage initialOrchestratorId={null} createOnMount={false} />
        ) : (
          <Ft3SurfaceContent surfaceType="board" threadRef={ref} visible />
        )}
      </RegistryContext.Provider>,
    );
    await userEvent.click(screen.getByRole("button", { name: /Ship the board/ }).first());
    const detail = page.getByRole("dialog", { name: "Ship the board", exact: true });
    await userEvent.click(detail.getByRole("button", { name: "Plan", exact: true }));
    const plan = page.getByRole("dialog", { name: /^Plan:/ });
    await expect.element(plan).toBeVisible();
    const scroll = plan.element().querySelector<HTMLElement>("[data-slot=scroll-area-viewport]")!;
    scroll.style.height = "160px";
    scroll.style.overflowY = "auto";
    scroll.scrollTop = 120;
    expect(scroll.scrollTop).toBe(120);
    await act(() =>
      state.registry.set(state.list, AsyncResult.success(state.listData, { waiting: true })),
    );
    await expect.element(plan).toBeVisible();
    expect(scroll.isConnected).toBe(true);
    expect(scroll.scrollTop).toBe(120);
    await act(() =>
      state.registry.set(
        state.list,
        AsyncResult.success({
          ...state.listData,
          cards: [{ ...state.card, status: "in_progress", title: "Updated card" }],
        }),
      ),
    );
    await expect.element(plan).toBeVisible();
    await expect.element(plan).toHaveAccessibleName("Plan: Updated card");
    await act(() => {
      state.registry.set(state.list, AsyncResult.success({ ...state.listData, cards: [] }));
      for (const query of [mocks.planGet, mocks.readDoc]) {
        const atom = query.mock.results.at(-1)!.value as Atom.Writable<
          AsyncResult.AsyncResult<unknown, Error>
        >;
        const previous = state.registry.get(atom);
        state.registry.set(
          atom,
          AsyncResult.failure(Cause.fail(new Error("Card deleted")), {
            previousSuccess: AsyncResult.isSuccess(previous)
              ? Option.some(previous)
              : Option.none(),
          }),
        );
      }
    });
    await expect.element(plan).toBeVisible();
    await expect.element(plan).toHaveAccessibleName("Plan: Updated card");
    await expect.element(detail).not.toBeInTheDocument();
    await expect
      .element(plan.getByRole("alert"))
      .toHaveTextContent("Plan could not be refreshed; the view may be outdated");
    await expect.element(plan.getByRole("button", { name: "Plan accepted" })).toBeDisabled();
    expect(scroll.isConnected).toBe(true);
    expect(scroll.scrollTop).toBe(120);
  });

  it("shows a fallback for a removed surface", async () => {
    await using screen = await render(
      <Ft3SurfaceContent surfaceType="removed" threadRef={ref} visible />,
    );
    await expect.element(screen.getByRole("status")).toHaveTextContent("Panel unavailable.");
  });
});

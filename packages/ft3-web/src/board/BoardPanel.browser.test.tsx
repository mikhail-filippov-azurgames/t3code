import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { BoardCardId, type BoardCard } from "@t3tools/ft3-board/contracts";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { render } from "../../../../apps/web/test/render";
import { Ft3SurfaceContent } from "../panels.tsx";

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
vi.mock("~/state/entities", () => ({ useThreadShells: () => [] }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("./BoardCardDialog.tsx", () => ({ BoardCardDialog: () => null }));

const ref = {
  environmentId: EnvironmentId.make("browser-env"),
  threadId: ThreadId.make("browser-coordinator"),
};

function setup() {
  vi.clearAllMocks();
  const card: BoardCard = {
    cardId: BoardCardId.make("11111111-1111-4111-8111-111111111111"),
    orchestratorThreadId: ref.threadId,
    title: "Ship the board",
    body: "Acceptance criteria",
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
  const list = Atom.make(AsyncResult.success({ cards: [card], events: [] }));
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
  const registry = AtomRegistry.make();
  return { registry, [Symbol.dispose]: () => registry.dispose() };
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

  it("shows a fallback for a removed surface", async () => {
    await using screen = await render(
      <Ft3SurfaceContent surfaceType="removed" threadRef={ref} visible />,
    );
    await expect.element(screen.getByRole("status")).toHaveTextContent("Panel unavailable.");
  });
});

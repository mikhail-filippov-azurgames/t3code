import { EnvironmentId } from "@t3tools/contracts";
import { BoardCardId, BoardMcpFailure } from "@t3tools/ft3-board/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../../apps/web/test/render";
import { PlanViewerDialog } from "./PlanViewerDialog.tsx";

const mocks = vi.hoisted(() => ({
  planGet: null as unknown,
  readDoc: null as unknown,
  calls: [] as Array<{ label: string; input: unknown }>,
  refreshes: [] as string[],
  commandResult: null as unknown,
  pending: false,
}));

vi.mock("./state.ts", () => ({
  planningEnvironment: {
    planGet: (target: unknown) => ({ __query: "planGet", target }),
    readDoc: (target: unknown) => ({ __query: "readDoc", target }),
    planAccept: { label: "board.planAccept" },
  },
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    const view = {
      error: null,
      failure: null,
      isPending: mocks.pending,
      isSuccess: !mocks.pending,
      dataUpdatedAt: 0,
    };
    if (atom === null) return { ...view, data: null, refresh: () => {} };
    const query = (atom as { __query: string }).__query;
    return {
      ...view,
      data: mocks.pending ? null : query === "planGet" ? mocks.planGet : mocks.readDoc,
      refresh: () => {
        mocks.refreshes.push(query);
      },
    };
  },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand:
    (command: { label: string }) => async (target: { environmentId: unknown; input: unknown }) => {
      mocks.calls.push({ label: command.label, input: target.input });
      return mocks.commandResult;
    },
}));

const environmentId = EnvironmentId.make("browser-env");
const cardId = BoardCardId.make("11111111-1111-4111-8111-111111111111");

const planRecord = (state: string, overrides: Record<string, unknown> = {}) => ({
  cardId,
  required: true,
  requiredBy: "human",
  requiredReason: "contracts",
  state,
  planDocId: "doc-plan",
  plannerMemberId: "member-planner",
  plannerThreadId: "planner-thread",
  reviewRounds: 0,
  acceptedSha256: null,
  acceptedRevision: 0,
  acceptedAt: null,
  updatedAt: "2026-11-05T00:00:00.000Z",
  ...overrides,
});

const planGetResult = (state: string) => ({
  record: planRecord(state),
  doc: { stableId: "doc-plan", relPath: "corvis/plans/demo/card.md", name: "card.md" },
  liveSha256: "f".repeat(64),
  versions: [],
});

const readDocResult = {
  status: "found" as const,
  stableId: "doc-plan",
  relPath: "corvis/plans/demo/card.md",
  name: "card.md",
  sha256: "a".repeat(64),
  content: "# Plan\n\n| step | change |\n|---|---|\n| P1 | Ship it |",
};

function setup(options: { readonly state: string }) {
  vi.clearAllMocks();
  mocks.pending = false;
  mocks.planGet = planGetResult(options.state);
  mocks.readDoc = readDocResult;
  mocks.calls = [];
  mocks.refreshes = [];
  mocks.commandResult = AsyncResult.success(
    planRecord("accepted", {
      acceptedSha256: readDocResult.sha256,
      acceptedRevision: 1,
      acceptedAt: "2026-11-05T00:05:00.000Z",
    }),
  );
}

const renderDialog = () =>
  render(
    <PlanViewerDialog
      environmentId={environmentId}
      cardId={cardId}
      title="Ship the board"
      onClose={() => {}}
    />,
  );

describe("PlanViewerDialog", () => {
  it("shows the plan state and content with a link to the planner thread", async () => {
    setup({ state: "discussion" });
    await using screen = await renderDialog();

    await expect.element(screen.getByText("Discussion", { exact: true })).toBeVisible();
    await expect.element(screen.getByText(/# Plan/)).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Open planner thread" })).toBeVisible();
  });

  it("preserves the document and its scroll position while plan queries refresh", async () => {
    setup({ state: "discussion" });
    mocks.readDoc = { ...readDocResult, content: "# Plan\n" + "Step P1.\n".repeat(300) };
    await using screen = await renderDialog();
    const dialog = page.getByRole("dialog", { name: "Plan: Ship the board" });
    const scroll = dialog.element().querySelector<HTMLElement>("[data-slot=scroll-area-viewport]")!;
    scroll.style.height = "160px";
    scroll.style.overflowY = "auto";
    scroll.scrollTop = 120;
    expect(scroll.scrollTop).toBe(120);
    mocks.pending = true;
    await screen.rerender(
      <PlanViewerDialog
        environmentId={environmentId}
        cardId={cardId}
        title="Ship the board"
        onClose={() => {}}
      />,
    );
    await expect.element(dialog.getByText(/# Plan/)).toBeVisible();
    await expect.element(dialog.getByRole("button", { name: "Plan accepted" })).toBeDisabled();
    expect(scroll.isConnected).toBe(true);
    expect(scroll.scrollTop).toBe(120);
    mocks.pending = false;
    await screen.rerender(
      <PlanViewerDialog
        environmentId={environmentId}
        cardId={cardId}
        title="Ship the board"
        onClose={() => {}}
      />,
    );
    await expect.element(dialog.getByRole("button", { name: "Plan accepted" })).toBeEnabled();
    expect(scroll.scrollTop).toBe(120);
  });

  it("accepts the shown plan from discussion and shows the accepted state", async () => {
    setup({ state: "discussion" });
    await using screen = await renderDialog();

    (screen.getByRole("button", { name: "Plan accepted" }).element() as HTMLElement).click();

    expect(mocks.calls).toEqual([
      {
        label: "board.planAccept",
        input: { cardId, sha256: readDocResult.sha256 },
      },
    ]);
    await expect.element(screen.getByText("Accepted", { exact: true })).toBeVisible();
  });

  it("keeps Plan accepted disabled while the plan is drafting", async () => {
    setup({ state: "drafting" });
    await using screen = await renderDialog();

    await expect.element(screen.getByText("Drafting", { exact: true })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Plan accepted" })).toBeDisabled();
    expect(mocks.calls).toEqual([]);
  });

  it("shows plan_changed as a readable error and reloads the plan", async () => {
    setup({ state: "discussion" });
    mocks.commandResult = AsyncResult.failure(
      Cause.fail(
        new BoardMcpFailure({ code: "plan_changed", message: "Plan changed; read it again." }),
      ),
    );
    await using screen = await renderDialog();

    (screen.getByRole("button", { name: "Plan accepted" }).element() as HTMLElement).click();

    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Plan changed; read it again.");
    expect(mocks.refreshes).toEqual(["readDoc", "planGet"]);
  });

  it("shows plan_invalid as a readable error without reloading", async () => {
    setup({ state: "discussion" });
    mocks.commandResult = AsyncResult.failure(
      Cause.fail(
        new BoardMcpFailure({
          code: "invalid_request",
          message:
            'Plan for card "c" line 4: step ids must be unique. Fix the plan and accept again.',
        }),
      ),
    );
    await using screen = await renderDialog();

    (screen.getByRole("button", { name: "Plan accepted" }).element() as HTMLElement).click();

    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent(
        'Plan for card "c" line 4: step ids must be unique. Fix the plan and accept again.',
      );
    expect(mocks.refreshes).toEqual([]);
  });
});

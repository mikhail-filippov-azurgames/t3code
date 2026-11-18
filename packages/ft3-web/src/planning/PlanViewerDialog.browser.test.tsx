import { EnvironmentId } from "@t3tools/contracts";
import { BoardCardId, BoardMcpFailure } from "@t3tools/ft3-board/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../../apps/web/test/render";
import { PlanViewerDialog } from "./PlanViewerDialog.tsx";

const mocks = vi.hoisted(() => ({
  planGet: null as unknown,
  readDoc: null as unknown,
  calls: [] as Array<{ label: string; input: unknown }>,
  refreshes: [] as string[],
  commandResult: null as unknown,
  pending: false,
  readPending: false,
  planResult: null as AsyncResult.AsyncResult<unknown, unknown> | null,
  readResult: null as AsyncResult.AsyncResult<unknown, unknown> | null,
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
    const emptyView = {
      error: null,
      failure: null,
      isPending: false,
      isSuccess: false,
      dataUpdatedAt: 0,
    };
    if (atom === null) return { ...emptyView, data: null, refresh: () => {} };
    const query = (atom as { __query: string }).__query;
    const data = query === "planGet" ? mocks.planGet : mocks.readDoc;
    const waiting = mocks.pending || (query === "readDoc" && mocks.readPending);
    const result =
      (query === "planGet" ? mocks.planResult : mocks.readResult) ??
      (data === null ? AsyncResult.initial(waiting) : AsyncResult.success(data, { waiting }));
    return {
      ...emptyView,
      error: AsyncResult.isFailure(result) ? String(Cause.squash(result.cause)) : null,
      isPending: result.waiting,
      isSuccess: AsyncResult.isSuccess(result),
      data: AsyncResult.getOrElse(result, () => null),
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
  mocks.readPending = false;
  mocks.planResult = null;
  mocks.readResult = null;
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
  it.each(["planGet", "readDoc"] as const)(
    "warns when %s fails after a successful read",
    async (query) => {
      setup({ state: "discussion" });
      await using screen = await renderDialog();
      await expect.element(screen.getByText(/# Plan/)).toBeVisible();
      const result = AsyncResult.failure(Cause.fail(new Error("Card deleted")), {
        previousSuccess: Option.some(AsyncResult.success(mocks[query])),
      });
      if (query === "planGet") mocks.planResult = result;
      else mocks.readResult = result;
      const dialog = () => (
        <PlanViewerDialog
          environmentId={environmentId}
          cardId={cardId}
          title="Ship the board"
          onClose={() => {}}
        />
      );
      await screen.rerender(dialog());
      await expect
        .element(
          screen
            .getByRole("alert")
            .getByText("Plan could not be refreshed; the view may be outdated"),
        )
        .toBeVisible();
      await expect.element(screen.getByText(/# Plan/)).toBeVisible();
      await expect.element(screen.getByRole("button", { name: "Plan accepted" })).toBeDisabled();
      (screen.getByRole("button", { name: "Retry" }).element() as HTMLElement).click();
      expect(mocks.refreshes).toEqual(["planGet", "readDoc"]);
      mocks.planResult = null;
      mocks.readResult = null;
      await screen.rerender(dialog());
      await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
      await expect.element(screen.getByRole("button", { name: "Plan accepted" })).toBeEnabled();
    },
  );

  it("reports an initial plan query failure and allows retrying", async () => {
    setup({ state: "discussion" });
    mocks.planResult = AsyncResult.failure(Cause.fail(new Error("Card deleted")));
    await using screen = await renderDialog();
    await expect.element(screen.getByText("Plan state unavailable")).toBeVisible();
    await expect.element(screen.getByText("Loading the plan state…")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Plan accepted" })).toBeDisabled();
    (screen.getByRole("button", { name: "Retry" }).element() as HTMLElement).click();
    expect(mocks.refreshes).toEqual(["planGet"]);
    mocks.planResult = null;
    await screen.rerender(
      <PlanViewerDialog
        environmentId={environmentId}
        cardId={cardId}
        title="Ship the board"
        onClose={() => {}}
      />,
    );
    await expect.element(screen.getByText("Discussion", { exact: true })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Plan accepted" })).toBeEnabled();
  });
  it("shows the plan state and content with a link to the planner thread", async () => {
    setup({ state: "discussion" });
    await using screen = await renderDialog();

    await expect.element(screen.getByText("Discussion", { exact: true })).toBeVisible();
    await expect.element(screen.getByText(/# Plan/)).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Open planner thread" })).toBeVisible();
  });

  it("preserves the document and its scroll position while plan queries refresh", async () => {
    setup({ state: "discussion" });
    mocks.planGet = {
      ...planGetResult("discussion"),
      record: planRecord("discussion", { plannerThreadId: null }),
    };
    mocks.readDoc = { ...readDocResult, content: "# Plan\n" + "Step P1.\n".repeat(300) };
    await using screen = await renderDialog();
    const dialog = page.getByRole("dialog", { name: "Plan: Ship the board" });
    const scroll = dialog.element().querySelector<HTMLElement>("[data-slot=scroll-area-viewport]")!;
    scroll.style.height = "160px";
    scroll.style.overflowY = "auto";
    await expect.element(scroll).toHaveFocus();
    expect(scroll.scrollTop).toBe(0);
    const scrollFinished = new Promise<void>((resolve) => {
      scroll.addEventListener("scrollend", () => resolve(), { once: true });
    });
    await userEvent.keyboard("{PageDown}");
    await scrollFinished;
    expect(scroll.scrollTop).toBeGreaterThan(0);
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

    const refreshedSha = "b".repeat(64);
    mocks.readDoc = { ...readDocResult, sha256: refreshedSha, content: "Updated plan text" };
    await screen.rerender(
      <PlanViewerDialog
        environmentId={environmentId}
        cardId={cardId}
        title="Ship the board"
        onClose={() => {}}
      />,
    );
    await expect.element(screen.getByText("Updated plan text")).toBeVisible();

    (screen.getByRole("button", { name: "Plan accepted" }).element() as HTMLElement).click();

    expect(mocks.calls).toEqual([
      {
        label: "board.planAccept",
        input: { cardId, sha256: refreshedSha },
      },
    ]);
    await expect.element(screen.getByText("Accepted", { exact: true })).toBeVisible();
  });

  it("shows loading and errors for a replacement document without the previous text", async () => {
    setup({ state: "discussion" });
    await using screen = await renderDialog();
    await expect.element(screen.getByText(/# Plan/)).toBeVisible();
    mocks.planGet = {
      ...planGetResult("discussion"),
      doc: { stableId: "other-doc", name: "other.md" },
    };
    mocks.readDoc = null;
    mocks.readPending = true;
    const dialog = () => (
      <PlanViewerDialog
        environmentId={environmentId}
        cardId={cardId}
        title="Ship the board"
        onClose={() => {}}
      />
    );
    await screen.rerender(dialog());
    await expect.element(screen.getByRole("status")).toHaveTextContent("Loading plan…");
    await expect.element(screen.getByText(/# Plan/)).not.toBeInTheDocument();
    mocks.readPending = false;
    await screen.rerender(dialog());
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Could not load the plan document.");
    await expect.element(screen.getByRole("button", { name: "Plan accepted" })).toBeDisabled();
    mocks.readDoc = { ...readDocResult, stableId: "other-doc", content: "Replacement plan" };
    await screen.rerender(dialog());
    await expect.element(screen.getByText("Replacement plan")).toBeVisible();
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
          message: 'Plan for card "c" line 4: step ids must be unique. Fix the plan and try again.',
        }),
      ),
    );
    await using screen = await renderDialog();

    (screen.getByRole("button", { name: "Plan accepted" }).element() as HTMLElement).click();

    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent(
        'Plan for card "c" line 4: step ids must be unique. Fix the plan and try again.',
      );
    expect(mocks.refreshes).toEqual([]);
  });
});

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { BoardCardId } from "@t3tools/ft3-board/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../../apps/web/test/render";
import { PlanLineageRow } from "./PlanLineageRow.tsx";
import type { PinnedPlanRow } from "./planLineage.logic.ts";

it("shows the plan state and opens the planner thread", async () => {
  const row: PinnedPlanRow = {
    label: "discussing",
    plan: {
      cardId: BoardCardId.make("11111111-1111-4111-8111-111111111111"),
      title: "Ship the board",
      orchestratorThreadId: ThreadId.make("lead"),
      plannerThreadId: ThreadId.make("planner-thread"),
      state: "discussion",
      implementStarted: false,
    },
  };
  await using screen = await render(
    <ul>
      <PlanLineageRow environmentId={EnvironmentId.make("browser-env")} row={row} />
    </ul>,
  );

  await expect.element(screen.getByText("discussing", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: /Plan: Ship the board/ }).click();
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/browser-env/planner-thread"),
  );
});

it("keeps the accepted plan pinned until implementation starts", async () => {
  const row: PinnedPlanRow = {
    label: "accepted",
    plan: {
      cardId: BoardCardId.make("11111111-1111-4111-8111-111111111111"),
      title: "Ship the board",
      orchestratorThreadId: ThreadId.make("lead"),
      plannerThreadId: ThreadId.make("planner-thread"),
      state: "accepted",
      implementStarted: false,
    },
  };
  await using screen = await render(
    <ul>
      <PlanLineageRow environmentId={EnvironmentId.make("browser-env")} row={row} />
    </ul>,
  );

  await expect.element(screen.getByText("accepted", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /Plan: Ship the board/ })).toBeVisible();
});

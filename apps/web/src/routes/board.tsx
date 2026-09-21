import { createFileRoute, redirect } from "@tanstack/react-router";
import { ThreadId } from "@t3tools/contracts";

import { BoardPage } from "../components/board/BoardPage";

interface BoardSearch {
  readonly orchestrator?: ThreadId;
  readonly create?: boolean;
}

function BoardRoute() {
  const search = Route.useSearch();
  // Remount when the search target changes so a sidebar "Create task" deep
  // link lands in the right drill-down with its create form open.
  return (
    <BoardPage
      key={`${search.orchestrator ?? ""}:${search.create === true ? "create" : ""}`}
      initialOrchestratorId={search.orchestrator ?? null}
      createOnMount={search.create === true}
    />
  );
}

/**
 * The board needs the same app-shell gate the chat routes use, but it is a
 * root-level route like `/calendar`, so the guard lives here rather than in
 * `__root.tsx`.
 */
export const Route = createFileRoute("/board")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  validateSearch: (raw: Record<string, unknown>): BoardSearch => ({
    ...(typeof raw.orchestrator === "string" && raw.orchestrator.trim().length > 0
      ? { orchestrator: ThreadId.make(raw.orchestrator) }
      : {}),
    ...(raw.create === true || raw.create === "true" ? { create: true } : {}),
  }),
  component: BoardRoute,
});

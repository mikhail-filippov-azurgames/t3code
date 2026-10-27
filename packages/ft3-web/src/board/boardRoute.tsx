import { redirect, useSearch } from "@tanstack/react-router";
import { ThreadId } from "@t3tools/contracts";

import { BoardPage } from "./BoardPage";

export interface BoardSearch {
  readonly orchestrator?: ThreadId;
  readonly create?: boolean;
}

export function boardRouteSearch(raw: Record<string, unknown>): BoardSearch {
  return {
    ...(typeof raw.orchestrator === "string" && raw.orchestrator.trim().length > 0
      ? { orchestrator: ThreadId.make(raw.orchestrator) }
      : {}),
    ...(raw.create === true || raw.create === "true" ? { create: true } : {}),
  };
}

/**
 * The board needs the same app-shell gate the chat routes use, but it is a
 * root-level route, so the guard is passed to the route options from here.
 */
export function boardRouteBeforeLoad(input: {
  readonly context: { readonly authGateState: { readonly status: string } };
}): void {
  if (
    input.context.authGateState.status !== "authenticated" &&
    input.context.authGateState.status !== "hosted-static"
  ) {
    throw redirect({ to: "/pair", replace: true });
  }
}

export function BoardRouteView() {
  const search = useSearch({ from: "/board" });
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

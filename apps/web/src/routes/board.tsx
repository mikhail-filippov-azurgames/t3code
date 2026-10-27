import { createFileRoute } from "@tanstack/react-router";

import { BoardRouteView, boardRouteBeforeLoad, boardRouteSearch } from "@t3tools/ft3-web/board";

export const Route = createFileRoute("/board")({
  beforeLoad: boardRouteBeforeLoad,
  validateSearch: boardRouteSearch,
  component: BoardRouteView,
});

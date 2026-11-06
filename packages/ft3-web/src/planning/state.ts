import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "~/connection/runtime";
import { boardEnvironment } from "../board/state.ts";
import { createPlanningEnvironmentAtoms } from "./backend.ts";

export const planningEnvironment = createPlanningEnvironmentAtoms(connectionAtomRuntime, {
  refreshBoardLists: (environmentId, registry) =>
    Effect.sync(() => {
      registry.refresh(boardEnvironment.list({ environmentId, input: {} }));
      registry.refresh(boardEnvironment.list({ environmentId, input: { includeArchived: true } }));
      registry.refresh(
        boardEnvironment.listForChatPanel({ environmentId, input: { includeArchived: true } }),
      );
    }),
});

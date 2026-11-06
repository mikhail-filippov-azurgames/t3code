import type { EnvironmentId } from "@t3tools/contracts";
import { FT3_BOARD_WS_METHODS as BOARD_METHODS } from "@t3tools/ft3-board/rpc-contracts";
import { FT3_DOCS_WS_METHODS as DOCS_METHODS } from "@t3tools/ft3-docs/rpc-contracts";
import * as Effect from "effect/Effect";
import type { Atom, AtomRegistry } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";

export interface PlanningBoardRefresh {
  /** Re-reads the board card lists so the Lineage plan row label follows acceptance. */
  readonly refreshBoardLists: (
    environmentId: EnvironmentId,
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.Effect<void>;
}

export function createPlanningEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
  options: PlanningBoardRefresh,
) {
  const commandScheduler = createAtomCommandScheduler();
  const serial = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: EnvironmentId }) => environmentId,
  };

  return {
    planGet: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:planning:plan-get",
      tag: BOARD_METHODS.boardPlanGet,
      staleTimeMs: 15_000,
    }),
    readDoc: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:planning:read-doc",
      tag: DOCS_METHODS.docsRead,
      staleTimeMs: 15_000,
    }),
    planAccept: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:planning:plan-accept",
      tag: BOARD_METHODS.boardPlanAccept,
      scheduler: commandScheduler,
      concurrency: serial,
      onSuccess: ({ environmentId }, registry) =>
        options.refreshBoardLists(environmentId, registry),
    }),
  };
}

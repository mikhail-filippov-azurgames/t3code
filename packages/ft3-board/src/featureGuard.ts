/**
 * The board's entry-point guard: while the `board` feature is ineffective, MCP
 * tools and RPC refuse with the reason the Policies tab shows.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FeatureGate from "@t3tools/ft3-policies/server";

import * as Contracts from "./contracts.ts";

/** The guard closed over one gate instance, for handlers whose services are fixed. */
export const requireBoardWith = (
  gate: FeatureGate.FeatureGate["Service"],
  projectId?: string,
): Effect.Effect<void, Contracts.BoardMcpFailure> =>
  gate
    .require("board", projectId)
    .pipe(
      Effect.mapError(
        (error) =>
          new Contracts.BoardMcpFailure({ code: "feature_disabled", message: error.message }),
      ),
    );

/** Uses a resolved thread project, or the environment default when it is unavailable. */
export const requireBoardForThreadWith = Effect.fn("Ft3Board.requireForThread")(function* (
  gate: FeatureGate.FeatureGate["Service"],
  threadId?: string,
) {
  if (threadId === undefined) {
    yield* Effect.logDebug("Board feature check has no thread context; using environment setting");
    return yield* requireBoardWith(gate);
  }
  const projectId = Option.getOrUndefined(yield* FeatureGate.projectIdOfThread(threadId));
  if (projectId === undefined) {
    yield* Effect.logDebug(
      "Board feature check could not resolve thread project; using environment setting",
      {
        threadId,
      },
    );
  }
  return yield* requireBoardWith(gate, projectId);
});

/** The guard as an effect for RPC handlers, which may require the gate directly. */
export const requireBoard: Effect.Effect<void, Contracts.BoardMcpFailure, FeatureGate.FeatureGate> =
  Effect.gen(function* () {
    const gate = yield* FeatureGate.FeatureGate;
    yield* Effect.logDebug("Board feature check has no thread context; using environment setting");
    yield* requireBoardWith(gate);
  });

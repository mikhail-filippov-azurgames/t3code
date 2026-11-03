/**
 * The board's entry-point guard: while the `board` feature is ineffective, MCP
 * tools and RPC refuse with the reason the Policies tab shows.
 */
import * as Effect from "effect/Effect";
import * as FeatureGate from "@t3tools/ft3-policies/server";

import * as Contracts from "./contracts.ts";

/** The guard closed over one gate instance, for handlers whose services are fixed. */
export const requireBoardWith = (
  gate: FeatureGate.FeatureGate["Service"],
): Effect.Effect<void, Contracts.BoardMcpFailure> =>
  gate
    .require("board")
    .pipe(
      Effect.mapError(
        (error) =>
          new Contracts.BoardMcpFailure({ code: "feature_disabled", message: error.message }),
      ),
    );

/** The guard as an effect for RPC handlers, which may require the gate directly. */
export const requireBoard: Effect.Effect<void, Contracts.BoardMcpFailure, FeatureGate.FeatureGate> =
  Effect.gen(function* () {
    const gate = yield* FeatureGate.FeatureGate;
    yield* requireBoardWith(gate);
  });

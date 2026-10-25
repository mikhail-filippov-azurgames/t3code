import { assert, describe } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  materializeMuseReplayWorkspace,
  MuseOrchestratorReplayHarness,
} from "../Adapters/MuseAdapterV2.testkit.ts";
import { itRunsReplayFixtures, runReplayFixture } from "./ProviderReplayFixtures.ts";

describe("Muse replay fixtures", () => {
  itRunsReplayFixtures("muse", (input) =>
    runReplayFixture({
      ...input,
      harness: MuseOrchestratorReplayHarness,
      materializeWorkspace: materializeMuseReplayWorkspace,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          if (input.fixtureName !== "simple") return;
          const turns = [...result.projections.values()].flatMap(
            (projection) => projection.providerTurns,
          );
          assert.isTrue(turns.some((turn) => turn.status === "completed"));
          for (const turn of turns.filter((turn) => turn.status === "completed"))
            assert.strictEqual(turn.outputStatus, "unavailable");
        }),
      ),
    ),
  );
});

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../../../apps/server/src/serverSettings.ts";
import * as FeatureGate from "./FeatureGate.ts";

const gateLayer = (features: Readonly<Record<string, boolean>>) =>
  FeatureGate.layer.pipe(
    Layer.provideMerge(ServerSettings.layerTest({ ft3: { policies: { features } } })),
  );

describe("FeatureGate", () => {
  it.effect("answers on for a requested feature whose dependencies hold", () =>
    Effect.gen(function* () {
      const gate = yield* FeatureGate.FeatureGate;
      const board = yield* gate.state("board");

      assert.isTrue(board.requestedEnabled);
      assert.isTrue(board.effectiveEnabled);
      assert.isNull(board.offReason);
      assert.isTrue(yield* gate.isEffective("board"));
      yield* gate.require("board");
    }).pipe(Effect.provide(gateLayer({ board: true, roles: true }))),
  );

  it.effect("answers off and refuses a feature that was requested off", () =>
    Effect.gen(function* () {
      const gate = yield* FeatureGate.FeatureGate;
      const board = yield* gate.state("board");

      assert.isFalse(board.requestedEnabled);
      assert.isFalse(board.effectiveEnabled);
      assert.isNull(board.offReason);

      const error = yield* gate.require("board").pipe(Effect.flip);
      assert.equal(error.code, "feature_disabled");
      assert.equal(error.message, "board is off. Open Settings → Policies.");
    }).pipe(Effect.provide(gateLayer({ board: false }))),
  );

  it.effect("answers dependency-off and refuses with the dependency's name", () =>
    Effect.gen(function* () {
      const gate = yield* FeatureGate.FeatureGate;
      const planning = yield* gate.state("planning");

      assert.isTrue(planning.requestedEnabled);
      assert.isFalse(planning.effectiveEnabled);
      assert.deepStrictEqual(planning.offReason, {
        code: "feature_dependency_off",
        dependency: "mail",
      });
      assert.isFalse(yield* gate.isEffective("planning"));

      const error = yield* gate.require("planning").pipe(Effect.flip);
      assert.equal(error.code, "feature_dependency_off");
      assert.equal(error.dependency, "mail");
      assert.equal(error.message, "planning is off because mail is off.");
    }).pipe(Effect.provide(gateLayer({ planning: true, mail: false }))),
  );

  it.effect("reads the toggles from the live settings on every call", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const gate = yield* FeatureGate.FeatureGate;

      assert.isTrue(yield* gate.isEffective("board"));
      yield* settings
        .updateSettings({
          ft3: { policies: { features: { board: false } } },
        })
        .pipe(Effect.orDie);
      assert.isFalse(yield* gate.isEffective("board"));
    }).pipe(Effect.provide(gateLayer({}))),
  );
});

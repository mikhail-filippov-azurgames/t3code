import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../../../apps/server/src/serverSettings.ts";
import * as FeatureGate from "./FeatureGate.ts";
import { type PolicySnapshot, PolicyChangeTracker } from "./policyChangeTracker.ts";

const gateLayer = (features: Readonly<Record<string, boolean>>) =>
  FeatureGate.layer.pipe(
    Layer.provideMerge(ServerSettings.layerTest({ ft3: { policies: { features } } })),
  );

const trackerWithRequirements = (
  requirements: PolicySnapshot["requirements"],
): Layer.Layer<PolicyChangeTracker> =>
  Layer.succeed(
    PolicyChangeTracker,
    PolicyChangeTracker.of({
      refresh: () => Effect.die("unused in the gate tests"),
      snapshot: () => Effect.succeed({ configVersion: 1, documents: [], requirements }),
      applied: () => Effect.succeed(null),
      pendingChange: () => Effect.succeed(null),
      live: () => Effect.succeed(null),
    }),
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

  it.effect("accounts for requirement validity and refuses with the document off-reason", () =>
    Effect.gen(function* () {
      const gate = yield* FeatureGate.FeatureGate;
      const mail = yield* gate.state("mail");

      assert.isTrue(mail.requestedEnabled);
      assert.isFalse(mail.effectiveEnabled);
      assert.deepStrictEqual(mail.offReason, {
        code: "feature_document_off",
        requirement: "routingPolicy",
      });
      assert.isFalse(yield* gate.isEffective("mail"));

      const error = yield* gate.require("mail").pipe(Effect.flip);
      assert.equal(error.code, "feature_document_off");
      assert.equal(error.requirement, "routingPolicy");
    }).pipe(
      Effect.provide(
        gateLayer({ mail: true, board: true, delegation: true, roles: true }).pipe(
          Layer.provideMerge(
            trackerWithRequirements({
              rolesManifest: true,
              leadSkills: true,
              leadRole: true,
              routingPolicy: false,
              requestedRoles: true,
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("keeps a feature effective when its requirements are valid", () =>
    Effect.gen(function* () {
      const gate = yield* FeatureGate.FeatureGate;
      const mail = yield* gate.state("mail");

      assert.isTrue(mail.effectiveEnabled);
      assert.isNull(mail.offReason);
      yield* gate.require("mail");
    }).pipe(
      Effect.provide(
        gateLayer({ mail: true, board: true, delegation: true, roles: true }).pipe(
          Layer.provideMerge(
            trackerWithRequirements({
              routingPolicy: true,
              requestedRoles: true,
              rolesManifest: true,
              leadSkills: true,
              leadRole: true,
            }),
          ),
        ),
      ),
    ),
  );
});

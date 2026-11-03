import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layerMemory as policyAppliedStoreLayer } from "./policyAppliedStore.ts";
import {
  PolicyChangeTracker,
  type PolicySnapshot,
  appliedRoutingPolicyRef,
  layer as policyChangeTrackerLayer,
  withRefreshHook,
} from "./policyChangeTracker.ts";
import { layer as policyDocumentLoaderLayer } from "./policyDocumentLoader.ts";
import { memoryPolicyDocumentPort } from "./policyDocuments.testkit.ts";

const ROLES_MANIFEST_PATH = "policies/roles/roles.json";

const manifest = (revision: number): string =>
  [
    "{",
    '  "schema": "corvis-role-map-v1",',
    `  "revision": ${revision},`,
    '  "configured": true,',
    '  "roles": [ { "id": "lead", "roleId": "lead", "file": "lead.md" } ]',
    "}",
    "",
  ].join("\n");

const leadFile = [
  "---",
  "schema: corvis-role-v1",
  "roleId: lead",
  "revision: 1",
  "configured: true",
  "---",
  "",
  "# Lead",
  "",
].join("\n");

const files = (revision: number): ReadonlyMap<string, string> =>
  new Map([
    [ROLES_MANIFEST_PATH, manifest(revision)],
    ["policies/roles/lead.md", leadFile],
  ]);

const trackerLayerFor = (store: ReadonlyMap<string, string>) =>
  policyChangeTrackerLayer.pipe(
    Layer.provide(policyDocumentLoaderLayer(memoryPolicyDocumentPort(store))),
    Layer.provide(policyAppliedStoreLayer),
  );

const rolesSources = {
  routingPolicy: { kind: "builtin" },
  roles: { kind: "doc", address: { kind: "path", relPath: ROLES_MANIFEST_PATH } },
  leadSkills: { kind: "builtin" },
} as const;

describe("PolicyChangeTracker refresh hook", () => {
  it.effect("runs the hook after every refresh, seeing the version it just published", () => {
    const store = new Map(files(1));
    const seen: Array<number | null> = [];
    const hooked = withRefreshHook((tracker) =>
      Effect.gen(function* () {
        const applied = yield* tracker.applied("roles");
        seen.push(applied?.revision ?? null);
      }),
    ).pipe(Layer.provide(trackerLayerFor(store)));
    return Effect.gen(function* () {
      const tracker = yield* PolicyChangeTracker;
      const input = { sources: rolesSources, features: { board: true }, applyExternalEdits: true };
      yield* tracker.refresh(input);
      store.set(ROLES_MANIFEST_PATH, manifest(2));
      yield* tracker.refresh(input);
      assert.deepEqual(seen, [1, 2]);
    }).pipe(Effect.provide(hooked));
  });
});

const NIL_ID = "00000000-0000-0000-0000-000000000000";

const storeRoutingTracker = (applied: boolean) =>
  Layer.succeed(
    PolicyChangeTracker,
    PolicyChangeTracker.of({
      refresh: () => Effect.die("unused"),
      snapshot: () =>
        Effect.succeed({
          configVersion: 1,
          requirements: {},
          documents: [
            {
              key: "routingPolicy",
              source: { kind: "doc", address: { kind: "id", stableId: NIL_ID } },
              configured: true,
              applied: applied
                ? { revision: 1, sha256: "0".repeat(64), appliedAt: "2026-11-03T00:00:00.000Z" }
                : null,
              seen: null,
              errors: [],
              warnings: [],
              kept: false,
              pending: false,
            },
          ],
        } satisfies PolicySnapshot),
      applied: () => Effect.succeed(null),
      pendingChange: () => Effect.succeed(null),
      live: () => Effect.succeed(null),
    }),
  );

describe("appliedRoutingPolicyRef", () => {
  it.effect("links the applied routing policy served from the store by its id", () =>
    Effect.gen(function* () {
      assert.equal(yield* appliedRoutingPolicyRef, `oc://doc/${NIL_ID}`);
    }).pipe(Effect.provide(storeRoutingTracker(true))),
  );

  it.effect("is empty while the store routing policy has no applied version", () =>
    Effect.gen(function* () {
      assert.equal(yield* appliedRoutingPolicyRef, "");
    }).pipe(Effect.provide(storeRoutingTracker(false))),
  );

  it.effect("is empty while no tracker runs", () =>
    Effect.gen(function* () {
      assert.equal(yield* appliedRoutingPolicyRef, "");
    }),
  );

  it.effect("is empty while the routing policy is builtin", () =>
    Effect.gen(function* () {
      const tracker = yield* PolicyChangeTracker;
      yield* tracker.refresh({ sources: rolesSources, features: { board: true } });
      assert.equal(yield* appliedRoutingPolicyRef, "");
    }).pipe(Effect.provide(trackerLayerFor(new Map(files(1))))),
  );
});

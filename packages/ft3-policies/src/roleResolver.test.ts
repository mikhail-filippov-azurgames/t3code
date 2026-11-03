import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { PolicyDocumentSource } from "./contracts.ts";
import { PolicyChangeTracker, layer as policyChangeTrackerLayer } from "./policyChangeTracker.ts";
import { layer as policyDocumentLoaderLayer } from "./policyDocumentLoader.ts";
import { memoryPolicyDocumentPort } from "./policyDocuments.testkit.ts";
import {
  RoleResolutionError,
  RoleResolver,
  layer as roleResolverLayer,
  roleInstructionLine,
} from "./roleResolver.ts";

const ROLES_MANIFEST_PATH = "policies/roles/roles.json";
const ROLES_FOLDER = "policies/roles";

const manifest = (revision: number): string =>
  [
    "{",
    '  "schema": "corvis-role-map-v1",',
    `  "revision": ${revision},`,
    '  "configured": true,',
    '  "roles": [',
    '    { "id": "lead", "roleId": "lead", "file": "lead.md" },',
    '    { "id": "general", "roleId": "general", "file": "general.md", "upstreamRole": "general" },',
    '    { "id": "architect", "roleId": "architect", "file": "architect.md", "upstreamRole": "architecture" },',
    '    { "id": "review", "roleId": "review-common", "file": "review-common.md", "upstreamRole": "review" }',
    "  ]",
    "}",
    "",
  ].join("\n");

const roleFile = (roleId: string, body: string): string =>
  [
    "---",
    "schema: corvis-role-v1",
    `roleId: ${roleId}`,
    "revision: 1",
    "configured: true",
    "---",
    "",
    body,
    "",
  ].join("\n");

const store = (): Map<string, string> =>
  new Map([
    [ROLES_MANIFEST_PATH, manifest(4)],
    [`${ROLES_FOLDER}/lead.md`, roleFile("lead", "# Lead\n\nOwn the board.")],
    [`${ROLES_FOLDER}/general.md`, roleFile("general", "# General\n\nDo the bounded work.")],
    [`${ROLES_FOLDER}/architect.md`, roleFile("architect", "# Architect\n\nAdvise once.")],
    [`${ROLES_FOLDER}/review-common.md`, roleFile("review-common", "# Review\n\nFind defects.")],
  ]);

const sources = {
  routingPolicy: { kind: "builtin" },
  roles: { kind: "doc", address: { kind: "path", relPath: ROLES_MANIFEST_PATH } },
  leadSkills: { kind: "builtin" },
} satisfies Readonly<Record<"routingPolicy" | "roles" | "leadSkills", PolicyDocumentSource>>;

const trackerLayerFor = (files: ReadonlyMap<string, string>) =>
  policyChangeTrackerLayer.pipe(
    Layer.provide(policyDocumentLoaderLayer(memoryPolicyDocumentPort(files))),
  );

const layerFor = (files: ReadonlyMap<string, string>) =>
  Layer.mergeAll(roleResolverLayer, trackerLayerFor(files));

const applyRoles = Effect.gen(function* () {
  const tracker = yield* PolicyChangeTracker;
  return yield* tracker.refresh({ sources, features: { board: true } });
});

const withRoles = <A, E>(
  files: ReadonlyMap<string, string>,
  use: Effect.Effect<A, E, RoleResolver | PolicyChangeTracker>,
) =>
  Effect.gen(function* () {
    yield* applyRoles;
    return yield* use;
  }).pipe(Effect.provide(layerFor(files)));

const resolveFailure = (role: string) =>
  Effect.gen(function* () {
    const resolver = yield* RoleResolver;
    return yield* Effect.flip(resolver.resolve(role));
  });

describe("RoleResolver applied roles", () => {
  it.effect("resolves a declared role to its applied instruction", () =>
    withRoles(
      store(),
      Effect.gen(function* () {
        const resolver = yield* RoleResolver;
        const reviewer = yield* resolver.resolve("review-contracts");
        assert.equal(reviewer.id, "review");
        assert.equal(reviewer.roleId, "review-common");
        assert.equal(reviewer.upstreamRole, "review");
        assert.equal(reviewer.revision, 4);
        assert.include(reviewer.instruction, "Find defects.");
        assert.equal(
          roleInstructionLine(reviewer),
          "Your role is review-common. Follow this role instruction before any work.\n\n# Review\n\nFind defects.",
        );
      }),
    ),
  );

  it.effect("resolves the architecture alias to the architect role", () =>
    withRoles(
      store(),
      Effect.gen(function* () {
        const resolver = yield* RoleResolver;
        const architect = yield* resolver.resolve("architecture");
        assert.equal(architect.roleId, "architect");
        assert.include(architect.instruction, "Advise once.");
      }),
    ),
  );

  it.effect("reports an unknown role as a typed error with the declared names", () =>
    withRoles(
      store(),
      resolveFailure("nobody").pipe(
        Effect.map((error) => {
          assert.instanceOf(error, RoleResolutionError);
          assert.equal(error.code, "unknown_role");
          assert.equal(error.rolesConfigured, true);
          assert.deepStrictEqual(error.available, ["architect", "general", "lead", "review"]);
          assert.equal(
            error.message,
            'Role "nobody" has no entry in the applied roles document. Available roles: architect, general, lead, review.',
          );
        }),
      ),
    ),
  );

  it.effect("serves the newly applied version after a role changes", () => {
    const files = store();
    return withRoles(
      files,
      Effect.gen(function* () {
        const resolver = yield* RoleResolver;
        const tracker = yield* PolicyChangeTracker;
        assert.include((yield* resolver.resolve("general")).instruction, "bounded work");

        files.set(`${ROLES_FOLDER}/general.md`, roleFile("general", "# General\n\nOwn the wave."));
        files.set(ROLES_MANIFEST_PATH, manifest(5));
        yield* tracker.refresh({ sources, features: { board: true } });

        const updated = yield* resolver.resolve("general");
        assert.equal(updated.revision, 5);
        assert.include(updated.instruction, "Own the wave.");
      }),
    );
  });

  it.effect("keeps the previous applied role while the new role document is invalid", () => {
    const files = store();
    return withRoles(
      files,
      Effect.gen(function* () {
        const resolver = yield* RoleResolver;
        const tracker = yield* PolicyChangeTracker;
        yield* applyRoles;

        files.set(
          `${ROLES_FOLDER}/general.md`,
          roleFile("not-a-role", "# General\n\nOwn the wave."),
        );
        files.set(ROLES_MANIFEST_PATH, manifest(5));
        const snapshot = yield* tracker.refresh({ sources, features: { board: true } });

        const status = snapshot.documents.find((document) => document.key === "roles");
        assert.equal(status?.kept, true);
        assert.equal(status?.applied?.revision, 4);
        const kept = yield* resolver.resolve("general");
        assert.equal(kept.revision, 4);
        assert.include(kept.instruction, "bounded work");
      }),
    );
  });

  it.effect("starts the lead brief with the applied lead instruction", () =>
    withRoles(
      store(),
      Effect.gen(function* () {
        const resolver = yield* RoleResolver;
        assert.equal(
          yield* resolver.leadLine,
          "Your role is lead. Follow this role instruction before any work.\n\n# Lead\n\nOwn the board.",
        );
      }),
    ),
  );

  it.effect("serves roles off and keeps the upstream role while nothing is applied", () =>
    Effect.gen(function* () {
      const resolver = yield* RoleResolver;
      assert.deepStrictEqual(yield* resolver.assignment(undefined), {
        _tag: "off",
        role: undefined,
      });
      assert.deepStrictEqual(yield* resolver.assignment("review"), { _tag: "off", role: "review" });
      assert.equal(yield* resolver.leadLine, "");

      const rejected = yield* resolver.assignment("lead");
      assert.equal(rejected._tag, "rejected");
      assert.equal(rejected._tag === "rejected" ? rejected.error.code : "", "unknown_role");
      assert.equal(rejected._tag === "rejected" ? rejected.error.rolesConfigured : true, false);
      assert.include(
        rejected._tag === "rejected" ? rejected.message : "",
        "needs a configured roles document",
      );
    }).pipe(Effect.provide(roleResolverLayer)),
  );

  it.effect("defaults to general and rejects an undeclared name while roles are on", () =>
    withRoles(
      store(),
      Effect.gen(function* () {
        const resolver = yield* RoleResolver;
        const assignment = yield* resolver.assignment(undefined);
        assert.equal(assignment._tag, "assigned");
        assert.equal(assignment._tag === "assigned" ? assignment.role : "", "general");
        assert.equal(assignment._tag === "assigned" ? assignment.resolved.roleId : "", "general");

        const specialisation = yield* resolver.assignment("architect-data");
        assert.equal(specialisation._tag, "assigned");
        assert.equal(
          specialisation._tag === "assigned" ? specialisation.resolved.roleId : "",
          "architect",
        );

        const rejected = yield* resolver.assignment("design");
        assert.equal(rejected._tag, "rejected");
        assert.equal(rejected._tag === "rejected" ? rejected.error.code : "", "unknown_role");
        assert.include(rejected._tag === "rejected" ? rejected.message : "", "design");
      }),
    ),
  );
});

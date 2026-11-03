// @effect-diagnostics nodeBuiltinImport:off - the test writes a roles tree into a temporary directory.
import { DocsService } from "@t3tools/ft3-docs/server";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ServerSettings from "../../../apps/server/src/serverSettings.ts";
import { ROLES_DIR_ENV } from "./envMigration.ts";
import { layerMemory as policyAppliedStoreLayer } from "./policyAppliedStore.ts";
import { layer as policyChangeTrackerLayer } from "./policyChangeTracker.ts";
import {
  docsPolicyDocumentReadPort,
  layer as policyDocumentLoaderLayer,
} from "./policyDocumentLoader.ts";
import { RoleResolver, layer as roleResolverLayer, roleInstructionLine } from "./roleResolver.ts";
import { refreshAppliedPolicies } from "./rpc.ts";
import { readPolicySettings } from "./settings.ts";

// Startup must not read the developer's shell: each case sets its own value.
delete process.env[ROLES_DIR_ENV];

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

const makeRolesDir = (): string => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ft3-applied-roles-"));
  NodeFS.writeFileSync(
    NodePath.join(dir, "roles.json"),
    [
      "{",
      '  "schema": "corvis-role-map-v1",',
      '  "revision": 3,',
      '  "configured": true,',
      '  "roles": [',
      '    { "id": "lead", "roleId": "lead", "file": "lead.md" },',
      '    { "id": "general", "roleId": "general", "file": "general.md" }',
      "  ]",
      "}",
      "",
    ].join("\n"),
  );
  NodeFS.writeFileSync(NodePath.join(dir, "lead.md"), roleFile("lead", "Lead body."));
  NodeFS.writeFileSync(NodePath.join(dir, "general.md"), roleFile("general", "General body."));
  return dir.replace(/\\/g, "/");
};

const docsFake = DocsService.of({
  list: () => Effect.die("unused"),
  manifest: () => Effect.die("unused"),
  read: () => Effect.die("unused"),
  resolve: () => Effect.die("unused"),
  search: () => Effect.die("unused"),
  write: () => Effect.die("unused"),
  writeAsHuman: () => Effect.die("unused"),
  // An unmanaged roles directory migrates to a plain path source.
  locateServerPath: () => Effect.succeed(null),
  setDescription: () => Effect.die("unused"),
  docRef: () => Effect.die("unused"),
});

const services = Layer.mergeAll(
  policyChangeTrackerLayer.pipe(
    Layer.provide(policyDocumentLoaderLayer(docsPolicyDocumentReadPort(docsFake))),
    Layer.provide(policyAppliedStoreLayer),
  ),
  roleResolverLayer,
  Layer.succeed(DocsService, docsFake),
  ServerSettings.layerTest(),
);

const withRolesDir = <A, E, R>(dir: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const previous = process.env[ROLES_DIR_ENV];
    process.env[ROLES_DIR_ENV] = dir;
    try {
      return yield* effect;
    } finally {
      if (previous === undefined) delete process.env[ROLES_DIR_ENV];
      else process.env[ROLES_DIR_ENV] = previous;
    }
  });

describe("applied policies at server startup", () => {
  it.effect("folds T3CODE_FT3_ROLES_DIR in and serves its roles before any Policies call", () => {
    const dir = makeRolesDir();
    return withRolesDir(
      dir,
      Effect.gen(function* () {
        yield* refreshAppliedPolicies;

        const roles = yield* RoleResolver;
        const assignment = yield* roles.assignment(undefined);
        assert.equal(assignment._tag, "assigned");
        if (assignment._tag === "assigned") {
          assert.equal(assignment.resolved.roleId, "general");
          assert.equal(
            roleInstructionLine(assignment.resolved),
            "Your role is general. Follow this role instruction before any work.\n\nGeneral body.",
          );
        }
        assert.include(yield* roles.leadLine, "Lead body.");

        const settings = yield* ServerSettings.ServerSettingsService;
        assert.deepStrictEqual(
          readPolicySettings((yield* settings.getSettings).ft3).documents.roles,
          { kind: "path", path: NodePath.resolve(dir, "roles.json") },
        );
      }).pipe(Effect.provide(services)),
    );
  });

  it.effect("keeps the migrated roles on the next refresh", () => {
    const dir = makeRolesDir();
    return withRolesDir(
      dir,
      Effect.gen(function* () {
        yield* refreshAppliedPolicies;
        yield* refreshAppliedPolicies;

        const roles = yield* RoleResolver;
        const assignment = yield* roles.assignment("general");
        assert.equal(assignment._tag, "assigned");
        if (assignment._tag === "assigned") {
          assert.equal(assignment.resolved.instruction, "\nGeneral body.\n");
          assert.equal(assignment.resolved.revision, 3);
        }
      }).pipe(Effect.provide(services)),
    );
  });

  it.effect("leaves roles off when neither settings nor the environment configure them", () => {
    const previous = process.env[ROLES_DIR_ENV];
    delete process.env[ROLES_DIR_ENV];
    return Effect.gen(function* () {
      yield* refreshAppliedPolicies;
      const roles = yield* RoleResolver;
      assert.deepStrictEqual(yield* roles.assignment(undefined), { _tag: "off", role: undefined });
      assert.equal(yield* roles.leadLine, "");
    }).pipe(
      Effect.provide(services),
      Effect.ensuring(
        Effect.sync(() => {
          if (previous !== undefined) process.env[ROLES_DIR_ENV] = previous;
        }),
      ),
    );
  });
});

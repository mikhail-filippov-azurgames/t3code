// @effect-diagnostics nodeBuiltinImport:off - the legacy roles directory is a real directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { POLICY_ENV_MIGRATION_VERSION, DEFAULT_POLICY_SETTINGS } from "./settings.ts";
import {
  ROLES_DIR_ENV,
  ROUTING_POLICY_REF_ENV,
  type PolicyEnvDocsPort,
  migratePolicyEnvironment,
} from "./envMigration.ts";

// The repository never carries real document ids; tests use the nil UUID.
const NIL_ID = "00000000-0000-0000-0000-000000000000";

const rolesDirectory = (): string => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ft3-policy-env-"));
  NodeFS.writeFileSync(NodePath.join(directory, "roles.json"), "{}", "utf8");
  NodeFS.mkdirSync(NodePath.join(directory, "skills", "lead"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(directory, "skills", "lead", "lead-skills.json"),
    "{}",
    "utf8",
  );
  return directory;
};

const docsPort = (
  inside: Readonly<Record<string, { relPath: string; stableId: string | null }>> = {},
  ids: readonly string[] = [],
): PolicyEnvDocsPort => ({
  locateServerPath: (absolutePath) => Effect.succeed(inside[absolutePath] ?? null),
  docRef: (ref) => Effect.succeed(ids.includes(ref) ? { stableId: NIL_ID } : null),
});

describe("policy env migration", () => {
  it.effect("moves the roles directory and an oc:// routing reference into settings", () => {
    const roles = rolesDirectory();
    const routingRef = `oc://doc/${NIL_ID}`;
    return Effect.gen(function* () {
      const result = yield* migratePolicyEnvironment({
        settings: DEFAULT_POLICY_SETTINGS,
        docs: docsPort(
          {
            [NodePath.join(roles, "roles.json")]: {
              relPath: "policies/roles/roles.json",
              stableId: NIL_ID,
            },
            [NodePath.join(roles, "skills", "lead", "lead-skills.json")]: {
              relPath: "policies/roles/skills/lead/lead-skills.json",
              stableId: null,
            },
          },
          [routingRef],
        ),
        environment: { [ROLES_DIR_ENV]: roles, [ROUTING_POLICY_REF_ENV]: routingRef },
      });

      assert.isTrue(result.changed);
      assert.deepStrictEqual(result.warnings, []);
      assert.equal(result.settings.envMigration, POLICY_ENV_MIGRATION_VERSION);
      assert.deepStrictEqual(result.settings.documents.routingPolicy, {
        kind: "doc",
        address: { kind: "id", stableId: NIL_ID },
      });
      assert.deepStrictEqual(result.settings.documents.roles, {
        kind: "doc",
        address: { kind: "id", stableId: NIL_ID },
      });
      assert.deepStrictEqual(result.settings.documents.leadSkills, {
        kind: "doc",
        address: {
          kind: "path",
          relPath: "policies/roles/skills/lead/lead-skills.json",
        },
      });
    });
  });

  it.effect("keeps a roles directory outside the store as a server path", () => {
    const roles = rolesDirectory();
    return Effect.gen(function* () {
      const result = yield* migratePolicyEnvironment({
        settings: DEFAULT_POLICY_SETTINGS,
        docs: docsPort(),
        environment: { [ROLES_DIR_ENV]: roles },
      });

      assert.equal(result.settings.documents.roles.kind, "path");
      assert.equal(
        result.settings.documents.roles.kind === "path" ? result.settings.documents.roles.path : "",
        NodePath.resolve(roles, "roles.json"),
      );
      assert.equal(result.settings.documents.leadSkills.kind, "path");
    });
  });

  it.effect("warns and keeps the builtin template when the ref does not resolve", () => {
    return Effect.gen(function* () {
      const result = yield* migratePolicyEnvironment({
        settings: DEFAULT_POLICY_SETTINGS,
        docs: docsPort(),
        environment: {
          [ROUTING_POLICY_REF_ENV]: `oc://doc/${NIL_ID}`,
        },
      });

      assert.deepStrictEqual(result.settings.documents.routingPolicy, { kind: "builtin" });
      assert.deepStrictEqual(
        result.warnings.map((issue) => issue.code),
        ["legacy_policy_ref_unresolved"],
      );
      assert.equal(result.warnings[0]?.severity, "warning");
    });
  });

  it.effect("lets explicit settings win over the environment", () => {
    const roles = rolesDirectory();
    const explicit = {
      ...DEFAULT_POLICY_SETTINGS,
      documents: {
        ...DEFAULT_POLICY_SETTINGS.documents,
        roles: { kind: "path" as const, path: NodePath.join(roles, "chosen.json") },
      },
    };
    return Effect.gen(function* () {
      const result = yield* migratePolicyEnvironment({
        settings: explicit,
        docs: docsPort(),
        environment: { [ROLES_DIR_ENV]: roles },
      });

      assert.deepStrictEqual(result.settings.documents.roles, {
        kind: "path",
        path: NodePath.join(roles, "chosen.json"),
      });
    });
  });

  it.effect("runs once: the marker makes later starts ignore both variables", () => {
    const roles = rolesDirectory();
    return Effect.gen(function* () {
      const first = yield* migratePolicyEnvironment({
        settings: DEFAULT_POLICY_SETTINGS,
        docs: docsPort(),
        environment: { [ROLES_DIR_ENV]: roles },
      });
      const second = yield* migratePolicyEnvironment({
        settings: first.settings,
        docs: docsPort(),
        environment: {
          [ROLES_DIR_ENV]: NodePath.join(roles, "changed"),
          [ROUTING_POLICY_REF_ENV]: `oc://doc/${NIL_ID}`,
        },
      });

      assert.isFalse(second.changed);
      assert.deepStrictEqual(second.settings, first.settings);
      assert.deepStrictEqual(second.warnings, []);
    });
  });
});

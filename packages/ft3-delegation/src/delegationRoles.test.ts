import { assert, describe, it } from "@effect/vitest";
// @effect-diagnostics nodeBuiltinImport:off - tests write role files into a temporary directory.
import { t3OrchestrationSystemPrompt } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  availableRoles,
  coordinatorBriefRoleLine,
  delegatedRoleAssignment,
  delegatedTaskPrompt,
  ROLES_DIR_ENV,
  roleInstructionLine,
  rolesDir,
  startupRoleConfiguration,
  UPSTREAM_ROLE_IDS,
} from "./delegationRoles.ts";

const makeRolesDir = (roles: ReadonlyArray<string>): string => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ft3-roles-"));
  for (const role of roles) NodeFS.writeFileSync(NodePath.join(dir, `${role}.md`), role);
  return dir;
};

const readDir = (env: Record<string, string> = {}) =>
  rolesDir.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))));

describe("ft3 delegation roles", () => {
  it("leaves the prompt untouched while roles are off", () => {
    const upstreamPrompt = "Act as the review sub-agent for this task.\n\nReview it.";
    assert.deepStrictEqual(delegatedRoleAssignment(undefined, ""), {
      _tag: "off",
      role: undefined,
    });
    assert.deepStrictEqual(delegatedRoleAssignment("review", ""), { _tag: "off", role: "review" });
    assert.equal(
      delegatedTaskPrompt({
        role: "review",
        rolesDir: "",
        task: "Review it.",
        upstreamPrompt,
      }),
      upstreamPrompt,
    );
  });

  it("rejects a role id that only exists once roles are configured", () => {
    const assignment = delegatedRoleAssignment("lead", "");
    assert.equal(assignment._tag, "rejected");
    assert.include(assignment._tag === "rejected" ? assignment.message : "", ROLES_DIR_ENV);
    for (const role of UPSTREAM_ROLE_IDS) {
      assert.equal(delegatedRoleAssignment(role, "")._tag, "off");
    }
  });

  it.effect("keeps the roles directory empty when the setting is absent", () =>
    Effect.gen(function* () {
      assert.equal(yield* readDir(), "");
      assert.equal(yield* readDir({ [ROLES_DIR_ENV]: "   " }), "");
    }),
  );

  it.effect("fails startup when the roles directory does not exist", () =>
    Effect.gen(function* () {
      const missing = NodePath.join(NodeOS.tmpdir(), "t3-ft3-roles-missing-dir");
      const exit = yield* Effect.exit(readDir({ [ROLES_DIR_ENV]: missing }));
      assert.equal(exit._tag, "Failure");
      const message = exit._tag === "Failure" ? Cause.pretty(exit.cause) : "";
      assert.include(message, ROLES_DIR_ENV);
      assert.include(message, "not an existing directory");
    }),
  );

  it("defaults a missing role to general and puts the role line first", () => {
    const dir = makeRolesDir(["general", "lead"]);
    const assignment = delegatedRoleAssignment(undefined, dir);
    assert.deepStrictEqual(assignment, { _tag: "assigned", role: "general" });
    const prompt = delegatedTaskPrompt({
      role: assignment._tag === "assigned" ? assignment.role : undefined,
      rolesDir: dir,
      task: "Fix the parser.",
      upstreamPrompt: "Fix the parser.",
    });
    assert.isTrue(prompt.startsWith(`${roleInstructionLine("general", dir)}\n\n`));
    assert.include(prompt, "Fix the parser.");
  });

  it("starts a given role's prompt with that role's instruction", () => {
    const dir = makeRolesDir(["general", "lead", "review-architecture"]);
    const assignment = delegatedRoleAssignment("review-architecture", dir);
    assert.deepStrictEqual(assignment, { _tag: "assigned", role: "review-architecture" });
    const prompt = delegatedTaskPrompt({
      role: "review-architecture",
      rolesDir: dir,
      task: "Check the boundaries.",
      upstreamPrompt: "unused",
    });
    assert.isTrue(prompt.startsWith(`${roleInstructionLine("review-architecture", dir)}\n\n`));
    assert.include(prompt, `${dir.replace(/\\/g, "/")}/review-architecture.md`);
    assert.notInclude(prompt, "\\");
    assert.notInclude(prompt, "Act as the");
  });

  it("rejects a role without a file and lists the available roles", () => {
    const dir = makeRolesDir(["general", "lead", "review-contracts"]);
    const assignment = delegatedRoleAssignment("architect-data", dir);
    assert.equal(assignment._tag, "rejected");
    const message = assignment._tag === "rejected" ? assignment.message : "";
    assert.include(message, "architect-data.md");
    assert.include(message, "lead");
    assert.include(message, "review-contracts");
    assert.deepStrictEqual(availableRoles(dir), ["general", "lead", "review-contracts"]);
  });

  it("starts the coordinator brief with the lead instruction", () => {
    const dir = makeRolesDir(["lead"]);
    assert.equal(coordinatorBriefRoleLine(""), "");
    assert.equal(
      coordinatorBriefRoleLine(dir),
      `Your role is lead. Before any work, read the whole file ${dir.replace(/\\/g, "/")}/lead.md and follow it.`,
    );
  });

  it.effect("drops the native-subagent guidance only while roles are configured", () =>
    Effect.gen(function* () {
      const unconfigured = t3OrchestrationSystemPrompt(true, false) ?? "";
      assert.include(unconfigured, "- Subagents: use your native tool");

      const dir = makeRolesDir(["general"]);
      yield* startupRoleConfiguration.pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { [ROLES_DIR_ENV]: dir } })),
        ),
      );
      const configured = t3OrchestrationSystemPrompt(true, false) ?? "";
      assert.notInclude(configured, "- Subagents: use your native tool");
      assert.include(configured, "`delegate_task`");

      yield* startupRoleConfiguration.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
      );
      assert.include(
        t3OrchestrationSystemPrompt(true, false) ?? "",
        "- Subagents: use your native tool",
      );
    }),
  );
});

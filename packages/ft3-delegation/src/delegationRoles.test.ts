import { assert, describe, it } from "@effect/vitest";
// @effect-diagnostics nodeBuiltinImport:off - tests write role files into a temporary directory.
import { t3OrchestrationSystemPrompt } from "@t3tools/provider-core/server/orchestrationInstructions";
import { docsBriefBlock, setDocumentsBriefEnabled } from "@t3tools/ft3-docs/brief";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  delegatedTaskPrompt,
  ROLES_DIR_ENV,
  rolesDir,
  startupRoleConfiguration,
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
    assert.equal(
      delegatedTaskPrompt({ roleLine: "", task: "Review it.", upstreamPrompt }),
      upstreamPrompt,
    );
  });

  it("puts the applied role line before the task while roles are on", () => {
    const roleLine = "Your role is review-common. Follow this role instruction before any work.";
    const prompt = delegatedTaskPrompt({
      roleLine,
      task: "Check the boundaries.",
      upstreamPrompt: "Act as the review sub-agent for this task.",
    });
    assert.equal(prompt, `${roleLine}\n\nCheck the boundaries.`);
  });

  it("adds the documents brief block only while documents are effective", () => {
    const upstreamPrompt = "Act as the review sub-agent for this task.";
    try {
      setDocumentsBriefEnabled(true);
      assert.equal(
        delegatedTaskPrompt({ roleLine: "", task: "Review it.", upstreamPrompt }),
        `${docsBriefBlock()}\n\n${upstreamPrompt}`,
      );
    } finally {
      setDocumentsBriefEnabled(false);
    }
    assert.equal(
      delegatedTaskPrompt({ roleLine: "", task: "Review it.", upstreamPrompt }),
      upstreamPrompt,
    );
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

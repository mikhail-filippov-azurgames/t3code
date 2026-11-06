// @effect-diagnostics nodeBuiltinImport:off - tests use a temporary roles directory.
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Docs from "@t3tools/ft3-docs/server";
import { launcherFake } from "../../ft3-mail/src/mail.testkit.ts";
import { layer, runMigrations } from "./server.ts";
import { ProjectStoreV2 } from "../../../apps/server/src/orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../../apps/server/src/serverSettings.ts";
import * as Crypto from "effect/Crypto";
import * as ServerConfig from "../../../apps/server/src/config.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FeatureGate from "@t3tools/ft3-policies/server";
import * as Context from "effect/Context";

const rolesDirEnv = "T3CODE_FT3_ROLES_DIR";

const hostLayer = (
  env: Record<string, string>,
  settings: Parameters<typeof ServerSettings.layerTest>[0] = {},
) =>
  layer.pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    Layer.provide(ServerSettings.layerTest(settings)),
    Layer.provide(
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
          digest: () => Effect.die("unused"),
        }),
      ),
    ),
    Layer.provide(ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-ft3-host-" })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(launcherFake().layer),
    // The mail stack takes PlanService, which reads the project shell and
    // the thread shell. Startup only builds the layer, so these never run.
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.die("unused in host startup tests"),
          getThreadRecords: () => Effect.die("unused in host startup tests"),
          dispatch: () => Effect.die("unused in host startup tests"),
        }),
        Layer.mock(ProjectStoreV2)({
          getShell: () => Effect.succeedNone,
        }),
      ),
    ),
  );

const buildHostLayer = (
  env: Record<string, string>,
  settings: Parameters<typeof ServerSettings.layerTest>[0] = {},
) => Layer.build(hostLayer(env, settings)).pipe(Effect.scoped);

/** Writes a minimal configured policy document set a `path` source can read. */
const writePolicyFixtures = (dir: string) => {
  const write = (relPath: string, content: string) => {
    const path = NodePath.join(dir, ...relPath.split("/"));
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, content, "utf8");
  };
  write(
    "routing-policy.md",
    [
      "---",
      "revision: 1",
      "---",
      "",
      "| Role | low | medium | high | very-high |",
      "|---|---|---|---|---|",
      "| `architect` | A1 | A1 | A1 | A1 |",
      "| `planner` | A1 | A1 | A1 | A1 |",
      "| `implementation` | A1 | A1 | A1 | A1 |",
      "| `review-*` | A1 | A1 | A1 | A1 |",
      "| `test` | A1 | A1 | A1 | A1 |",
      "| `research` | A1 | A1 | A1 | A1 |",
      "| `general` | A1 | A1 | A1 | A1 |",
      "",
      "### Alpha (`alpha / acp`)",
      "| Alias | model | low | medium | high | very-high |",
      "|---|---|---|---|---|---|",
      "| A1 | `alpha-one` | — | — | — | — |",
      "",
    ].join("\n"),
  );
  write(
    "roles/roles.json",
    JSON.stringify({
      schema: "corvis-role-map-v1",
      revision: 1,
      configured: true,
      roles: [
        { id: "lead", roleId: "lead", file: "lead.md" },
        { id: "planner", roleId: "planner", file: "planner.md" },
        { id: "architect", roleId: "architect", file: "architect.md" },
      ],
    }),
  );
  for (const roleId of ["lead", "planner", "architect"]) {
    write(
      `roles/${roleId}.md`,
      [
        "---",
        "schema: corvis-role-v1",
        `roleId: ${roleId}`,
        "revision: 1",
        "configured: true",
        "---",
        "",
        `# ${roleId}`,
        "",
      ].join("\n"),
    );
  }
  write(
    "lead-skills/lead-skills.json",
    JSON.stringify({
      schema: "corvis-lead-skills-v1",
      revision: 1,
      configured: true,
      skills: [
        { id: "t3-orchestrator", file: "t3-orchestrator/SKILL.md" },
        { id: "board-orchestrator", file: "board-orchestrator/SKILL.md" },
        { id: "plan-orchestrator", file: "plan-orchestrator/SKILL.md" },
      ],
    }),
  );
  for (const skillId of ["t3-orchestrator", "board-orchestrator", "plan-orchestrator"]) {
    write(
      `lead-skills/${skillId}/SKILL.md`,
      [
        "---",
        `name: ${skillId}`,
        'description: "Test fixture skill."',
        "---",
        "",
        `# ${skillId}`,
        "",
      ].join("\n"),
    );
  }
};

describe("ft3 host startup", () => {
  it.effect("composes the feature gate with the default toggles", () =>
    Effect.gen(function* () {
      const context = yield* buildHostLayer({});
      const gate = Context.get(context, FeatureGate.FeatureGate);
      assert.isTrue(yield* gate.isEffective("board"));
      assert.isFalse(yield* gate.isEffective("mail"));
    }),
  );

  it.effect("keeps project feature overrides identical after rebuilding host layers", () =>
    Effect.gen(function* () {
      const settings = {
        ft3: { policies: { features: { board: true } } },
        projectSettingsOverrides: {
          "project-alpha": { ft3FeatureToggles: { board: false } },
        },
      } as Parameters<typeof ServerSettings.layerTest>[0];
      const firstContext = yield* buildHostLayer({}, settings);
      const inspectRequestedFeatures = (context: typeof firstContext) => {
        const gate = Context.get(context, FeatureGate.FeatureGate);
        const requested = (projectId?: string) =>
          gate.state("board", projectId).pipe(
            Effect.map((state) => state.requestedEnabled),
            Effect.provide(context),
          );
        return Effect.all({
          environment: requested(),
          projectA: requested("project-alpha"),
          projectB: requested("project-beta"),
        });
      };
      const firstState = yield* inspectRequestedFeatures(firstContext);
      assert.deepEqual(firstState, { environment: true, projectA: false, projectB: true });

      const restartedContext = yield* buildHostLayer({}, settings);
      const restartedState = yield* inspectRequestedFeatures(restartedContext);
      assert.deepEqual(restartedState, firstState);
    }),
  );

  it.effect(
    "restores a project's document scope at startup, so planning passes for it without an RPC",
    () =>
      Effect.gen(function* () {
        const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ft3-host-policies-"));
        writePolicyFixtures(dir);
        const context = yield* buildHostLayer({}, {
          ft3: {
            policies: {
              features: { mail: true, planning: true },
              documents: {
                routingPolicy: { kind: "path", path: `${dir}/routing-policy.md` },
                roles: { kind: "builtin" },
                leadSkills: { kind: "path", path: `${dir}/lead-skills/lead-skills.json` },
              },
            },
          },
          projectSettingsOverrides: {
            "project-alpha": {
              ft3PolicyDocuments: {
                key: "roles",
                source: { kind: "path", path: `${dir}/roles/roles.json` },
              },
            },
          },
        } as Parameters<typeof ServerSettings.layerTest>[0]);
        const gate = Context.get(context, FeatureGate.FeatureGate);

        // The environment's builtin roles template stays unconfigured, so
        // planning stays off there; only the restored project scope turns it on.
        const envPlanning = yield* gate.state("planning").pipe(Effect.provide(context));
        assert.isFalse(envPlanning.effectiveEnabled);

        yield* gate.require("planning", "project-alpha").pipe(Effect.provide(context));
        assert.isTrue(
          yield* gate.isEffective("planning", "project-alpha").pipe(Effect.provide(context)),
        );
      }),
  );

  it.effect("builds without a roles directory", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(buildHostLayer({}));
      assert.equal(exit._tag, "Success");
    }),
  );

  it.effect(
    "builds with the legacy roles directory set, which only the one-time migration reads",
    () =>
      Effect.gen(function* () {
        const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ft3-host-roles-"));
        const exit = yield* Effect.exit(buildHostLayer({ [rolesDirEnv]: dir }));
        assert.equal(exit._tag, "Success");
      }),
  );

  it.effect("builds when the legacy roles directory does not exist", () =>
    Effect.gen(function* () {
      const missing = NodePath.join(NodeOS.tmpdir(), "t3-ft3-host-roles-missing");
      const exit = yield* Effect.exit(buildHostLayer({ [rolesDirEnv]: missing }));
      assert.equal(exit._tag, "Success");
    }),
  );

  it.effect("lets the lead write a plan document and refuses a delegated child", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(hostLayer({}));
      yield* runMigrations().pipe(Effect.provideContext(context));
      const docs = Context.get(context, Docs.DocsService);
      const planPath = "corvis/plans/corvis/card.md";
      const created = yield* docs.write({
        caller: { threadId: "thread:lead", parentThreadId: null },
        relPath: planPath,
        content: "# Plan: card\n",
        clientRequestId: "plan:card",
      });
      assert.equal(created.relPath, planPath);
      const denied = yield* docs
        .write({
          caller: { threadId: "thread:child", parentThreadId: "thread:lead" },
          relPath: "corvis/plans/corvis/other.md",
          content: "# Plan: other\n",
          clientRequestId: "plan:other",
        })
        .pipe(Effect.flip);
      assert.equal(denied.code, "capability_denied");
      assert.equal(denied.reason, "child_read_only");
    }).pipe(Effect.scoped),
  );
});

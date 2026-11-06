// @effect-diagnostics nodeBuiltinImport:off - the fake store hashes document content.
import * as NodeCrypto from "node:crypto";

import { ProjectId, type OrchestrationProjectShell } from "@t3tools/contracts";
import { DocsService, DocsServiceError } from "@t3tools/ft3-docs/server";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { ProjectStoreV2 } from "../../../apps/server/src/orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../../../apps/server/src/serverSettings.ts";
import * as FeatureGate from "./FeatureGate.ts";
import {
  PolicyAppliedStore,
  type PolicyAppliedRecord,
  layerMemory as policyAppliedStoreLayer,
} from "./policyAppliedStore.ts";
import { PolicyChangeTracker, layer as policyChangeTrackerLayer } from "./policyChangeTracker.ts";
import {
  docsPolicyDocumentReadPort,
  layer as policyDocumentLoaderLayer,
} from "./policyDocumentLoader.ts";
import { policiesRpcHandlers, refreshAppliedPolicies } from "./rpc.ts";
import { FT3_POLICIES_WS_METHODS } from "./rpc-contracts.ts";
import { DEFAULT_POLICY_SETTINGS, type PoliciesSettings } from "./settings.ts";

const ROUTING_POLICY_PATH = "policies/routing-policy.md";
const ROLES_DIR = "policies/roles/";
const ROLES_PATH = `${ROLES_DIR}roles.json`;
const LEAD_SKILLS_PATH = "policies/lead-skills/lead-skills.json";
const PLAN_SKILL_PATH = "policies/lead-skills/plan-orchestrator/SKILL.md";
const T3_SKILL_PATH = "policies/lead-skills/t3-orchestrator/SKILL.md";
const BOARD_SKILL_PATH = "policies/lead-skills/board-orchestrator/SKILL.md";

// A live editor does not run inside a shell with the legacy settings.
delete process.env.T3CODE_FT3_ROLES_DIR;
delete process.env.T3CODE_FT3_ROUTING_POLICY_REF;

const sha256 = (content: string): string =>
  NodeCrypto.createHash("sha256").update(content, "utf8").digest("hex");

const routingPolicy = (revision: number, implementationCell = "A1"): string =>
  [
    "---",
    `revision: ${revision}`,
    "---",
    "",
    "| Role | low | medium | high | very-high |",
    "|---|---|---|---|---|",
    "| `architect` | A1 | A1 | A1 | A1 |",
    `| \`implementation\` | ${implementationCell} | A1 | A1 | A1 |`,
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
  ].join("\n");

const docsOver = (files: Map<string, string>) =>
  DocsService.of({
    list: ({ folder }) =>
      Effect.succeed({
        folder: folder ?? "",
        folders: [],
        documents: [...files.keys()]
          .filter((relPath) => relPath.startsWith(folder === undefined ? "" : `${folder}/`))
          .map((relPath) => ({
            relPath,
            stableId: relPath,
            name: relPath.split("/").pop() ?? relPath,
            description: "",
            updatedAt: "2026-11-03T00:00:00.000Z",
          })),
      }),
    manifest: ({ folder }) =>
      Effect.succeed(
        [...files.keys()]
          .filter((relPath) => relPath.startsWith(folder === undefined ? "" : `${folder}/`))
          .map((relPath) => ({
            name: relPath.split("/").pop() ?? relPath,
            relPath,
            stableId: relPath,
            description: "",
            updatedAt: "2026-11-03T00:00:00.000Z",
          })),
      ),
    read: ({ ref }) => {
      const content = files.get(ref);
      if (content === undefined) {
        return Effect.fail(new DocsServiceError({ code: "document_not_found", ref }));
      }
      return Effect.succeed({
        stableId: ref,
        relPath: ref,
        name: ref.split("/").pop() ?? ref,
        description: "",
        sha256: sha256(content),
        ocLink: `oc://doc/${ref}`,
        content,
      });
    },
    resolve: ({ ref }) =>
      Effect.gen(function* () {
        const content = files.get(ref);
        if (content === undefined) {
          return yield* new DocsServiceError({ code: "document_not_found", ref });
        }
        return {
          document: {
            stableId: ref,
            relPath: ref,
            name: ref.split("/").pop() ?? ref,
            description: "",
            sha256: sha256(content),
            ocLink: `oc://doc/${ref}`,
          },
          absolutePath: `/store/${ref}`,
        };
      }),
    search: () => Effect.succeed([]),
    write: () => Effect.die("unused in the policy apply tests"),
    writeAsHuman: ({ ref, content, baseSha256 }) =>
      Effect.gen(function* () {
        const live = files.get(ref);
        if (live === undefined) {
          return yield* new DocsServiceError({ code: "document_not_found", ref });
        }
        if (baseSha256 !== undefined && baseSha256 !== sha256(live)) {
          return yield* new DocsServiceError({ code: "document_changed", ref });
        }
        files.set(ref, content);
        return {
          stableId: ref,
          relPath: ref,
          name: ref.split("/").pop() ?? ref,
          sha256: sha256(content),
          ocLink: `oc://doc/${ref}`,
        };
      }),
    locateServerPath: () => Effect.succeed(null),
    setDescription: () => Effect.die("unused in the policy apply tests"),
    docRef: () => Effect.die("unused in the policy apply tests"),
    docStat: () => Effect.die("unused in the policy apply tests"),
  });

const policySettings = (
  applyExternalEdits: boolean,
  documents?: PoliciesSettings["documents"],
  featureOverrides: Partial<PoliciesSettings["features"]> = {},
) => ({
  documents: documents ?? routingPolicyDocuments(),
  applyExternalEdits,
  features: {
    ...DEFAULT_POLICY_SETTINGS.features,
    board: false,
    planning: false,
    ...featureOverrides,
  },
});

function routingPolicyDocuments(): PoliciesSettings["documents"] {
  return {
    routingPolicy: {
      kind: "doc",
      address: { kind: "path", relPath: ROUTING_POLICY_PATH },
    },
    roles: { kind: "builtin" },
    leadSkills: { kind: "builtin" },
  };
}

function rolesDocuments(): PoliciesSettings["documents"] {
  return {
    routingPolicy: { kind: "builtin" },
    roles: { kind: "doc", address: { kind: "path", relPath: ROLES_PATH } },
    leadSkills: { kind: "builtin" },
  };
}

const rolesManifest = (revision: number): string =>
  JSON.stringify({
    schema: "corvis-role-map-v1",
    revision,
    configured: true,
    roles: [{ id: "lead", roleId: "lead", file: "lead.md" }],
  });

const leadRole = (revision: number): string =>
  [
    "---",
    "schema: corvis-role-v1",
    "roleId: lead",
    `revision: ${revision}`,
    "configured: true",
    "---",
    "",
    "# Lead",
    "",
  ].join("\n");

const roleDocument = (roleId: string): string =>
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
  ].join("\n");

const leadSkillDocument = (name: string): string =>
  `---\nname: ${name}\ndescription: A short description.\n---\n\n# Skill\n`;

const configuredPlanningDocuments: PoliciesSettings["documents"] = {
  routingPolicy: {
    kind: "doc",
    address: { kind: "path", relPath: ROUTING_POLICY_PATH },
  },
  roles: { kind: "doc", address: { kind: "path", relPath: ROLES_PATH } },
  leadSkills: { kind: "doc", address: { kind: "path", relPath: LEAD_SKILLS_PATH } },
};

const missingPlannerFiles = () =>
  new Map([
    [ROUTING_POLICY_PATH, routingPolicy(1)],
    [
      ROLES_PATH,
      JSON.stringify({
        schema: "corvis-role-map-v1",
        revision: 1,
        configured: true,
        roles: [
          { id: "lead", roleId: "lead", file: "lead.md" },
          { id: "architect", roleId: "architect", file: "architect.md" },
        ],
      }),
    ],
    [`${ROLES_DIR}lead.md`, leadRole(1)],
    [`${ROLES_DIR}architect.md`, roleDocument("architect")],
    [
      LEAD_SKILLS_PATH,
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
    ],
    [T3_SKILL_PATH, leadSkillDocument("t3-orchestrator")],
    [BOARD_SKILL_PATH, leadSkillDocument("board-orchestrator")],
    [PLAN_SKILL_PATH, leadSkillDocument("plan-orchestrator")],
  ]);

const services = (
  files: Map<string, string>,
  applyExternalEdits: boolean,
  applied: Layer.Layer<PolicyAppliedStore> = policyAppliedStoreLayer,
  documents?: PoliciesSettings["documents"],
  projectSettingsOverrides?: Record<string, unknown>,
  featureOverrides?: Partial<PoliciesSettings["features"]>,
  projectExists: (projectId: string) => boolean = (projectId) => projectId.startsWith("proj-"),
) => {
  const docs = docsOver(files);
  const projectStore = Layer.mock(ProjectStoreV2)({
    getShell: (projectId) =>
      Effect.succeed(
        projectExists(String(projectId))
          ? Option.some({ projectId } as unknown as OrchestrationProjectShell)
          : Option.none(),
      ),
  });
  return Layer.mergeAll(
    policyChangeTrackerLayer.pipe(
      Layer.provide(policyDocumentLoaderLayer(docsPolicyDocumentReadPort(docs))),
      Layer.provide(applied),
    ),
    Layer.succeed(DocsService, docs),
    projectStore,
    ServerSettings.layerTest({
      ft3: { policies: policySettings(applyExternalEdits, documents, featureOverrides) },
      ...(projectSettingsOverrides === undefined ? {} : { projectSettingsOverrides }),
    } as Parameters<typeof ServerSettings.layerTest>[0]),
  );
};

const getSnapshot = policiesRpcHandlers[FT3_POLICIES_WS_METHODS.policiesGetSnapshot];
const readDocument = policiesRpcHandlers[FT3_POLICIES_WS_METHODS.policiesReadDocument];
const saveDocument = policiesRpcHandlers[FT3_POLICIES_WS_METHODS.policiesSaveDocument];
const getPending = policiesRpcHandlers[FT3_POLICIES_WS_METHODS.policiesGetPendingChange];
const applyPending = policiesRpcHandlers[FT3_POLICIES_WS_METHODS.policiesApplyPending];
const setApplyExternalEdits =
  policiesRpcHandlers[FT3_POLICIES_WS_METHODS.policiesSetApplyExternalEdits];
const setDocument = policiesRpcHandlers[FT3_POLICIES_WS_METHODS.policiesSetDocument];
const setFeature = policiesRpcHandlers[FT3_POLICIES_WS_METHODS.policiesSetFeature];

const revisionOf = (snapshot: {
  readonly documents: ReadonlyArray<{
    readonly key: string;
    readonly source: { readonly kind: string };
    readonly applied: { readonly revision: number } | null;
    readonly pending: boolean;
    readonly kept: boolean;
    readonly errors: ReadonlyArray<{ readonly code: string }>;
  }>;
}) => snapshot.documents.find((document) => document.key === "routingPolicy") ?? null;

const rolesOf = (snapshot: {
  readonly documents: ReadonlyArray<{
    readonly key: string;
    readonly source: { readonly kind: string };
    readonly applied: { readonly revision: number } | null;
  }>;
}) => snapshot.documents.find((document) => document.key === "roles") ?? null;

describe("policy write and apply RPC", () => {
  it.effect("saves a valid document from the Policies tab and applies it at once", () => {
    const files = new Map([[ROUTING_POLICY_PATH, routingPolicy(1)]]);
    return Effect.gen(function* () {
      const first = yield* getSnapshot({});
      assert.equal(revisionOf(first)?.applied?.revision, 1);

      const saved = yield* saveDocument({
        key: "routingPolicy",
        baseSha256: sha256(routingPolicy(1)),
        content: routingPolicy(2),
      });

      assert.equal(saved.status, "saved");
      assert.equal(revisionOf(saved.snapshot)?.applied?.revision, 2);
      assert.isFalse(revisionOf(saved.snapshot)?.pending);
      assert.equal(files.get(ROUTING_POLICY_PATH), routingPolicy(2));
    }).pipe(Effect.provide(services(files, false)));
  });

  it.effect("keeps the applied version when the saved document is invalid", () => {
    const files = new Map([[ROUTING_POLICY_PATH, routingPolicy(1)]]);
    return Effect.gen(function* () {
      yield* getSnapshot({});
      const broken = routingPolicy(2, "A1 (all low)");
      const saved = yield* saveDocument({
        key: "routingPolicy",
        baseSha256: sha256(routingPolicy(1)),
        content: broken,
      });
      const status = revisionOf(saved.snapshot);

      assert.equal(saved.status, "invalid");
      assert.equal(status?.applied?.revision, 1);
      assert.isTrue(status?.kept);
      assert.deepStrictEqual(
        status?.errors.map((issue) => issue.code),
        ["policy_invalid_kept", "table_row_invalid", "role_missing"],
      );
      assert.equal(files.get(ROUTING_POLICY_PATH), broken);
    }).pipe(Effect.provide(services(files, false)));
  });

  it.effect("refuses a save whose base SHA is stale", () => {
    const files = new Map([[ROUTING_POLICY_PATH, routingPolicy(1)]]);
    return Effect.gen(function* () {
      yield* getSnapshot({});
      files.set(ROUTING_POLICY_PATH, routingPolicy(2));
      const saved = yield* saveDocument({
        key: "routingPolicy",
        baseSha256: sha256(routingPolicy(1)),
        content: routingPolicy(3),
      });

      assert.equal(saved.status, "changed_externally");
      assert.equal(files.get(ROUTING_POLICY_PATH), routingPolicy(2));
    }).pipe(Effect.provide(services(files, false)));
  });

  it.effect("holds an external edit as pending, shows the diff, then applies it", () => {
    const files = new Map([[ROUTING_POLICY_PATH, routingPolicy(1)]]);
    return Effect.gen(function* () {
      yield* getSnapshot({});
      files.set(ROUTING_POLICY_PATH, routingPolicy(2));

      const pendingSnapshot = yield* getSnapshot({});
      assert.equal(revisionOf(pendingSnapshot)?.applied?.revision, 1);
      assert.isTrue(revisionOf(pendingSnapshot)?.pending);

      const pending = yield* getPending({ key: "routingPolicy" });
      assert.isTrue(pending.pending);
      const diff = pending.change?.files[0]?.diff ?? "";
      assert.include(diff, "--- a/policies/routing-policy.md");
      assert.include(diff, "-revision: 1");
      assert.include(diff, "+revision: 2");
      assert.isTrue(pending.change?.valid);

      const applied = yield* applyPending({
        key: "routingPolicy",
        liveSha256: sha256(routingPolicy(2)),
      });
      assert.equal(applied.status, "applied");
      assert.equal(revisionOf(applied.snapshot)?.applied?.revision, 2);
      assert.isFalse(revisionOf(applied.snapshot)?.pending);
    }).pipe(Effect.provide(services(files, false)));
  });

  it.effect("refuses Apply of a newer live edit and never applies an invalid one", () => {
    const files = new Map([[ROUTING_POLICY_PATH, routingPolicy(1)]]);
    return Effect.gen(function* () {
      yield* getSnapshot({});
      files.set(ROUTING_POLICY_PATH, routingPolicy(2));
      yield* getPending({ key: "routingPolicy" });

      const stale = yield* applyPending({
        key: "routingPolicy",
        liveSha256: sha256(routingPolicy(1)),
      });
      assert.equal(stale.status, "changed_externally");
      assert.equal(revisionOf(stale.snapshot)?.applied?.revision, 1);

      const broken = routingPolicy(3, "A1 (all low)");
      files.set(ROUTING_POLICY_PATH, broken);
      yield* getPending({ key: "routingPolicy" });
      const invalid = yield* applyPending({
        key: "routingPolicy",
        liveSha256: sha256(broken),
      });
      assert.equal(invalid.status, "invalid");
      assert.equal(revisionOf(invalid.snapshot)?.applied?.revision, 1);
      assert.isTrue(revisionOf(invalid.snapshot)?.kept);
    }).pipe(Effect.provide(services(files, false)));
  });

  it.effect(
    "applies external edits immediately once the toggle is on, and keeps invalid ones out",
    () => {
      const files = new Map([[ROUTING_POLICY_PATH, routingPolicy(1)]]);
      return Effect.gen(function* () {
        yield* getSnapshot({});
        files.set(ROUTING_POLICY_PATH, routingPolicy(2));
        const pending = yield* getSnapshot({});
        assert.isTrue(revisionOf(pending)?.pending);

        const enabled = yield* setApplyExternalEdits({ enabled: true });
        assert.isTrue(enabled.enabled);
        assert.equal(revisionOf(enabled.snapshot)?.applied?.revision, 2);

        files.set(ROUTING_POLICY_PATH, routingPolicy(3, "A1 (all low)"));
        const auto = yield* getSnapshot({});
        assert.equal(revisionOf(auto)?.applied?.revision, 2);
        assert.isTrue(revisionOf(auto)?.kept);
        assert.isFalse(revisionOf(auto)?.pending);

        const off = yield* setApplyExternalEdits({ enabled: false });
        assert.isFalse(off.enabled);
        files.set(ROUTING_POLICY_PATH, routingPolicy(4));
        const held = yield* getSnapshot({});
        assert.equal(revisionOf(held)?.applied?.revision, 2);
        assert.isTrue(revisionOf(held)?.pending);
      }).pipe(Effect.provide(services(files, false)));
    },
  );

  it.effect(
    "restores the applied version after a restart and does not apply pending silently",
    () => {
      const files = new Map([[ROUTING_POLICY_PATH, routingPolicy(1)]]);
      return Effect.gen(function* () {
        // One applied store shared by both tracker instances, as the database is.
        const applied = yield* Ref.make(new Map<string, readonly PolicyAppliedRecord[]>());
        const sharedStore = Layer.succeed(
          PolicyAppliedStore,
          PolicyAppliedStore.of({
            load: ({ scope, key }) =>
              Effect.map(Ref.get(applied), (all) => all.get(`${scope}:${key}`) ?? []),
            save: ({ scope, key, files: appliedFiles, appliedAt, appliedBy }) =>
              Ref.update(applied, (all) => {
                const next = new Map(all);
                next.set(
                  `${scope}:${key}`,
                  appliedFiles.map((file) => ({ ...file, appliedAt, appliedBy })),
                );
                return next;
              }),
          }),
        );

        yield* getSnapshot({}).pipe(Effect.provide(services(files, false, sharedStore)));

        // Restart: a new tracker over the persisted applied copy.
        const restored = yield* getSnapshot({}).pipe(
          Effect.provide(services(files, false, sharedStore)),
        );
        assert.equal(revisionOf(restored)?.applied?.revision, 1);
        assert.isFalse(revisionOf(restored)?.pending);

        // An external edit made while the server was off stays pending after restart.
        files.set(ROUTING_POLICY_PATH, routingPolicy(2));
        const afterRestart = yield* getSnapshot({}).pipe(
          Effect.provide(services(files, false, sharedStore)),
        );
        assert.equal(revisionOf(afterRestart)?.applied?.revision, 1);
        assert.isTrue(revisionOf(afterRestart)?.pending);
      });
    },
  );

  it.effect("neither returns nor writes store files roles.json does not declare", () => {
    const files = new Map([
      [ROLES_PATH, rolesManifest(1)],
      [`${ROLES_DIR}lead.md`, leadRole(1)],
      [`${ROLES_DIR}notes.md`, "# Notes\n"],
    ]);
    return Effect.gen(function* () {
      yield* getSnapshot({});
      const read = yield* readDocument({ key: "roles" });
      assert.equal(read.status, "ok");
      if (read.status !== "ok") return;
      assert.deepStrictEqual(
        read.files.map((file) => file.file),
        ["", "lead.md"],
      );

      const undeclared = yield* saveDocument({
        key: "roles",
        file: "notes.md",
        baseSha256: sha256("# Notes\n"),
        content: "# Overwritten\n",
      });
      assert.equal(undeclared.status, "not_writable");
      assert.equal(files.get(`${ROLES_DIR}notes.md`), "# Notes\n");

      const declared = yield* saveDocument({
        key: "roles",
        file: "lead.md",
        baseSha256: sha256(leadRole(1)),
        content: leadRole(2),
      });
      assert.equal(declared.status, "saved");
      assert.equal(files.get(`${ROLES_DIR}lead.md`), leadRole(2));
    }).pipe(Effect.provide(services(files, false, policyAppliedStoreLayer, rolesDocuments())));
  });

  it.effect("reports effective features and attention in the snapshot", () => {
    const files = new Map([[ROUTING_POLICY_PATH, routingPolicy(1)]]);
    return Effect.gen(function* () {
      const on = yield* setFeature({ feature: "mail", enabled: true });
      assert.isTrue(on.snapshot.features.mail.requestedEnabled);
      assert.isFalse(on.snapshot.features.mail.effectiveEnabled);
      assert.deepStrictEqual(on.snapshot.features.mail.offReason, {
        code: "feature_dependency_off",
        dependency: "board",
      });
      assert.isTrue(on.snapshot.needsAttention);

      const off = yield* setFeature({ feature: "mail", enabled: false });
      assert.isFalse(off.snapshot.features.mail.requestedEnabled);
      assert.isFalse(off.snapshot.features.mail.effectiveEnabled);
      // Unconfigured built-in roles and skills keep warning-level attention up.
      assert.isTrue(off.snapshot.needsAttention);
    }).pipe(Effect.provide(services(files, false)));
  });

  it.effect("changes the environment-wide document source and restores it", () => {
    const files = new Map([[ROUTING_POLICY_PATH, routingPolicy(1)]]);
    return Effect.gen(function* () {
      const initial = yield* getSnapshot({});
      assert.equal(revisionOf(initial)?.source.kind, "doc");
      assert.equal(revisionOf(initial)?.applied?.revision, 1);

      const toBuiltin = yield* setDocument({ key: "routingPolicy", source: { kind: "builtin" } });
      assert.equal(revisionOf(toBuiltin.snapshot)?.source.kind, "builtin");
      assert.equal(revisionOf(toBuiltin.snapshot)?.applied?.revision, 1);
      assert.isTrue(revisionOf(toBuiltin.snapshot)?.kept);

      const back = yield* setDocument({
        key: "routingPolicy",
        source: { kind: "doc", address: { kind: "path", relPath: ROUTING_POLICY_PATH } },
      });
      assert.equal(revisionOf(back.snapshot)?.source.kind, "doc");
      assert.equal(revisionOf(back.snapshot)?.applied?.revision, 1);
      assert.isFalse(revisionOf(back.snapshot)?.kept);
    }).pipe(Effect.provide(services(files, false)));
  });

  it.effect("keeps applied state isolated per project and survives a restart", () => {
    const files = new Map([
      [ROLES_PATH, rolesManifest(1)],
      [`${ROLES_DIR}lead.md`, leadRole(1)],
    ]);
    const docSource = {
      kind: "doc",
      address: { kind: "path", relPath: ROLES_PATH },
    } as const;
    return Effect.gen(function* () {
      // One applied store and one settings file, as the database is across restarts.
      const applied = yield* Ref.make(new Map<string, readonly PolicyAppliedRecord[]>());
      const sharedApplied = Layer.succeed(
        PolicyAppliedStore,
        PolicyAppliedStore.of({
          load: ({ scope, key }) =>
            Effect.map(Ref.get(applied), (all) => all.get(`${scope}:${key}`) ?? []),
          save: ({ scope, key, files: appliedFiles, appliedAt, appliedBy }) =>
            Ref.update(applied, (all) => {
              const next = new Map(all);
              next.set(
                `${scope}:${key}`,
                appliedFiles.map((file) => ({ ...file, appliedAt, appliedBy })),
              );
              return next;
            }),
        }),
      );
      const settingsService = yield* Effect.service(ServerSettings.ServerSettingsService).pipe(
        Effect.provide(ServerSettings.layerTest({ ft3: { policies: policySettings(false) } })),
      );
      const servicesFor = () => {
        const docs = docsOver(files);
        return Layer.mergeAll(
          policyChangeTrackerLayer.pipe(
            Layer.provide(policyDocumentLoaderLayer(docsPolicyDocumentReadPort(docs))),
            Layer.provide(sharedApplied),
          ),
          Layer.succeed(DocsService, docs),
          Layer.succeed(ServerSettings.ServerSettingsService, settingsService),
        );
      };

      const envInitial = yield* getSnapshot({}).pipe(Effect.provide(servicesFor()));
      assert.equal(rolesOf(envInitial)?.source.kind, "builtin");
      assert.equal(rolesOf(envInitial)?.applied?.revision, 0);

      const set = yield* setDocument({ projectId: "proj-1", key: "roles", source: docSource }).pipe(
        Effect.provide(servicesFor()),
      );
      assert.equal(rolesOf(set.snapshot)?.source.kind, "doc");
      assert.equal(rolesOf(set.snapshot)?.applied?.revision, 1);

      const env = yield* getSnapshot({}).pipe(Effect.provide(servicesFor()));
      assert.equal(rolesOf(env)?.source.kind, "builtin");
      assert.equal(rolesOf(env)?.applied?.revision, 0);

      const project = yield* getSnapshot({ projectId: "proj-1" }).pipe(
        Effect.provide(servicesFor()),
      );
      assert.equal(rolesOf(project)?.source.kind, "doc");
      assert.equal(rolesOf(project)?.applied?.revision, 1);

      // A -> B: a second project's override gets its own applied state.
      files.set(ROLES_PATH, rolesManifest(2));
      yield* setDocument({ projectId: "proj-2", key: "roles", source: docSource }).pipe(
        Effect.provide(servicesFor()),
      );
      const projectB = yield* getSnapshot({ projectId: "proj-2" }).pipe(
        Effect.provide(servicesFor()),
      );
      assert.equal(rolesOf(projectB)?.applied?.revision, 2);
      const projectAgain = yield* getSnapshot({ projectId: "proj-1" }).pipe(
        Effect.provide(servicesFor()),
      );
      assert.equal(rolesOf(projectAgain)?.applied?.revision, 1);
      const envAgain = yield* getSnapshot({}).pipe(Effect.provide(servicesFor()));
      assert.equal(rolesOf(envAgain)?.applied?.revision, 0);

      // Restart: a fresh tracker over the shared store restores each scope.
      const restarted = yield* getSnapshot({ projectId: "proj-1" }).pipe(
        Effect.provide(servicesFor()),
      );
      assert.equal(rolesOf(restarted)?.applied?.revision, 1);
      const restartedEnv = yield* getSnapshot({}).pipe(Effect.provide(servicesFor()));
      assert.equal(rolesOf(restartedEnv)?.applied?.revision, 0);
    });
  });
});

describe("per-project feature toggle RPC", () => {
  const toggleServices = () => services(new Map([[ROUTING_POLICY_PATH, routingPolicy(1)]]), false);

  it.effect("sets a project override without touching the environment", () =>
    Effect.gen(function* () {
      const set = yield* setFeature({ projectId: "proj-1", feature: "mail", enabled: true });

      assert.isTrue(set.snapshot.features.mail.requestedEnabled);
      assert.equal(set.snapshot.featureSources.mail, "project");
      assert.equal(set.snapshot.featureSources.board, "default");
      // D2: documents is environment-only and never reports a project source.
      assert.equal(set.snapshot.featureSources.documents, "default");

      const env = yield* getSnapshot({});
      assert.isFalse(env.features.mail.requestedEnabled);
      assert.equal(env.featureSources.mail, "default");

      const project = yield* getSnapshot({ projectId: "proj-1" });
      assert.isTrue(project.features.mail.requestedEnabled);
      assert.equal(project.featureSources.mail, "project");
    }).pipe(Effect.provide(toggleServices())),
  );

  it.effect(
    "keeps environment requirements stable when a project snapshot requests planning off",
    () => {
      const projectOverrides = { "proj-a": { ft3FeatureToggles: { planning: false } } };
      const layer = FeatureGate.layer.pipe(
        Layer.provideMerge(
          services(
            missingPlannerFiles(),
            false,
            undefined,
            configuredPlanningDocuments,
            projectOverrides,
            { board: true, mail: true, planning: true },
          ),
        ),
      );
      return Effect.gen(function* () {
        const tracker = yield* PolicyChangeTracker;
        yield* getSnapshot({});
        const before = yield* tracker.snapshot();
        assert.isFalse(before.requirements.plannerRole);

        yield* getSnapshot({ projectId: "proj-a" });
        const after = yield* tracker.snapshot();
        assert.deepStrictEqual(after.requirements, before.requirements);

        const gate = yield* FeatureGate.FeatureGate;
        const failure = yield* gate.require("planning", "proj-b").pipe(Effect.flip);
        assert.equal(failure.feature, "planning");
        assert.notEqual(failure.code, "feature_disabled");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "loads project-enabled planning requirements at startup and after a project toggle",
    () => {
      const layer = FeatureGate.layer.pipe(
        Layer.provideMerge(
          services(
            missingPlannerFiles(),
            false,
            undefined,
            configuredPlanningDocuments,
            { "proj-a": { ft3FeatureToggles: { planning: true } } },
            { board: true, mail: true, planning: false },
          ),
        ),
      );
      return Effect.gen(function* () {
        const tracker = yield* PolicyChangeTracker;
        yield* refreshAppliedPolicies;
        const startup = yield* tracker.snapshot();
        assert.isFalse(startup.requirements.plannerRole);
        assert.isTrue(startup.requirements.planOrchestratorSkill);

        const gate = yield* FeatureGate.FeatureGate;
        const startupFailure = yield* gate.require("planning", "proj-a").pipe(Effect.flip);
        assert.equal(startupFailure.feature, "planning");
        assert.notEqual(startupFailure.code, "feature_disabled");

        yield* setFeature({ projectId: "proj-a", feature: "planning", enabled: false });
        const changed = yield* setFeature({
          projectId: "proj-a",
          feature: "planning",
          enabled: true,
        });
        assert.isFalse(changed.snapshot.requirements.plannerRole);
        assert.isTrue(changed.snapshot.requirements.planOrchestratorSkill);
        assert.isFalse(changed.snapshot.features.planning.effectiveEnabled);

        const environment = yield* tracker.snapshot();
        assert.isFalse(environment.requirements.plannerRole);
        assert.isTrue(environment.requirements.planOrchestratorSkill);
        const failure = yield* gate.require("planning", "proj-a").pipe(Effect.flip);
        assert.equal(failure.feature, "planning");
        assert.notEqual(failure.code, "feature_disabled");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("resets a project override with enabled null", () =>
    Effect.gen(function* () {
      yield* setFeature({ projectId: "proj-1", feature: "mail", enabled: true });
      const reset = yield* setFeature({ projectId: "proj-1", feature: "mail", enabled: null });

      assert.isFalse(reset.snapshot.features.mail.requestedEnabled);
      assert.equal(reset.snapshot.featureSources.mail, "default");
    }).pipe(Effect.provide(toggleServices())),
  );

  it.effect("rejects a reset without a projectId", () =>
    Effect.gen(function* () {
      const error = yield* setFeature({ feature: "mail", enabled: null }).pipe(Effect.flip);

      assert.equal(error._tag, "PoliciesSetFeatureError");
      if (error._tag !== "PoliciesSetFeatureError") return;
      assert.equal(error.code, "reset_requires_project");
    }).pipe(Effect.provide(toggleServices())),
  );

  it.effect("rejects a feature override for an unknown project", () =>
    Effect.gen(function* () {
      const error = yield* setFeature({
        projectId: "missing-project",
        feature: "board",
        enabled: false,
      }).pipe(Effect.flip);

      assert.equal(error._tag, "PoliciesSetFeatureError");
      if (error._tag !== "PoliciesSetFeatureError") return;
      assert.equal(error.code, "project_not_found");
      const settings = yield* ServerSettings.ServerSettingsService;
      const stored = yield* settings.getSettings;
      assert.isUndefined(stored.projectSettingsOverrides[ProjectId.make("missing-project")]);
    }).pipe(Effect.provide(services(new Map([[ROUTING_POLICY_PATH, routingPolicy(1)]]), false))),
  );

  it.effect("rejects a per-project override of the environment-only documents feature", () =>
    Effect.gen(function* () {
      const error = yield* setFeature({
        projectId: "proj-1",
        feature: "documents",
        enabled: false,
      }).pipe(Effect.flip);

      assert.equal(error._tag, "PoliciesSetFeatureError");
      if (error._tag !== "PoliciesSetFeatureError") return;
      assert.equal(error.code, "environment_only_feature");
    }).pipe(Effect.provide(toggleServices())),
  );
});

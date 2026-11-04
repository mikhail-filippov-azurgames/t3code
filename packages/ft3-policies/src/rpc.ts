// @effect-diagnostics nodeBuiltinImport:off - an unmanaged policy file outside the store is written atomically.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { DocsService } from "@t3tools/ft3-docs/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerSettingsService } from "../../../apps/server/src/serverSettings.ts";
import { docsPolicyEnvPort, migratePolicyEnvironment } from "./envMigration.ts";
import {
  type PolicySnapshot as TrackerSnapshot,
  PolicyChangeTracker,
  layer as policyChangeTrackerLayer,
} from "./policyChangeTracker.ts";
import {
  docsPolicyDocumentReadPort,
  layer as policyDocumentLoaderLayer,
} from "./policyDocumentLoader.ts";
import { layer as policyAppliedStoreLayer } from "./policyAppliedStore.ts";
import {
  readPolicySettings,
  resolvePolicyDocumentSources,
  decodeProjectPolicyDocumentOverrideValue,
  withPolicySettings,
} from "./settings.ts";
import {
  FT3_POLICIES_WS_METHODS,
  type PoliciesApplyPendingInput,
  type PoliciesApplyPendingResult,
  type PoliciesGetPendingChangeInput,
  type PoliciesGetPendingChangeResult,
  type PoliciesGetSnapshotInput,
  type PoliciesGetSnapshotResult,
  type PoliciesReadDocumentInput,
  type PoliciesReadDocumentResult,
  type PoliciesSaveDocumentInput,
  type PoliciesSaveDocumentResult,
  type PoliciesSetApplyExternalEditsInput,
  type PoliciesSetApplyExternalEditsResult,
  type PoliciesSetDocumentInput,
  type PoliciesSetDocumentResult,
  type PoliciesSetFeatureInput,
  type PoliciesSetFeatureResult,
} from "./rpc-contracts.ts";
import {
  type FeatureId,
  POLICY_REQUIREMENT_IDS,
  type PolicyDocumentKey,
  type PolicyDocumentSource,
  type PolicyRequirementId,
  resolveFeatureStates,
} from "./contracts.ts";

export { FT3_POLICIES_WS_METHODS, policiesRpcs, policiesRpcScopes } from "./rpc-contracts.ts";
export { PolicyChangeTracker } from "./policyChangeTracker.ts";

/**
 * The snapshot loader reads through the ambient `DocsService`, so the host
 * composition provides the same store the docs RPC uses; applied copies live in
 * `statev2.sqlite` beside the other fork tables.
 */
export const policiesRpcServiceLayer: Layer.Layer<
  PolicyChangeTracker,
  never,
  DocsService | SqlClient.SqlClient
> = Layer.unwrap(
  Effect.map(DocsService, (docs) =>
    policyChangeTrackerLayer.pipe(
      Layer.provide(policyDocumentLoaderLayer(docsPolicyDocumentReadPort(docs))),
      Layer.provide(policyAppliedStoreLayer),
    ),
  ),
);

const resultOf = (
  snapshot: TrackerSnapshot,
  warnings: PoliciesGetSnapshotResult["warnings"],
  requested: Readonly<Partial<Record<FeatureId, boolean>>>,
) => {
  const features = resolveFeatureStates({ requested, requirements: snapshot.requirements });
  return {
    configVersion: snapshot.configVersion,
    documents: snapshot.documents,
    requirements: Object.fromEntries(
      POLICY_REQUIREMENT_IDS.map((id) => [id, snapshot.requirements[id] === true]),
    ) as Record<PolicyRequirementId, boolean>,
    features,
    needsAttention:
      Object.values(features).some((state) => state.requestedEnabled && !state.effectiveEnabled) ||
      snapshot.documents.some((document) => document.pending || document.warnings.length > 0),
    warnings,
  } satisfies PoliciesGetSnapshotResult;
};

const statusOf = (snapshot: TrackerSnapshot, key: PolicyDocumentKey) =>
  snapshot.documents.find((document) => document.key === key) ?? null;

/** The project's `ft3PolicyDocuments` override, when it decodes; null otherwise. */
const projectOverrideOf = (
  settings: {
    readonly projectSettingsOverrides: Readonly<
      Record<string, { readonly ft3PolicyDocuments?: unknown } | undefined>
    >;
  },
  projectId: string | undefined,
): { key: PolicyDocumentKey; source: PolicyDocumentSource } | null => {
  if (projectId === undefined) return null;
  const raw = settings.projectSettingsOverrides[projectId]?.ft3PolicyDocuments;
  if (raw === undefined) return null;
  const decoded = decodeProjectPolicyDocumentOverrideValue(raw);
  return decoded._tag === "Some" ? decoded.value : null;
};

/** Settings, the ticked documents and the one-time env migration, in one place. */
const prepared = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const docs = yield* DocsService;
  const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
  const migration = yield* migratePolicyEnvironment({
    settings: readPolicySettings(settings.ft3),
    docs: docsPolicyEnvPort(docs),
    environment: process.env,
  });
  const policies = migration.changed
    ? readPolicySettings(
        (yield* serverSettings
          .updateSettings({ ft3: withPolicySettings(settings.ft3, migration.settings) })
          .pipe(Effect.orDie)).ft3,
      )
    : migration.settings;
  return { settings, policies, warnings: migration.warnings };
});

/**
 * The server startup and the Policies tab run the same refresh, so a live
 * server serves the applied role documents without anyone opening the tab, and
 * the legacy `T3CODE_FT3_*` environment folds in on the first refresh.
 */
export const refreshAppliedPolicies: Effect.Effect<
  void,
  never,
  PolicyChangeTracker | ServerSettingsService | DocsService
> = Effect.gen(function* () {
  const { policies, warnings } = yield* prepared;
  const tracker = yield* PolicyChangeTracker;
  yield* tracker.refresh({
    sources: resolvePolicyDocumentSources(policies, null),
    features: {
      board: policies.features.board,
      planning: policies.features.planning,
    },
    applyExternalEdits: policies.applyExternalEdits,
  });
  yield* Effect.forEach(warnings, (issue) => Effect.logWarning(issue.message), { discard: true });
}).pipe(Effect.withSpan("PoliciesRpc.refreshAppliedPolicies"));

/** The tracker scope a refresh runs in: a project override is per-project state. */
const scopeFor = (
  override: { key: PolicyDocumentKey; source: PolicyDocumentSource } | null,
  projectId: string | null | undefined,
): string | undefined => (override !== null && projectId != null ? projectId : undefined);

const refreshWith = Effect.fn("PoliciesRpc.refreshWith")(function* (
  policies: ReturnType<typeof readPolicySettings>,
  warnings: PoliciesGetSnapshotResult["warnings"],
  override: { key: PolicyDocumentKey; source: PolicyDocumentSource } | null,
  scope: string | undefined,
  extra: {
    readonly forceApplyKeys?: readonly PolicyDocumentKey[];
    readonly appliedBy?: "human_tab" | "human_apply" | "auto";
  } = {},
) {
  const tracker = yield* PolicyChangeTracker;
  const snapshot = yield* tracker.refresh({
    sources: resolvePolicyDocumentSources(policies, override),
    features: {
      board: policies.features.board,
      planning: policies.features.planning,
    },
    applyExternalEdits: policies.applyExternalEdits,
    ...(scope === undefined ? {} : { scope }),
    ...extra,
  });
  return resultOf(snapshot, warnings, policies.features);
});

const getSnapshot = Effect.fn("PoliciesRpc.getSnapshot")(function* (
  input: PoliciesGetSnapshotInput,
) {
  const { settings, policies, warnings } = yield* prepared;
  const override = projectOverrideOf(settings, input.projectId);
  return yield* refreshWith(policies, warnings, override, scopeFor(override, input.projectId));
});

const readDocument = Effect.fn("PoliciesRpc.readDocument")(function* (
  input: PoliciesReadDocumentInput,
) {
  const { settings, policies, warnings } = yield* prepared;
  const override = projectOverrideOf(settings, input.projectId);
  yield* refreshWith(policies, warnings, override, scopeFor(override, input.projectId));
  const tracker = yield* PolicyChangeTracker;
  const live = yield* tracker.live(input.key, scopeFor(override, input.projectId));
  if (live === null || live.files.length === 0) {
    return {
      status: "unavailable",
      key: input.key,
      issues: live?.issues ?? [],
    } satisfies PoliciesReadDocumentResult;
  }
  return {
    status: "ok",
    key: input.key,
    source: live.source,
    configured: live.configured,
    files: live.files.map((file) => ({
      file: file.file,
      content: file.content,
      sha256: file.sha256,
    })),
    mainFile: input.file ?? "",
  } satisfies PoliciesReadDocumentResult;
});

const writeUnmanaged = (path: string, content: string) =>
  Effect.sync(() => {
    const temporary = `${path}.corvis-tmp`;
    NodeFS.writeFileSync(temporary, content, "utf8");
    NodeFS.renameSync(temporary, path);
  });

const saveDocument = Effect.fn("PoliciesRpc.saveDocument")(function* (
  input: PoliciesSaveDocumentInput,
) {
  const { settings, policies, warnings } = yield* prepared;
  const override = projectOverrideOf(settings, input.projectId);
  const before = yield* refreshWith(
    policies,
    warnings,
    override,
    scopeFor(override, input.projectId),
  );
  const tracker = yield* PolicyChangeTracker;
  const docs = yield* DocsService;
  const live = yield* tracker.live(input.key, scopeFor(override, input.projectId));
  const file = live?.files.find((entry) => entry.file === (input.file ?? ""));
  if (
    live === null ||
    file === undefined ||
    (file.relPath === null && file.absolutePath === null)
  ) {
    return { status: "not_writable", snapshot: before } satisfies PoliciesSaveDocumentResult;
  }
  if (file.sha256 !== input.baseSha256) {
    return {
      status: "changed_externally",
      snapshot: before,
    } satisfies PoliciesSaveDocumentResult;
  }

  const written =
    file.relPath !== null
      ? yield* Effect.result(
          docs.writeAsHuman({
            ref: file.relPath,
            content: input.content,
            baseSha256: input.baseSha256,
          }),
        )
      : yield* Effect.result(
          writeUnmanaged(NodePath.resolve(file.absolutePath ?? ""), input.content),
        );
  if (written._tag === "Failure") {
    return {
      status: "changed_externally",
      snapshot: before,
    } satisfies PoliciesSaveDocumentResult;
  }

  const snapshot = yield* refreshWith(
    policies,
    warnings,
    override,
    scopeFor(override, input.projectId),
    {
      forceApplyKeys: [input.key],
      appliedBy: "human_tab",
    },
  );
  const status = statusOf(
    {
      configVersion: snapshot.configVersion,
      documents: snapshot.documents,
      requirements: {},
    },
    input.key,
  );
  const applied = status?.applied?.sha256 === status?.seen?.sha256;
  return {
    status: applied ? "saved" : "invalid",
    snapshot,
  } satisfies PoliciesSaveDocumentResult;
});

const getPendingChange = Effect.fn("PoliciesRpc.getPendingChange")(function* (
  input: PoliciesGetPendingChangeInput,
) {
  const { settings, policies, warnings } = yield* prepared;
  const override = projectOverrideOf(settings, input.projectId);
  yield* refreshWith(policies, warnings, override, scopeFor(override, input.projectId));
  const tracker = yield* PolicyChangeTracker;
  const change = yield* tracker.pendingChange(input.key, scopeFor(override, input.projectId));
  return {
    key: input.key,
    pending: change !== null,
    change:
      change === null
        ? null
        : {
            liveSha256: change.liveSha256,
            valid: change.valid,
            issues: change.issues,
            files: change.files,
          },
  } satisfies PoliciesGetPendingChangeResult;
});

const applyPending = Effect.fn("PoliciesRpc.applyPending")(function* (
  input: PoliciesApplyPendingInput,
) {
  const { settings, policies, warnings } = yield* prepared;
  const override = projectOverrideOf(settings, input.projectId);
  const before = yield* refreshWith(
    policies,
    warnings,
    override,
    scopeFor(override, input.projectId),
  );
  const tracker = yield* PolicyChangeTracker;
  const pending = yield* tracker.pendingChange(input.key, scopeFor(override, input.projectId));
  const beforeStatus = statusOf(
    { configVersion: before.configVersion, documents: before.documents, requirements: {} },
    input.key,
  );

  if (pending === null) {
    return {
      status: beforeStatus?.applied?.sha256 === input.liveSha256 ? "applied" : "nothing_pending",
      snapshot: before,
    } satisfies PoliciesApplyPendingResult;
  }
  if (pending.liveSha256 !== input.liveSha256) {
    return {
      status: "changed_externally",
      snapshot: before,
    } satisfies PoliciesApplyPendingResult;
  }

  const snapshot = yield* refreshWith(
    policies,
    warnings,
    override,
    scopeFor(override, input.projectId),
    {
      forceApplyKeys: [input.key],
      appliedBy: "human_apply",
    },
  );
  const status = statusOf(
    { configVersion: snapshot.configVersion, documents: snapshot.documents, requirements: {} },
    input.key,
  );
  return {
    status: status?.applied?.sha256 === input.liveSha256 ? "applied" : "invalid",
    snapshot,
  } satisfies PoliciesApplyPendingResult;
});

const setApplyExternalEdits = Effect.fn("PoliciesRpc.setApplyExternalEdits")(function* (
  input: PoliciesSetApplyExternalEditsInput,
) {
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
  const policies = readPolicySettings(settings.ft3);
  const updated = readPolicySettings(
    (yield* serverSettings
      .updateSettings({
        ft3: withPolicySettings(settings.ft3, {
          ...policies,
          applyExternalEdits: input.enabled,
        }),
      })
      .pipe(Effect.orDie)).ft3,
  );
  const snapshot = yield* refreshWith(updated, [], null, undefined);
  return {
    enabled: updated.applyExternalEdits,
    snapshot,
  } satisfies PoliciesSetApplyExternalEditsResult;
});

/**
 * Changes where a policy document comes from (design §6.1): environment-wide
 * through `ft3.policies.documents`, or per project through the generic
 * `ft3PolicyDocuments` override, which `null` removes.
 */
const setDocument = Effect.fn("PoliciesRpc.setDocument")(function* (
  input: PoliciesSetDocumentInput,
) {
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
  const projectId = input.projectId ?? null;
  let policies;
  let override: { key: PolicyDocumentKey; source: PolicyDocumentSource } | null = null;

  if (projectId === null) {
    const current = readPolicySettings(settings.ft3);
    policies = readPolicySettings(
      (yield* serverSettings
        .updateSettings({
          ft3: withPolicySettings(settings.ft3, {
            ...current,
            documents: {
              ...current.documents,
              [input.key]: input.source ?? { kind: "builtin" },
            },
          }),
        })
        .pipe(Effect.orDie)).ft3,
    );
  } else {
    const overrides = settings.projectSettingsOverrides as Readonly<
      Record<string, { readonly ft3PolicyDocuments?: unknown } | undefined>
    >;
    const entry: Record<string, unknown> = { ...overrides[projectId] };
    if (input.source === null) {
      delete entry.ft3PolicyDocuments;
    } else {
      entry.ft3PolicyDocuments = { key: input.key, source: input.source };
      override = { key: input.key, source: input.source };
    }
    const updated = yield* serverSettings
      .updateSettings({ projectSettingsOverrides: { [projectId]: entry } })
      .pipe(Effect.orDie);
    policies = readPolicySettings(updated.ft3);
  }

  const snapshot = yield* refreshWith(policies, [], override, scopeFor(override, input.projectId), {
    forceApplyKeys: [input.key],
    appliedBy: "human_apply",
  });
  return { snapshot } satisfies PoliciesSetDocumentResult;
});

const setFeature = Effect.fn("PoliciesRpc.setFeature")(function* (input: PoliciesSetFeatureInput) {
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
  const current = readPolicySettings(settings.ft3);
  const updated = readPolicySettings(
    (yield* serverSettings
      .updateSettings({
        ft3: withPolicySettings(settings.ft3, {
          ...current,
          features: { ...current.features, [input.feature]: input.enabled },
        }),
      })
      .pipe(Effect.orDie)).ft3,
  );
  const snapshot = yield* refreshWith(updated, [], null, undefined);
  return { snapshot } satisfies PoliciesSetFeatureResult;
});

export const policiesRpcHandlers = {
  [FT3_POLICIES_WS_METHODS.policiesGetSnapshot]: getSnapshot,
  [FT3_POLICIES_WS_METHODS.policiesReadDocument]: readDocument,
  [FT3_POLICIES_WS_METHODS.policiesSaveDocument]: saveDocument,
  [FT3_POLICIES_WS_METHODS.policiesGetPendingChange]: getPendingChange,
  [FT3_POLICIES_WS_METHODS.policiesApplyPending]: applyPending,
  [FT3_POLICIES_WS_METHODS.policiesSetApplyExternalEdits]: setApplyExternalEdits,
  [FT3_POLICIES_WS_METHODS.policiesSetDocument]: setDocument,
  [FT3_POLICIES_WS_METHODS.policiesSetFeature]: setFeature,
};

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
} from "./rpc-contracts.ts";
import type { PolicyDocumentKey } from "./contracts.ts";

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

const resultOf = (snapshot: TrackerSnapshot, warnings: PoliciesGetSnapshotResult["warnings"]) =>
  ({
    configVersion: snapshot.configVersion,
    documents: snapshot.documents,
    warnings,
  }) satisfies PoliciesGetSnapshotResult;

const statusOf = (snapshot: TrackerSnapshot, key: PolicyDocumentKey) =>
  snapshot.documents.find((document) => document.key === key) ?? null;

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

const refreshWith = Effect.fn("PoliciesRpc.refreshWith")(function* (
  policies: ReturnType<typeof readPolicySettings>,
  warnings: PoliciesGetSnapshotResult["warnings"],
  extra: {
    readonly forceApplyKeys?: readonly PolicyDocumentKey[];
    readonly appliedBy?: "human_tab" | "human_apply" | "auto";
  } = {},
) {
  const tracker = yield* PolicyChangeTracker;
  const snapshot = yield* tracker.refresh({
    sources: resolvePolicyDocumentSources(policies, null),
    features: {
      board: policies.features.board,
      planning: policies.features.planning,
    },
    applyExternalEdits: policies.applyExternalEdits,
    ...extra,
  });
  return resultOf(snapshot, warnings);
});

const getSnapshot = Effect.fn("PoliciesRpc.getSnapshot")(function* (
  _input: PoliciesGetSnapshotInput,
) {
  const { policies, warnings } = yield* prepared;
  return yield* refreshWith(policies, warnings);
});

const readDocument = Effect.fn("PoliciesRpc.readDocument")(function* (
  input: PoliciesReadDocumentInput,
) {
  const { policies, warnings } = yield* prepared;
  yield* refreshWith(policies, warnings);
  const tracker = yield* PolicyChangeTracker;
  const live = yield* tracker.live(input.key);
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
  const { policies, warnings } = yield* prepared;
  const before = yield* refreshWith(policies, warnings);
  const tracker = yield* PolicyChangeTracker;
  const docs = yield* DocsService;
  const live = yield* tracker.live(input.key);
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

  const snapshot = yield* refreshWith(policies, warnings, {
    forceApplyKeys: [input.key],
    appliedBy: "human_tab",
  });
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
  const { policies, warnings } = yield* prepared;
  yield* refreshWith(policies, warnings);
  const tracker = yield* PolicyChangeTracker;
  const change = yield* tracker.pendingChange(input.key);
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
  const { policies, warnings } = yield* prepared;
  const before = yield* refreshWith(policies, warnings);
  const tracker = yield* PolicyChangeTracker;
  const pending = yield* tracker.pendingChange(input.key);
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

  const snapshot = yield* refreshWith(policies, warnings, {
    forceApplyKeys: [input.key],
    appliedBy: "human_apply",
  });
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
  const snapshot = yield* refreshWith(updated, []);
  return {
    enabled: updated.applyExternalEdits,
    snapshot,
  } satisfies PoliciesSetApplyExternalEditsResult;
});

export const policiesRpcHandlers = {
  [FT3_POLICIES_WS_METHODS.policiesGetSnapshot]: getSnapshot,
  [FT3_POLICIES_WS_METHODS.policiesReadDocument]: readDocument,
  [FT3_POLICIES_WS_METHODS.policiesSaveDocument]: saveDocument,
  [FT3_POLICIES_WS_METHODS.policiesGetPendingChange]: getPendingChange,
  [FT3_POLICIES_WS_METHODS.policiesApplyPending]: applyPending,
  [FT3_POLICIES_WS_METHODS.policiesSetApplyExternalEdits]: setApplyExternalEdits,
};

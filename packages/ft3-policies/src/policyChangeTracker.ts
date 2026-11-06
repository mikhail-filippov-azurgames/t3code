/**
 * Applied-versus-live policy versions (design §3.4): a live edit becomes applied
 * only on save, Apply, or `applyExternalEdits`; invalid content never replaces
 * the applied copy. Applied copies persist, so a restart never applies a pending
 * external edit silently.
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import {
  POLICY_DOCUMENT_KEYS,
  type PolicyDocumentKey,
  type PolicyDocumentSource,
  type PolicyRequirementId,
} from "./contracts.ts";
import { documentPendingIssue, policyInvalidKeptIssue, type PolicyIssue } from "./diagnostics.ts";
import { unifiedDiff } from "./policyDiff.ts";
import {
  type LoadedPolicyDocument,
  type LoadedPolicyFile,
  PolicyDocumentLoader,
  type PolicyFeatureRequest,
} from "./policyDocumentLoader.ts";
import {
  POLICY_ENVIRONMENT_SCOPE,
  type PolicyAppliedBy,
  PolicyAppliedStore,
} from "./policyAppliedStore.ts";

export interface PolicySyncInput {
  readonly sources: Readonly<Record<PolicyDocumentKey, PolicyDocumentSource>>;
  readonly features?: PolicyFeatureRequest;
  /** Design toggle, off by default: valid external edits apply without a click. */
  readonly applyExternalEdits?: boolean;
  /** Documents a save or Apply must re-apply even while the toggle is off. */
  readonly forceApplyKeys?: readonly PolicyDocumentKey[];
  /** Audit label of versions applied by this refresh. */
  readonly appliedBy?: PolicyAppliedBy;
  /**
   * Applied state is keyed by scope (design §10.4): "environment" or a
   * projectId. A project scope gets its own entries, applied copies and
   * configVersion, so a project override never replaces the environment's.
   */
  readonly scope?: string;
}

/** The version that serves routing and delegation right now. */
export interface PolicyAppliedVersion {
  readonly revision: number;
  readonly sha256: string;
  readonly appliedAt: string;
}

/** The version last read from the document, valid or not. */
export interface PolicySeenVersion {
  readonly revision: number | null;
  readonly sha256: string | null;
  readonly issues: readonly PolicyIssue[];
}

/** One file that differs between the applied copy and the live document. */
export interface PolicyPendingFile {
  readonly file: string;
  readonly appliedSha256: string | null;
  readonly liveSha256: string | null;
  /** Unified diff applied → live; empty when only one side exists and is empty. */
  readonly diff: string;
}

export interface PolicyPendingChange {
  readonly key: PolicyDocumentKey;
  readonly liveSha256: string | null;
  readonly valid: boolean;
  readonly issues: readonly PolicyIssue[];
  readonly files: readonly PolicyPendingFile[];
}

/** The live files of one document, as the Policies-tab editor reads them. */
export interface PolicyLiveDocument {
  readonly source: PolicyDocumentSource;
  readonly configured: boolean;
  readonly valid: boolean;
  readonly issues: readonly PolicyIssue[];
  readonly files: readonly LoadedPolicyFile[];
}

export interface PolicyDocumentStatus {
  readonly key: PolicyDocumentKey;
  readonly source: PolicyDocumentSource;
  readonly configured: boolean;
  readonly applied: PolicyAppliedVersion | null;
  readonly seen: PolicySeenVersion | null;
  /** Errors of the seen version, plus `policy_invalid_kept` when it was skipped. */
  readonly errors: readonly PolicyIssue[];
  readonly warnings: readonly PolicyIssue[];
  /** The seen version had errors and the applied one stayed active. */
  readonly kept: boolean;
  /** The live document differs from the applied one and waits for Apply. */
  readonly pending: boolean;
}

export interface PolicySnapshot {
  readonly configVersion: number;
  readonly documents: readonly PolicyDocumentStatus[];
  /** Requirement validity of the applied documents, for the feature registry. */
  readonly requirements: Readonly<Partial<Record<PolicyRequirementId, boolean>>>;
}

const REQUIREMENTS_BY_KEY: Readonly<Record<PolicyDocumentKey, readonly PolicyRequirementId[]>> = {
  routingPolicy: ["routingPolicy", "requestedRoles"],
  roles: ["rolesManifest", "leadRole", "plannerRole", "architectRole"],
  leadSkills: ["leadSkills", "planOrchestratorSkill"],
};

interface AppliedEntry {
  readonly revision: number;
  readonly sha256: string;
  readonly appliedAt: string;
  readonly document: LoadedPolicyDocument;
  readonly files: readonly LoadedPolicyFile[];
}

interface EntryState {
  readonly applied: AppliedEntry | null;
  readonly seen: PolicySeenVersion | null;
  readonly kept: boolean;
  readonly issues: readonly PolicyIssue[];
  readonly pending: PolicyPendingChange | null;
  readonly live: PolicyLiveDocument | null;
}

interface ScopeState {
  readonly entries: Readonly<Record<PolicyDocumentKey, EntryState | null>>;
  readonly sources: PolicySyncInput["sources"] | null;
  readonly configVersion: number;
  /** Applied copies of this scope were read from the database once. */
  readonly restored: boolean;
}

interface TrackerState {
  /** One isolated state per scope: the environment and each project override. */
  readonly scopes: Readonly<Record<string, ScopeState>>;
}

const emptyScope: ScopeState = {
  entries: { routingPolicy: null, roles: null, leadSkills: null },
  sources: null,
  configVersion: 0,
  restored: false,
};

const emptyEntry: EntryState = {
  applied: null,
  seen: null,
  kept: false,
  issues: [],
  pending: null,
  live: null,
};

const emptyState: TrackerState = { scopes: {} };

const scopeKey = (scope: string | undefined): string => scope ?? POLICY_ENVIRONMENT_SCOPE;

const scopeOf = (state: TrackerState, scope: string): ScopeState =>
  state.scopes[scope] ?? emptyScope;

const BUILTIN_SOURCES: Readonly<Record<PolicyDocumentKey, PolicyDocumentSource>> = {
  routingPolicy: { kind: "builtin" },
  roles: { kind: "builtin" },
  leadSkills: { kind: "builtin" },
};

const emptyRequirements = (): Record<PolicyRequirementId, boolean> => {
  const requirements = {} as Record<PolicyRequirementId, boolean>;
  for (const ids of Object.values(REQUIREMENTS_BY_KEY)) {
    for (const id of ids) requirements[id] = false;
  }
  return requirements;
};

const splitIssues = (issues: readonly PolicyIssue[]) => ({
  errors: issues.filter((issue) => issue.severity === "error"),
  warnings: issues.filter((issue) => issue.severity === "warning"),
});

const fileKey = (file: LoadedPolicyFile): string => file.file;

const sameFiles = (
  applied: readonly LoadedPolicyFile[],
  live: readonly LoadedPolicyFile[],
): boolean =>
  applied.length === live.length &&
  applied.every((file) =>
    live.some((other) => fileKey(other) === fileKey(file) && other.sha256 === file.sha256),
  );

const samePending = (
  before: PolicyPendingChange | null,
  after: PolicyPendingChange | null,
): boolean => {
  if (before === null || after === null) return before === after;
  return (
    before.liveSha256 === after.liveSha256 &&
    before.valid === after.valid &&
    before.files.length === after.files.length &&
    before.files.every((file) =>
      after.files.some(
        (other) =>
          other.file === file.file &&
          other.appliedSha256 === file.appliedSha256 &&
          other.liveSha256 === file.liveSha256,
      ),
    )
  );
};

const labelOf = (file: { readonly file: string; readonly relPath: string | null }): string =>
  file.relPath ?? (file.file === "" ? "document" : file.file);

const pendingFiles = (
  applied: readonly LoadedPolicyFile[],
  live: readonly LoadedPolicyFile[],
): readonly PolicyPendingFile[] => {
  const appliedByFile = new Map(applied.map((file) => [fileKey(file), file]));
  const liveByFile = new Map(live.map((file) => [fileKey(file), file]));
  const files = new Set([...appliedByFile.keys(), ...liveByFile.keys()]);
  const pending: PolicyPendingFile[] = [];
  for (const file of files) {
    const before = appliedByFile.get(file);
    const after = liveByFile.get(file);
    if (before !== undefined && after !== undefined && before.sha256 === after.sha256) continue;
    pending.push({
      file,
      appliedSha256: before?.sha256 ?? null,
      liveSha256: after?.sha256 ?? null,
      diff: unifiedDiff(
        before?.content ?? "",
        after?.content ?? "",
        labelOf(after ?? before ?? { file, relPath: null }),
      ),
    });
  }
  return pending;
};

const make = Effect.gen(function* () {
  const loader = yield* PolicyDocumentLoader;
  const appliedStore = yield* PolicyAppliedStore;
  const state = yield* Ref.make<TrackerState>(emptyState);
  const now = Effect.map(DateTime.now, DateTime.formatIso);

  const statusOf = (
    key: PolicyDocumentKey,
    source: PolicyDocumentSource,
    entry: EntryState,
  ): PolicyDocumentStatus => {
    const { errors, warnings } = splitIssues(entry.issues);
    return {
      key,
      source,
      configured: entry.applied?.document.configured ?? false,
      applied:
        entry.applied === null
          ? null
          : {
              revision: entry.applied.revision,
              sha256: entry.applied.sha256,
              appliedAt: entry.applied.appliedAt,
            },
      seen: entry.seen,
      errors,
      warnings,
      kept: entry.kept,
      pending: entry.pending !== null,
    };
  };

  const snapshotOf = (current: ScopeState): PolicySnapshot => {
    const requirements = emptyRequirements();
    const sources = current.sources ?? BUILTIN_SOURCES;
    const documents = POLICY_DOCUMENT_KEYS.map((key) => {
      const entry = current.entries[key] ?? emptyEntry;
      const applied = entry.applied;
      for (const id of REQUIREMENTS_BY_KEY[key]) {
        requirements[id] = applied?.document.requirements[id] === true;
      }
      return statusOf(key, sources[key], entry);
    });
    return { configVersion: current.configVersion, documents, requirements };
  };

  /** Reads persisted applied copies of one scope once, so a restart keeps the applied version. */
  const restore = Effect.fn("PolicyChangeTracker.restore")(function* (input: PolicySyncInput) {
    const scope = scopeKey(input.scope);
    const current = yield* Ref.get(state);
    if (scopeOf(current, scope).restored) return;
    const entries: Record<PolicyDocumentKey, EntryState | null> = {
      routingPolicy: null,
      roles: null,
      leadSkills: null,
    };
    for (const key of POLICY_DOCUMENT_KEYS) {
      const records = yield* appliedStore.load({ scope, key });
      const main = records.find((record) => record.file === "");
      if (main === undefined) {
        entries[key] = null;
        continue;
      }
      const files: readonly LoadedPolicyFile[] = records.map((record) => ({
        file: record.file,
        content: record.content,
        sha256: record.sha256,
        relPath: null,
        absolutePath: null,
        stableId: record.stableId,
      }));
      const parsed = yield* loader.parse({
        key,
        source: input.sources[key],
        files,
        ...(input.features === undefined ? {} : { features: input.features }),
      });
      entries[key] =
        parsed.document === null || parsed.revision === null
          ? null
          : {
              applied: {
                revision: parsed.revision,
                sha256: main.sha256,
                appliedAt: records.at(-1)?.appliedAt ?? "",
                document: parsed,
                files,
              },
              seen: null,
              kept: false,
              issues: [],
              pending: null,
              live: null,
            };
    }
    yield* Ref.update(state, (value) => {
      const scoped = scopeOf(value, scope);
      return {
        scopes: { ...value.scopes, [scope]: { ...scoped, entries, restored: true } },
      };
    });
  });

  const persist = Effect.fn("PolicyChangeTracker.persist")(function* (
    scope: string,
    key: PolicyDocumentKey,
    files: readonly LoadedPolicyFile[],
    timestamp: string,
    appliedBy: PolicyAppliedBy,
  ) {
    yield* appliedStore.save({
      scope,
      key,
      files: files.map((file) => ({
        file: file.file,
        sha256: file.sha256,
        content: file.content,
        stableId: file.stableId,
      })),
      appliedAt: timestamp,
      appliedBy,
    });
  });

  const refreshEntry = Effect.fn("PolicyChangeTracker.refreshEntry")(function* (
    input: PolicySyncInput,
    key: PolicyDocumentKey,
    timestamp: string,
  ) {
    const loaded = yield* loader.load({
      key,
      source: input.sources[key],
      ...(input.features === undefined ? {} : { features: input.features }),
    });
    const previous = scopeOf(yield* Ref.get(state), scopeKey(input.scope));
    const applied = previous.entries[key]?.applied ?? null;
    const revision = loaded.revision;
    const sha256 = loaded.sha256;
    const liveFiles = loaded.files;
    const valid = loaded.valid && loaded.document !== null && revision !== null && sha256 !== null;
    const unchanged = applied !== null && sameFiles(applied.files, liveFiles);
    const forced = input.forceApplyKeys?.includes(key) === true;
    const auto = input.applyExternalEdits === true;
    const applies = valid && (applied === null || unchanged || forced || auto);
    const live: PolicyLiveDocument = {
      source: input.sources[key],
      configured: loaded.configured,
      valid,
      issues: loaded.issues,
      files: liveFiles,
    };

    if (applies) {
      const appliedBy = forced ? (input.appliedBy ?? "human_apply") : "auto";
      const nextApplied: AppliedEntry =
        unchanged && applied !== null
          ? // Same files, but requirements depend on the current feature toggles.
            { ...applied, document: loaded }
          : {
              revision: revision ?? applied?.revision ?? 1,
              sha256: sha256 ?? "",
              appliedAt: timestamp,
              document: loaded,
              files: liveFiles,
            };
      if (!unchanged) yield* persist(scopeKey(input.scope), key, liveFiles, timestamp, appliedBy);
      return {
        changed: !unchanged,
        entry: {
          applied: nextApplied,
          seen: { revision, sha256, issues: loaded.issues },
          kept: false,
          issues: loaded.issues,
          pending: null,
          live,
        } satisfies EntryState,
      };
    }

    const kept = applied !== null && !valid;
    const pending =
      applied !== null && !unchanged && !auto && !forced
        ? {
            key,
            liveSha256: sha256,
            valid,
            issues: loaded.issues,
            files: pendingFiles(applied.files, liveFiles),
          }
        : null;
    const issues: PolicyIssue[] = [
      ...(kept && applied !== null ? [policyInvalidKeptIssue(key, applied.revision)] : []),
      ...(pending !== null ? [documentPendingIssue(key)] : []),
      ...loaded.issues,
    ];
    return {
      changed: false,
      entry: {
        applied,
        seen: { revision, sha256, issues: loaded.issues },
        kept,
        issues,
        pending,
        live,
      } satisfies EntryState,
    };
  });

  const refresh = Effect.fn("PolicyChangeTracker.refresh")(function* (input: PolicySyncInput) {
    yield* restore(input);
    const scope = scopeKey(input.scope);
    const timestamp = yield* now;
    const entries: Partial<Record<PolicyDocumentKey, EntryState>> = {};
    let changed = false;
    for (const key of POLICY_DOCUMENT_KEYS) {
      const result = yield* refreshEntry(input, key, timestamp);
      entries[key] = result.entry;
      changed = changed || result.changed;
    }
    const previous = scopeOf(yield* Ref.get(state), scope);
    // Pending-only transitions must also order command results against query refreshes in the tab.
    const pendingChanged = POLICY_DOCUMENT_KEYS.some(
      (key) => !samePending(previous.entries[key]?.pending ?? null, entries[key]?.pending ?? null),
    );
    const next: ScopeState = {
      entries: {
        routingPolicy: entries.routingPolicy ?? null,
        roles: entries.roles ?? null,
        leadSkills: entries.leadSkills ?? null,
      },
      sources: input.sources,
      configVersion:
        changed || pendingChanged || previous.configVersion === 0
          ? previous.configVersion + 1
          : previous.configVersion,
      restored: previous.restored,
    };
    yield* Ref.update(state, (value) => ({ scopes: { ...value.scopes, [scope]: next } }));
    return snapshotOf(next);
  });

  const snapshot = Effect.fn("PolicyChangeTracker.snapshot")(function* (scope?: string) {
    const current = yield* Ref.get(state);
    return snapshotOf(scopeOf(current, scopeKey(scope)));
  });

  const applied = Effect.fn("PolicyChangeTracker.applied")(function* (
    key: PolicyDocumentKey,
    scope?: string,
  ) {
    const current = yield* Ref.get(state);
    return scopeOf(current, scopeKey(scope)).entries[key]?.applied?.document ?? null;
  });

  const pendingChange = Effect.fn("PolicyChangeTracker.pendingChange")(function* (
    key: PolicyDocumentKey,
    scope?: string,
  ) {
    const current = yield* Ref.get(state);
    return scopeOf(current, scopeKey(scope)).entries[key]?.pending ?? null;
  });

  const live = Effect.fn("PolicyChangeTracker.live")(function* (
    key: PolicyDocumentKey,
    scope?: string,
  ) {
    const current = yield* Ref.get(state);
    return scopeOf(current, scopeKey(scope)).entries[key]?.live ?? null;
  });

  return PolicyChangeTracker.of({ refresh, snapshot, applied, pendingChange, live });
});

/**
 * Keeps one applied version per policy document and publishes it atomically:
 * the snapshot a caller sees never mixes a half-applied document set.
 * Applied state is isolated per scope: the environment and each project
 * override hold their own entries, applied copies and configVersion.
 */
export class PolicyChangeTracker extends Context.Service<
  PolicyChangeTracker,
  {
    readonly refresh: (input: PolicySyncInput) => Effect.Effect<PolicySnapshot, never, never>;
    readonly snapshot: (scope?: string) => Effect.Effect<PolicySnapshot, never, never>;
    readonly applied: (
      key: PolicyDocumentKey,
      scope?: string,
    ) => Effect.Effect<LoadedPolicyDocument | null, never, never>;
    /** The pending external change of one document in a scope, or null. */
    readonly pendingChange: (
      key: PolicyDocumentKey,
      scope?: string,
    ) => Effect.Effect<PolicyPendingChange | null, never, never>;
    /** The live files read by the last refresh of a scope. */
    readonly live: (
      key: PolicyDocumentKey,
      scope?: string,
    ) => Effect.Effect<PolicyLiveDocument | null, never, never>;
  }
>()("@t3tools/ft3-policies/policyChangeTracker") {}

export const layer: Layer.Layer<
  PolicyChangeTracker,
  never,
  PolicyDocumentLoader | PolicyAppliedStore
> = Layer.effect(PolicyChangeTracker, make);

/**
 * Runs `onRefresh` after every refresh, so state derived from the applied
 * documents follows Apply without a restart.
 */
export const withRefreshHook = (
  onRefresh: (tracker: PolicyChangeTracker["Service"]) => Effect.Effect<void>,
): Layer.Layer<PolicyChangeTracker, never, PolicyChangeTracker> =>
  Layer.effect(
    PolicyChangeTracker,
    Effect.gen(function* () {
      const inner = yield* PolicyChangeTracker;
      return PolicyChangeTracker.of({
        ...inner,
        refresh: Effect.fn("PolicyChangeTracker.refreshWithHook")(function* (
          input: PolicySyncInput,
        ) {
          const snapshot = yield* inner.refresh(input);
          yield* onRefresh(inner);
          return snapshot;
        }),
      });
    }),
  );

/**
 * The `oc://doc` link of the applied routing policy when the store serves it.
 * Empty for a builtin, a path or no applied version, and when no tracker runs.
 */
export const appliedRoutingPolicyRef: Effect.Effect<string> = Effect.gen(function* () {
  const tracker = yield* Effect.serviceOption(PolicyChangeTracker);
  if (Option.isNone(tracker)) return "";
  const snapshot = yield* tracker.value.snapshot();
  const routing = snapshot.documents.find((document) => document.key === "routingPolicy");
  const source = routing?.source;
  if (routing?.applied == null || source?.kind !== "doc" || source.address.kind !== "id") {
    return "";
  }
  return `oc://doc/${source.address.stableId}`;
});

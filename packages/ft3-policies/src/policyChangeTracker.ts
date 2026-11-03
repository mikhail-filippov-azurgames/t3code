/**
 * Applied-versus-live policy versions. A refresh loads the live documents and
 * replaces an applied version only when the new one parses without errors; an
 * invalid version leaves the applied one serving and records
 * `policy_invalid_kept` next to the line errors.
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  POLICY_DOCUMENT_KEYS,
  type PolicyDocumentKey,
  type PolicyDocumentSource,
  type PolicyRequirementId,
} from "./contracts.ts";
import { policyInvalidKeptIssue, type PolicyIssue } from "./diagnostics.ts";
import {
  type LoadedPolicyDocument,
  PolicyDocumentLoader,
  type PolicyFeatureRequest,
} from "./policyDocumentLoader.ts";

export interface PolicySyncInput {
  readonly sources: Readonly<Record<PolicyDocumentKey, PolicyDocumentSource>>;
  readonly features?: PolicyFeatureRequest;
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
}

interface EntryState {
  readonly applied: AppliedEntry | null;
  readonly seen: PolicySeenVersion | null;
  readonly kept: boolean;
  readonly issues: readonly PolicyIssue[];
}

interface TrackerState {
  readonly entries: Readonly<Record<PolicyDocumentKey, EntryState | null>>;
  readonly sources: PolicySyncInput["sources"] | null;
  readonly configVersion: number;
}

const emptyState: TrackerState = {
  entries: { routingPolicy: null, roles: null, leadSkills: null },
  sources: null,
  configVersion: 0,
};

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

const make = Effect.gen(function* () {
  const loader = yield* PolicyDocumentLoader;
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
    };
  };

  const snapshotOf = (current: TrackerState): PolicySnapshot => {
    const requirements = emptyRequirements();
    const sources = current.sources ?? BUILTIN_SOURCES;
    const documents = POLICY_DOCUMENT_KEYS.map((key) => {
      const entry = current.entries[key];
      const applied = entry?.applied ?? null;
      for (const id of REQUIREMENTS_BY_KEY[key]) {
        requirements[id] = applied?.document.requirements[id] === true;
      }
      return statusOf(
        key,
        sources[key],
        entry ?? { applied: null, seen: null, kept: false, issues: [] },
      );
    });
    return { configVersion: current.configVersion, documents, requirements };
  };

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
    const previous = yield* Ref.get(state);
    const applied = previous.entries[key]?.applied ?? null;
    const revision = loaded.revision;
    const sha256 = loaded.sha256;
    const applies =
      loaded.valid && loaded.document !== null && revision !== null && sha256 !== null;

    if (applies) {
      const unchanged =
        applied !== null && applied.sha256 === sha256 && applied.revision === revision;
      const nextApplied = unchanged
        ? applied
        : { revision, sha256, appliedAt: timestamp, document: loaded };
      return {
        changed: !unchanged,
        entry: {
          applied: nextApplied,
          seen: { revision, sha256, issues: loaded.issues },
          kept: false,
          issues: loaded.issues,
        } satisfies EntryState,
      };
    }

    const kept = applied !== null;
    const issues = kept
      ? [policyInvalidKeptIssue(key, applied.revision), ...loaded.issues]
      : loaded.issues;
    return {
      changed: false,
      entry: {
        applied,
        seen: { revision, sha256, issues: loaded.issues },
        kept,
        issues,
      } satisfies EntryState,
    };
  });

  const refresh = Effect.fn("PolicyChangeTracker.refresh")(function* (input: PolicySyncInput) {
    const timestamp = yield* now;
    const entries: Partial<Record<PolicyDocumentKey, EntryState>> = {};
    let changed = false;
    for (const key of POLICY_DOCUMENT_KEYS) {
      const result = yield* refreshEntry(input, key, timestamp);
      entries[key] = result.entry;
      changed = changed || result.changed;
    }
    const previous = yield* Ref.get(state);
    const next: TrackerState = {
      entries: {
        routingPolicy: entries.routingPolicy ?? null,
        roles: entries.roles ?? null,
        leadSkills: entries.leadSkills ?? null,
      },
      sources: input.sources,
      configVersion:
        changed || previous.configVersion === 0
          ? previous.configVersion + 1
          : previous.configVersion,
    };
    yield* Ref.set(state, next);
    return snapshotOf(next);
  });

  const snapshot = Effect.fn("PolicyChangeTracker.snapshot")(function* () {
    const current = yield* Ref.get(state);
    return snapshotOf(current);
  });

  const applied = Effect.fn("PolicyChangeTracker.applied")(function* (key: PolicyDocumentKey) {
    const current = yield* Ref.get(state);
    return current.entries[key]?.applied?.document ?? null;
  });

  return PolicyChangeTracker.of({ refresh, snapshot, applied });
});

/**
 * Keeps one applied version per policy document and publishes it atomically:
 * the snapshot a caller sees never mixes a half-applied document set.
 */
export class PolicyChangeTracker extends Context.Service<
  PolicyChangeTracker,
  {
    readonly refresh: (input: PolicySyncInput) => Effect.Effect<PolicySnapshot, never, never>;
    readonly snapshot: () => Effect.Effect<PolicySnapshot, never, never>;
    readonly applied: (
      key: PolicyDocumentKey,
    ) => Effect.Effect<LoadedPolicyDocument | null, never, never>;
  }
>()("@t3tools/ft3-policies/policyChangeTracker") {}

export const layer: Layer.Layer<PolicyChangeTracker, never, PolicyDocumentLoader> = Layer.effect(
  PolicyChangeTracker,
  make,
);

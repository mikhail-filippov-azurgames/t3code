/**
 * The applied routing policy as a candidate chain: the role's cell for the task
 * level, resolved through the alias tables, with `alias@level` pinning a
 * candidate's options to a fixed level. Only the normal service tier is handed
 * out; accelerated model ids are skipped and accelerated tier options replaced.
 */
import type { ProviderOptionSelection } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { PolicyChangeTracker } from "./policyChangeTracker.ts";
import type { LoadedRoutingPolicyDocument } from "./policyDocumentLoader.ts";
import {
  type RoutingLevel,
  type RoutingOptions,
  type RoutingOptionValue,
  type RoutingPolicy,
  type RoutingProvider,
  type RoutingRoleId,
} from "./routingPolicy.ts";

/** Options for one resolved candidate, in the shape a model selection carries. */
export type RoutingOptionSelections = readonly ProviderOptionSelection[];

export interface RoutingResolvedCandidate {
  readonly alias: string;
  readonly provider: RoutingProvider;
  readonly model: string;
  /** The level whose alias options apply; `alias@level` pins it, else the task level. */
  readonly level: RoutingLevel;
  readonly options: RoutingOptionSelections;
}

export type RoutingSkipReason = "alias_unknown" | "accelerated_model" | "unavailable";

export interface RoutingSkippedCandidate {
  readonly alias: string;
  readonly model: string | null;
  readonly reason: RoutingSkipReason;
}

export interface RoutingChain {
  readonly role: RoutingRoleId;
  readonly level: RoutingLevel;
  readonly candidates: readonly RoutingResolvedCandidate[];
  readonly skipped: readonly RoutingSkippedCandidate[];
}

export interface RoutingResolution extends RoutingChain {
  /** The applied policy version the chain came from. */
  readonly policy: {
    readonly revision: number;
    readonly sha256: string | null;
  };
}

export interface RoutingSelection extends RoutingResolution {
  /** The candidate a delegation would start with; null when none is left. */
  readonly selected: RoutingResolvedCandidate | null;
}

export interface RoutingResolveInput {
  readonly role: RoutingRoleId;
  readonly level: RoutingLevel;
}

export interface RoutingSelectInput extends RoutingResolveInput {
  /** Identifies the delegation the usage is recorded for. */
  readonly delegationId: string;
}

/** Live-catalog check; a model the provider does not offer is skipped. */
export interface RoutingCatalogPort {
  readonly available: (input: {
    readonly instanceId: string;
    readonly driverKind: string;
    readonly model: string;
  }) => Effect.Effect<boolean, never, never>;
}

/** The accelerated suffix the parser warns about; such a model is never run. */
const ACCELERATED_MODEL_SUFFIX = "-highspeed";

export const isAcceleratedModel = (model: string): boolean =>
  model.toLowerCase().endsWith(ACCELERATED_MODEL_SUFFIX);

/**
 * Option ids that request a service tier or speed. Reasoning effort, model
 * variant and every other option are left alone.
 */
const TIER_OPTION_IDS: ReadonlySet<string> = new Set([
  "servicetier",
  "servicetierforturn",
  "fastmode",
  "priority",
  "fast",
  "speed",
]);

const NORMAL_TIER_OPTIONS: Readonly<Record<string, RoutingOptionValue>> = {
  servicetier: "default",
  servicetierforturn: "default",
  fastmode: false,
  priority: false,
  fast: false,
  speed: "normal",
};

const isTierOption = (id: string): boolean => TIER_OPTION_IDS.has(id.toLowerCase());

const isNormalTierValue = (id: string, value: RoutingOptionValue): boolean =>
  NORMAL_TIER_OPTIONS[id.toLowerCase()] === value;

/** The provider's normal tier is forced; every other provider gets no tier option at all. */
const NORMAL_TIER_BY_DRIVER: Readonly<Record<string, ProviderOptionSelection>> = {
  codex: { id: "serviceTier", value: "default" },
  claudeAgent: { id: "fastMode", value: false },
};

export interface NormalServiceResult {
  readonly options: RoutingOptionSelections;
  /** Tier option ids the request asked for and the policy replaced or dropped. */
  readonly removed: readonly string[];
  /** The request asked for an accelerated tier; the result is normal anyway. */
  readonly accelerated: boolean;
}

export interface NormalServiceSelectionResult {
  readonly selection: {
    readonly instanceId: string;
    readonly model: string;
    readonly options: RoutingOptionSelections;
  };
  readonly removed: readonly string[];
  readonly accelerated: boolean;
}

/**
 * The candidate's options with the normal service tier applied. A request for
 * `fast`, `priority` or `highspeed` never reaches the provider.
 */
export function normalServiceOptions(
  driverKind: string,
  options: RoutingOptions,
): NormalServiceResult {
  const removed: string[] = [];
  let accelerated = false;
  const kept: ProviderOptionSelection[] = [];
  for (const [id, value] of Object.entries(options)) {
    if (!isTierOption(id)) {
      kept.push({ id, value });
      continue;
    }
    removed.push(id);
    if (!isNormalTierValue(id, value)) accelerated = true;
  }
  const forced = NORMAL_TIER_BY_DRIVER[driverKind];
  if (forced !== undefined) kept.push(forced);
  return { options: kept, removed, accelerated };
}

/**
 * The applied routing policy as a service: what a role and task level resolve
 * to right now, and the same chain recorded against the delegation.
 */
export class RoutingPolicyService extends Context.Service<
  RoutingPolicyService,
  {
    /** Null when no routing policy version is applied. */
    readonly resolve: (
      input: RoutingResolveInput,
    ) => Effect.Effect<RoutingResolution | null, never, never>;
    /** Resolves and records which policy revision and candidate were used. */
    readonly select: (
      input: RoutingSelectInput,
    ) => Effect.Effect<RoutingSelection | null, never, never>;
  }
>()("@t3tools/ft3-policies/routing/RoutingPolicyService") {}

export interface RoutingPolicyServiceOptions {
  readonly catalog?: RoutingCatalogPort;
}

export interface PolicyUsageEntry {
  readonly delegationId: string;
  readonly role: RoutingRoleId;
  readonly level: RoutingLevel;
  readonly policy: {
    readonly revision: number;
    readonly sha256: string | null;
  };
  readonly candidate: RoutingResolvedCandidate | null;
  readonly outcome: "selected" | "no_candidate";
}

/**
 * Records delegation evidence in `ft3_policy_delegations`. Persistence must not
 * fail a routing decision, so a failed insert is logged and the run continues.
 */
export class PolicyUsageRecorder extends Context.Service<
  PolicyUsageRecorder,
  {
    readonly record: (entry: PolicyUsageEntry) => Effect.Effect<void, never, never>;
  }
>()("@t3tools/ft3-policies/routing/PolicyUsageRecorder") {}

export const noopPolicyUsageRecorderLayer: Layer.Layer<PolicyUsageRecorder> = Layer.succeed(
  PolicyUsageRecorder,
  { record: Effect.fn("PolicyUsageRecorder.record")(() => Effect.void) },
);

export interface InMemoryPolicyUsageRecorder {
  readonly layer: Layer.Layer<PolicyUsageRecorder>;
  readonly entries: () => readonly PolicyUsageEntry[];
}

/** Keeps recorded usage in a list, so a caller or test can read it back. */
export const inMemoryPolicyUsageRecorder = (): InMemoryPolicyUsageRecorder => {
  const entries: PolicyUsageEntry[] = [];
  return {
    layer: Layer.succeed(PolicyUsageRecorder, {
      record: Effect.fn("PolicyUsageRecorder.record")((entry: PolicyUsageEntry) =>
        Effect.sync(() => {
          entries.push(entry);
        }),
      ),
    }),
    entries: () => entries,
  };
};

/** Persists recorded usage for the `10_PolicyUsage` table. */
export const sqlPolicyUsageRecorderLayer: Layer.Layer<
  PolicyUsageRecorder,
  never,
  SqlClient.SqlClient
> = Layer.effect(
  PolicyUsageRecorder,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return PolicyUsageRecorder.of({
      record: Effect.fn("PolicyUsageRecorder.record")(function* (entry: PolicyUsageEntry) {
        const recordedAt = DateTime.formatIso(yield* DateTime.now);
        const candidate = entry.candidate;
        yield* sql`INSERT INTO ft3_policy_delegations (
            delegation_id, role, level, policy_revision, policy_sha256, outcome,
            candidate_alias, candidate_model, candidate_level,
            candidate_provider_instance_id, candidate_provider_driver_kind, recorded_at
          ) VALUES (
            ${entry.delegationId}, ${entry.role}, ${entry.level}, ${entry.policy.revision},
            ${entry.policy.sha256}, ${entry.outcome}, ${candidate?.alias ?? null},
            ${candidate?.model ?? null}, ${candidate?.level ?? null},
            ${candidate?.provider.instanceId ?? null},
            ${candidate?.provider.driverKind ?? null}, ${recordedAt}
          )`.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Policy usage was not recorded", { cause }),
          ),
        );
      }),
    });
  }),
);

/** Normal-service policy as a service, so every create and override goes through one place. */
export class NormalServicePolicy extends Context.Service<
  NormalServicePolicy,
  {
    readonly normalizeOptions: (driverKind: string, options: RoutingOptions) => NormalServiceResult;
    readonly normalizeSelection: (input: {
      readonly driverKind: string;
      readonly instanceId: string;
      readonly model: string;
      readonly options?: RoutingOptionSelections;
    }) => NormalServiceSelectionResult;
    readonly isAcceleratedModel: (model: string) => boolean;
  }
>()("@t3tools/ft3-policies/routing/NormalServicePolicy") {}

const optionsRecord = (options: RoutingOptionSelections): RoutingOptions => {
  const record: Record<string, RoutingOptionValue> = {};
  for (const option of options) record[option.id] = option.value;
  return record;
};

const normalizeSelection = (input: {
  readonly driverKind: string;
  readonly instanceId: string;
  readonly model: string;
  readonly options?: RoutingOptionSelections;
}): NormalServiceSelectionResult => {
  const normalized = normalServiceOptions(input.driverKind, optionsRecord(input.options ?? []));
  return {
    selection: {
      instanceId: input.instanceId,
      model: input.model,
      options: normalized.options,
    },
    removed: normalized.removed,
    accelerated: normalized.accelerated,
  };
};

export const normalServicePolicyLayer: Layer.Layer<NormalServicePolicy> = Layer.succeed(
  NormalServicePolicy,
  {
    normalizeOptions: normalServiceOptions,
    normalizeSelection,
    isAcceleratedModel,
  },
);

/**
 * The ordered chain of the cell for `role` and `level`, without availability
 * checks: alias lookup, `alias@level` options and the tier rule only.
 */
export function resolveRoutingCandidates(
  policy: RoutingPolicy,
  input: RoutingResolveInput,
  normalizeOptions: (
    driverKind: string,
    options: RoutingOptions,
  ) => NormalServiceResult = normalServiceOptions,
): RoutingChain {
  const candidates: RoutingResolvedCandidate[] = [];
  const skipped: RoutingSkippedCandidate[] = [];
  const aliases = new Map(policy.aliases.map((alias) => [alias.alias, alias]));

  for (const candidate of policy.roles[input.role]?.[input.level] ?? []) {
    const target = aliases.get(candidate.alias);
    if (target === undefined) {
      skipped.push({ alias: candidate.alias, model: null, reason: "alias_unknown" });
      continue;
    }
    if (isAcceleratedModel(target.model)) {
      skipped.push({ alias: candidate.alias, model: target.model, reason: "accelerated_model" });
      continue;
    }
    const level = candidate.level ?? input.level;
    const normalized = normalizeOptions(target.provider.driverKind, target.options[level]);
    candidates.push({
      alias: target.alias,
      provider: target.provider,
      model: target.model,
      level,
      options: normalized.options,
    });
  }

  return { role: input.role, level: input.level, candidates, skipped };
}

const appliedRevision = (applied: LoadedRoutingPolicyDocument): number =>
  applied.revision ?? applied.document?.revision ?? 0;

const make = Effect.fn("RoutingPolicyService.make")(function* (
  options: RoutingPolicyServiceOptions,
) {
  const tracker = yield* PolicyChangeTracker;
  const normalService = yield* NormalServicePolicy;
  const recorder = yield* PolicyUsageRecorder;

  const resolve = Effect.fn("RoutingPolicyService.resolve")(function* (input: RoutingResolveInput) {
    const applied = yield* tracker.applied("routingPolicy");
    if (applied === null || applied.key !== "routingPolicy" || applied.document === null) {
      return null;
    }
    const policy: RoutingPolicy = applied.document;
    const chain = resolveRoutingCandidates(policy, input, normalService.normalizeOptions);
    const candidates: RoutingResolvedCandidate[] = [];
    const skipped = [...chain.skipped];
    for (const candidate of chain.candidates) {
      if (options.catalog !== undefined) {
        const available = yield* options.catalog.available({
          instanceId: candidate.provider.instanceId,
          driverKind: candidate.provider.driverKind,
          model: candidate.model,
        });
        if (!available) {
          skipped.push({ alias: candidate.alias, model: candidate.model, reason: "unavailable" });
          continue;
        }
      }
      candidates.push(candidate);
    }
    return {
      role: input.role,
      level: input.level,
      candidates,
      skipped,
      policy: { revision: appliedRevision(applied), sha256: applied.sha256 },
    } satisfies RoutingResolution;
  });

  const select = Effect.fn("RoutingPolicyService.select")(function* (input: RoutingSelectInput) {
    const resolution = yield* resolve(input);
    if (resolution === null) return null;
    const selected = resolution.candidates[0] ?? null;
    yield* recorder.record({
      delegationId: input.delegationId,
      role: input.role,
      level: input.level,
      policy: resolution.policy,
      candidate: selected,
      outcome: selected === null ? "no_candidate" : "selected",
    });
    return { ...resolution, selected } satisfies RoutingSelection;
  });

  return RoutingPolicyService.of({ resolve, select });
});

export const routingPolicyServiceLayer = (
  options: RoutingPolicyServiceOptions = {},
): Layer.Layer<
  RoutingPolicyService,
  never,
  PolicyChangeTracker | NormalServicePolicy | PolicyUsageRecorder
> => Layer.effect(RoutingPolicyService, make(options));

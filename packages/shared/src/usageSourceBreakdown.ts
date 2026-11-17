import {
  type EnvironmentId,
  USAGE_CONTRACT_VERSION,
  type UsageBucket,
  type UsageProviderKind,
  type UsageSource,
  type UsageSourceFingerprint,
  type UsageSummary,
} from "@t3tools/contracts";

import {
  bucketsForSource,
  claimSources,
  type EnvironmentUsage,
  isCompatibleUsageContractVersion,
  ownedContribution,
  sourceIdentity,
} from "./usageMerge.ts";

export interface UsageSourceLabel {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: string;
  readonly displayName?: string;
}

export interface UsageBreakdownTotals {
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly records: number;
  readonly unpricedRecords: number;
  readonly sessions: number;
}

export interface UsageSourceRow extends UsageBreakdownTotals {
  /** Identity shared by every environment reading this directory. */
  readonly key: string;
  readonly fingerprint: UsageSourceFingerprint;
  readonly instances: readonly UsageSourceLabel[];
}

export interface ProviderSourceBreakdown {
  readonly provider: UsageProviderKind;
  /** Labeled sources; empty when no source of this provider carries instances. */
  readonly rows: readonly UsageSourceRow[];
  /** Unlabeled sources and legacy buckets no single source owns; rows plus this equal the provider total. */
  readonly unattributed: UsageBreakdownTotals;
}

interface Accumulator {
  costUsd: number;
  totalTokens: number;
  records: number;
  unpricedRecords: number;
  sessions: number;
}

const emptyTotals = (): Accumulator => ({
  costUsd: 0,
  totalTokens: 0,
  records: 0,
  unpricedRecords: 0,
  sessions: 0,
});

function addBucket(target: Accumulator, bucket: UsageBucket): void {
  target.costUsd += bucket.costUsd;
  // reasoningTokens is a subset of outputTokens, as in mergeUsage.
  target.totalTokens +=
    bucket.totals.uncachedInputTokens +
    bucket.totals.cachedInputTokens +
    bucket.totals.cacheCreationTokens +
    bucket.totals.outputTokens;
  target.records += bucket.records;
  target.unpricedRecords += bucket.unpricedRecords;
}

/** Splits each provider's mergeUsage totals by labeled source, applying the same ownership rules. */
export function usageSourceBreakdown(
  environments: readonly EnvironmentUsage[],
  expectedContractVersion: number,
): ReadonlyMap<UsageProviderKind, ProviderSourceBreakdown> {
  const current = environments.filter((environment) =>
    isCompatibleUsageContractVersion(environment.summary.contractVersion, expectedContractVersion),
  );
  const sourceKey = sourceIdentity(current);
  const { ownerScanByFingerprint, supplementalBucketsByEnvironment, sessionsByFingerprint } =
    claimSources(current, sourceKey);

  const labels = new Map<string, UsageSourceLabel[]>();
  const fingerprints = new Map<string, UsageSourceFingerprint>();
  for (const environment of current) {
    for (const source of environment.summary.sources) {
      const key = sourceKey(source.fingerprint);
      if (!fingerprints.has(key)) fingerprints.set(key, source.fingerprint);
      for (const instance of source.instances ?? []) {
        const list = labels.get(key) ?? [];
        labels.set(key, list);
        if (
          list.some(
            (entry) =>
              entry.environmentId === environment.environmentId &&
              entry.instanceId === instance.instanceId,
          )
        ) {
          continue;
        }
        list.push({
          environmentId: environment.environmentId,
          environmentLabel: environment.label,
          instanceId: instance.instanceId,
          ...(instance.displayName === undefined ? {} : { displayName: instance.displayName }),
        });
      }
    }
  }
  for (const [key, owner] of ownerScanByFingerprint)
    fingerprints.set(key, owner.source.fingerprint);

  const bySource = new Map<string, Accumulator>();
  const unattributed = new Map<UsageProviderKind, Accumulator>();
  const providers = new Set<UsageProviderKind>();
  const target = (provider: UsageProviderKind, key: string | undefined): Accumulator => {
    providers.add(provider);
    if (key !== undefined && labels.has(key)) {
      const totals = bySource.get(key) ?? emptyTotals();
      bySource.set(key, totals);
      return totals;
    }
    const totals = unattributed.get(provider) ?? emptyTotals();
    unattributed.set(provider, totals);
    return totals;
  };

  for (const environment of current) {
    const supplemental =
      supplementalBucketsByEnvironment.get(environment.environmentId) ?? new Set();
    const { buckets } = ownedContribution(
      environment,
      ownerScanByFingerprint,
      supplemental,
      sessionsByFingerprint,
      sourceKey,
    );
    const owned: UsageSource[] = [];
    for (const source of environment.summary.sources) {
      if (source.status === "missing") continue;
      const key = sourceKey(source.fingerprint);
      if (ownerScanByFingerprint.get(key)?.source !== source) continue;
      owned.push(source);
      target(source.fingerprint.provider, key).sessions +=
        sessionsByFingerprint.get(key) ?? source.distinctSessions;
    }
    const supplementalOwner = new Map<UsageBucket, string>();
    for (const source of environment.summary.sources) {
      if (source.status !== "partial") continue;
      for (const bucket of bucketsForSource(environment.summary, source)) {
        if (supplemental.has(bucket) && !supplementalOwner.has(bucket)) {
          supplementalOwner.set(bucket, sourceKey(source.fingerprint));
        }
      }
    }
    for (const bucket of buckets) {
      let key = supplementalOwner.get(bucket);
      if (key === undefined) {
        const providerSources = environment.summary.sources.filter(
          (source) => source.fingerprint.provider === bucket.provider,
        );
        const source =
          bucket.sourcePath === undefined
            ? providerSources.length === 1
              ? providerSources[0]
              : undefined
            : owned.find(
                (entry) =>
                  entry.fingerprint.provider === bucket.provider &&
                  entry.fingerprint.resolvedHomePath === bucket.sourcePath,
              );
        key = source === undefined ? undefined : sourceKey(source.fingerprint);
      }
      addBucket(target(bucket.provider, key), bucket);
    }
  }

  const rowsByProvider = new Map<UsageProviderKind, UsageSourceRow[]>();
  for (const [key, instances] of labels) {
    const fingerprint = fingerprints.get(key)!;
    providers.add(fingerprint.provider);
    const rows = rowsByProvider.get(fingerprint.provider) ?? [];
    rowsByProvider.set(fingerprint.provider, rows);
    rows.push({ key, fingerprint, instances, ...(bySource.get(key) ?? emptyTotals()) });
  }

  const result = new Map<UsageProviderKind, ProviderSourceBreakdown>();
  for (const provider of providers) {
    result.set(provider, {
      provider,
      rows: (rowsByProvider.get(provider) ?? []).sort(
        (a, b) =>
          b.costUsd - a.costUsd || b.totalTokens - a.totalTokens || a.key.localeCompare(b.key),
      ),
      unattributed: unattributed.get(provider) ?? emptyTotals(),
    });
  }
  return result;
}

export interface UsageSourceDisplayRow extends UsageBreakdownTotals {
  readonly key: string;
  readonly label: string;
  readonly unattributed: boolean;
}

export const UNATTRIBUTED_SOURCE_LABEL = "Other";

/** Names a source by its instances; the environment is added when names come from several. */
export function sourceRowLabel(instances: readonly UsageSourceLabel[]): string {
  const environments = new Set(instances.map((instance) => instance.environmentId));
  const names = instances.map((instance) => {
    const name = instance.displayName ?? instance.instanceId;
    return environments.size > 1 ? `${name} (${instance.environmentLabel})` : name;
  });
  return [...new Set(names)].join(", ");
}

/** Rows under a provider; none when no source carries an instance label. */
export function usageSourceRows(
  breakdown: ProviderSourceBreakdown | undefined,
): readonly UsageSourceDisplayRow[] {
  if (breakdown === undefined || breakdown.rows.length === 0) return [];
  const rows: UsageSourceDisplayRow[] = breakdown.rows.map(({ key, instances, ...totals }) => ({
    key,
    label: sourceRowLabel(instances),
    unattributed: false,
    costUsd: totals.costUsd,
    totalTokens: totals.totalTokens,
    records: totals.records,
    unpricedRecords: totals.unpricedRecords,
    sessions: totals.sessions,
  }));
  const rest = breakdown.unattributed;
  if (rest.records > 0 || rest.sessions > 0 || rest.costUsd !== 0 || rest.totalTokens > 0) {
    rows.push({
      key: "\u0000unattributed",
      label: UNATTRIBUTED_SOURCE_LABEL,
      unattributed: true,
      ...rest,
    });
  }
  return rows;
}

/** Breakdown over the environments that answered, matching the page's merged totals. */
export function answeredSourceBreakdown(
  environments: readonly {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly summary: UsageSummary | null;
  }[],
): ReadonlyMap<UsageProviderKind, ProviderSourceBreakdown> {
  return usageSourceBreakdown(
    environments.flatMap(({ environmentId, label, summary }) =>
      summary === null ? [] : [{ environmentId, label, summary }],
    ),
    USAGE_CONTRACT_VERSION,
  );
}

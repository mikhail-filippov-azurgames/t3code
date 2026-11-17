import {
  type EnvironmentId,
  USAGE_CONTRACT_VERSION,
  type UsageProviderKind,
  type UsageSummary,
} from "@t3tools/contracts";
import {
  type ProviderSourceBreakdown,
  type UsageBreakdownTotals,
  type UsageSourceLabel,
  usageSourceBreakdown,
} from "@t3tools/shared/usageSourceBreakdown";

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

import type { UsageProviderKind } from "@t3tools/contracts";

import { PROVIDER_ORDER, rankProvidersByMetric } from "~/components/usage/usageProviders";

export { rankProvidersByMetric };

/** Providers with tokens in the selected window, in display order; zero-token providers are hidden. */
export function providersForWindow(
  totals: readonly {
    readonly provider: UsageProviderKind;
    readonly costUsd: number;
    readonly totalTokens: number;
  }[],
): readonly UsageProviderKind[] {
  const visible = new Set(
    totals.filter((entry) => entry.totalTokens > 0).map((entry) => entry.provider),
  );
  return PROVIDER_ORDER.filter((provider) => visible.has(provider));
}

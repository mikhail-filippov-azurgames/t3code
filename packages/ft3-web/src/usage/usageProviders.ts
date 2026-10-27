import type { UsageProviderKind } from "@t3tools/contracts";

import { PROVIDER_ORDER, providersWithUsage } from "~/components/usage/usageProviders";

/**
 * A provider whose scan reported a source is configured for this environment,
 * so its column stays put even when the selected window has no events;
 * otherwise every window change reshuffles the page and a provider looks
 * broken rather than idle.
 */
export function providersForWindow(
  totals: readonly {
    readonly provider: UsageProviderKind;
    readonly costUsd: number;
    readonly totalTokens: number;
  }[],
  reported: Iterable<UsageProviderKind>,
): readonly UsageProviderKind[] {
  const visible = new Set(providersWithUsage(totals));
  for (const provider of reported) visible.add(provider);
  return PROVIDER_ORDER.filter((provider) => visible.has(provider));
}

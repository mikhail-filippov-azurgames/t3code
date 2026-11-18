import { describe, expect, it } from "vite-plus/test";

import { PROVIDER_ORDER, providersWithUsage } from "~/components/usage/usageProviders";

import { providersForWindow, rankProvidersByMetric } from "./usageProviders";

describe("providersForWindow", () => {
  it("hides providers with zero tokens and keeps PROVIDER_ORDER", () => {
    const totals = [
      { provider: "kimi" as const, costUsd: 0, totalTokens: 50 },
      { provider: "codex" as const, costUsd: 0, totalTokens: 100 },
      { provider: "claude" as const, costUsd: 5, totalTokens: 0 },
      { provider: "grok" as const, costUsd: 0, totalTokens: 0 },
    ];

    expect(providersForWindow(totals)).toEqual(
      PROVIDER_ORDER.filter((provider) => provider === "codex" || provider === "kimi"),
    );
  });

  it("returns no providers for an empty window", () => {
    expect(providersForWindow([])).toEqual([]);
  });
});

describe("providersWithUsage", () => {
  it("keeps a cost-only provider without tokens visible", () => {
    const totals = [
      { provider: "claude" as const, costUsd: 5, totalTokens: 0 },
      { provider: "grok" as const, costUsd: 0, totalTokens: 0 },
    ];

    expect(providersWithUsage(totals)).toEqual(["claude"]);
  });
});

describe("rankProvidersByMetric", () => {
  it("ranks by the selected metric, highest first", () => {
    const totals = [
      { provider: "codex" as const, totalTokens: 100, costUsd: 20 },
      { provider: "claude" as const, totalTokens: 200, costUsd: 10 },
    ];
    const providers = ["codex", "claude"] as const;

    expect(rankProvidersByMetric(providers, totals, "tokens")).toEqual(["claude", "codex"]);
    expect(rankProvidersByMetric(providers, totals, "cost")).toEqual(["codex", "claude"]);
  });

  it("keeps ties in input order without reordering the shared provider list", () => {
    const totals = [
      { provider: "codex" as const, totalTokens: 10, costUsd: 1 },
      { provider: "claude" as const, totalTokens: 10, costUsd: 1 },
      { provider: "grok" as const, totalTokens: 20, costUsd: 2 },
    ];
    const providers = ["claude", "codex", "grok"] as const;

    expect(rankProvidersByMetric(providers, totals, "tokens")).toEqual(["grok", "claude", "codex"]);
    expect(providers).toEqual(["claude", "codex", "grok"]);
  });
});

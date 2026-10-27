import type { ModelTotals } from "@t3tools/shared/usageMerge";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { UsageModelTable } from "@t3tools/ft3-web/usage";

function model(overrides: Partial<ModelTotals> & Pick<ModelTotals, "model">): ModelTotals {
  return {
    provider: "codex",
    costUsd: 0,
    totalTokens: 0,
    tokens: {
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
    records: 1,
    unpricedRecords: 0,
    unpricedTokens: 0,
    sessions: 0,
    costShare: 0,
    tokenShare: 0,
    ...overrides,
  };
}

const models = [
  model({
    model: "expensive-model",
    provider: "claude",
    costUsd: 10,
    totalTokens: 100,
    sessions: 4,
  }),
  model({ model: "token-heavy-model", costUsd: 5, totalTokens: 1_000, sessions: 42 }),
  model({ model: "token-heavy-cheaper-model", costUsd: 1, totalTokens: 1_000, sessions: 2 }),
  model({
    model: "unpriced-model",
    costUsd: 0,
    totalTokens: 500,
    records: 2,
    unpricedRecords: 2,
    sessions: 1,
  }),
  model({ model: "zero-token-model", costUsd: 1, totalTokens: 0, sessions: 1 }),
];

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    },
  });
});

function render(metric: "cost" | "tokens") {
  return renderToStaticMarkup(
    <UsageModelTable
      models={models}
      metric={metric}
      loadingProviders={new Set()}
      onSelectModel={() => {}}
    />,
  );
}

describe("UsageModelTable", () => {
  it("shows our own columns and toggles by metric", () => {
    const markup = render("cost");
    expect(markup).toContain("$/1M tokens");
    expect(markup).toContain("Sessions");
    expect(markup).toContain('aria-label="Model columns"');
    expect(markup).toContain("$100,000.00");
  });

  it("shows per-model session counts", () => {
    const body = render("cost").match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";
    const tokenHeavyRow = body.split("<tr").find((row) => row.includes("token-heavy-model")) ?? "";
    expect(tokenHeavyRow).toContain(">42<");
  });

  it("sorts by cost for the cost metric", () => {
    const body = render("cost").match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";
    expect(body).toMatch(/expensive-model.*token-heavy-model.*token-heavy-cheaper-model/);
  });

  it("sorts from the cost fallback when costs tie under the token metric", () => {
    const body = render("tokens").match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";
    expect(body).toMatch(/token-heavy-model.*token-heavy-cheaper-model.*expensive-model/);
  });

  it("flags unpriced rows and never prices a zero-token model", () => {
    const body = render("cost").match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? "";
    const rows = body.split("<tr");
    const unpricedRow = rows.find((row) => row.includes("unpriced-model")) ?? "";
    const zeroTokenRow = rows.find((row) => row.includes("zero-token-model")) ?? "";
    expect(unpricedRow).toContain("Unpriced");
    expect(unpricedRow).not.toContain("$0.00");
    expect(zeroTokenRow).toContain("—");
    expect(zeroTokenRow).not.toContain("Infinity");
    expect(zeroTokenRow).not.toContain("NaN");
  });
});

// @effect-diagnostics nodeBuiltinImport:off - assertions mirror the pure candidate builder.
import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "node:path";

import { openCodeCatalogCandidates, parseOpenCodeCatalog } from "./opencodePricing.ts";
import {
  cacheSavingsUsd,
  createOverrideRateTable,
  lookupOpenCodeRate,
  parseRateTable,
  priceUsage,
  type RateTable,
} from "./usagePricing.ts";

const haikuCost = {
  input: 0.1,
  output: 0.5,
  cache_read: 0.01,
  cache_write: 0.125,
  tiers: [
    {
      input: 0.5,
      output: 2.5,
      cache_read: 0.05,
      cache_write: 0.625,
      tier: { type: "context", size: 100_000 },
    },
  ],
};

const catalog = {
  opencode: {
    id: "opencode",
    models: {
      "claude-haiku-5-5": { cost: haikuCost },
      "deepseek-v4.1-flash": { cost: { input: 0.3, output: 1.2, cache_read: 0.006 } },
      "step-5-preview-free": { cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } },
      "no-cost-model": {},
      "dual-listed-model": { cost: { input: 1.74, output: 3.48, cache_read: 0.145 } },
    },
  },
  "opencode-go": {
    id: "opencode-go",
    models: {
      "claude-haiku-5-5": { cost: haikuCost },
      // Known-divergent catalog rates; this model bills at the zen entry instead.
      "deepseek-v4.1-flash": { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } },
      "dual-listed-model": { cost: { input: 0.66, output: 1.98, cache_read: 0.022 } },
      "legacy-tier-model": {
        cost: {
          input: 1,
          output: 2,
          context_over_200k: { input: 3, output: 6 },
        },
      },
      "qwen3.7-plus": {
        cost: {
          input: 0.4,
          output: 1.6,
          cache_read: 0.04,
          cache_write: 0.5,
          context_over_200k: { input: 1.2, output: 4.8, cache_read: 0.12, cache_write: 1.5 },
          tiers: [
            {
              input: 1.2,
              output: 4.8,
              cache_read: 0.12,
              cache_write: 1.5,
              tier: { type: "context", size: 256_000 },
            },
          ],
        },
      },
      "go-only-model": { cost: { input: 1, output: 2 } },
      "priceless-go-model": {},
    },
  },
  malformed: "not a provider",
};

const perMillion = (value: number) => value / 1_000_000;

describe("openCodeCatalogCandidates", () => {
  it("prefers an absolute XDG cache home, then the home cache, then Windows local app data", () => {
    expect(
      openCodeCatalogCandidates(
        { XDG_CACHE_HOME: "/xdg/cache", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
        "/home/u",
        "win32",
      ),
    ).toEqual([
      NodePath.join("/xdg/cache", "opencode", "models.json"),
      NodePath.join("/home/u", ".cache", "opencode", "models.json"),
      NodePath.join("C:\\Users\\u\\AppData\\Local", "opencode", "models.json"),
    ]);
  });

  it("ignores a relative XDG cache home and the Windows candidate off Windows", () => {
    expect(openCodeCatalogCandidates({ XDG_CACHE_HOME: "relative" }, "/home/u", "linux")).toEqual([
      NodePath.join("/home/u", ".cache", "opencode", "models.json"),
    ]);
  });
});

describe("parseOpenCodeCatalog", () => {
  it("registers provider-prefixed keys, per-1M rates, and bare zen aliases only", () => {
    const table = parseOpenCodeCatalog(catalog);

    // Four priced opencode models (bare alias each) plus six priced opencode-go models.
    expect(table.size).toBe(14);
    const flash = table.get("opencode/deepseek-v4.1-flash");
    expect(flash).toMatchObject({
      inputCostPerToken: perMillion(0.3),
      outputCostPerToken: perMillion(1.2),
      cacheReadCostPerToken: perMillion(0.006),
      // OpenCode lists no cache-write rate for this model; writes bill at the input rate.
      cacheCreationCostPerToken: perMillion(0.3),
      fast: null,
      ultrafast: null,
    });
    expect(table.get("deepseek-v4.1-flash")).toBe(flash);
    expect(table.get("opencode-go/go-only-model")).toMatchObject({
      inputCostPerToken: perMillion(1),
    });
    // Only zen models register a bare alias; provider-specific models stay prefixed.
    expect(table.has("go-only-model")).toBe(false);
    // Models without a cost entry stay out of the table so they surface as unpriced, never $0.
    expect(table.has("opencode/no-cost-model")).toBe(false);
    expect(table.has("opencode-go/priceless-go-model")).toBe(false);
  });

  it("keeps explicitly free models priced at zero", () => {
    const table = parseOpenCodeCatalog(catalog);
    const free = table.get("opencode/step-5-preview-free");
    expect(free).toMatchObject({
      inputCostPerToken: 0,
      outputCostPerToken: 0,
      cacheReadCostPerToken: 0,
      cacheCreationCostPerToken: 0,
    });
  });

  it("parses context tiers from tier entries and the legacy context_over_200k form", () => {
    const table = parseOpenCodeCatalog(catalog);
    const haiku = table.get("opencode/claude-haiku-5-5");
    expect(haiku?.contextTiers).toEqual([
      {
        aboveTokens: 100_000,
        rates: {
          inputCostPerToken: perMillion(0.5),
          outputCostPerToken: perMillion(2.5),
          cacheReadCostPerToken: perMillion(0.05),
          cacheCreationCostPerToken: perMillion(0.625),
        },
      },
    ]);
    // Base rates stay the published base, not the tier rates.
    expect(haiku).toMatchObject({ inputCostPerToken: perMillion(0.1) });

    const qwen = table.get("opencode-go/qwen3.7-plus");
    expect(qwen?.contextTiers?.map((tier) => tier.aboveTokens)).toEqual([256_000]);
  });

  it("uses the legacy 200k field only when no explicit tiers exist", () => {
    const legacy = parseOpenCodeCatalog(catalog).get("opencode-go/legacy-tier-model");
    expect(legacy?.contextTiers?.map((tier) => tier.aboveTokens)).toEqual([200_000]);
  });

  it("returns an empty table for malformed documents", () => {
    expect(parseOpenCodeCatalog(null).size).toBe(0);
    expect(parseOpenCodeCatalog("nope").size).toBe(0);
    expect(parseOpenCodeCatalog({ opencode: { models: [] } }).size).toBe(0);
  });
});

describe("OpenCode pricing", () => {
  const table: RateTable = parseOpenCodeCatalog(catalog);
  const empty: RateTable = new Map();

  const record = (model: string, totals: Partial<Record<string, number>> = {}) => ({
    model,
    totals: {
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      ...totals,
    },
    reportedCostUsd: null,
    speed: "standard" as const,
  });

  it("bills opencode-go models at zen rates, including bare names from older transcripts", () => {
    for (const model of ["opencode-go/deepseek-v4.1-flash", "deepseek-v4.1-flash"]) {
      const priced = priceUsage(
        empty,
        record(model, { uncachedInputTokens: 1_000_000 }),
        undefined,
        table,
      );
      expect(priced.costSource).toBe("modelPriced");
      expect(priced.costUsd).toBeCloseTo(0.3, 10);
      expect(priced.categoryCostUsd?.cacheRead).toBe(0);
      expect(
        cacheSavingsUsd(empty, record(model, { cachedInputTokens: 1_000_000 }), undefined, table),
      ).toBeCloseTo(1_000_000 * (perMillion(0.3) - perMillion(0.006)), 10);
    }
    // Other opencode-go models keep their own rates even when zen lists the same model.
    expect(
      priceUsage(
        empty,
        record("opencode-go/dual-listed-model", { uncachedInputTokens: 1_000_000 }),
        undefined,
        table,
      ).costUsd,
    ).toBeCloseTo(0.66, 10);
    // A model only its own provider carries still prices from that provider's entry.
    expect(
      priceUsage(
        empty,
        record("opencode-go/go-only-model", { uncachedInputTokens: 1_000_000 }),
        undefined,
        table,
      ).costUsd,
    ).toBeCloseTo(1, 10);
  });

  it("picks the context tier by the request's input context size", () => {
    // 110k-token prompt crosses the 100k Haiku tier.
    const above = priceUsage(
      empty,
      record("opencode-go/claude-haiku-5-5", {
        uncachedInputTokens: 50_000,
        cachedInputTokens: 60_000,
        outputTokens: 10_000,
      }),
      undefined,
      table,
    );
    expect(above.costUsd).toBeCloseTo(
      (50_000 * 0.5 + 60_000 * 0.05 + 10_000 * 2.5) / 1_000_000,
      10,
    );
    expect(above.categoryCostUsd?.input).toBeCloseTo((50_000 * 0.5) / 1_000_000, 12);
    expect(above.categoryCostUsd?.cacheRead).toBeCloseTo((60_000 * 0.05) / 1_000_000, 12);
    expect(above.categoryCostUsd?.output).toBeCloseTo((10_000 * 2.5) / 1_000_000, 12);
    expect(
      cacheSavingsUsd(
        empty,
        record("opencode-go/claude-haiku-5-5", {
          uncachedInputTokens: 50_000,
          cachedInputTokens: 60_000,
        }),
        undefined,
        table,
      ),
    ).toBeCloseTo((60_000 * (0.5 - 0.05)) / 1_000_000, 10);

    // Exactly 100k stays at base rates; the tier bills contexts above its size.
    const at = priceUsage(
      empty,
      record("opencode-go/claude-haiku-5-5", { uncachedInputTokens: 100_000 }),
      undefined,
      table,
    );
    expect(at.costUsd).toBeCloseTo((100_000 * 0.1) / 1_000_000, 10);
    expect(at.categoryCostUsd?.input).toBeCloseTo((100_000 * 0.1) / 1_000_000, 10);
  });

  it("leaves models with no catalog price unpriced instead of pricing them at $0", () => {
    for (const model of [
      "opencode-go/priceless-go-model",
      "opencode/no-cost-model",
      "opencode-go/unknown-model",
    ]) {
      expect(lookupOpenCodeRate(table, model)).toBeNull();
      expect(priceUsage(empty, record(model), undefined, table)).toEqual({
        costUsd: 0,
        costSource: "unpriced",
        categoryCostUsd: null,
        speedPremiumUsd: 0,
      });
    }
  });

  it("still honors user price overrides for OpenCode models", () => {
    const overrides = createOverrideRateTable({
      "opencode-go/claude-haiku-5-5": {
        inputCostPerMillionTokens: 2,
        outputCostPerMillionTokens: 8,
      },
    });
    const priced = priceUsage(
      empty,
      record("opencode-go/claude-haiku-5-5", { uncachedInputTokens: 1_000_000 }),
      overrides,
      table,
    );
    expect(priced).toMatchObject({ costUsd: 2, costSource: "modelPriced" });
  });

  it("falls back to the LiteLLM table when no OpenCode catalog is available", () => {
    const litellm = parseRateTable({
      "opencode-go/go-only-model": {
        input_cost_per_token: perMillion(1),
        output_cost_per_token: perMillion(2),
      },
    });
    const priced = priceUsage(
      litellm,
      record("opencode-go/go-only-model", { uncachedInputTokens: 1_000_000 }),
    );
    expect(priced).toMatchObject({ costUsd: 1, costSource: "modelPriced" });
  });
});

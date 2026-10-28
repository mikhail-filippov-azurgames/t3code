import { describe, expect, it } from "@effect/vitest";

import { kimiPriceOverrides } from "./pricing.ts";

describe("kimiPriceOverrides", () => {
  it("prices every model id the Kimi CLI writes to wire.jsonl", () => {
    // ids come from ~/.kimi-code/config.toml `[models."<id>"]` and the recorded usage lines.
    expect(Object.keys(kimiPriceOverrides).sort()).toEqual([
      "kimi-code/k2.7-code",
      "kimi-code/k3",
      "kimi-code/k3-256k",
      "kimi-code/k3.1-pro",
      "kimi-code/k3.1-pro-highspeed",
      "kimi-code/kimi-for-coding",
      "kimi-code/kimi-for-coding-highspeed",
    ]);
  });

  it("carries Moonshot list prices with the cache rates each model publishes", () => {
    expect(kimiPriceOverrides["kimi-code/kimi-for-coding"]).toEqual({
      inputCostPerMillionTokens: 1,
      outputCostPerMillionTokens: 4,
      cacheReadCostPerMillionTokens: 0.25,
    });
    expect(kimiPriceOverrides["kimi-code/k3.1-pro"]).toEqual({
      inputCostPerMillionTokens: 2,
      outputCostPerMillionTokens: 10,
      cacheReadCostPerMillionTokens: 0.2,
      cacheWriteCostPerMillionTokens: 2,
    });
    const highspeed = kimiPriceOverrides["kimi-code/k3.1-pro-highspeed"];
    expect(highspeed?.inputCostPerMillionTokens).toBe(4);
    expect(highspeed?.outputCostPerMillionTokens).toBe(20);
    expect(highspeed?.cacheWriteCostPerMillionTokens).toBe(4);
  });
});

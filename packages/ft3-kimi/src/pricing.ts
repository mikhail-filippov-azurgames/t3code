import type { UsageModelPriceOverride } from "@t3tools/contracts";

/**
 * Kimi Code bills the coding plan at Moonshot list price, and the CLI writes
 * `kimi-code/<model>` ids to wire.jsonl that the public rate tables do not carry.
 * USD per 1M tokens; omitted cache-write rates fall back to the input rate.
 */
export const kimiPriceOverrides: Readonly<Record<string, UsageModelPriceOverride>> = {
  "kimi-code/kimi-for-coding": {
    inputCostPerMillionTokens: 1,
    outputCostPerMillionTokens: 4,
    cacheReadCostPerMillionTokens: 0.25,
  },
  "kimi-code/kimi-for-coding-highspeed": {
    inputCostPerMillionTokens: 1.9,
    outputCostPerMillionTokens: 8,
    cacheReadCostPerMillionTokens: 0.38,
  },
  "kimi-code/k3": {
    inputCostPerMillionTokens: 3,
    outputCostPerMillionTokens: 15,
    cacheReadCostPerMillionTokens: 0.3,
  },
  "kimi-code/k3-256k": {
    inputCostPerMillionTokens: 3,
    outputCostPerMillionTokens: 15,
    cacheReadCostPerMillionTokens: 0.3,
  },
  "kimi-code/k3.1-pro": {
    inputCostPerMillionTokens: 2,
    outputCostPerMillionTokens: 10,
    cacheReadCostPerMillionTokens: 0.2,
    cacheWriteCostPerMillionTokens: 2,
  },
  "kimi-code/k3.1-pro-highspeed": {
    inputCostPerMillionTokens: 4,
    outputCostPerMillionTokens: 20,
    cacheReadCostPerMillionTokens: 0.2,
    cacheWriteCostPerMillionTokens: 4,
  },
  "kimi-code/k2.7-code": {
    inputCostPerMillionTokens: 0.95,
    outputCostPerMillionTokens: 4,
    cacheReadCostPerMillionTokens: 0.19,
  },
};

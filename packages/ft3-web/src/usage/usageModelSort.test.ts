import type { ModelTotals } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import { modelSortValue, sortModels } from "./usageModelSort";

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

const cheap = model({ model: "cheap", costUsd: 1, totalTokens: 1_000_000 });
const pricey = model({ model: "pricey", costUsd: 5, totalTokens: 1_000_000 });
const unpriced = model({
  model: "unpriced",
  costUsd: 0,
  totalTokens: 500_000,
  records: 2,
  unpricedRecords: 2,
});
const zeroToken = model({ model: "zero-token", costUsd: 1, totalTokens: 0 });

describe("modelSortValue", () => {
  it("treats unpriced and zero-token cost as unknown", () => {
    expect(modelSortValue(cheap, "cost")).toBe(1);
    expect(modelSortValue(unpriced, "cost")).toBeNull();
    expect(modelSortValue(pricey, "pricePerMillion")).toBe(5);
    expect(modelSortValue(zeroToken, "pricePerMillion")).toBeNull();
    expect(modelSortValue(unpriced, "pricePerMillion")).toBeNull();
  });

  it("reads the session count directly, with no unknown case", () => {
    expect(modelSortValue(model({ model: "busy", sessions: 9 }), "sessions")).toBe(9);
    expect(modelSortValue(model({ model: "idle", sessions: 0 }), "sessions")).toBe(0);
  });

  it("sorts share by the displayed metric", () => {
    const mixed = model({
      model: "mixed",
      costUsd: 1,
      totalTokens: 100,
      costShare: 0.9,
      tokenShare: 0.1,
    });
    expect(modelSortValue(mixed, "share", "cost")).toBe(0.9);
    expect(modelSortValue(mixed, "share", "tokens")).toBe(0.1);
  });
});

describe("sortModels by price per million tokens", () => {
  it("orders by effective price ascending", () => {
    expect(
      sortModels([unpriced, pricey, zeroToken, cheap], "pricePerMillion", "asc").map(
        (entry) => entry.model,
      ),
    ).toEqual(["cheap", "pricey", "zero-token", "unpriced"]);
  });

  it("orders by effective price descending and keeps unknowns last", () => {
    expect(
      sortModels([unpriced, cheap, zeroToken, pricey], "pricePerMillion", "desc").map(
        (entry) => entry.model,
      ),
    ).toEqual(["pricey", "cheap", "zero-token", "unpriced"]);
  });
});

describe("sortModels by cost", () => {
  it("keeps unpriced rows last in both directions", () => {
    const ascending = sortModels([unpriced, pricey, cheap], "cost", "asc").map(
      (entry) => entry.model,
    );
    const descending = sortModels([unpriced, pricey, cheap], "cost", "desc").map(
      (entry) => entry.model,
    );

    expect(ascending).toEqual(["cheap", "pricey", "unpriced"]);
    expect(descending).toEqual(["pricey", "cheap", "unpriced"]);
  });
});

describe("sortModels by sessions", () => {
  it("orders by session count in both directions", () => {
    const few = model({ model: "few", sessions: 2 });
    const many = model({ model: "many", sessions: 9 });

    expect(sortModels([few, many], "sessions", "desc").map((entry) => entry.model)).toEqual([
      "many",
      "few",
    ]);
    expect(sortModels([many, few], "sessions", "asc").map((entry) => entry.model)).toEqual([
      "few",
      "many",
    ]);
  });
});

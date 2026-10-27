import { isModelCostUnknown, type ModelTotals } from "@t3tools/shared/usageMerge";

export type ModelSortKey = "cost" | "share" | "tokens" | "pricePerMillion" | "sessions";
export type ModelSortDirection = "asc" | "desc";
export type ModelSortMetric = "cost" | "tokens";

export function pricedTokenCount(model: ModelTotals): number {
  return Math.max(0, model.totalTokens - model.unpricedTokens);
}

/** Comparable value for a model column, or `null` when the column has none. */
export function modelSortValue(
  model: ModelTotals,
  key: ModelSortKey,
  metric: ModelSortMetric = "cost",
): number | null {
  switch (key) {
    case "cost":
      return isModelCostUnknown(model) ? null : model.costUsd;
    case "share":
      if (metric === "tokens") return model.tokenShare;
      return isModelCostUnknown(model) ? null : model.costShare;
    case "tokens":
      return model.totalTokens;
    case "pricePerMillion": {
      const pricedTokens = pricedTokenCount(model);
      return isModelCostUnknown(model) || pricedTokens <= 0
        ? null
        : (model.costUsd / pricedTokens) * 1_000_000;
    }
    case "sessions":
      return model.sessions;
  }
}

/** Unknowns sink to the bottom in both directions, so they never look cheapest or priciest. */
export function sortModels(
  models: readonly ModelTotals[],
  key: ModelSortKey,
  direction: ModelSortDirection,
  metric: ModelSortMetric = "cost",
): readonly ModelTotals[] {
  const factor = direction === "asc" ? 1 : -1;
  return models.toSorted((left, right) => {
    const leftValue = modelSortValue(left, key, metric);
    const rightValue = modelSortValue(right, key, metric);
    if (leftValue === null || rightValue === null) {
      if (leftValue === null && rightValue === null) return byCostFallback(left, right);
      return leftValue === null ? 1 : -1;
    }
    return leftValue === rightValue
      ? byCostFallback(left, right)
      : (leftValue - rightValue) * factor;
  });
}

function byCostFallback(left: ModelTotals, right: ModelTotals): number {
  return right.costUsd - left.costUsd || right.totalTokens - left.totalTokens;
}

import { isModelCostUnknown, type ModelTotals } from "@t3tools/shared/usageMerge";

export type ModelSortKey = "cost" | "share" | "tokens" | "pricePerMillion" | "sessions";
export type ModelSortDirection = "asc" | "desc";

/**
 * Comparable value for a model column, or `null` when the column has none.
 *
 * An unpriced model is unknown, not cheap, so it must not rank as `$0`.
 * `$ / 1M tokens` also has no value for a model with zero counted tokens.
 */
export function modelSortValue(model: ModelTotals, key: ModelSortKey): number | null {
  switch (key) {
    case "cost":
      return isModelCostUnknown(model) ? null : model.costUsd;
    case "share":
      return isModelCostUnknown(model) ? null : model.costShare;
    case "tokens":
      return model.totalTokens;
    case "pricePerMillion":
      if (isModelCostUnknown(model) || model.totalTokens <= 0) return null;
      return (model.costUsd / model.totalTokens) * 1_000_000;
    case "sessions":
      return model.sessions;
  }
}

/**
 * Ranks models by one column. Models without a value for that column always
 * sink to the bottom, in both directions, so a toggled direction never makes
 * "Unpriced" rows look like the cheapest or the most expensive.
 */
export function sortModels(
  models: readonly ModelTotals[],
  key: ModelSortKey,
  direction: ModelSortDirection,
): readonly ModelTotals[] {
  const factor = direction === "asc" ? 1 : -1;
  return models.toSorted((left, right) => {
    const leftValue = modelSortValue(left, key);
    const rightValue = modelSortValue(right, key);
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

/**
 * Visibility of the Usage model-breakdown data columns.
 *
 * The Model column itself is always shown; these ids cover the toggleable
 * metric columns only, in their display order.
 *
 * @module usageModelColumns
 */

export type ModelColumnId = "cost" | "share" | "tokens" | "pricePerMillion" | "sessions";

export const DEFAULT_MODEL_COLUMNS: readonly ModelColumnId[] = [
  "cost",
  "share",
  "tokens",
  "pricePerMillion",
  "sessions",
];

const MODEL_COLUMN_IDS: ReadonlySet<string> = new Set(DEFAULT_MODEL_COLUMNS);

/** Narrows a toggle-group value to a real column id. */
export function isModelColumnId(value: string): value is ModelColumnId {
  return MODEL_COLUMN_IDS.has(value);
}

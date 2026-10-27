export type ModelColumnId = "cost" | "share" | "tokens" | "pricePerMillion" | "sessions";

export const DEFAULT_MODEL_COLUMNS: readonly ModelColumnId[] = [
  "cost",
  "share",
  "tokens",
  "pricePerMillion",
  "sessions",
];

const MODEL_COLUMN_IDS: ReadonlySet<string> = new Set(DEFAULT_MODEL_COLUMNS);

export function isModelColumnId(value: string): value is ModelColumnId {
  return MODEL_COLUMN_IDS.has(value);
}

export const MODEL_COLUMN_LABELS: Readonly<Record<ModelColumnId, string>> = {
  cost: "Cost",
  share: "Share",
  tokens: "Tokens",
  pricePerMillion: "$/1M tokens",
  sessions: "Sessions",
};

import * as Schema from "effect/Schema";
import { useState } from "react";

import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";

import { DEFAULT_MODEL_COLUMNS, type ModelColumnId } from "./usageModelColumns";

const STORAGE_KEY = "t3code:ft3-usage-model-columns:v1";
const ModelColumnsSchema = Schema.mutable(
  Schema.Array(Schema.Literals(["cost", "share", "tokens", "pricePerMillion", "sessions"])),
);

export function readUsageModelColumns(): readonly ModelColumnId[] {
  try {
    return getLocalStorageItem(STORAGE_KEY, ModelColumnsSchema) ?? DEFAULT_MODEL_COLUMNS;
  } catch (error) {
    console.error("Could not read Usage model columns.", error);
    return DEFAULT_MODEL_COLUMNS;
  }
}

export function saveUsageModelColumns(columns: readonly ModelColumnId[]): void {
  try {
    setLocalStorageItem(STORAGE_KEY, [...columns], ModelColumnsSchema);
  } catch (error) {
    console.error("Could not save Usage model columns.", error);
  }
}

export function useUsageModelColumns(): {
  readonly columns: readonly ModelColumnId[];
  readonly setColumns: (columns: readonly ModelColumnId[]) => void;
} {
  const [columns, setColumnsState] = useState(readUsageModelColumns);
  return {
    columns,
    setColumns: (next) => {
      setColumnsState(next);
      saveUsageModelColumns(next);
    },
  };
}

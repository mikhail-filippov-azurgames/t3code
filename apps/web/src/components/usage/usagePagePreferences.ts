import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { DEFAULT_MODEL_COLUMNS } from "./usageModelColumns";

const STORAGE_KEY = "t3code:usage-page-preferences:v1";
const UsagePagePreferencesSchema = Schema.Struct({
  metric: Schema.Literals(["cost", "tokens", "limits"]),
  windowDays: Schema.Literals([1, 7, 30, 90]),
  // Optional so payloads saved before the model-column picker still decode.
  modelColumns: Schema.mutable(
    Schema.Array(Schema.Literals(["cost", "share", "tokens", "pricePerMillion", "sessions"])),
  ).pipe(Schema.withDecodingDefault(Effect.sync(() => [...DEFAULT_MODEL_COLUMNS]))),
});
export type UsagePagePreferences = typeof UsagePagePreferencesSchema.Type;

// Limits is what most people open the page for (how much subscription quota is
// left, and when it resets), so it is the first-visit default; the last picked
// tab sticks after that.
const DEFAULT_PREFERENCES: UsagePagePreferences = {
  metric: "limits",
  windowDays: 30,
  modelColumns: [...DEFAULT_MODEL_COLUMNS],
};

export function readUsagePagePreferences(): UsagePagePreferences {
  try {
    return getLocalStorageItem(STORAGE_KEY, UsagePagePreferencesSchema) ?? DEFAULT_PREFERENCES;
  } catch (error) {
    console.error("Could not read Usage page preferences.", error);
    return DEFAULT_PREFERENCES;
  }
}

export function saveUsagePagePreferences(preferences: UsagePagePreferences): void {
  try {
    setLocalStorageItem(STORAGE_KEY, preferences, UsagePagePreferencesSchema);
  } catch (error) {
    console.error("Could not save Usage page preferences.", error);
  }
}

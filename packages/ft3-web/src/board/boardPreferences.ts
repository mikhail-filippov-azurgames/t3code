import * as Schema from "effect/Schema";

import { getLocalStorageItem, useLocalStorage } from "~/hooks/useLocalStorage";

const SKIP_ORCHESTRATOR_UNMARK_CONFIRM_KEY = "t3code:board:skip-orchestrator-unmark-confirmation";
const EXPAND_COORDINATOR_HISTORY_KEY = "t3code:board:expand-coordinator-history-by-default";

const booleanSchema = Schema.Boolean;

export function readSkipOrchestratorUnmarkConfirmation(): boolean {
  return getLocalStorageItem(SKIP_ORCHESTRATOR_UNMARK_CONFIRM_KEY, booleanSchema) ?? false;
}

export function useSkipOrchestratorUnmarkConfirmation(): [boolean, (value: boolean) => void] {
  return useLocalStorage(SKIP_ORCHESTRATOR_UNMARK_CONFIRM_KEY, false, booleanSchema);
}

/** Whether History entries in the chat side panel start expanded. Collapsed unless chosen. */
export function useExpandCoordinatorHistoryByDefault(): [boolean, (value: boolean) => void] {
  return useLocalStorage(EXPAND_COORDINATOR_HISTORY_KEY, false, booleanSchema);
}

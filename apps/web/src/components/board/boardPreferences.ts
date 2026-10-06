/**
 * Device-local board preferences.
 *
 * The unmark-orchestrator confirmation toggle lives on the client, not on a
 * server: it controls whether this browser asks before a destructive unmark
 * (design §6). It is stored under its own localStorage key rather than in
 * `ClientSettingsSchema` because the board owns no contract surface for it.
 * The chat-panel history default follows the same rule.
 *
 * @module components/board/boardPreferences
 */
import * as Schema from "effect/Schema";

import { getLocalStorageItem, useLocalStorage } from "../../hooks/useLocalStorage";

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

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { Preferences } from "../../persistence/mobile-preferences";

const FULL_BOARD_CARD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BOARD_CARD_PINS = 20;

export function mobileBoardCardPinsKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return String(environmentId) + "\u0000" + String(threadId);
}

export function readMobileBoardCardPins(
  preferences: Preferences,
  key: string,
): ReadonlyArray<string> {
  return (preferences.boardCardPins?.[key] ?? [])
    .filter((cardId) => FULL_BOARD_CARD_UUID.test(cardId))
    .slice(0, MAX_BOARD_CARD_PINS);
}

export function updateMobileBoardCardPins(
  preferences: Preferences,
  key: string,
  pins: ReadonlyArray<string>,
): Preferences["boardCardPins"] {
  return {
    ...preferences.boardCardPins,
    [key]: [...new Set(pins.filter((cardId) => FULL_BOARD_CARD_UUID.test(cardId)))].slice(
      0,
      MAX_BOARD_CARD_PINS,
    ),
  };
}

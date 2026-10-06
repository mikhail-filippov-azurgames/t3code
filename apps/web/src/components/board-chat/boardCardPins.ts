import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

const BOARD_CARD_PINS_EVENT = "t3code:board-card-pins-changed";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function boardCardPinsKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return `t3code:board-card-pins:v1:${environmentId}:${threadId}`;
}

function validIds(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value.filter((id): id is string => typeof id === "string" && UUID_PATTERN.test(id)),
        ),
      ]
    : [];
}

function parseIds(value: string | null): string[] {
  if (value === null) return [];
  try {
    return validIds(JSON.parse(value));
  } catch {
    return [];
  }
}

export function readBoardCardPins(environmentId: EnvironmentId, threadId: ThreadId): string[] {
  if (typeof window === "undefined") return [];
  try {
    const value = window.localStorage.getItem(boardCardPinsKey(environmentId, threadId));
    return parseIds(value);
  } catch {
    return [];
  }
}

export function addBoardCardPin(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  cardId: string,
): void {
  if (typeof window === "undefined" || !UUID_PATTERN.test(cardId)) return;
  const key = boardCardPinsKey(environmentId, threadId);
  const pins = readBoardCardPins(environmentId, threadId);
  if (pins.includes(cardId)) return;
  publishPins(key, [...pins, cardId]);
}

export function removeBoardCardPin(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  cardId: string,
): void {
  if (typeof window === "undefined") return;
  const key = boardCardPinsKey(environmentId, threadId);
  publishPins(
    key,
    readBoardCardPins(environmentId, threadId).filter((candidate) => candidate !== cardId),
  );
}

function publishPins(key: string, pins: ReadonlyArray<string>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(pins));
  } catch {
    // Keep the current chat usable when browser storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent(BOARD_CARD_PINS_EVENT, { detail: { key, pins } }));
}

export function subscribeBoardCardPins(
  callback: (key: string, pins: string[]) => void,
): () => void {
  const onChange = (event: Event) => {
    if (event instanceof CustomEvent) {
      const detail = event.detail as { key?: unknown; pins?: unknown } | null;
      if (typeof detail?.key === "string") {
        callback(detail.key, validIds(detail.pins));
        return;
      }
    }
    const storageEvent = event as StorageEvent;
    if (storageEvent.key !== null) callback(storageEvent.key, parseIds(storageEvent.newValue));
  };
  window.addEventListener(BOARD_CARD_PINS_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(BOARD_CARD_PINS_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

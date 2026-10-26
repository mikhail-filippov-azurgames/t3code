import type { ScopedThreadRef } from "@t3tools/contracts";
import type { BoardCard } from "@t3tools/ft3-board/contracts";
import { useSyncExternalStore } from "react";
import { Button } from "~/components/ui/button";
import {
  boardCardPinsKey,
  readBoardCardPins,
  removeBoardCardPin,
  subscribeBoardCardPins,
} from "./boardCardPins.ts";

export function useBoardCardPins(ref: ScopedThreadRef): readonly string[] {
  const key = boardCardPinsKey(ref.environmentId, ref.threadId);
  const snapshot = useSyncExternalStore(
    (notify) =>
      subscribeBoardCardPins((changedKey) => {
        if (changedKey === key) notify();
      }),
    () => JSON.stringify(readBoardCardPins(ref.environmentId, ref.threadId)),
    () => "[]",
  );
  return JSON.parse(snapshot) as string[];
}

export function BoardCardPinnedPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly cardIds: readonly string[];
  readonly cards: readonly BoardCard[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly onSelect: (card: BoardCard) => void;
  readonly onRetry: () => void;
}) {
  if (props.cardIds.length === 0) return null;
  return (
    <section aria-label="Pinned cards" className="flex flex-col gap-2 border-b p-3">
      <h3 className="text-sm font-medium">Pinned cards</h3>
      {props.error ? (
        <div role="alert">
          {props.error}{" "}
          <Button size="xs" variant="outline" onClick={props.onRetry}>
            Retry pinned cards
          </Button>
        </div>
      ) : null}
      {props.cardIds.map((id) => {
        const card = props.cards.find((entry) => entry.cardId === id);
        return (
          <div key={id} className="flex items-center gap-2">
            <Button
              size="xs"
              variant="ghost"
              disabled={!card}
              onClick={() => {
                if (card) props.onSelect(card);
              }}
            >
              {card?.title ??
                (props.loading ? "Loading card…" : `Unavailable card ${id.slice(0, 8)}`)}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                removeBoardCardPin(props.threadRef.environmentId, props.threadRef.threadId, id)
              }
              aria-label={`Unpin ${card?.title ?? id}`}
            >
              Unpin
            </Button>
          </div>
        );
      })}
    </section>
  );
}

import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { BoardCardId, type BoardCard, type BoardDelegation } from "@t3tools/ft3-board/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { Button } from "~/components/ui/button";
import { useEnvironmentQuery } from "~/state/query";
import {
  boardDelegationStatusLabel,
  boardDelegationSummaryText,
  formatBoardEventTime,
} from "./board.logic.ts";
import {
  boardCardPinsKey,
  readBoardCardPins,
  removeBoardCardPin,
  subscribeBoardCardPins,
} from "./boardCardPins.ts";
import { boardEnvironment } from "./state.ts";

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
          <div key={id} className="flex min-w-0 flex-col">
            <div className="flex items-center gap-2">
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
            {card?.executorThreadId != null ? (
              <PinnedCardDelegations environmentId={props.threadRef.environmentId} cardId={id} />
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

function PinnedCardDelegations(props: {
  readonly environmentId: EnvironmentId;
  readonly cardId: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const query = useEnvironmentQuery(
    expanded
      ? boardEnvironment.delegations({
          environmentId: props.environmentId,
          input: { cardId: BoardCardId.make(props.cardId) },
        })
      : null,
  );
  const delegations: ReadonlyArray<BoardDelegation> = query.data?.delegations ?? [];
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div className="pl-3">
      <button
        type="button"
        className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <Chevron className="size-3.5 shrink-0" aria-hidden="true" />
        Delegations
      </button>
      {expanded ? (
        <div className="mt-1 flex flex-col gap-1 text-xs">
          {query.isPending && delegations.length === 0 ? (
            <p role="status" className="text-muted-foreground">
              Loading delegations…
            </p>
          ) : null}
          {query.error !== null ? (
            <div role="alert" className="flex items-center gap-2">
              <span>Could not load delegations.</span>
              <Button size="xs" variant="outline" onClick={query.refresh}>
                Retry
              </Button>
            </div>
          ) : null}
          {!query.isPending && query.error === null && delegations.length === 0 ? (
            <p className="text-muted-foreground">No delegated tasks yet.</p>
          ) : null}
          {delegations.length > 0 ? (
            <ol className="flex flex-col gap-1">
              {delegations.map((delegation) => {
                const summary = boardDelegationSummaryText(delegation.summary);
                return (
                  <li
                    key={delegation.taskId}
                    className="rounded-md border border-border bg-card px-2 py-1"
                  >
                    <span className="flex min-w-0 items-center justify-between gap-2">
                      <span className="truncate font-medium">{delegation.title}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {boardDelegationStatusLabel(delegation.latestStatus)}
                      </span>
                    </span>
                    <span className="block text-[10px] text-muted-foreground">
                      {formatBoardEventTime(delegation.updatedAt)}
                    </span>
                    {summary !== null ? (
                      <p className="mt-1 whitespace-pre-wrap break-words">{summary}</p>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

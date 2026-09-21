/**
 * Read-only card detail with the progress timeline and the human's only
 * mutations: Start while `todo`, and archive/unarchive.
 *
 * Every other change (stop, reassign, status, delete) is orchestrator-owned, so
 * the dialog sends a system request to the orchestrator thread instead of
 * mutating the card (design §5).
 *
 * @module components/board/BoardCardDetailDialog
 */
import type { BoardCard, BoardCardEvent } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { BoardRoleIcon } from "./boardRoleIcons";
import {
  boardExecutorRoleLabel,
  boardEventsForCard,
  boardStatusLabel,
  formatBoardEventTime,
  isCardStartable,
} from "./board.logic";

export interface BoardCardDetailDialogProps {
  readonly card: BoardCard;
  readonly events: ReadonlyArray<BoardCardEvent>;
  readonly executorTitle: string | null;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onStart: (card: BoardCard) => void;
  readonly onToggleArchive: (card: BoardCard, archived: boolean) => void;
  readonly onRequest: (card: BoardCard, text: string) => void;
  readonly onOpenExecutor: (card: BoardCard) => void;
}

export function BoardCardDetailDialog({
  card,
  events,
  executorTitle,
  busy,
  onClose,
  onStart,
  onToggleArchive,
  onRequest,
  onOpenExecutor,
}: BoardCardDetailDialogProps) {
  const [requestText, setRequestText] = useState("");
  const timeline = boardEventsForCard(events, card.cardId);
  const editable = isCardStartable(card);

  const sendRequest = (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    onRequest(card, trimmed);
    setRequestText("");
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{card.title}</DialogTitle>
          <DialogDescription>
            <span className="inline-flex items-center gap-1">
              <BoardRoleIcon role={card.executorRole} />
              {`${boardStatusLabel(card.status)} · ${boardExecutorRoleLabel(card.executorRole)}`}
            </span>
            {card.failureStreak >= 3 ? " · needs human" : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4 text-base sm:text-sm">
          {card.body.trim().length > 0 ? (
            <p className="whitespace-pre-wrap text-muted-foreground">{card.body}</p>
          ) : null}

          {card.lastError !== null && card.lastError.trim().length > 0 ? (
            <p className="rounded-md border border-destructive/32 bg-destructive/5 px-2.5 py-1.5 text-xs text-destructive">
              {`Last error: ${card.lastError}`}
            </p>
          ) : null}

          <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {card.assignee !== null ? (
              <span>{`Executor: ${card.assignee.instanceId} · ${card.assignee.model}`}</span>
            ) : (
              <span>Executor: not assigned</span>
            )}
            {card.executorThreadId !== null ? (
              <Button size="xs" variant="outline" onClick={() => onOpenExecutor(card)}>
                {executorTitle === null ? "Open executor thread" : `Open ${executorTitle}`}
              </Button>
            ) : null}
          </div>

          <section className="flex min-w-0 flex-col gap-2">
            <h3 className="text-sm font-medium">Progress</h3>
            {timeline.length === 0 ? (
              <p className="text-xs text-muted-foreground">No progress recorded yet.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {timeline.map((event) => (
                  <li
                    key={event.entryId}
                    className="flex min-w-0 flex-col rounded-md border border-border bg-card px-2.5 py-1.5"
                  >
                    <span className="flex min-w-0 items-center justify-between gap-2 text-xs">
                      <span className="font-medium">{boardStatusLabel(event.status)}</span>
                      <span className="text-muted-foreground">
                        {formatBoardEventTime(event.at)}
                      </span>
                    </span>
                    <span className="inline-flex min-w-0 items-center gap-1 truncate text-[11px] text-muted-foreground">
                      <BoardRoleIcon role={event.executorRole} />
                      {`${boardExecutorRoleLabel(event.executorRole)}${event.model ? ` · ${event.model}` : ""}${event.effort ? ` · ${event.effort}` : ""}`}
                    </span>
                    {event.body !== undefined ? (
                      <span className="text-[11px] text-muted-foreground">{event.body}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {editable ? (
            <div className="flex flex-col gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={() => onStart(card)}
                className="self-start"
              >
                Start
              </Button>
              <p className="text-[11px] text-muted-foreground">
                Starting hands this task to the orchestrator. After that the card is read-only for
                you.
              </p>
            </div>
          ) : (
            <section className="flex min-w-0 flex-col gap-2">
              <h3 className="text-sm font-medium">Request the orchestrator</h3>
              <p className="text-[11px] text-muted-foreground">
                You cannot stop, reassign, change status, or delete a started card. Ask the
                orchestrator instead.
              </p>
              <div className="flex min-w-0 items-center gap-1.5">
                <Input
                  nativeInput
                  aria-label="Request to the orchestrator"
                  value={requestText}
                  placeholder="Reassign this to a cheaper model"
                  onChange={(event) => setRequestText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      sendRequest(requestText);
                    }
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || requestText.trim().length === 0}
                  onClick={() => sendRequest(requestText)}
                >
                  Send
                </Button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => sendRequest(`Please stop work on card ${card.cardId}.`)}
                >
                  Ask to stop
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => sendRequest(`Please reassign card ${card.cardId}.`)}
                >
                  Ask to reassign
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => sendRequest(`Please change the status of card ${card.cardId}.`)}
                >
                  Ask to change status
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => sendRequest(`Please delete card ${card.cardId}.`)}
                >
                  Ask to delete
                </Button>
              </div>
            </section>
          )}
        </DialogPanel>
        <DialogFooter className="flex-row items-center justify-between">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onToggleArchive(card, !card.archived)}
          >
            {card.archived ? "Unarchive" : "Archive"}
          </Button>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

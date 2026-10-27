import type { BoardCardLookupMatch } from "@t3tools/ft3-board/contracts";
import { OctagonAlertIcon, TriangleAlertIcon } from "lucide-react";

import { ContextChip, ContextChipLabel } from "~/components/ContextChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  boardExecutorRoleLabel,
  boardReadinessLabel,
  boardStatusLabel,
  shouldShowBoardReadiness,
} from "../board/board.logic";

export const BoardCardMentionButton = (props: {
  readonly match: BoardCardLookupMatch;
  readonly onPin: (cardId: string) => void;
}) => {
  const { card, orchestratorThreadTitle, recentEvents } = props.match;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="mention"
            dir="ltr"
            render={<button type="button" />}
            aria-label={`Preview board card ${card.title}`}
            data-board-card-mention={String(card.cardId)}
            data-markdown-copy={String(props.match.token)}
            onClick={() => props.onPin(String(card.cardId))}
          />
        }
      >
        <ContextChipLabel className="font-mono">{String(props.match.token)}</ContextChipLabel>
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-sm whitespace-normal">
        <div className="space-y-1.5">
          <p className="font-semibold">{card.title}</p>
          <p>
            {boardStatusLabel(card.status)} · {boardExecutorRoleLabel(card.executorRole)} ·{" "}
            {orchestratorThreadTitle ?? String(card.orchestratorThreadId)}
          </p>
          {shouldShowBoardReadiness(card.readiness) ? (
            <p className="flex items-start gap-1">
              {card.readiness === "needs_human" ? (
                <TriangleAlertIcon
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0 text-destructive"
                />
              ) : (
                <OctagonAlertIcon
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0 text-warning"
                />
              )}
              <span className="min-w-0 flex-1 truncate">
                {boardReadinessLabel(card.readiness)}
                {card.readinessNote === null ? "" : ` · ${card.readinessNote.split(/\r?\n/)[0]}`}
              </span>
            </p>
          ) : null}
          {recentEvents.length > 0 ? (
            <ol className="space-y-1 border-t border-border pt-1.5">
              {recentEvents.map((event) => (
                <li key={event.entryId}>
                  <span className="font-medium">{boardStatusLabel(event.status)}</span>
                  {event.body ? " · " + event.body : ""}
                </li>
              ))}
            </ol>
          ) : (
            <p>История пока пуста.</p>
          )}
          <p className="text-muted-foreground">Нажмите, чтобы закрепить карточку.</p>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
};

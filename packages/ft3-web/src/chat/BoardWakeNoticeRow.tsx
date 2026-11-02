import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";

import {
  boardWakeNoticeLine,
  boardWakeNoticeOf,
  type BoardWakeNoticeMessage,
} from "./boardWakeNotice.logic.ts";

export {
  boardWakeNoticeKind,
  boardWakeNoticeLabel,
  boardWakeNoticeLine,
  boardWakeNoticeOf,
  type BoardWakeNotice,
  type BoardWakeNoticeKind,
  type BoardWakeNoticeMessage,
} from "./boardWakeNotice.logic.ts";

/**
 * A board wake, brief or nudge prompt is server force-work, not a person
 * talking. It renders as one collapsed line and only shows the full prompt
 * after a click, so repeated wakes stop filling the whole transcript.
 */
export function BoardWakeNoticeRow({ message }: { readonly message: BoardWakeNoticeMessage }) {
  const [expanded, setExpanded] = useState(false);
  const notice = boardWakeNoticeOf(message);
  if (notice === null) return null;
  const line = boardWakeNoticeLine(notice);
  return (
    <div
      className="flex min-w-0 flex-col items-center gap-1 py-0.5"
      data-ft3-board-wake-notice={notice.kind}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={line}
        onClick={() => setExpanded((value) => !value)}
        className="flex max-w-[80%] min-w-0 items-center gap-1.5 rounded-full border border-border/70 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/70 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="min-w-0 truncate">{line}</span>
        <ChevronDownIcon
          className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-180")}
        />
      </button>
      {expanded ? (
        <div
          className="w-full max-w-[80%] rounded-xl border border-border/70 bg-muted/30 px-3 py-2"
          data-ft3-board-wake-notice-body=""
        >
          <p className="max-h-96 overflow-auto break-words whitespace-pre-wrap text-xs text-muted-foreground">
            {notice.text}
          </p>
        </div>
      ) : null}
    </div>
  );
}

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { useState, type MouseEvent } from "react";

import { Button, InlineButton } from "~/components/ui/button";
import { TimelineRowTimestamp } from "~/components/chat/TimelineRowParts";
import { workEntryDisplayLabel } from "~/components/chat/MessagesTimeline.logic";
import type { TimelineWorkEntry } from "~/components/chat/timelineRowContext";
import { mailTasksUnsupported } from "../mail/mail.logic.ts";
import { useBoardMailLetter } from "../mail/MailTabContent.tsx";
import { BoardWakeNoticeChip, mailWakeNotificationHeader } from "./BoardWakeNoticeRow.tsx";

/** Points the lead chat at one letter: its task, id and a bounded body preview. */
export interface MailNoticeRef {
  readonly taskId: string;
  readonly letterId: string;
  readonly preview: string;
}

/**
 * A mail wake notice that opens the full letter on demand.
 */
export function MailNotificationRow(props: {
  readonly workEntry: TimelineWorkEntry;
  readonly workspaceRoot: string | undefined;
  readonly mail: MailNoticeRef;
  readonly senderThreadId: ThreadId | null;
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly timestampFormat: TimestampFormat;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { workEntry, mail } = props;
  const [expanded, setExpanded] = useState(false);
  const letter = useBoardMailLetter(
    props.environmentId,
    expanded ? { letterId: mail.letterId, threadId: props.threadId } : null,
  );
  const label = workEntryDisplayLabel(workEntry, props.workspaceRoot);
  const header = mailWakeNotificationHeader(label);
  const chipLabel = header
    ? `✉ Mail ${header.kind} letter from ${header.sender ?? "unknown sender"}: ${header.task}`
    : `✉ Mail ${label}`;
  const toggleExpanded = () => setExpanded((value) => !value);
  const senderThreadId = props.senderThreadId;

  return (
    <BoardWakeNoticeChip
      kind="mail"
      line={chipLabel}
      expanded={expanded}
      onToggle={toggleExpanded}
      trailing={
        <>
          {senderThreadId ? (
            <InlineButton
              aria-label="Open subagent thread"
              onClick={(event: MouseEvent) => {
                event.stopPropagation();
                props.onOpenThread(senderThreadId);
              }}
            >
              Open subagent
            </InlineButton>
          ) : null}
          <TimelineRowTimestamp
            createdAt={workEntry.createdAt}
            timestampFormat={props.timestampFormat}
          />
        </>
      }
      body={
        letter.isPending ? (
          <p role="status" className="py-1 text-xs leading-relaxed text-muted-foreground">
            Loading letter…
          </p>
        ) : letter.data?.letter !== undefined ? (
          <p className="max-h-96 overflow-auto break-words whitespace-pre-wrap text-xs text-muted-foreground select-text">
            {letter.data.letter.body}
          </p>
        ) : mailTasksUnsupported(letter.error, letter.failure) ? (
          <p className="py-1 text-xs leading-relaxed text-muted-foreground">
            This server does not support reading letters yet. Update the server to read it here.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2 py-1">
            <p role="alert" className="text-xs leading-relaxed text-muted-foreground">
              Could not load the letter.
            </p>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={(event: MouseEvent) => {
                event.stopPropagation();
                void letter.refresh();
              }}
            >
              Retry
            </Button>
          </div>
        )
      }
    />
  );
}

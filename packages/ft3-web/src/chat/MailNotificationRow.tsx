import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { useState, type KeyboardEvent, type MouseEvent } from "react";

import { Button, InlineButton } from "~/components/ui/button";
import { TimelineRowTimestamp } from "~/components/chat/TimelineRowParts";
import { ToolActivityIconView } from "~/components/chat/TimelineToolActivityIcon";
import { workEntryDisplayLabel } from "~/components/chat/MessagesTimeline.logic";
import { workEntryIconName } from "~/components/chat/TimelineWorkEntryRow.logic";
import { WorkLogDetails, WorkLogRow } from "~/components/chat/WorkLog";
import type { TimelineWorkEntry } from "~/components/chat/timelineRowContext";
import { mailTasksUnsupported } from "../mail/mail.logic.ts";
import { useBoardMailLetter } from "../mail/MailTabContent.tsx";

/** Points the lead chat at one letter: its task, id and a bounded body preview. */
export interface MailNoticeRef {
  readonly taskId: string;
  readonly letterId: string;
  readonly preview: string;
}

const stopRowToggle = (event: { stopPropagation: () => void }) => event.stopPropagation();

/**
 * A mail wake notice. The collapsed line keeps the notice summary with the
 * letter preview below it; expanding reads the full letter through mail.letter
 * instead of showing sender agent activity.
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
  const preview = mail.preview.trim();
  const toggleExpanded = () => setExpanded((value) => !value);
  const senderThreadId = props.senderThreadId;

  return (
    <WorkLogRow
      data-v2-item-type="notification"
      icon={
        <ToolActivityIconView
          icon={workEntry.toolIcon ?? workEntry.toolSource?.icon}
          fallbackName={workEntryIconName(workEntry)}
          className="block size-4 shrink-0 stroke-2"
          muted
        />
      }
      label={label}
      trailing={
        <>
          {senderThreadId ? (
            <InlineButton
              aria-label="Open subagent thread"
              onClick={(event: MouseEvent) => {
                event.stopPropagation();
                props.onOpenThread(senderThreadId);
              }}
              onKeyDown={stopRowToggle}
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
      role="button"
      tabIndex={0}
      aria-label={preview === "" ? label : `${label}: ${preview}`}
      aria-expanded={expanded}
      onClick={toggleExpanded}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          toggleExpanded();
        }
      }}
    >
      {preview === "" ? null : (
        <p className="ms-7 whitespace-pre-wrap break-words py-1 text-xs leading-relaxed text-muted-foreground">
          {preview}
        </p>
      )}
      {expanded ? (
        <WorkLogDetails kind="panel">
          {letter.isPending ? (
            <p role="status" className="py-1 text-xs leading-relaxed text-muted-foreground">
              Loading letter…
            </p>
          ) : letter.data !== null ? (
            <p className="whitespace-pre-wrap break-words py-1 text-sm leading-relaxed text-foreground/80 select-text">
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
          )}
        </WorkLogDetails>
      ) : null}
    </WorkLogRow>
  );
}

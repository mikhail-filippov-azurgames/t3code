import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import type { MailTask, MailTimelineEntry } from "@t3tools/ft3-mail/contracts";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { useRightPanelStore } from "~/rightPanelStore";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { useEnvironmentQuery } from "~/state/query";
import { OpenContextDocChip } from "../chat/OpenContextDocChip.tsx";
import {
  docsEnvironment,
  toOpenContextDocResolveResult,
  useOpenContextDocsEnabled,
} from "../chat/openContextState.ts";
import { policiesEnvironment } from "../policies/state.ts";
import {
  MAIL_TIMELINE_PAGE_LIMIT,
  mailDeliveryBadgeVariant,
  mailLetterSenderLabel,
  mailPlanPhaseLabel,
  mailRecipientLabel,
  mailTaskGroup,
} from "./mail.logic.ts";
import { mailEnvironment } from "./state.ts";

/**
 * The board chat panel's Mail tab: one request for the board's mail tasks and
 * one timeline request per task, so a long letter count never means per-letter
 * traffic. With the mail feature off the same page stays as read-only history.
 */
export function BoardMailTab(props: {
  readonly threadRef: ScopedThreadRef;
  readonly cardIds: ReadonlyArray<string>;
  readonly refreshSeq: number;
}) {
  const { environmentId } = props.threadRef;
  const tasksQuery = useEnvironmentQuery(
    props.cardIds.length > 0
      ? mailEnvironment.tasks({ environmentId, input: { cardIds: props.cardIds } })
      : null,
  );
  const snapshotQuery = useEnvironmentQuery(
    policiesEnvironment.snapshot({ environmentId, input: {} }),
  );
  const mailEnabled = snapshotQuery.data?.features.mail.effectiveEnabled ?? true;

  if (tasksQuery.isPending) {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Loading mail…
      </p>
    );
  }
  if (tasksQuery.error !== null) {
    return (
      <div role="alert" className="space-y-2 text-xs">
        <p>Could not load mail tasks.</p>
        <Button type="button" size="sm" variant="outline" onClick={() => void tasksQuery.refresh()}>
          Retry
        </Button>
      </div>
    );
  }
  const tasks = tasksQuery.data?.tasks ?? [];
  if (tasks.length === 0) {
    return <p className="text-xs text-muted-foreground">No mail tasks for this board yet.</p>;
  }
  return (
    <div className="space-y-3">
      {mailEnabled ? null : (
        <p className="rounded-md bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
          Mail is off: this history is read-only. Turn the feature on in{" "}
          <Link to="/settings/policies" className="font-medium underline underline-offset-2">
            Settings → Policies
          </Link>
          .
        </p>
      )}
      <ol className="space-y-3">
        {tasks.map((task) => (
          <MailTaskGroupItem
            key={task.taskId}
            environmentId={environmentId}
            threadRef={props.threadRef}
            task={task}
            refreshSeq={props.refreshSeq}
          />
        ))}
      </ol>
    </div>
  );
}

function MailTaskGroupItem(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly task: MailTask;
  readonly refreshSeq: number;
}) {
  const { environmentId, task } = props;
  const timelineQuery = useEnvironmentQuery(
    mailEnvironment.timeline({
      environmentId,
      input: { taskId: task.taskId, limit: MAIL_TIMELINE_PAGE_LIMIT },
    }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the panel refresh button revalidates this task's timeline page against the registry
  useEffect(() => {
    if (props.refreshSeq > 0) void timelineQuery.refresh();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- only the bump matters, not the query identity
  }, [props.refreshSeq]);
  const group = mailTaskGroup(task, timelineQuery.data?.entries ?? []);
  return (
    <li className="rounded-lg border border-border bg-card p-3" data-mail-task-id={task.taskId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-semibold leading-snug">{task.title}</h3>
        <Badge variant={task.status === "open" ? "secondary" : "outline"} size="sm">
          {task.status}
        </Badge>
      </div>
      {timelineQuery.isPending && timelineQuery.data === null ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          Loading letters…
        </p>
      ) : timelineQuery.error !== null ? (
        <div role="alert" className="mt-2 space-y-2 text-xs">
          <p>Could not load the letter timeline.</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void timelineQuery.refresh()}
          >
            Retry
          </Button>
        </div>
      ) : group.entries.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">No letters yet.</p>
      ) : (
        <>
          <ol className="mt-2 space-y-2">
            {group.entries.map((entry) => (
              <MailLetterItem
                key={entry.letter.letterId}
                environmentId={environmentId}
                threadRef={props.threadRef}
                task={task}
                entry={entry}
              />
            ))}
          </ol>
          {(timelineQuery.data?.entries.length ?? 0) >= MAIL_TIMELINE_PAGE_LIMIT ? (
            <p className="mt-2 text-[10px] text-muted-foreground">
              Showing the latest {MAIL_TIMELINE_PAGE_LIMIT} letters.
            </p>
          ) : null}
        </>
      )}
    </li>
  );
}

function MailLetterItem(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly task: MailTask;
  readonly entry: MailTimelineEntry;
}) {
  const { entry, task } = props;
  const { letter, deliveries } = entry;
  const documentsEnabled = useOpenContextDocsEnabled(props.environmentId);
  const resolveOpenContextDocQuery = useAtomQueryRunner(docsEnvironment.resolveDoc, {
    reportFailure: false,
  });
  const resolveDoc = useCallback(
    async (stableId: string) => {
      const result = await resolveOpenContextDocQuery({
        environmentId: props.environmentId,
        input: { stableId },
      });
      if (!AsyncResult.isSuccess(result)) return null;
      return toOpenContextDocResolveResult(result.value);
    },
    [props.environmentId, resolveOpenContextDocQuery],
  );
  const openDocument = useCallback(
    (absolutePath: string) => {
      useRightPanelStore.getState().openFile(props.threadRef, absolutePath);
    },
    [props.threadRef],
  );
  return (
    <li className="border-l-2 border-border pl-2 text-xs" data-mail-letter-id={letter.letterId}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{mailLetterSenderLabel(letter, task)}</span>
        <span className="text-muted-foreground">→ {mailRecipientLabel(letter.recipient)}</span>
        <Badge variant="secondary" size="sm">
          {letter.kind}
        </Badge>
        {letter.planPhase !== null ? (
          <Badge variant="outline" size="sm">
            {mailPlanPhaseLabel(letter.planPhase, letter.planStep)}
          </Badge>
        ) : null}
        <time className="text-[10px] text-muted-foreground" dateTime={letter.createdAt}>
          {new Date(letter.createdAt).toLocaleString()}
        </time>
      </div>
      {deliveries.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {deliveries.map((delivery) => (
            <Badge
              key={delivery.deliveryId}
              variant={mailDeliveryBadgeVariant(delivery.state)}
              size="sm"
              {...(delivery.failureReason !== null ? { title: delivery.failureReason } : {})}
            >
              {delivery.state}
            </Badge>
          ))}
        </div>
      ) : null}
      {letter.body.trim() !== "" ? (
        <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed text-muted-foreground">
          {letter.body}
        </p>
      ) : null}
      {letter.planDocId !== null && documentsEnabled ? (
        <div className="mt-1">
          <OpenContextDocChip
            href={`oc://doc/${letter.planDocId}`}
            stableId={letter.planDocId}
            resolvable
            canOpenDocument
            resolveDoc={resolveDoc}
            onOpenDocument={openDocument}
          />
        </div>
      ) : null}
    </li>
  );
}

import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import type { MailTask, MailTimelineEntry } from "@t3tools/ft3-mail/contracts";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";

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
  MAIL_TASKS_PAGE_LIMIT,
  MAIL_TIMELINE_PAGE_LIMIT,
  mailDeliveryBadgeVariant,
  mailLetterSenderLabel,
  mailPlanPhaseLabel,
  mailRecipientLabel,
  mailTaskGroups,
  mailTasksUnsupported,
} from "./mail.logic.ts";
import { mailEnvironment } from "./state.ts";
import { useMailTabPolling } from "./useMailTabPolling.ts";

/**
 * The board chat panel's Mail tab. One `mail.tasks` request carries the whole
 * page (tasks plus their recent letters); doc chips resolve only on click,
 * never per row on mount. With mail off the page stays as read-only history.
 */
export function BoardMailTab(props: {
  readonly threadRef: ScopedThreadRef;
  readonly cardIds: ReadonlyArray<string>;
  /** Re-reads the board's card list so cards created after mount join the mail page. */
  readonly refreshCards?: () => void;
}) {
  const { environmentId } = props.threadRef;
  const { refreshCards } = props;
  const tasksQuery = useBoardMailTasks(environmentId, props.cardIds, props.threadRef.threadId);
  const refresh = useCallback(() => {
    refreshCards?.();
    void tasksQuery.refresh();
  }, [refreshCards, tasksQuery]);
  useMailTabPolling(refresh);
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
  if (mailTasksUnsupported(tasksQuery.error, tasksQuery.failure)) {
    return (
      <p className="text-xs text-muted-foreground">
        This server does not support the Mail tab yet. Update the server to use it here.
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
  const letters = tasksQuery.data?.letters ?? {};
  const cardGroups = mailTaskGroups(
    tasks.filter((task) => task.cardId !== null),
    letters,
  );
  const cardlessGroups = mailTaskGroups(
    tasks.filter((task) => task.cardId === null),
    letters,
  );
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
      {cardGroups.length >= MAIL_TASKS_PAGE_LIMIT ||
      cardlessGroups.length >= MAIL_TASKS_PAGE_LIMIT ? (
        <p className="text-[10px] text-muted-foreground">
          Showing the latest {MAIL_TASKS_PAGE_LIMIT} mail tasks.
        </p>
      ) : null}
      <ol className="space-y-3">
        {cardGroups.map((group) => (
          <MailTaskGroupItem
            key={group.task.taskId}
            environmentId={environmentId}
            threadRef={props.threadRef}
            group={group}
          />
        ))}
      </ol>
      {cardlessGroups.length > 0 ? (
        <section>
          <h2 className="text-xs font-semibold text-muted-foreground">Without a card</h2>
          <ol className="mt-2 space-y-3">
            {cardlessGroups.map((group) => (
              <MailTaskGroupItem
                key={group.task.taskId}
                environmentId={environmentId}
                threadRef={props.threadRef}
                group={group}
              />
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

/** Reads one letter by id for the lead chat notice; null input stays idle. */
export function useBoardMailLetter(
  environmentId: EnvironmentId,
  input: { readonly letterId: string; readonly threadId: string } | null,
) {
  return useEnvironmentQuery(
    input === null ? null : mailEnvironment.letter({ environmentId, input }),
  );
}

/** The tab's single query; the panel subscribes to the same atom for content and refresh. */
export function useBoardMailTasks(
  environmentId: EnvironmentId,
  cardIds: ReadonlyArray<string>,
  threadId: string,
) {
  return useEnvironmentQuery(
    mailEnvironment.tasks({
      environmentId,
      input: {
        cardIds,
        lettersPerTask: MAIL_TIMELINE_PAGE_LIMIT,
        withoutCard: true,
        threadId,
      },
    }),
  );
}

function MailTaskGroupItem(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly group: ReturnType<typeof mailTaskGroups>[number];
}) {
  const { group } = props;
  const { task, entries } = group;
  return (
    <li className="rounded-lg border border-border bg-card p-3" data-mail-task-id={task.taskId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-semibold leading-snug">{task.title}</h3>
        <Badge variant={task.status === "open" ? "secondary" : "outline"} size="sm">
          {task.status}
        </Badge>
      </div>
      {entries.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">No letters yet.</p>
      ) : (
        <>
          <ol className="mt-2 space-y-2">
            {entries.map((entry) => (
              <MailLetterItem
                key={entry.letter.letterId}
                environmentId={props.environmentId}
                threadRef={props.threadRef}
                task={task}
                entry={entry}
              />
            ))}
          </ol>
          {entries.length >= MAIL_TIMELINE_PAGE_LIMIT ? (
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
          {/* No label-less mount lookup: the chip resolves and opens only on click. */}
          <OpenContextDocChip
            href={`oc://doc/${letter.planDocId}`}
            stableId={letter.planDocId}
            resolvable
            label="Plan"
            canOpenDocument
            resolveDoc={resolveDoc}
            onOpenDocument={openDocument}
          />
        </div>
      ) : null}
    </li>
  );
}

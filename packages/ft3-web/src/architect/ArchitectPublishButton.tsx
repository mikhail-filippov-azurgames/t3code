import { AsyncResult } from "effect/reactivity";
import { UploadIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { composerFloatingLayerProps } from "~/components/chat/composerEventScope";
import { Button } from "~/components/ui/button";
import { Menu, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import {
  architectPublicationIdempotencyKey,
  canShowArchitectPublishButton,
  visibleArchitectPublications,
} from "./architect.logic.ts";
import { architectEnvironment } from "./state.ts";

export interface ArchitectPublishButtonProps {
  readonly threadRef: ScopedThreadRef | null;
  readonly compact?: boolean;
}

export function ArchitectPublishButton({
  threadRef,
  compact = false,
}: ArchitectPublishButtonProps) {
  const shell = useThreadShell(threadRef);
  const query = useEnvironmentQuery(
    threadRef === null
      ? null
      : architectEnvironment.sidebarSnapshotByArchitect({
          environmentId: threadRef.environmentId,
          input: { architectThreadId: threadRef.threadId },
        }),
  );
  const publish = useAtomCommand(architectEnvironment.publishArchitectPublication, {
    reportFailure: false,
  });
  const [publishingReviewId, setPublishingReviewId] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishedReviewIds, setPublishedReviewIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const activityVersion = `${shell?.updatedAt ?? ""}:${shell?.itemCount ?? 0}`;
  const previousActivityVersion = useRef(activityVersion);
  useEffect(() => {
    if (previousActivityVersion.current !== activityVersion) query.refresh();
    previousActivityVersion.current = activityVersion;
  }, [activityVersion, query.refresh]);

  const snapshot = query.data;
  const publishable = visibleArchitectPublications(snapshot?.publishable ?? [], publishedReviewIds);
  const binding = snapshot?.binding ?? null;
  const canPublish =
    threadRef !== null &&
    canShowArchitectPublishButton({
      isArchitectThread: binding?.architectThreadId === threadRef.threadId,
      binding,
      publishableCount: publishable.length,
    });

  if (!canPublish || threadRef === null) return null;

  const onPublish = async (reviewId: string) => {
    if (publishingReviewId !== null) return;
    setPublishingReviewId(reviewId);
    setPublishError(null);
    const result = await publish({
      environmentId: threadRef.environmentId,
      input: { reviewId, idempotencyKey: architectPublicationIdempotencyKey() },
    });
    setPublishingReviewId(null);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setPublishError(cause instanceof Error ? cause.message : "The publication request failed.");
      return;
    }
    setPublishedReviewIds((current) => {
      const next = new Set(current);
      next.add(reviewId);
      return next;
    });
    query.refresh();
  };

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size={compact ? "icon-sm" : "sm"}
            variant="outline"
            className={cn("rounded-full", compact ? "px-0" : "px-3")}
            aria-label="Publish to coordinator"
            title="Publish to coordinator"
            onPointerDown={(event) => event.preventDefault()}
          />
        }
      >
        <UploadIcon className={compact ? "size-3.5" : "size-4"} aria-hidden="true" />
        {compact ? <span className="sr-only">Publish to coordinator</span> : "Publish"}
      </MenuTrigger>
      <MenuPopup
        align="end"
        side="top"
        className="w-80 max-w-[calc(100vw-2rem)]"
        {...composerFloatingLayerProps}
      >
        <div className="grid min-w-0 gap-2 p-1">
          <p className="px-2 text-xs font-medium text-muted-foreground">Coordinator publications</p>
          {publishable.map((record) => (
            <div
              key={record.reviewId}
              className="grid min-w-0 max-w-full gap-2 overflow-hidden rounded-md border border-border/60 bg-background/70 p-2"
              data-testid={`architect-publication-${record.reviewId}`}
            >
              {record.question ? (
                <p className="min-w-0 whitespace-pre-wrap wrap-anywhere text-xs text-muted-foreground">
                  Coordinator request: {record.question}
                </p>
              ) : null}
              <p className="min-w-0 whitespace-pre-wrap wrap-anywhere text-sm">{record.summary}</p>
              <p className="text-xs text-muted-foreground">
                {record.disposition.replaceAll("-", " ")}
              </p>
              <Button
                size="sm"
                className="justify-self-end"
                disabled={publishingReviewId !== null}
                onClick={() => void onPublish(record.reviewId)}
                aria-label={`Publish ${record.summary}`}
              >
                {publishingReviewId === record.reviewId ? "Publishing:" : "Publish"}
              </Button>
            </div>
          ))}
          {publishError ? (
            <p role="alert" className="px-2 text-xs text-destructive-foreground">
              {publishError}
            </p>
          ) : null}
        </div>
      </MenuPopup>
    </Menu>
  );
}

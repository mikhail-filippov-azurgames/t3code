import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  MessageCircleQuestionIcon,
  SendIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useThreadShell, useThreadShells, useThreadUpdatedAt } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  architectRouteLabel,
  buildArchitectReplacePrompt,
  resolveArchitectReviewAttention,
} from "./architect.logic.ts";
import { architectEnvironment } from "./state.ts";
import { reportActiveArchitectChild } from "../sidebar/architectBindingIndex.ts";

export interface ArchitectSidebarPinProps {
  readonly thread: Pick<EnvironmentThreadShell, "environmentId" | "id" | "title">;
  readonly depth?: number;
  readonly onNavigate: (threadRef: ScopedThreadRef) => void;
}

export function ArchitectSidebarPin({ thread, depth = 0, onNavigate }: ArchitectSidebarPinProps) {
  const coordinatorRef = scopeThreadRef(thread.environmentId, thread.id);
  const coordinatorKey = scopedThreadKey(coordinatorRef);
  const query = useEnvironmentQuery(
    architectEnvironment.sidebarSnapshot({
      environmentId: thread.environmentId,
      input: { coordinatorThreadId: thread.id },
    }),
  );
  const updatedAt = useThreadUpdatedAt(coordinatorRef);
  const binding = query.data?.binding ?? null;
  const architectRef =
    binding !== null && binding.status === "active"
      ? scopeThreadRef(thread.environmentId, binding.architectThreadId)
      : null;
  const architectShell = useThreadShell(architectRef);
  // Detach/replace and deletion do not always bump the coordinator's
  // updatedAt, so the snapshot also refreshes on the bound architect thread's
  // own activity and on any thread-list membership change.
  const threadShells = useThreadShells();
  const threadListVersion = useMemo(() => {
    let signature = 0;
    for (const shell of threadShells) {
      const token = `${shell.environmentId}:${shell.id}:${shell.updatedAt}:${shell.deletedAt ?? ""}`;
      for (let index = 0; index < token.length; index += 1) {
        signature = (signature * 31 + token.charCodeAt(index)) | 0;
      }
    }
    return `${threadShells.length}:${signature}`;
  }, [threadShells]);
  const activityVersion = `${updatedAt?.toString() ?? ""}:${
    architectShell?.updatedAt ?? ""
  }:${architectShell?.deletedAt ?? ""}:${threadListVersion}`;
  const previousActivityVersion = useRef(activityVersion);
  useEffect(() => {
    if (previousActivityVersion.current !== activityVersion) query.refresh();
    previousActivityVersion.current = activityVersion;
  }, [activityVersion, query.refresh]);

  const architectDeleted = architectShell?.deletedAt != null;
  // Only an active, live binding nests its Architect row and offers actions:
  // a detached/replaced binding hides the pin, a deleted architect thread
  // keeps the marker without actions.
  const activeArchitectKey =
    architectRef !== null && !architectDeleted ? scopedThreadKey(architectRef) : null;
  useEffect(() => {
    reportActiveArchitectChild({ coordinatorKey, architectKey: activeArchitectKey });
    return () => reportActiveArchitectChild({ coordinatorKey, architectKey: null });
  }, [coordinatorKey, activeArchitectKey]);

  if (binding === null || binding.status !== "active" || architectRef === null) return null;

  const attention = resolveArchitectReviewAttention(query.data?.reviews ?? []);
  const architectIsWorking = threadRuntimeIsActive(architectShell?.runtime);

  const replace = () => {
    const reason = window.prompt("Reason for replacing this Architect:");
    if (!reason?.trim()) return;
    useComposerDraftStore.getState().setPrompt(
      coordinatorRef,
      buildArchitectReplacePrompt({
        architectThreadId: binding.architectThreadId,
        taskEffort: binding.architectTaskEffort,
        reason: reason.trim(),
      }),
    );
    onNavigate(coordinatorRef);
  };

  return (
    <li
      className="list-none"
      data-thread-selection-safe
      data-testid={`coordinator-architect-pin-${thread.id}`}
      style={depth > 0 ? { marginLeft: depth * 12 } : undefined}
    >
      <div className="flex min-h-9 min-w-0 items-center gap-1.5 rounded-md border border-sidebar-border/70 bg-sidebar-row-hover/40 px-2 py-1 text-xs">
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
          onClick={() => onNavigate(architectRef)}
          aria-label={`Open Architect ${architectShell?.title ?? ""}`}
        >
          <span className="mr-1.5">Architect</span>
          <span className="text-sidebar-muted-foreground">{architectRouteLabel(binding)}</span>
        </button>
        <span className="shrink-0 text-sidebar-muted-foreground">
          {architectDeleted ? "Deleted" : "Active"}
        </span>
        {architectIsWorking ? (
          <span
            className="inline-flex shrink-0 text-sky-600 dark:text-sky-300/80"
            role="status"
            data-testid={`coordinator-architect-working-${thread.id}`}
          >
            <span className="sr-only">Architect is working</span>
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex animate-status-pulse" />}>
                <CircleDashedIcon aria-hidden="true" className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup>Architect is working</TooltipPopup>
            </Tooltip>
          </span>
        ) : null}
        {attention.map(({ status, count }) => {
          const Icon =
            status === "open"
              ? MessageCircleQuestionIcon
              : status === "answered"
                ? CircleCheckIcon
                : SendIcon;
          const label =
            status === "open"
              ? `Open ${count}`
              : status === "answered"
                ? `Ready to publish ${count}`
                : `Published ${count}`;
          return (
            <Tooltip key={status}>
              <TooltipTrigger
                render={
                  <span
                    className="inline-flex items-center gap-0.5"
                    role="img"
                    aria-label={label}
                  />
                }
              >
                <Icon aria-hidden="true" className="size-3" />
                <span aria-hidden="true">{count}</span>
              </TooltipTrigger>
              <TooltipPopup>{label}</TooltipPopup>
            </Tooltip>
          );
        })}
        {architectDeleted ? null : (
          <>
            <Button size="xs" variant="ghost" onClick={() => onNavigate(architectRef)}>
              Open
            </Button>
            <Button size="xs" variant="ghost" onClick={replace}>
              Replace
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

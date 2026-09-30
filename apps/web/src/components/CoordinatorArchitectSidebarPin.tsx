import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useEffect, useRef } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { useThreadDetail } from "../state/entities";
import {
  coordinatorArchitectEnvironment,
  reportActiveArchitectChild,
} from "../state/coordinatorArchitect";
import { useEnvironmentQuery } from "../state/query";
import { requestSwitchProviderTarget } from "./SwitchProviderDialog";
import { resolveCoordinatorArchitectReviewAttention } from "./Sidebar.logic";
import { buildCoordinatorArchitectSidebarPrompt } from "./threadActionMenu.logic";
import { SidebarMenuSubItem } from "./ui/sidebar";

const ARCHITECT_BOUND_ACTIVITY = "architect.bound";

export interface CoordinatorArchitectSidebarPinProps {
  readonly environmentId: EnvironmentId;
  readonly coordinatorThreadId: ThreadId;
  readonly isCurrentThread: boolean;
  readonly depth?: number;
  readonly onNavigate: (threadRef: ScopedThreadRef) => void;
}

export function CoordinatorArchitectSidebarPin({
  environmentId,
  coordinatorThreadId,
  isCurrentThread,
  depth = 0,
  onNavigate,
}: CoordinatorArchitectSidebarPinProps) {
  const coordinatorRef = scopeThreadRef(environmentId, coordinatorThreadId);
  const coordinatorKey = scopedThreadKey(coordinatorRef);
  const detail = useThreadDetail(coordinatorRef);
  const hasBindingHistory =
    detail?.activities.some((activity) => activity.kind === ARCHITECT_BOUND_ACTIVITY) ?? false;
  const enabled = isCurrentThread || hasBindingHistory;
  const query = useEnvironmentQuery(
    enabled
      ? coordinatorArchitectEnvironment.sidebarSnapshot({
          environmentId,
          input: { coordinatorThreadId },
        })
      : null,
  );
  const latestActivityId = detail?.activities.at(-1)?.id ?? "";
  const activityVersion = `${detail?.updatedAt ?? ""}:${detail?.activities.length ?? 0}:${latestActivityId}`;
  const previousActivityVersion = useRef(activityVersion);

  useEffect(() => {
    if (enabled && previousActivityVersion.current !== activityVersion) query.refresh();
    previousActivityVersion.current = activityVersion;
  }, [activityVersion, enabled, query.refresh]);

  const binding = query.data?.binding ?? null;
  // Only an active binding nests its Architect row; the cleared report covers
  // terminal bindings and unmounting rows.
  const activeArchitectKey =
    binding !== null && binding.status === "active"
      ? scopedThreadKey(scopeThreadRef(environmentId, binding.architectThreadId))
      : null;
  useEffect(() => {
    reportActiveArchitectChild({ coordinatorKey, architectKey: activeArchitectKey });
    return () => reportActiveArchitectChild({ coordinatorKey, architectKey: null });
  }, [coordinatorKey, activeArchitectKey]);

  if (binding === null || binding.status !== "active") return null;

  const selected = binding.routingEvidence?.consideredCandidates.at(-1) ?? null;
  const attention = resolveCoordinatorArchitectReviewAttention(query.data?.reviews ?? []);
  const attentionLabel = attention
    .map(({ status, count }) => {
      const label =
        status === "open" ? "Open" : status === "answered" ? "Ready to publish" : "Published";
      return `${label} ${count}`;
    })
    .join(" · ");
  const architectRef = scopeThreadRef(environmentId, binding.architectThreadId);
  const currentCandidate = selected
    ? { instanceId: selected.providerInstanceId, model: selected.model }
    : null;

  const replace = async () => {
    const choice = await requestSwitchProviderTarget({
      environmentId,
      currentInstanceId: currentCandidate?.instanceId ?? null,
      currentModel: currentCandidate?.model ?? null,
      purpose: {
        title: "Choose preferred Architect route",
        description:
          "The Coordinator will verify this preference against role=architecture, the accepted routing policy, and the live read-only permission envelope before replacement.",
        reasonLabel: "Replacement reason (required)",
        reasonPlaceholder: "Why should the current Architect be replaced?",
        submitLabel: "Use route",
        requireReason: true,
      },
    });
    if (choice === null) return;
    let reason = choice.reason;
    if (reason === null) {
      reason = window.prompt("Reason for replacing this Architect:");
    }
    if (!reason?.trim()) return;
    if (
      !window.confirm(
        "Confirm that the routing decision and reason are saved in OpenContext, and that you want to replace the Architect. The old binding will be retained as replaced and its credential will be revoked after the durable change.",
      )
    ) {
      return;
    }
    useComposerDraftStore.getState().setPrompt(
      coordinatorRef,
      buildCoordinatorArchitectSidebarPrompt({
        action: "replace",
        architectThreadId: binding.architectThreadId,
        taskEffort: binding.architectTaskEffort,
        questionOrReason: reason.trim(),
        preferredTarget: {
          instanceId: choice.instanceId,
          driverKind: choice.driverKind,
          model: choice.model,
        },
      }),
    );
    onNavigate(coordinatorRef);
  };

  const detach = () => {
    const reason = window.prompt("Reason for detaching this Architect:");
    if (!reason?.trim()) return;
    if (
      !window.confirm(
        "Detach this Architect? The binding remains as a detached audit record; its credential is revoked after the durable change. This does not purge the thread or binding.",
      )
    ) {
      return;
    }
    useComposerDraftStore.getState().setPrompt(
      coordinatorRef,
      buildCoordinatorArchitectSidebarPrompt({
        action: "detach",
        architectThreadId: binding.architectThreadId,
        taskEffort: binding.architectTaskEffort,
        questionOrReason: reason.trim(),
      }),
    );
    onNavigate(coordinatorRef);
  };

  const leftInset = (depth + 1) * 16;
  return (
    <SidebarMenuSubItem
      className="w-full"
      data-thread-selection-safe
      data-testid={`coordinator-architect-pin-${coordinatorThreadId}`}
      style={{ paddingInlineStart: `${leftInset}px` }}
    >
      <div className="flex min-h-9 min-w-0 items-center gap-1.5 rounded-md border border-sidebar-border/70 bg-sidebar-accent/35 px-2 py-1 text-xs">
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
          onClick={() => onNavigate(architectRef)}
          aria-label={`Open Architect ${selected?.alias ?? ""} ${selected?.model ?? ""}`.trim()}
        >
          <span className="mr-1.5">Architect</span>
          <span className="text-sidebar-muted-foreground">
            {selected ? `${selected.providerInstanceId} · ${selected.model}` : "Bound"}
          </span>
        </button>
        <span className="shrink-0 text-sidebar-muted-foreground">Active</span>
        {attentionLabel ? (
          <span
            className="shrink-0 text-amber-700 dark:text-amber-300"
            role="status"
            data-testid={`coordinator-architect-attention-${coordinatorThreadId}`}
          >
            {attentionLabel}
          </span>
        ) : null}
        <button
          type="button"
          className="rounded px-1 hover:bg-sidebar-accent"
          onClick={() => onNavigate(architectRef)}
        >
          Open
        </button>
        <button
          type="button"
          className="rounded px-1 hover:bg-sidebar-accent"
          onClick={() => void replace()}
        >
          Replace
        </button>
        <button type="button" className="rounded px-1 hover:bg-sidebar-accent" onClick={detach}>
          Detach
        </button>
      </div>
    </SidebarMenuSubItem>
  );
}

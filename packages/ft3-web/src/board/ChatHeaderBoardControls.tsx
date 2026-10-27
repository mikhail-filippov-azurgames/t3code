import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { Badge } from "~/components/ui/badge";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { BoardThreadActionsControl } from "./BoardThreadActionsControl";
import { resolveBoardThreadActionsControlModel } from "./boardThreadActions.logic";
import { OrchestratorIcon, ORCHESTRATOR_ICON_CLASS } from "./boardRoleIcons";
import { useBoardOrchestratorThreadKeys } from "./useBoardBackend";
import { useBoardThreadActions } from "./useBoardThreadActions";

export interface CoordinatorBadgeProps {
  readonly activeThreadId: ThreadId;
  readonly isServerThread: boolean;
}

/** Coordinator marker next to the thread title, as in the old fork. */
export function CoordinatorBadge({ activeThreadId, isServerThread }: CoordinatorBadgeProps) {
  const orchestratorThreadKeys = useBoardOrchestratorThreadKeys();
  if (!isServerThread || !orchestratorThreadKeys.has(activeThreadId)) return null;
  return (
    <Badge variant="secondary" size="sm" className="ml-1 shrink-0 gap-1">
      <OrchestratorIcon aria-hidden className={`size-3 ${ORCHESTRATOR_ICON_CLASS}`} />
      Coordinator
    </Badge>
  );
}

export interface ChatHeaderBoardActionsProps {
  readonly activeThreadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly isServerThread: boolean;
  /** The active thread carries a delegation lineage, so it is a delegated child. */
  readonly hasDelegationParent: boolean;
}

/** Coordinator actions control in the chat header; hidden where no action applies. */
export function ChatHeaderBoardActions({
  activeThreadId,
  environmentId,
  isServerThread,
  hasDelegationParent,
}: ChatHeaderBoardActionsProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const orchestratorThreadKeys = useBoardOrchestratorThreadKeys();
  const isOrchestrator = orchestratorThreadKeys.has(activeThreadId);
  // The toolbar control and the sidebar menu share one item set and one handler.
  const runBoardThreadAction = useBoardThreadActions();
  const model = useMemo(
    () =>
      resolveBoardThreadActionsControlModel({
        isServerThread,
        environmentId,
        primaryEnvironmentId,
        isCoordinator: isOrchestrator,
        hasDelegationParent,
      }),
    [environmentId, hasDelegationParent, isOrchestrator, isServerThread, primaryEnvironmentId],
  );
  return (
    <BoardThreadActionsControl
      model={model}
      onSelect={(actionId) => void runBoardThreadAction(actionId, activeThreadId)}
    />
  );
}

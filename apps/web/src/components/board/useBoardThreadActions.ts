/**
 * Wires the shared board thread action handler to the web client runtime:
 * board atom commands on the primary environment, `/board` navigation for
 * Create task, the destructive confirm dialog, and the stacked thread toasts.
 *
 * @module components/board/useBoardThreadActions
 */
import type { ThreadId } from "@t3tools/contracts";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { readLocalApi } from "../../localApi";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  runBoardThreadAction,
  type BoardThreadActionId,
  type BoardThreadActionPorts,
} from "./boardThreadActions.logic";
import { readSkipOrchestratorUnmarkConfirmation } from "./boardPreferences";
import { boardEnvironment } from "./useBoardBackend";

export function useBoardThreadActions(): (
  actionId: BoardThreadActionId,
  threadId: ThreadId,
) => Promise<void> {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const addCoordinator = useAtomCommand(boardEnvironment.orchestratorAdd, {
    reportFailure: false,
  });
  const removeCoordinator = useAtomCommand(boardEnvironment.orchestratorRemove, {
    reportFailure: false,
  });
  const resendCoordinatorBrief = useAtomCommand(boardEnvironment.resendBrief, {
    reportFailure: false,
  });
  const router = useRouter();

  const openCreateTask = useCallback(
    (threadId: ThreadId) => {
      void router.navigate({
        to: "/board",
        search: { orchestrator: threadId, create: true },
      });
    },
    [router],
  );

  const confirmRemoveCoordinator = useCallback(async () => {
    if (readSkipOrchestratorUnmarkConfirmation()) return true;
    const api = readLocalApi();
    if (!api) return false;
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm("Remove this Coordinator? Its cards and delegated chats are deleted.", {
        variant: "destructive",
      }),
    );
    return confirmed._tag === "Success" && confirmed.value;
  }, []);

  return useCallback(
    (actionId, threadId) => {
      const ports: BoardThreadActionPorts = {
        addCoordinator,
        removeCoordinator,
        resendCoordinatorBrief,
        openCreateTask,
        confirmRemoveCoordinator,
        notify: (toast) => toastManager.add(stackedThreadToast(toast)),
      };
      return runBoardThreadAction({
        actionId,
        threadId,
        primaryEnvironmentId,
        ports,
      });
    },
    [
      addCoordinator,
      confirmRemoveCoordinator,
      openCreateTask,
      primaryEnvironmentId,
      removeCoordinator,
      resendCoordinatorBrief,
    ],
  );
}

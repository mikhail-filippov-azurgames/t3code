/**
 * Board Coordinator thread actions, shared by the sidebar context menu and the
 * chat header toolbar. The item set and the action handler live here once so
 * both surfaces cannot drift apart: `buildBoardThreadContextMenuItems` owns the
 * ids and labels, and `runBoardThreadAction` owns the mutations, toasts and
 * destructive confirmation.
 *
 * @module components/board/boardThreadActions.logic
 */
import type { ContextMenuItem, EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

export const BoardThreadAction = {
  createTask: "board-create-task",
  resendBrief: "board-resend-brief",
  makeCoordinator: "board-make-orchestrator",
  removeCoordinator: "board-unmark-orchestrator",
} as const;

export type BoardThreadActionId = (typeof BoardThreadAction)[keyof typeof BoardThreadAction];

const BOARD_THREAD_ACTION_IDS: ReadonlySet<string> = new Set(Object.values(BoardThreadAction));

export function isBoardThreadActionId(
  value: string | null | undefined,
): value is BoardThreadActionId {
  return value != null && BOARD_THREAD_ACTION_IDS.has(value);
}

/**
 * The three conditions both surfaces read off a thread to decide which board
 * actions exist. The sidebar has only real threads; the header must also reject
 * drafts, so `isServerThread` is part of the shared rule.
 */
export interface BoardThreadMenuInput {
  readonly isServerThread: boolean;
  readonly environmentId: string;
  readonly primaryEnvironmentId: string | null;
  readonly isCoordinator: boolean;
  readonly hasDelegationParent: boolean;
}

export function resolveBoardThreadMenuInput(input: BoardThreadMenuInput): {
  readonly isBoardEligible: boolean;
  readonly isCoordinator: boolean;
  readonly hasDelegationParent: boolean;
} {
  return {
    isBoardEligible:
      input.isServerThread &&
      input.primaryEnvironmentId !== null &&
      input.environmentId === input.primaryEnvironmentId,
    isCoordinator: input.isCoordinator,
    hasDelegationParent: input.hasDelegationParent,
  };
}

export function buildBoardThreadContextMenuItems(input: {
  readonly isBoardEligible: boolean;
  readonly isCoordinator: boolean;
  readonly hasDelegationParent: boolean;
}): {
  readonly topItems: ReadonlyArray<ContextMenuItem<BoardThreadActionId>>;
  readonly destructiveItems: ReadonlyArray<ContextMenuItem<BoardThreadActionId>>;
} {
  if (!input.isBoardEligible) return { topItems: [], destructiveItems: [] };

  const topItems: ContextMenuItem<BoardThreadActionId>[] = input.isCoordinator
    ? [
        { id: BoardThreadAction.createTask, label: "Create task" },
        { id: BoardThreadAction.resendBrief, label: "Resend Coordinator brief" },
      ]
    : input.hasDelegationParent
      ? []
      : [{ id: BoardThreadAction.makeCoordinator, label: "Make Coordinator" }];
  const destructiveItems: ContextMenuItem<BoardThreadActionId>[] = input.isCoordinator
    ? [{ id: BoardThreadAction.removeCoordinator, label: "Remove Coordinator", destructive: true }]
    : [];

  return { topItems, destructiveItems };
}

/** Toolbar decomposition: nothing to render, or a menu over the shared item set. */
export type BoardThreadActionsControlModel =
  | {
      readonly kind: "hidden";
      readonly topItems: readonly [];
      readonly destructiveItems: readonly [];
    }
  | {
      readonly kind: "menu";
      readonly topItems: ReadonlyArray<ContextMenuItem<BoardThreadActionId>>;
      readonly destructiveItems: ReadonlyArray<ContextMenuItem<BoardThreadActionId>>;
    };

export function resolveBoardThreadActionsControlModel(
  input: BoardThreadMenuInput,
): BoardThreadActionsControlModel {
  const items = buildBoardThreadContextMenuItems(resolveBoardThreadMenuInput(input));
  return items.topItems.length === 0 && items.destructiveItems.length === 0
    ? { kind: "hidden", topItems: [], destructiveItems: [] }
    : { kind: "menu", topItems: items.topItems, destructiveItems: items.destructiveItems };
}

export interface BoardThreadActionToast {
  readonly type: "error" | "success";
  readonly title: string;
  readonly description: string;
}

interface CoordinatorMutation {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly threadId: ThreadId };
}

export interface BoardThreadActionPorts {
  readonly addCoordinator: (
    input: CoordinatorMutation,
  ) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly removeCoordinator: (
    input: CoordinatorMutation,
  ) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly resendCoordinatorBrief: (
    input: CoordinatorMutation,
  ) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly openCreateTask: (threadId: ThreadId) => void;
  readonly confirmRemoveCoordinator: () => Promise<boolean>;
  readonly notify: (toast: BoardThreadActionToast) => void;
}

function failureDescription(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "An error occurred.";
}

/**
 * The sidebar and the toolbar both route their board action ids here. Failures
 * toast and report the same titles as the sidebar always did; a cancelled
 * confirmation aborts the removal without touching the Coordinator.
 */
export async function runBoardThreadAction(input: {
  readonly actionId: BoardThreadActionId;
  readonly threadId: ThreadId;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly ports: BoardThreadActionPorts;
}): Promise<void> {
  const { actionId, threadId, ports } = input;
  const environmentId = input.primaryEnvironmentId;

  switch (actionId) {
    case BoardThreadAction.makeCoordinator: {
      if (environmentId === null) return;
      const result = await ports.addCoordinator({ environmentId, input: { threadId } });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        ports.notify({
          type: "error",
          title: "Could not mark the Coordinator",
          description: failureDescription(result),
        });
      }
      return;
    }
    case BoardThreadAction.createTask: {
      ports.openCreateTask(threadId);
      return;
    }
    case BoardThreadAction.resendBrief: {
      if (environmentId === null) return;
      const result = await ports.resendCoordinatorBrief({ environmentId, input: { threadId } });
      if (result._tag === "Success") {
        ports.notify({
          type: "success",
          title: "Coordinator brief resent",
          description: "The Coordinator will see it in its thread.",
        });
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        ports.notify({
          type: "error",
          title: "Could not resend the Coordinator brief",
          description: failureDescription(result),
        });
      }
      return;
    }
    case BoardThreadAction.removeCoordinator: {
      if (environmentId === null) return;
      if (!(await ports.confirmRemoveCoordinator())) return;
      const result = await ports.removeCoordinator({ environmentId, input: { threadId } });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        ports.notify({
          type: "error",
          title: "Could not remove the Coordinator",
          description: failureDescription(result),
        });
      }
      return;
    }
  }
}

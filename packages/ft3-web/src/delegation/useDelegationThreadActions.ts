import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import type { ThreadActionMenuId } from "~/components/threadActionMenu.logic";
import type { useThreadActions } from "~/hooks/useThreadActions";
import { useClientSettings } from "~/hooks/useSettings";
import { readLocalApi } from "~/localApi";
import { readThreadShell, readThreadShells } from "~/state/entities";
import {
  collectDelegatedChildRefs,
  countDelegatedDescendants,
  runDelegatedChildrenAction,
  runDelegatedChildrenCleanup,
} from "./delegatedChildren.logic";
import { requestThreadChildrenDialog } from "./threadChildrenDialog";
import { requestSwitchProviderTarget } from "./switchProviderStore";
import { useSwitchThreadProvider } from "./useSwitchThreadProvider";

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/**
 * Thread-menu actions that follow delegation lineage and provider handoff:
 * provider switch, bulk cleanup of old subtasks, and the archive/delete
 * cascades. Archive and delete return false when the thread has no delegated
 * children, so the upstream menu hook runs its own unchanged flow.
 */
export function useDelegationThreadActions(
  threadActions: Pick<ReturnType<typeof useThreadActions>, "archiveThread" | "deleteThread">,
): (
  action: ThreadActionMenuId,
  thread: EnvironmentThreadShell,
  threadRef: ScopedThreadRef,
) => Promise<boolean> {
  const { archiveThread, deleteThread } = threadActions;
  const { attemptSwitchProvider } = useSwitchThreadProvider();
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const archiveThreadChildren = useClientSettings((s) => s.archiveThreadChildren);

  return useCallback(
    async (
      action: ThreadActionMenuId,
      thread: EnvironmentThreadShell,
      threadRef: ScopedThreadRef,
    ): Promise<boolean> => {
      const api = readLocalApi();
      if (!api) return false;
      switch (action) {
        case "switch-provider": {
          // Target + optional reason come from the picker dialog; the attempt
          // persists the model selection and reports handoff failures
          // (including provider_handoff_unsupported) as a visible toast.
          const choice = await requestSwitchProviderTarget({
            environmentId: threadRef.environmentId,
            currentInstanceId: thread.modelSelection.instanceId,
            currentModel: thread.modelSelection.model,
          });
          if (!choice) return true;
          await attemptSwitchProvider(
            threadRef,
            {
              providerInstanceId: choice.instanceId,
              driverKind: choice.driverKind,
              model: choice.model,
            },
            choice.reason,
          );
          return true;
        }
        case "archive-old-children":
        case "delete-old-children": {
          const cleanupAction = action === "delete-old-children" ? "delete" : "archive";
          const outcome = await runDelegatedChildrenCleanup({
            action: cleanupAction,
            parent: threadRef,
            threads: readThreadShells(),
            confirm: async (message) => {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(
                  message,
                  cleanupAction === "delete" ? { variant: "destructive" } : undefined,
                ),
              );
              return confirmed._tag === "Success" && confirmed.value;
            },
            runChild: async (childRef, staleKeys) => {
              if (cleanupAction === "archive") {
                const result = await archiveThread(childRef);
                return result._tag === "Failure" && !isAtomCommandInterrupted(result)
                  ? { ok: false, error: squashAtomCommandFailure(result) }
                  : { ok: true };
              }
              const result = await deleteThread(childRef, { deletedThreadKeys: staleKeys });
              if (
                result._tag === "Failure" &&
                !isAtomCommandInterrupted(result) &&
                readThreadShell(childRef) !== null
              ) {
                return { ok: false, error: squashAtomCommandFailure(result) };
              }
              return { ok: true };
            },
          });
          if (outcome.kind === "child-failed") {
            failureToast(
              cleanupAction === "delete"
                ? "Failed to delete old delegated subtask"
                : "Failed to archive old delegated subtask",
              outcome.error,
            );
          }
          return true;
        }
        case "archive": {
          const children = collectDelegatedChildRefs({
            parent: threadRef,
            threads: readThreadShells(),
          });
          if (children.length === 0) return false;
          const outcome = await runDelegatedChildrenAction({
            children,
            mode: archiveThreadChildren,
            ask: () =>
              requestThreadChildrenDialog({ action: "archive", childCount: children.length }),
            runChild: async (childRef) => {
              const result = await archiveThread(childRef);
              return result._tag === "Success"
                ? { ok: true }
                : { ok: false, error: squashAtomCommandFailure(result) };
            },
            runParent: async ({ cascadeConfirmed }) => {
              if (!cascadeConfirmed && confirmThreadArchive) {
                const confirmed = await settlePromise(() =>
                  api.dialogs.confirm(`Archive thread "${thread.title}"?`),
                );
                if (confirmed._tag === "Failure" || !confirmed.value) return { ok: false };
              }
              let didArchive = false;
              const result = await archiveThread(threadRef, {
                onArchived: () => {
                  didArchive = true;
                },
              });
              if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                failureToast(
                  didArchive
                    ? "Thread archived, but navigation failed"
                    : "Failed to archive thread",
                  squashAtomCommandFailure(result),
                );
                return { ok: false };
              }
              return { ok: true };
            },
          });
          if (outcome.kind === "child-failed") {
            failureToast("Failed to archive delegated subtask", outcome.error);
          }
          return true;
        }
        case "delete": {
          const descendantCount = countDelegatedDescendants({
            parent: threadRef,
            threads: readThreadShells(),
          });
          if (descendantCount === 0) return false;
          // The server deletes the whole delegated subtree, so the client
          // only confirms (naming the cascade) and deletes the thread.
          if (confirmThreadDelete) {
            const lines = [
              `Delete thread "${thread.title}"?`,
              "This permanently clears conversation history for this thread.",
            ];
            if (descendantCount > 0) {
              lines.push(
                `${descendantCount} delegated subtask${descendantCount === 1 ? "" : "s"} under it will also be deleted.`,
              );
            }
            const confirmed = await settlePromise(() =>
              api.dialogs.confirm(lines.join("\n"), { variant: "destructive" }),
            );
            if (confirmed._tag === "Failure" || !confirmed.value) return true;
          }
          const deleted = await deleteThread(threadRef);
          if (
            deleted._tag === "Failure" &&
            !isAtomCommandInterrupted(deleted) &&
            // A failure with the thread already gone is worktree cleanup
            // failing after a successful delete — deleteThread has toasted
            // that itself, and "Failed to delete thread" would be a lie.
            readThreadShell(threadRef) !== null
          ) {
            failureToast("Failed to delete thread", squashAtomCommandFailure(deleted));
          }
          return true;
        }
        default:
          return false;
      }
    },
    [
      archiveThread,
      archiveThreadChildren,
      attemptSwitchProvider,
      confirmThreadArchive,
      confirmThreadDelete,
      deleteThread,
    ],
  );
}

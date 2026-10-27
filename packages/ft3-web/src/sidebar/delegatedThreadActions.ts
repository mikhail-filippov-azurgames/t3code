import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ThreadChildrenAction } from "@t3tools/contracts/settings";
import type { useThreadActions } from "~/hooks/useThreadActions";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import {
  collectDelegatedChildRefs,
  countDelegatedDescendants,
  runDelegatedChildrenAction,
  runDelegatedChildrenCleanup,
} from "../delegation/delegatedChildren.logic.ts";
import { requestThreadChildrenDialog } from "../delegation/threadChildrenDialog.ts";

type ThreadActions = ReturnType<typeof useThreadActions>;

export type Ft3SidebarDelegatedAction =
  | "archive"
  | "delete"
  | "archive-old-children"
  | "delete-old-children";

export async function runFt3SidebarDelegatedAction(input: {
  readonly action: Ft3SidebarDelegatedAction;
  readonly thread: Pick<EnvironmentThreadShell, "title">;
  readonly threadRef: ScopedThreadRef;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly archiveThread: ThreadActions["archiveThread"];
  readonly deleteThread: ThreadActions["deleteThread"];
  readonly getThread: (threadRef: ScopedThreadRef) => EnvironmentThreadShell | null;
  readonly archiveChildrenMode: ThreadChildrenAction;
  readonly confirmArchive: boolean;
  readonly confirmDelete: boolean;
  readonly confirm: (message: string, destructive?: boolean) => Promise<boolean>;
}): Promise<void> {
  if (input.action === "archive-old-children" || input.action === "delete-old-children") {
    const action = input.action === "delete-old-children" ? "delete" : "archive";
    const outcome = await runDelegatedChildrenCleanup({
      action,
      parent: input.threadRef,
      threads: input.threads,
      confirm: (message) => input.confirm(message, action === "delete"),
      runChild: async (childRef, staleKeys) => {
        if (action === "archive") {
          const result = await input.archiveThread(childRef);
          return result._tag === "Failure" && !isAtomCommandInterrupted(result)
            ? { ok: false, error: squashAtomCommandFailure(result) }
            : { ok: true };
        }
        const result = await input.deleteThread(childRef, { deletedThreadKeys: staleKeys });
        if (
          result._tag === "Failure" &&
          !isAtomCommandInterrupted(result) &&
          input.getThread(childRef) !== null
        ) {
          return { ok: false, error: squashAtomCommandFailure(result) };
        }
        return { ok: true };
      },
    });
    if (outcome.kind === "child-failed") {
      showActionError(
        action === "delete"
          ? "Failed to delete old delegated subtask"
          : "Failed to archive old delegated subtask",
        outcome.error,
      );
    }
    return;
  }

  if (input.action === "archive") {
    const children = collectDelegatedChildRefs({
      parent: input.threadRef,
      threads: input.threads,
    });
    const outcome = await runDelegatedChildrenAction({
      children,
      mode: input.archiveChildrenMode,
      ask: () => requestThreadChildrenDialog({ action: "archive", childCount: children.length }),
      runChild: async (childRef) => {
        const result = await input.archiveThread(childRef);
        return result._tag === "Success"
          ? { ok: true }
          : { ok: false, error: squashAtomCommandFailure(result) };
      },
      runParent: async ({ cascadeConfirmed }) => {
        if (!cascadeConfirmed && input.confirmArchive) {
          const confirmed = await input.confirm(`Archive thread "${input.thread.title}"?`);
          if (!confirmed) return { ok: false };
        }
        let didArchive = false;
        const result = await input.archiveThread(input.threadRef, {
          onArchived: () => {
            didArchive = true;
          },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          showActionError(
            didArchive ? "Thread archived, but navigation failed" : "Failed to archive thread",
            squashAtomCommandFailure(result),
          );
          return { ok: false };
        }
        return { ok: true };
      },
    });
    if (outcome.kind === "child-failed") {
      showActionError("Failed to archive delegated subtask", outcome.error);
    }
    return;
  }

  if (input.confirmDelete) {
    const descendantCount = countDelegatedDescendants({
      parent: input.threadRef,
      threads: input.threads,
    });
    const confirmed = await input.confirm(
      [
        `Delete thread "${input.thread.title}"?`,
        "This permanently clears conversation history for this thread.",
        ...(descendantCount > 0
          ? [
              `${descendantCount} delegated subtask${descendantCount === 1 ? "" : "s"} under it will also be deleted.`,
            ]
          : []),
      ].join("\n"),
      true,
    );
    if (!confirmed) return;
  }
  const result = await input.deleteThread(input.threadRef);
  if (
    result._tag === "Failure" &&
    !isAtomCommandInterrupted(result) &&
    input.getThread(input.threadRef) !== null
  ) {
    showActionError("Failed to delete thread", squashAtomCommandFailure(result));
  }
}

function showActionError(title: string, error: unknown): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

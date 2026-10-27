import { useSyncExternalStore } from "react";

/** Three outcomes: an explicit Yes cascades, No keeps the children, dismissal does nothing. */
export type ThreadChildrenDialogAnswer = "yes" | "no" | "dismissed";

export interface ThreadChildrenDialogRequest {
  readonly action: "delete" | "archive";
  readonly childCount: number;
  readonly resolve: (answer: ThreadChildrenDialogAnswer) => void;
}

let request: ThreadChildrenDialogRequest | null = null;
const listeners = new Set<() => void>();

function publish(next: ThreadChildrenDialogRequest | null): void {
  request = next;
  for (const listener of listeners) {
    listener();
  }
}

export function readThreadChildrenDialogRequest(): ThreadChildrenDialogRequest | null {
  return request;
}

function subscribeThreadChildrenDialogHost(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Answers a pending request and closes the dialog; safe with nothing open. */
export function respondToThreadChildrenDialog(answer: ThreadChildrenDialogAnswer): void {
  const pending = request;
  publish(null);
  pending?.resolve(answer);
}

/**
 * Opens the children dialog. A still-open request resolves "dismissed" so its
 * caller can never be stranded by a second menu action.
 */
export function requestThreadChildrenDialog(input: {
  readonly action: "delete" | "archive";
  readonly childCount: number;
}): Promise<ThreadChildrenDialogAnswer> {
  respondToThreadChildrenDialog("dismissed");
  return new Promise((resolve) => {
    publish({ action: input.action, childCount: input.childCount, resolve });
  });
}

export function useThreadChildrenDialogRequest(): ThreadChildrenDialogRequest | null {
  return useSyncExternalStore(
    subscribeThreadChildrenDialogHost,
    readThreadChildrenDialogRequest,
    readThreadChildrenDialogRequest,
  );
}

export function resetThreadChildrenDialogForTests(): void {
  listeners.clear();
  request = null;
}

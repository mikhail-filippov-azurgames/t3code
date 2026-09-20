import { create } from "zustand";

/** Three outcomes: an explicit Yes cascades, No keeps the children, dismissal does nothing. */
export type ThreadChildrenDialogAnswer = "yes" | "no" | "dismissed";

export interface ThreadChildrenDialogRequest {
  readonly action: "delete" | "archive";
  readonly childCount: number;
  readonly resolve: (answer: ThreadChildrenDialogAnswer) => void;
}

const useThreadChildrenDialogStore = create<{
  request: ThreadChildrenDialogRequest | null;
}>(() => ({ request: null }));

/** Answers a pending request and closes the dialog; safe with nothing open. */
export function respondToThreadChildrenDialog(answer: ThreadChildrenDialogAnswer): void {
  const request = useThreadChildrenDialogStore.getState().request;
  useThreadChildrenDialogStore.setState({ request: null });
  request?.resolve(answer);
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
    useThreadChildrenDialogStore.setState({ request: { ...input, resolve } });
  });
}

export function useThreadChildrenDialogRequest(): ThreadChildrenDialogRequest | null {
  return useThreadChildrenDialogStore((state) => state.request);
}

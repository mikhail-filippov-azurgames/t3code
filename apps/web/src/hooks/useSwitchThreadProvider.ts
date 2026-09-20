import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useRef, useState } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import {
  buildSwitchProviderInput,
  resolveSwitchProviderFailureMessage,
  type SwitchProviderTarget,
  type SwitchProviderTransport,
} from "../components/switchProviderDialog.logic";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import {
  dispatchSwitchProviderTransport,
  type SwitchProviderDispatchRequest,
} from "../switchProviderTransport";

const EMPTY_PENDING: ReadonlySet<string> = new Set();

/**
 * Thread-menu "Switch provider" attempt, shaped like the sidebar pin/unpin
 * attempts: fire-and-forget from the menu handler, an optimistic
 * in-flight mark per thread (prevents double submits while the engine
 * call is out), a success toast on switch, and a failure toast that
 * always carries the engine's own reason text.
 */
export function useSwitchThreadProvider(input?: {
  readonly transport?: SwitchProviderTransport | undefined;
}) {
  // Default transport: the `thread.switch-provider` dispatch command to the
  // engine. The per-call environment comes from the thread being switched;
  // an injected transport (tests, alternate surfaces) still wins.
  const dispatchSwitchProvider = useAtomCommand(threadEnvironment.switchProvider, {
    reportFailure: false,
  });
  const injectedTransport = input?.transport;
  const dispatchRunner = useCallback(
    (request: SwitchProviderDispatchRequest) =>
      dispatchSwitchProvider({
        environmentId: request.environmentId,
        input: {
          threadId: request.input.taskId,
          target: request.input.target,
          reason: request.input.reason,
        },
      }),
    [dispatchSwitchProvider],
  );
  const [pendingThreadKeys, setPendingThreadKeys] = useState<ReadonlySet<string>>(EMPTY_PENDING);
  const pendingThreadKeysRef = useRef(new Set<string>());

  const attemptSwitchProvider = useCallback(
    async (
      threadRef: ScopedThreadRef,
      target: SwitchProviderTarget,
      reason?: string | null,
    ): Promise<boolean> => {
      const threadKey = scopedThreadKey(threadRef);
      // State updates are asynchronous; the ref closes the double-click race
      // before React renders the optimistic pending state.
      if (pendingThreadKeysRef.current.has(threadKey)) return false;
      pendingThreadKeysRef.current.add(threadKey);
      setPendingThreadKeys(new Set(pendingThreadKeysRef.current));
      try {
        const swInput = buildSwitchProviderInput({
          taskId: threadRef.threadId,
          target,
          reason: reason ?? null,
        });
        const result = injectedTransport
          ? await injectedTransport(swInput)
          : await dispatchSwitchProviderTransport(dispatchRunner, {
              environmentId: threadRef.environmentId,
              input: swInput,
            });
        if (result.status === "failure") {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to switch provider",
              description: resolveSwitchProviderFailureMessage(result),
            }),
          );
          return false;
        }
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "Provider switched",
            description: `Now running on ${target.model} (${target.providerInstanceId}).`,
            timeout: 5_000,
          }),
        );
        return true;
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to switch provider",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return false;
      } finally {
        pendingThreadKeysRef.current.delete(threadKey);
        setPendingThreadKeys(new Set(pendingThreadKeysRef.current));
      }
    },
    [dispatchRunner, injectedTransport],
  );

  const isSwitchingProvider = useCallback(
    (threadRef: ScopedThreadRef) => pendingThreadKeys.has(scopedThreadKey(threadRef)),
    [pendingThreadKeys],
  );

  return { attemptSwitchProvider, isSwitchingProvider };
}

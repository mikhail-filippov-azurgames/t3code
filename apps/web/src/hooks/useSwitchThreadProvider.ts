import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useRef, useState } from "react";

import {
  buildSwitchProviderInput,
  resolveSwitchProviderFailureMessage,
  type SwitchProviderTarget,
  type SwitchProviderTransport,
} from "@t3tools/ft3-web/delegation";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

const EMPTY_PENDING: ReadonlySet<string> = new Set();

/**
 * Thread-menu "Switch provider" attempt, built on V2's native provider
 * handoff: the chosen instance/model is persisted with
 * `thread.update-metadata` and the server hands the thread off when the
 * current provider session supports it. Fire-and-forget from the menu
 * handler, an optimistic in-flight mark per thread (prevents double submits
 * while the mutation is out), a success toast on switch, and a failure toast
 * that always carries the server's own reason text. The collected reason is
 * accepted for parity with the picker dialog; the native handoff itself
 * carries no reason, so it is not sent.
 */
export function useSwitchThreadProvider(input?: {
  readonly transport?: SwitchProviderTransport | undefined;
}) {
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const injectedTransport = input?.transport;
  const [pendingThreadKeys, setPendingThreadKeys] = useState<ReadonlySet<string>>(EMPTY_PENDING);
  const pendingThreadKeysRef = useRef(new Set<string>());

  const attemptSwitchProvider = useCallback(
    async (
      threadRef: ScopedThreadRef,
      target: SwitchProviderTarget,
      reason?: string | null,
    ): Promise<boolean> => {
      const swInput = buildSwitchProviderInput({
        threadId: threadRef.threadId,
        target,
        reason: reason ?? null,
      });
      const threadKey = scopedThreadKey(threadRef);
      // State updates are asynchronous; the ref closes the double-click race
      // before React renders the optimistic pending state.
      if (pendingThreadKeysRef.current.has(threadKey)) return false;
      pendingThreadKeysRef.current.add(threadKey);
      setPendingThreadKeys(new Set(pendingThreadKeysRef.current));
      try {
        if (injectedTransport) {
          const result = await injectedTransport(swInput);
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
        } else {
          const result = await updateThreadMetadata({
            environmentId: threadRef.environmentId,
            input: {
              threadId: threadRef.threadId,
              modelSelection: {
                instanceId: swInput.target.providerInstanceId,
                model: swInput.target.model,
              },
            },
          });
          if (result._tag === "Failure") {
            if (isAtomCommandInterrupted(result)) return false;
            const failure = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to switch provider",
                description:
                  failure instanceof Error ? failure.message : "Could not switch provider.",
              }),
            );
            return false;
          }
        }
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "Provider switched",
            description: `Now running on ${swInput.target.model} (${swInput.target.providerInstanceId}).`,
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
    [injectedTransport, updateThreadMetadata],
  );

  const isSwitchingProvider = useCallback(
    (threadRef: ScopedThreadRef) => pendingThreadKeys.has(scopedThreadKey(threadRef)),
    [pendingThreadKeys],
  );

  return { attemptSwitchProvider, isSwitchingProvider };
}

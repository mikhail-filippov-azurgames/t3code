import { useSyncExternalStore } from "react";

import type { ProviderInstanceId } from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";

import type { SwitchProviderChoice, SwitchProviderDialogPurpose } from "./SwitchProviderDialog";

export interface SwitchProviderRequest {
  readonly environmentId: EnvironmentId;
  readonly currentInstanceId: ProviderInstanceId | null;
  readonly currentModel: string | null;
  readonly purpose?: SwitchProviderDialogPurpose;
  readonly resolve: (choice: SwitchProviderChoice | null) => void;
}

let request: SwitchProviderRequest | null = null;
const listeners = new Set<() => void>();

function publish(next: SwitchProviderRequest | null): void {
  request = next;
  for (const listener of listeners) {
    listener();
  }
}

export function readSwitchProviderRequest(): SwitchProviderRequest | null {
  return request;
}

function subscribeSwitchProviderHost(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Answers a pending request and closes the dialog; safe with nothing open. */
export function finishSwitchProviderRequest(choice: SwitchProviderChoice | null): void {
  const pending = request;
  publish(null);
  pending?.resolve(choice);
}

/**
 * Opens the switch dialog. A still-open request resolves null so its caller
 * can never be stranded by a second menu action.
 */
export function requestSwitchProviderTarget(input: {
  readonly environmentId: EnvironmentId;
  readonly currentInstanceId?: ProviderInstanceId | null;
  readonly currentModel?: string | null;
  readonly purpose?: SwitchProviderDialogPurpose;
}): Promise<SwitchProviderChoice | null> {
  finishSwitchProviderRequest(null);
  return new Promise((resolve) => {
    publish({
      environmentId: input.environmentId,
      currentInstanceId: input.currentInstanceId ?? null,
      currentModel: input.currentModel ?? null,
      ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
      resolve,
    });
  });
}

export function useSwitchProviderRequest(): SwitchProviderRequest | null {
  return useSyncExternalStore(
    subscribeSwitchProviderHost,
    readSwitchProviderRequest,
    readSwitchProviderRequest,
  );
}

export function resetSwitchProviderStoreForTests(): void {
  listeners.clear();
  request = null;
}

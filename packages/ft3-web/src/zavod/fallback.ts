import type { ServerProvider } from "@t3tools/contracts";

import type { SwitchProviderTarget } from "../delegation/switchProviderDialog.logic.ts";
import { isZavodInstanceId } from "./failure.ts";

export interface PersonalFallback {
  readonly target: SwitchProviderTarget;
  readonly displayName: string;
}

type FallbackCandidate = Pick<
  ServerProvider,
  "instanceId" | "driver" | "displayName" | "enabled" | "status" | "auth" | "models"
>;

/** A personal instance is offered only when it can actually take the thread. */
function isUsablePersonalInstance(provider: FallbackCandidate): boolean {
  return (
    provider.enabled &&
    !isZavodInstanceId(provider.instanceId) &&
    (provider.status === "ready" || provider.status === "warning") &&
    provider.auth.status === "authenticated" &&
    provider.models.length > 0
  );
}

function pickModel(provider: FallbackCandidate, model: string): string {
  const kept = provider.models.find(
    (candidate) => candidate.slug === model || candidate.aliases?.includes(model) === true,
  );
  if (kept) return kept.slug;
  return (provider.models.find((candidate) => candidate.isDefault === true) ?? provider.models[0])!
    .slug;
}

/**
 * Personal instance of the thread's driver to switch to when Zavod fails.
 * Keeps the thread model when the target knows it, otherwise the target default.
 */
export function resolvePersonalFallback(
  threadSelection: { readonly instanceId: string; readonly model: string },
  providerInstances: ReadonlyArray<FallbackCandidate>,
): PersonalFallback | null {
  const current = providerInstances.find(
    (provider) => provider.instanceId === threadSelection.instanceId,
  );
  if (!current) return null;
  const target = providerInstances.find(
    (provider) => provider.driver === current.driver && isUsablePersonalInstance(provider),
  );
  if (!target) return null;
  return {
    target: {
      providerInstanceId: target.instanceId,
      driverKind: target.driver,
      model: pickModel(target, threadSelection.model),
    },
    displayName: target.displayName ?? target.instanceId,
  };
}

import type { ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/** Bundled Pi cannot self-update; ft3 replaces the package with the app. */
export const BUNDLED_PI_UPDATE_MESSAGE = "Pi is bundled with ft3; it updates with ft3.";

export function makeBundledPiMaintenanceCapabilities(input: {
  readonly provider: ProviderDriverKind;
  readonly packageName: string;
  readonly installPath?: string | undefined;
}): ProviderMaintenanceCapabilities {
  return makeManualOnlyProviderMaintenanceCapabilities({
    provider: input.provider,
    packageName: input.packageName,
    ...(input.installPath ? { installPath: input.installPath } : {}),
  });
}

/** Replace the upstream updater with an explanation, never a runnable command. */
export function disableBundledPiUpdate(snapshot: ServerProvider): ServerProvider {
  const advisory = snapshot.versionAdvisory;
  if (advisory === undefined) {
    return snapshot;
  }
  return {
    ...snapshot,
    versionAdvisory: {
      ...advisory,
      canUpdate: false,
      canInstallVersion: false,
      updateCommand: null,
      message: BUNDLED_PI_UPDATE_MESSAGE,
    },
  };
}

/** Keep every published view of the managed snapshot free of the Pi updater. */
export function makeBundledPiSnapshot(input: {
  readonly snapshot: ManagedServerProvider;
  readonly capabilities: ProviderMaintenanceCapabilities;
}): ManagedServerProvider {
  const { snapshot, capabilities } = input;
  return {
    resolveMaintenance: () => Effect.succeed(capabilities),
    getSnapshot: snapshot.getSnapshot.pipe(Effect.map(disableBundledPiUpdate)),
    refresh: snapshot.refresh.pipe(Effect.map(disableBundledPiUpdate)),
    streamChanges: snapshot.streamChanges.pipe(Stream.map(disableBundledPiUpdate)),
    applyUsageLimits: snapshot.applyUsageLimits,
  };
}

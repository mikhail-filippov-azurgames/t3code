/**
 * MuseCodeDriver — subscription-only Muse Code provider instance.
 *
 * Fail-closed subscription boundary: any API-key entry in the merged
 * instance environment rejects instance creation before model work, so a
 * key can never authorize the child host. The snapshot probe then proves
 * the native host answers `model/list` on its persisted account login.
 *
 * @module provider/Drivers/MuseCodeDriver
 */
import { MuseCodeSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeMuseTextGeneration } from "../../textGeneration/MuseTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeMuseCodeAdapter } from "../Layers/MuseCodeAdapter.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import {
  buildInitialMuseCodeProviderSnapshot,
  checkMuseCodeProviderStatus,
} from "../muse/MuseCodeProvider.ts";
import { readMuseVersionPin, resolveMuseServeBinary, stripMuseApiKeys } from "../muse/MuseMspRuntime.ts";

const decodeMuseCodeSettings = Schema.decodeSync(MuseCodeSettings);

const DRIVER_KIND = ProviderDriverKind.make("museCode");
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type MuseCodeDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ServerSettingsService;

/** Fail closed when API keys could authorize the child host. */
export function assertMuseSubscriptionEnv(input: {
  readonly instanceId: string;
  readonly stripped: ReadonlyArray<string>;
}): Effect.Effect<void, ProviderDriverError> {
  return input.stripped.length === 0
    ? Effect.void
    : Effect.fail(
        new ProviderDriverError({
          driver: DRIVER_KIND,
          instanceId: input.instanceId,
          detail:
            `Muse instance environment carries ${input.stripped.join(", ")}; ` +
            `subscription provenance is unclear, refusing model work.`,
        }),
      );
}

export const MuseCodeDriver: ProviderDriver<MuseCodeSettings, MuseCodeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Muse Code",
    supportsMultipleInstances: true,
  },
  configSchema: MuseCodeSettings,
  defaultConfig: (): MuseCodeSettings => decodeMuseCodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const serverSettings = yield* ServerSettingsService;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const { env: subscriptionEnv, stripped } = stripMuseApiKeys(processEnv);
      yield* assertMuseSubscriptionEnv({ instanceId, stripped });

      const pin = yield* readMuseVersionPin({ binaryPath: config.binaryPath });
      const museBin = yield* resolveMuseServeBinary({
        binaryPath: config.binaryPath,
        platform: process.platform,
        ...(pin === undefined ? {} : { pinnedVersion: pin }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: cause.detail,
              cause,
            }),
        ),
      );

      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies MuseCodeSettings;

      const adapter = yield* makeMuseCodeAdapter({
        museBin,
        env: subscriptionEnv,
        instanceId,
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Muse adapter: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      const textGeneration = yield* makeMuseTextGeneration({
        museBin,
        environment: subscriptionEnv,
      });

      const checkProvider = checkMuseCodeProviderStatus(
        effectiveConfig,
        { binaryPath: config.binaryPath, environment: subscriptionEnv },
        subscriptionEnv,
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<MuseCodeSettings>>({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialMuseCodeProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Muse snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd: () => snapshot.getSnapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};

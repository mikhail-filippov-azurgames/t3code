// @effect-diagnostics nodeBuiltinImport:off - Host resource paths are inspected and snapshotted before Pi starts.
/**
 * PiDriver — `ProviderDriver` for the bundled Pi harness.
 *
 * Pi is FT3's built-in/default harness for local OpenAI-compatible model
 * endpoints (Ollama, LM Studio, vLLM, SGLang). No OpenCode and no separate
 * user Pi installation is required: the driver pins a Pi runtime version,
 * manages an FT3-owned agent dir (`models.json` + `settings.json` +
 * `APPEND_SYSTEM.md`) per instance, and speaks Pi RPC (`--mode rpc`) with a
 * fail-closed permission bridge (see `piPermissionBridge.ts`).
 *
 * @module provider/Drivers/PiDriver
 */
import {
  CodexSettings,
  PiSettings,
  ProviderDriverKind,
  resolveProviderInstanceEnabled,
  type ServerProvider,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makePiTextGeneration } from "../../textGeneration/PiTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
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
import { makePiAdapter } from "../pi/piAdapter.ts";
import { resolveCodexPersonalResources } from "../pi/piCodexSkills.ts";
import {
  makePiInferenceActivity,
  piInferenceServerManager,
  piInferenceSettingsForModel,
} from "../pi/piInferenceServer.ts";
import { buildInitialPiProviderSnapshot, checkPiProviderStatus } from "../pi/piProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);

const DRIVER_KIND = ProviderDriverKind.make("pi");
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

/**
 * Select the Codex home that Pi mirrors for shared personal resources. An
 * explicit per-Pi choice wins, then the selected Codex instance's own
 * `homePath`, then the ambient `CODEX_HOME`, then the default `~/.codex`.
 */
export function resolvePiCodexResourceHome(
  settings: Pick<ServerSettings, "providerInstances" | "defaultModelSelection" | "providers">,
  config: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const codexEntries = Object.entries(settings.providerInstances).filter(
    ([, entry]) => entry.driver === "codex" && resolveProviderInstanceEnabled(entry),
  );
  const explicitId = String(config.codexResourceInstanceId ?? "");
  if (config.codexResourceInstanceId && !codexEntries.some(([id]) => id === explicitId)) {
    throw new Error(`Codex resource instance ${explicitId} is missing or disabled on this host.`);
  }
  const selected =
    codexEntries.find(([id]) => id === explicitId) ??
    codexEntries.find(([id, entry]) => /personal|личн/i.test(`${id} ${entry.displayName ?? ""}`)) ??
    codexEntries.find(([id]) => id === String(settings.defaultModelSelection?.instanceId ?? "")) ??
    codexEntries[0];
  const instanceHome = selected
    ? decodeCodexSettings(selected[1].config ?? settings.providers.codex).homePath.trim()
    : "";
  if (instanceHome) return NodePath.resolve(expandHomePath(instanceHome));
  const ambientHome = environment.CODEX_HOME?.trim();
  return ambientHome
    ? NodePath.resolve(expandHomePath(ambientHome))
    : NodePath.join(NodeOS.homedir(), ".codex");
}

export type PiDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

export const PiDriver: ProviderDriver<PiSettings, PiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Pi",
    supportsMultipleInstances: true,
  },
  configSchema: PiSettings,
  defaultConfig: (): PiSettings => decodePiSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const processEnv = mergeProviderInstanceEnvironment(environment);
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
      const effectiveConfig = { ...config, enabled } satisfies PiSettings;
      const agentDir = pathService.join(serverConfig.stateDir, "pi", instanceId, "agent");
      let lastResources: ServerProvider["piResources"];
      let refreshResourceSnapshot: (() => void) | undefined;

      const resolvePersonalResources = async () => {
        const settings = await Effect.runPromise(serverSettings.getSettings);
        const codexHome = resolvePiCodexResourceHome(settings, effectiveConfig, processEnv);
        const explicitInstructions = effectiveConfig.personalInstructionsPath?.trim() ?? "";
        const explicitSkills = effectiveConfig.personalSkillsDirectory?.trim() ?? "";
        if (explicitInstructions && explicitSkills) {
          return { instructionsPath: explicitInstructions, skillsDirectories: [explicitSkills] };
        }
        const resolved = await resolveCodexPersonalResources({
          codexHome,
          hostHome: NodeOS.homedir(),
        });
        const instructionsPath =
          explicitInstructions ||
          ((await NodeFSP.stat(resolved.instructionsPath).then(
            () => true,
            () => false,
          ))
            ? resolved.instructionsPath
            : "");
        return {
          instructionsPath,
          skillsDirectories: explicitSkills
            ? [explicitSkills]
            : resolved.skillRoots.map((root) => root.path),
          warnings: resolved.warnings,
        };
      };

      const adapter = yield* makePiAdapter({
        instanceId,
        config: effectiveConfig,
        environment: processEnv,
        resolvePersonalResources,
        onResourcesLoaded: (resources) => {
          lastResources = resources;
          refreshResourceSnapshot?.();
        },
      }).pipe(
        Effect.provideService(ServerConfig, serverConfig),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Pi adapter: ${String((cause as { message?: unknown })?.message ?? cause)}`,
              cause,
            }),
        ),
      );
      const textGeneration = yield* makePiTextGeneration({
        instanceId,
        settings: effectiveConfig,
        environment: processEnv,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
      );

      const checkProvider = checkPiProviderStatus(
        effectiveConfig,
        processEnv,
        serverConfig.cwd,
        agentDir,
      ).pipe(
        Effect.map((provider) =>
          stampIdentity({ ...provider, ...(lastResources ? { piResources: lastResources } : {}) }),
        ),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<PiSettings>>({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialPiProviderSnapshot(settings.provider).pipe(
            Effect.map((provider) =>
              stampIdentity({
                ...provider,
                ...(lastResources ? { piResources: lastResources } : {}),
              }),
            ),
          ),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Pi snapshot: ${String((cause as { message?: unknown })?.message ?? cause)}`,
              cause,
            }),
        ),
      );

      const makeManualInferenceActivity = (threadId: ThreadId | undefined) =>
        makePiInferenceActivity({
          instanceId,
          threadId,
          source: "manual",
          emit: threadId
            ? (message) => Effect.runPromise(adapter.emitInferenceActivity(threadId, message))
            : undefined,
        });
      refreshResourceSnapshot = () => {
        void Effect.runPromise(snapshot.refresh).catch(() => undefined);
      };
      const runInferenceControl = <A>(
        operation: string,
        run: () => Promise<A>,
      ): Effect.Effect<A, ProviderDriverError> =>
        Effect.tryPromise({
          try: run,
          catch: (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Pi inference server ${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
              cause,
            }),
        });

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        emitRuntimeActivity: adapter.emitInferenceActivity,
        localInferenceServer: {
          getStatus: (model) =>
            runInferenceControl("status", async () => {
              try {
                return await piInferenceServerManager.getStatus(
                  instanceId,
                  piInferenceSettingsForModel(effectiveConfig, model),
                );
              } catch (cause) {
                const status = await piInferenceServerManager.getStatus(
                  instanceId,
                  effectiveConfig,
                );
                return {
                  ...status,
                  ready: false,
                  pendingRestart: status.owner === "ft3" || status.pendingRestart,
                  error:
                    cause instanceof Error
                      ? cause.message
                      : "Configure a managed profile for the selected model.",
                };
              }
            }),
          start: (threadId, model) =>
            runInferenceControl("start", () =>
              piInferenceServerManager.start(
                instanceId,
                piInferenceSettingsForModel(effectiveConfig, model),
                makeManualInferenceActivity(threadId),
              ),
            ),
          stop: (threadId, model) =>
            runInferenceControl("stop", () =>
              piInferenceServerManager.stop(
                instanceId,
                (() => {
                  try {
                    return piInferenceSettingsForModel(effectiveConfig, model);
                  } catch {
                    return effectiveConfig;
                  }
                })(),
                makeManualInferenceActivity(threadId),
              ),
            ),
        },
        snapshot,
        snapshotForCwd: () => snapshot.getSnapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  ProviderAdapterOpenSessionError,
  ProviderAdapterTurnStartError,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import type { ProviderDriver } from "@t3tools/provider-core/server/driver";
import { PiDriver, type PiDriverEnv } from "@t3tools/provider-pi/server";
import type { PiSettings } from "@t3tools/provider-pi/settings";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { setPiExtensionSourceTransform } from "../../provider-pi/src/server/mcpExtensionSource.ts";
import {
  ensurePiAgentFiles,
  resolvePiManagedModels,
  withPiAgentDir,
  type PiAgentFilesInput,
} from "./agentDir.ts";
import {
  disableBundledPiUpdate,
  makeBundledPiMaintenanceCapabilities,
  makeBundledPiSnapshot,
} from "./bundledPiMaintenance.ts";
import {
  loadPiInferenceConfig,
  piInferenceModelsBaseUrl,
  piInferenceServerManager,
  resolvePiInferenceConfigPath,
} from "./inferenceServer.ts";
import { applyLocalLlamaExtensionPolicy } from "./localLlamaExtension.ts";
import { PI_RUNTIME_PACKAGE, resolvePiBinaryPath } from "./piRuntime.ts";
import { defaultCodexImportPaths, importCodexResourcesIntoAgentDir } from "./skills.ts";

export type Ft3PiDriverEnv = PiDriverEnv | FileSystem.FileSystem | Path.Path;

export const Ft3PiDriver: ProviderDriver<PiSettings, Ft3PiDriverEnv, Path.Path> = {
  ...PiDriver,
  create: Effect.fn("Ft3PiDriver.create")(function* (input) {
    setPiExtensionSourceTransform(applyLocalLlamaExtensionPolicy);
    const host = yield* ProviderHost.ProviderHost;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const instanceId = input.instanceId;
    const agentDir = path.join(host.paths.stateDir, "pi", instanceId, "agent");
    const processEnvironment: NodeJS.ProcessEnv = { ...process.env };
    for (const entry of input.environment) processEnvironment[entry.name] = entry.value;
    const piRuntime = yield* resolvePiBinaryPath({
      binaryPath: input.config.binaryPath,
      environment: processEnvironment,
      launcherDir: path.join(host.paths.stateDir, "pi", instanceId, "runtime"),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: PiDriver.driverKind,
            instanceId,
            detail: "Failed to resolve the pinned Pi runtime.",
            cause,
          }),
      ),
    );
    const configPath = resolvePiInferenceConfigPath({
      stateDir: host.paths.stateDir,
      instanceId,
      environment: processEnvironment,
    });
    const inferenceConfig = yield* Effect.tryPromise({
      try: () => loadPiInferenceConfig(configPath),
      catch: (cause) =>
        new ProviderDriverError({
          driver: PiDriver.driverKind,
          instanceId,
          detail: `Failed to read the Pi inference profiles at ${configPath}.`,
          cause,
        }),
    });
    const environment = withPiAgentDir(input.environment, agentDir);
    const inference = piInferenceServerManager;
    inference.registerInstance(instanceId, inferenceConfig, configPath);

    // Re-read the registered config so a preset applied after creation reaches models.json.
    const buildAgentFiles = (runtimeMode: PiAgentFilesInput["runtimeMode"]): PiAgentFilesInput => {
      const current = inference.registeredConfig(instanceId) ?? inferenceConfig;
      const models = resolvePiManagedModels({
        configuredModel: undefined,
        profileModels: current.profiles.map((profile) => ({
          model: profile.model,
          baseUrl: profile.baseUrl,
        })),
        customModels: input.config.customModels,
      });
      return {
        baseUrl: piInferenceModelsBaseUrl(current),
        apiKey: current.apiKey,
        models,
        runtimeMode,
        defaultModel: models[0]?.id,
      };
    };
    const codexPaths = defaultCodexImportPaths(processEnvironment);

    yield* ensurePiAgentFiles(agentDir, buildAgentFiles("approval-required")).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: PiDriver.driverKind,
            instanceId,
            detail: `Failed to write the managed Pi agent dir at ${agentDir}.`,
            cause,
          }),
      ),
    );
    yield* Effect.tryPromise({
      try: () =>
        importCodexResourcesIntoAgentDir({
          agentDir,
          codexHome: codexPaths.codexHome,
          hostHome: codexPaths.hostHome,
        }),
      catch: (cause) =>
        new ProviderDriverError({
          driver: PiDriver.driverKind,
          instanceId,
          detail: `Failed to import Codex skills and AGENTS.md into ${agentDir}.`,
          cause,
        }),
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => inference.disposeInstance(instanceId)));

    const instance = yield* PiDriver.create({
      ...input,
      config: { ...input.config, binaryPath: piRuntime.binaryPath },
      environment,
    });
    const bundledInstallPath = piRuntime.cliJs ?? piRuntime.binaryPath;
    const bundledSnapshot = piRuntime.bundled
      ? makeBundledPiSnapshot({
          snapshot: instance.snapshot,
          capabilities: makeBundledPiMaintenanceCapabilities({
            provider: PiDriver.driverKind,
            packageName: PI_RUNTIME_PACKAGE,
            installPath: bundledInstallPath,
          }),
        })
      : undefined;

    const writeAgentFiles = (runtimeMode: PiAgentFilesInput["runtimeMode"]) =>
      ensurePiAgentFiles(agentDir, buildAgentFiles(runtimeMode));

    const prepareTurn = Effect.fn("Ft3PiDriver.prepareTurn")(function* (
      turn: ProviderAdapter.ProviderAdapterV2TurnInput,
    ) {
      yield* writeAgentFiles(turn.runtimePolicy.runtimeMode).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterTurnStartError({
              driver: PiDriver.driverKind,
              threadId: turn.threadId,
              providerThreadId: turn.providerThread.id,
              runId: turn.runId,
              cause,
            }),
        ),
      );
      const model =
        typeof turn.modelSelection.model === "string" ? turn.modelSelection.model : undefined;
      yield* Effect.tryPromise({
        try: () => inference.ensureReady(instanceId, model),
        catch: (cause) =>
          new ProviderAdapterTurnStartError({
            driver: PiDriver.driverKind,
            threadId: turn.threadId,
            providerThreadId: turn.providerThread.id,
            runId: turn.runId,
            cause,
          }),
      });
    });

    const withServices = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

    const orchestrationAdapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
      ...instance.orchestrationAdapter,
      openSession: (sessionInput) =>
        writeAgentFiles(sessionInput.runtimePolicy.runtimeMode).pipe(
          withServices,
          Effect.mapError(
            (cause) =>
              new ProviderAdapterOpenSessionError({
                driver: PiDriver.driverKind,
                providerSessionId: sessionInput.providerSessionId,
                cause,
              }),
          ),
          Effect.flatMap(() => instance.orchestrationAdapter.openSession(sessionInput)),
          Effect.map((runtime): ProviderAdapter.ProviderAdapterV2SessionRuntime => ({
            ...runtime,
            startTurn: (turn) =>
              prepareTurn(turn).pipe(
                withServices,
                Effect.flatMap(() => runtime.startTurn(turn)),
              ),
            ...(runtime.compactThread === undefined
              ? {}
              : {
                  compactThread: (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
                    prepareTurn(turn).pipe(
                      withServices,
                      Effect.flatMap(() => runtime.compactThread!(turn)),
                    ),
                }),
          })),
        ),
    };

    return {
      ...instance,
      ...(bundledSnapshot === undefined ? {} : { snapshot: bundledSnapshot }),
      ...(bundledSnapshot === undefined || instance.snapshotForCwd === undefined
        ? {}
        : {
            snapshotForCwd: (cwd: string) =>
              instance.snapshotForCwd!(cwd).pipe(Effect.map(disableBundledPiUpdate)),
          }),
      orchestrationAdapter,
    };
  }),
};

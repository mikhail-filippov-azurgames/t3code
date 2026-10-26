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

import {
  ensurePiAgentFiles,
  resolvePiManagedModels,
  withPiAgentDir,
  type PiAgentFilesInput,
} from "./agentDir.ts";
import {
  loadPiInferenceConfig,
  piInferenceModelsBaseUrl,
  piInferenceServerManager,
  resolvePiInferenceConfigPath,
} from "./inferenceServer.ts";
import { defaultCodexImportPaths, importCodexResourcesIntoAgentDir } from "./skills.ts";

export type Ft3PiDriverEnv = PiDriverEnv | FileSystem.FileSystem | Path.Path;

export const Ft3PiDriver: ProviderDriver<PiSettings, Ft3PiDriverEnv, Path.Path> = {
  ...PiDriver,
  create: Effect.fn("Ft3PiDriver.create")(function* (input) {
    const host = yield* ProviderHost.ProviderHost;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const instanceId = input.instanceId;
    const agentDir = path.join(host.paths.stateDir, "pi", instanceId, "agent");
    const processEnvironment: NodeJS.ProcessEnv = { ...process.env };
    for (const entry of input.environment) processEnvironment[entry.name] = entry.value;
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
    const models = resolvePiManagedModels({
      configuredModel: undefined,
      profileModels: inferenceConfig.profiles.map((profile) => profile.model),
      customModels: input.config.customModels,
    });
    const defaultModel = models[0];
    const agentFiles: PiAgentFilesInput = {
      baseUrl: piInferenceModelsBaseUrl(inferenceConfig),
      apiKey: inferenceConfig.apiKey,
      models,
      runtimeMode: "approval-required",
      defaultModel,
    };
    const environment = withPiAgentDir(input.environment, agentDir);
    const inference = piInferenceServerManager;
    inference.registerInstance(instanceId, inferenceConfig);
    const codexPaths = defaultCodexImportPaths(processEnvironment);

    yield* ensurePiAgentFiles(agentDir, agentFiles).pipe(
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

    const instance = yield* PiDriver.create({ ...input, environment });

    const writeAgentFiles = (runtimeMode: PiAgentFilesInput["runtimeMode"]) =>
      ensurePiAgentFiles(agentDir, { ...agentFiles, runtimeMode });

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

    return { ...instance, orchestrationAdapter };
  }),
};

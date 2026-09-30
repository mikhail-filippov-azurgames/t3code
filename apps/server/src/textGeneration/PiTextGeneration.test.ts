import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  PiSettings,
  ProviderInstanceId,
  ThreadId,
  type PiInferenceServerStatus,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../config.ts";
import { makePiAdapter } from "../provider/pi/piAdapter.ts";
import { piInferenceServerManager } from "../provider/pi/piInferenceServer.ts";
import type { PiProcessFactory } from "../provider/pi/piSessionRuntime.ts";
import { makePiTextGeneration, type PiTextGenerationOptions } from "./PiTextGeneration.ts";

const PiTextModelsJson = Schema.fromJsonString(
  Schema.Struct({
    providers: Schema.Struct({
      "ft3-local": Schema.Struct({
        baseUrl: Schema.String,
        models: Schema.Array(Schema.Struct({ id: Schema.String })),
      }),
    }),
  }),
);
const PiTextSettingsJson = Schema.fromJsonString(Schema.Struct({ defaultModel: Schema.String }));

function makeTestInferenceServerManager(
  modelIds: ReadonlyArray<string>,
  calls: Array<{ readonly operation: string; readonly baseUrl: string; readonly model?: string }>,
): NonNullable<PiTextGenerationOptions["inferenceServerManager"]> {
  return {
    getStatus: async (instanceId, settings) => {
      calls.push({ operation: "status", baseUrl: settings.baseUrl, model: settings.model });
      return {
        instanceId,
        endpoint: settings.baseUrl,
        local: true,
        phase: "ready",
        owner: "external",
        ready: true,
        canStart: false,
        canStop: false,
        pendingRestart: false,
        usedByOtherInstances: false,
        progress: null,
        error: null,
        modelIds: [...modelIds],
      } satisfies PiInferenceServerStatus;
    },
    waitForExistingReady: async () => undefined,
    acquireRequestSlot: async (baseUrl) => {
      calls.push({ operation: "slot", baseUrl });
      return () => undefined;
    },
  };
}

function makeIdlePiProcessFactory(): PiProcessFactory {
  return () => {
    const stdoutListeners: Array<(chunk: string) => void> = [];
    const emit = (record: unknown) => {
      queueMicrotask(() => {
        for (const listener of stdoutListeners) listener(`${JSON.stringify(record)}\n`);
      });
    };
    return {
      pid: 1,
      writeStdin: (line) => {
        const command = JSON.parse(line) as { readonly id?: string; readonly type: string };
        if (command.type === "get_state") {
          emit({
            type: "response",
            id: command.id,
            command: "get_state",
            success: true,
            data: { sessionId: "active-27b-session" },
          });
          emit({
            type: "extension_ui_request",
            id: "guard-ready",
            method: "notify",
            message: "FT3_PI_TOOL_GUARD_READY_V1",
          });
        } else if (command.type === "prompt") {
          emit({
            type: "response",
            id: command.id,
            command: "prompt",
            success: true,
          });
          emit({ type: "agent_start" });
        } else if (command.type === "abort") {
          emit({ type: "agent_settled" });
          emit({ type: "response", id: command.id, command: "abort", success: true });
        } else if (command.type === "clear_queue") {
          emit({
            type: "response",
            id: command.id,
            command: "clear_queue",
            success: true,
            data: { steering: [], followUp: [] },
          });
        }
      },
      endStdin: () => {},
      kill: () => {},
      onStdout: (listener) => stdoutListeners.push(listener),
      onStderr: () => {},
      onExit: () => {},
      onClose: () => {},
      onError: () => {},
    };
  };
}

function makeReadyInferenceServerManager(
  calls: Array<string>,
  onRequestQueued?: (baseUrl: string) => void,
): typeof piInferenceServerManager {
  const readyStatus = (
    instanceId: ProviderInstanceId,
    settings: PiSettings,
  ): PiInferenceServerStatus => ({
    instanceId,
    endpoint: settings.baseUrl,
    local: true,
    phase: "ready",
    owner: "external",
    ready: true,
    canStart: false,
    canStop: false,
    pendingRestart: false,
    usedByOtherInstances: false,
    progress: null,
    error: null,
    modelIds: [settings.model.replace(/^ft3-local\//, "")],
  });
  return {
    ...piInferenceServerManager,
    getStatus: async (instanceId, settings) => readyStatus(instanceId, settings),
    ensureReady: async (instanceId, settings) => readyStatus(instanceId, settings),
    waitForExistingReady: async (instanceId, settings) => readyStatus(instanceId, settings),
    acquireRequestSlot: (baseUrl, notifyQueued, signal) => {
      calls.push(baseUrl);
      return piInferenceServerManager.acquireRequestSlot(
        baseUrl,
        () => {
          onRequestQueued?.(baseUrl);
          notifyQueued?.();
        },
        signal,
      );
    },
    releaseActivity: () => undefined,
    releaseInstance: () => undefined,
  };
}

it.layer(NodeServices.layer)("Pi text-generation launch environment", (it) => {
  it.effect("rejects inherited Node hooks before starting a one-shot Pi process", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const piSettings = yield* Schema.decodeEffect(PiSettings)({
        binaryPath: "pi",
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "",
        model: "fixture-model",
      });
      let spawnAttempts = 0;
      const spawner = ChildProcessSpawner.make(() => {
        spawnAttempts += 1;
        return Effect.die(new Error("unexpected Pi text-generation spawn"));
      });
      const textGeneration = yield* makePiTextGeneration({
        instanceId: ProviderInstanceId.make("pi-text-security"),
        settings: piSettings,
        environment: {
          PATH: process.env.PATH,
          NODE_OPTIONS: "--require C:/hooks/inject.cjs",
        },
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const failure = yield* Effect.flip(
        textGeneration.generateBranchName({
          cwd: process.cwd(),
          message: "Name this change",
          modelSelection: {
            instanceId: ProviderInstanceId.make("pi_default"),
            model: "fixture-model",
          },
        }),
      );

      NodeAssert.equal(failure._tag, "TextGenerationError");
      NodeAssert.match(failure.detail, /unsafe environment variable NODE_OPTIONS/i);
      NodeAssert.equal(spawnAttempts, 0);
    }),
  );

  it.effect("isolates a concurrent 27B one-shot from the active chat catalog and endpoint", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-text-profile-" });
      const workspace = path.join(root, "worktree");
      yield* fileSystem.makeDirectory(workspace, { recursive: true });
      const serverConfig = yield* ServerConfig;
      const model8 = "ft3-local/bonsai-2-8b";
      const model27 = "ft3-local/bonsai-2-27b";
      const instanceId = ProviderInstanceId.make("pi_default");
      const piSettings = yield* Schema.decodeEffect(PiSettings)({
        binaryPath: "pi",
        baseUrl: "http://127.0.0.1:8081/v1",
        apiKey: "fixture-key",
        model: model8,
        inferenceServerExecutablePath: "C:/Bonsai/bin/llama-server.exe",
        inferenceServerModelPath: "C:/Bonsai/models/8B.gguf",
        inferenceServerProfiles: [
          {
            model: model8,
            baseUrl: "http://127.0.0.1:8081/v1",
            executablePath: "C:/Bonsai/bin/llama-server.exe",
            modelPath: "C:/Bonsai/models/8B.gguf",
          },
          {
            model: model27,
            baseUrl: "http://127.0.0.1:8080/v1",
            executablePath: "C:/Bonsai/bin/llama-server.exe",
            modelPath: "C:/Bonsai/models/27B.gguf",
          },
        ],
      });
      const adapter = yield* makePiAdapter({
        instanceId,
        config: piSettings,
        environment: { PATH: process.env.PATH },
        runtimeHooks: { processFactory: makeIdlePiProcessFactory() },
      });
      const activeThreadId = ThreadId.make("pi-active-27b-chat");
      yield* adapter.startSession({
        threadId: activeThreadId,
        cwd: workspace,
        runtimeMode: "approval-required",
        modelSelection: { instanceId, model: model27 },
      });
      const activeAgentDir = path.join(serverConfig.stateDir, "pi", instanceId, "agent");
      const before = {
        models: yield* fileSystem.readFileString(path.join(activeAgentDir, "models.json")),
        settings: yield* fileSystem.readFileString(path.join(activeAgentDir, "settings.json")),
        system: yield* fileSystem.readFileString(path.join(activeAgentDir, "APPEND_SYSTEM.md")),
      };
      const activeCatalog = yield* Schema.decodeEffect(PiTextModelsJson)(before.models);
      const activeSettings = yield* Schema.decodeEffect(PiTextSettingsJson)(before.settings);
      NodeAssert.equal(activeCatalog.providers["ft3-local"].baseUrl, "http://127.0.0.1:8080/v1");
      NodeAssert.deepEqual(activeCatalog.providers["ft3-local"].models, [
        { id: "bonsai-2-8b" },
        { id: "bonsai-2-27b" },
      ]);
      NodeAssert.equal(activeSettings.defaultModel, model27);

      const spawned = yield* Deferred.make<void>();
      const finishProcess = yield* Deferred.make<void>();
      let observed:
        | {
            readonly args: ReadonlyArray<string>;
            readonly agentDir: string;
            readonly models: string;
            readonly settings: string;
          }
        | undefined;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die(new Error("expected a standard Pi command"));
          }
          const agentDir = command.options.env?.PI_CODING_AGENT_DIR;
          if (!agentDir) return yield* Effect.die(new Error("missing isolated Pi state dir"));
          observed = {
            args: command.args,
            agentDir,
            models: yield* fileSystem.readFileString(path.join(agentDir, "models.json")),
            settings: yield* fileSystem.readFileString(path.join(agentDir, "settings.json")),
          };
          yield* Deferred.succeed(spawned, undefined);
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Deferred.await(finishProcess).pipe(
              Effect.as(ChildProcessSpawner.ExitCode(0)),
            ),
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make("feature/bonsai-27b\n")),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      );
      const inferenceCalls: Array<{
        readonly operation: string;
        readonly baseUrl: string;
        readonly model?: string;
      }> = [];
      const textGeneration = yield* makePiTextGeneration({
        instanceId,
        settings: piSettings,
        environment: { PATH: process.env.PATH },
        inferenceServerManager: makeTestInferenceServerManager(["bonsai-2-27b"], inferenceCalls),
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      const oneShot = yield* Effect.forkChild(
        textGeneration.generateBranchName({
          cwd: process.cwd(),
          message: "Name the Bonsai 27B change",
          modelSelection: {
            instanceId,
            model: model27,
          },
        }),
      );

      yield* Deferred.await(spawned);
      NodeAssert.ok(observed);
      NodeAssert.notEqual(observed.agentDir, activeAgentDir);
      NodeAssert.deepEqual(
        {
          models: yield* fileSystem.readFileString(path.join(activeAgentDir, "models.json")),
          settings: yield* fileSystem.readFileString(path.join(activeAgentDir, "settings.json")),
          system: yield* fileSystem.readFileString(path.join(activeAgentDir, "APPEND_SYSTEM.md")),
        },
        before,
      );

      const oneShotCatalog = yield* Schema.decodeEffect(PiTextModelsJson)(observed.models);
      NodeAssert.equal(oneShotCatalog.providers["ft3-local"].baseUrl, "http://127.0.0.1:8080/v1");
      NodeAssert.deepEqual(oneShotCatalog.providers["ft3-local"].models, [{ id: "bonsai-2-27b" }]);
      const oneShotSettings = yield* Schema.decodeEffect(PiTextSettingsJson)(observed.settings);
      NodeAssert.equal(oneShotSettings.defaultModel, model27);
      NodeAssert.deepEqual(inferenceCalls, [
        { operation: "status", baseUrl: "http://127.0.0.1:8080/v1", model: model27 },
        { operation: "slot", baseUrl: "http://127.0.0.1:8080/v1" },
      ]);
      const selectedModelArg = observed.args.indexOf("--model");
      NodeAssert.ok(selectedModelArg >= 0);
      NodeAssert.equal(observed.args[selectedModelArg + 1], model27);

      yield* Deferred.succeed(finishProcess, undefined);
      const generated = yield* Fiber.join(oneShot);
      NodeAssert.equal(generated.branch, "feature/bonsai-27b");
      NodeAssert.equal(yield* fileSystem.exists(observed.agentDir), false);
      yield* adapter.stopSession(activeThreadId);
    }).pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-text-profile-" })),
    ),
  );

  it.effect("interrupting a queued one-shot removes its endpoint waiter", () =>
    Effect.gen(function* () {
      const endpoint = "http://127.0.0.1:18991/v1";
      const model = "ft3-local/bonsai-2-27b";
      const settings = yield* Schema.decodeEffect(PiSettings)({
        binaryPath: "pi",
        baseUrl: endpoint,
        apiKey: "fixture-key",
        model,
        inferenceServerExecutablePath: "C:/Bonsai/bin/llama-server.exe",
        inferenceServerModelPath: "C:/Bonsai/models/27B.gguf",
        inferenceServerProfiles: [
          {
            model,
            baseUrl: endpoint,
            executablePath: "C:/Bonsai/bin/llama-server.exe",
            modelPath: "C:/Bonsai/models/27B.gguf",
          },
        ],
      });
      const calls: Array<string> = [];
      let markQueued!: (baseUrl: string) => void;
      const queued = new Promise<string>((resolve) => {
        markQueued = resolve;
      });
      const manager = makeReadyInferenceServerManager(calls, markQueued);
      const holdingRelease = yield* Effect.promise(() =>
        piInferenceServerManager.acquireRequestSlot(endpoint),
      );
      let spawnAttempts = 0;
      const spawner = ChildProcessSpawner.make(() => {
        spawnAttempts += 1;
        return Effect.die(new Error("a canceled queued request must not spawn Pi"));
      });
      const textGeneration = yield* makePiTextGeneration({
        instanceId: ProviderInstanceId.make("pi-cancelled-queued-one-shot"),
        settings,
        environment: { PATH: process.env.PATH },
        inferenceServerManager: manager,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      const oneShot = yield* Effect.forkChild(
        textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Summarize this thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("pi-cancelled-queued-one-shot"),
            model,
          },
        }),
      );

      NodeAssert.equal(yield* Effect.promise(() => queued), endpoint);
      yield* Fiber.interrupt(oneShot);
      NodeAssert.equal(spawnAttempts, 0);
      holdingRelease();

      const nextReleaseOption = yield* Effect.tryPromise((signal) =>
        piInferenceServerManager.acquireRequestSlot(endpoint, undefined, signal),
      ).pipe(Effect.timeoutOption("100 millis"));
      NodeAssert.equal(nextReleaseOption._tag, "Some", "the next request must acquire the slot");
      if (nextReleaseOption._tag === "Some") nextReleaseOption.value();
      NodeAssert.deepEqual(calls, [endpoint]);
    }).pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-cancel-slot-" })),
    ),
  );

  it.effect("queues a selected 27B chat and one-shot FIFO on the profile endpoint", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-cross-path-slot-" });
      const workspace = path.join(root, "worktree");
      yield* fileSystem.makeDirectory(workspace, { recursive: true });
      const serverConfig = yield* ServerConfig;
      const model8 = "ft3-local/bonsai-2-8b";
      const model27 = "ft3-local/bonsai-2-27b";
      const endpoint8 = "http://127.0.0.1:18981/v1";
      const endpoint27 = "http://127.0.0.1:18980/v1";
      const instanceId = ProviderInstanceId.make("pi-cross-path-slots");
      const settings = yield* Schema.decodeEffect(PiSettings)({
        binaryPath: "pi",
        baseUrl: endpoint8,
        apiKey: "fixture-key",
        model: model8,
        inferenceServerExecutablePath: "C:/Bonsai/bin/llama-server.exe",
        inferenceServerModelPath: "C:/Bonsai/models/8B.gguf",
        inferenceServerProfiles: [
          {
            model: model8,
            baseUrl: endpoint8,
            executablePath: "C:/Bonsai/bin/llama-server.exe",
            modelPath: "C:/Bonsai/models/8B.gguf",
          },
          {
            model: model27,
            baseUrl: endpoint27,
            executablePath: "C:/Bonsai/bin/llama-server.exe",
            modelPath: "C:/Bonsai/models/27B.gguf",
          },
        ],
      });
      let markQueued!: (baseUrl: string) => void;
      const queued = new Promise<string>((resolve) => {
        markQueued = resolve;
      });
      const slotCalls: Array<string> = [];
      const manager = makeReadyInferenceServerManager(slotCalls, markQueued);
      const adapter = yield* makePiAdapter({
        instanceId,
        config: settings,
        environment: { PATH: process.env.PATH },
        runtimeHooks: {
          processFactory: makeIdlePiProcessFactory(),
          inferenceServerManager: manager,
        },
      });
      const activeThreadId = ThreadId.make("pi-active-profile-chat");
      yield* adapter.startSession({
        threadId: activeThreadId,
        cwd: workspace,
        runtimeMode: "approval-required",
        modelSelection: { instanceId, model: model27 },
      });
      const activeAgentDir = path.join(serverConfig.stateDir, "pi", instanceId, "agent");
      const activeCatalogBefore = yield* fileSystem.readFileString(
        path.join(activeAgentDir, "models.json"),
      );
      const activeSettingsBefore = yield* fileSystem.readFileString(
        path.join(activeAgentDir, "settings.json"),
      );

      yield* adapter.sendTurn({ threadId: activeThreadId, input: "keep 27B chat active" });
      NodeAssert.deepEqual(
        slotCalls,
        [endpoint27],
        "chat must acquire the selected profile endpoint",
      );

      // A request on the top-level 8B endpoint remains independent while 27B is active.
      const otherEndpointRelease = yield* Effect.promise(() =>
        piInferenceServerManager.acquireRequestSlot(endpoint8),
      );
      otherEndpointRelease();

      const spawned = yield* Deferred.make<void>();
      const finishProcess = yield* Deferred.make<void>();
      let observed:
        | {
            readonly agentDir: string;
            readonly models: string;
            readonly settings: string;
          }
        | undefined;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die(new Error("expected a standard Pi command"));
          }
          const agentDir = command.options.env?.PI_CODING_AGENT_DIR;
          if (!agentDir) return yield* Effect.die(new Error("missing isolated Pi state dir"));
          observed = {
            agentDir,
            models: yield* fileSystem.readFileString(path.join(agentDir, "models.json")),
            settings: yield* fileSystem.readFileString(path.join(agentDir, "settings.json")),
          };
          yield* Deferred.succeed(spawned, undefined);
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Deferred.await(finishProcess).pipe(
              Effect.as(ChildProcessSpawner.ExitCode(0)),
            ),
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make("feature/bonsai-27b\n")),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      );
      const textGeneration = yield* makePiTextGeneration({
        instanceId,
        settings,
        environment: { PATH: process.env.PATH },
        inferenceServerManager: manager,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      const oneShot = yield* Effect.forkChild(
        textGeneration.generateBranchName({
          cwd: workspace,
          message: "Name the 27B change",
          modelSelection: { instanceId, model: model27 },
        }),
      );

      NodeAssert.equal(yield* Effect.promise(() => queued), endpoint27);
      NodeAssert.deepEqual(slotCalls, [endpoint27, endpoint27]);
      NodeAssert.equal(observed, undefined, "the one-shot must wait until chat releases 27B");
      NodeAssert.equal(
        yield* fileSystem.readFileString(path.join(activeAgentDir, "models.json")),
        activeCatalogBefore,
      );
      NodeAssert.equal(
        yield* fileSystem.readFileString(path.join(activeAgentDir, "settings.json")),
        activeSettingsBefore,
      );

      yield* adapter.interruptTurn(activeThreadId);
      yield* Deferred.await(spawned);
      const observation = observed as
        | {
            readonly agentDir: string;
            readonly models: string;
            readonly settings: string;
          }
        | undefined;
      NodeAssert.ok(observation);
      NodeAssert.notEqual(observation.agentDir, activeAgentDir);
      const catalog = yield* Schema.decodeEffect(PiTextModelsJson)(observation.models);
      const oneShotSettings = yield* Schema.decodeEffect(PiTextSettingsJson)(observation.settings);
      NodeAssert.equal(catalog.providers["ft3-local"].baseUrl, endpoint27);
      NodeAssert.deepEqual(catalog.providers["ft3-local"].models, [{ id: "bonsai-2-27b" }]);
      NodeAssert.equal(oneShotSettings.defaultModel, model27);
      yield* Deferred.succeed(finishProcess, undefined);
      const generated = yield* Fiber.join(oneShot);
      NodeAssert.equal(generated.branch, "feature/bonsai-27b");
      yield* adapter.stopSession(activeThreadId);

      const finalRelease = yield* Effect.promise(() =>
        piInferenceServerManager.acquireRequestSlot(endpoint27),
      );
      finalRelease();
    }).pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-cross-path-slot-" })),
    ),
  );

  it.effect("fails closed when a selected Bonsai 27B profile is missing", () =>
    Effect.gen(function* () {
      const piSettings = yield* Schema.decodeEffect(PiSettings)({
        binaryPath: "pi",
        baseUrl: "http://127.0.0.1:8081/v1",
        apiKey: "fixture-key",
        model: "ft3-local/bonsai-2-8b",
        inferenceServerExecutablePath: "C:/Bonsai/bin/llama-server.exe",
        inferenceServerModelPath: "C:/Bonsai/models/8B.gguf",
        inferenceServerProfiles: [],
      });
      let spawnAttempts = 0;
      const spawner = ChildProcessSpawner.make(() => {
        spawnAttempts += 1;
        return Effect.die(new Error("unavailable profile must not spawn Pi"));
      });
      const textGeneration = yield* makePiTextGeneration({
        instanceId: ProviderInstanceId.make("pi-text-missing-profile"),
        settings: piSettings,
        environment: { PATH: process.env.PATH },
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const failure = yield* Effect.flip(
        textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Summarize this thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("pi_default"),
            model: "ft3-local/bonsai-2-27b",
          },
        }),
      );
      NodeAssert.equal(failure._tag, "TextGenerationError");
      NodeAssert.match(failure.detail, /Configure a managed llama-server profile.*bonsai-2-27b/);
      NodeAssert.equal(spawnAttempts, 0);
    }),
  );

  it.effect("rejects a managed profile whose ready endpoint serves a different model", () =>
    Effect.gen(function* () {
      const model27 = "ft3-local/bonsai-2-27b";
      const piSettings = yield* Schema.decodeEffect(PiSettings)({
        binaryPath: "pi",
        baseUrl: "http://127.0.0.1:8081/v1",
        apiKey: "fixture-key",
        model: "ft3-local/bonsai-2-8b",
        inferenceServerExecutablePath: "C:/Bonsai/bin/llama-server.exe",
        inferenceServerModelPath: "C:/Bonsai/models/8B.gguf",
        inferenceServerProfiles: [
          {
            model: model27,
            baseUrl: "http://127.0.0.1:8080/v1",
            executablePath: "C:/Bonsai/bin/llama-server.exe",
            modelPath: "C:/Bonsai/models/27B.gguf",
          },
        ],
      });
      let spawnAttempts = 0;
      const inferenceCalls: Array<{
        readonly operation: string;
        readonly baseUrl: string;
        readonly model?: string;
      }> = [];
      const spawner = ChildProcessSpawner.make(() => {
        spawnAttempts += 1;
        return Effect.die(new Error("mismatched endpoint must not spawn Pi"));
      });
      const textGeneration = yield* makePiTextGeneration({
        instanceId: ProviderInstanceId.make("pi-text-mismatched-endpoint"),
        settings: piSettings,
        environment: { PATH: process.env.PATH },
        inferenceServerManager: makeTestInferenceServerManager(["bonsai-2-8b"], inferenceCalls),
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const failure = yield* Effect.flip(
        textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Summarize this thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("pi-text-mismatched-endpoint"),
            model: model27,
          },
        }),
      );
      NodeAssert.match(
        failure.detail,
        /endpoint does not serve the selected Pi model.*bonsai-2-27b/,
      );
      NodeAssert.equal(spawnAttempts, 0);
      NodeAssert.deepEqual(inferenceCalls, [
        { operation: "status", baseUrl: "http://127.0.0.1:8080/v1", model: model27 },
      ]);
    }),
  );
});

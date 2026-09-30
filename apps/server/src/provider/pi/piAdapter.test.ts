// @effect-diagnostics nodeBuiltinImport:off - Tests use disposable worktree fixtures.
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  ProviderInstanceId,
  ThreadId,
  type PiSettings,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import { makePiAdapter } from "./piAdapter.ts";
import { PI_BONSAI_MODEL_ID, piInferenceServerManager } from "./piInferenceServer.ts";
import type { PiProcessFactory, PiSpawnedProcess } from "./piSessionRuntime.ts";

function makeProcessFactory(
  options: {
    readonly failReadyCount?: number;
    readonly emitConcurrentApprovals?: boolean;
    readonly emitEmptyFailure?: boolean;
    readonly onPrompt?: (message: string) => void;
  } = {},
): {
  readonly factory: PiProcessFactory;
  readonly count: () => number;
  readonly launchArgs: Array<ReadonlyArray<string>>;
} {
  let childCount = 0;
  const launchArgs: Array<ReadonlyArray<string>> = [];
  const factory: PiProcessFactory = (input) => {
    childCount += 1;
    launchArgs.push(input.args);
    const childIndex = childCount;
    const stdout: Array<(chunk: string) => void> = [];
    const emit = (record: unknown) => {
      queueMicrotask(() => {
        for (const listener of stdout) listener(JSON.stringify(record) + "\n");
      });
    };
    const child: PiSpawnedProcess = {
      pid: childIndex,
      writeStdin: (line) => {
        const command = JSON.parse(line) as {
          readonly id?: string;
          readonly type: string;
          readonly message?: string;
        };
        if (command.type === "get_state") {
          emit({
            type: "response",
            id: command.id,
            command: "get_state",
            success: true,
            data: { sessionId: "pi-session-" + childIndex },
          });
          if (childIndex > (options.failReadyCount ?? 0)) {
            emit({
              type: "extension_ui_request",
              id: "ready-" + childIndex,
              method: "notify",
              message: "FT3_PI_TOOL_GUARD_READY_V1",
            });
          }
        } else if (command.type === "clear_queue") {
          emit({
            type: "response",
            id: command.id,
            command: "clear_queue",
            success: true,
            data: { steering: [], followUp: [] },
          });
        } else if (command.type === "abort") {
          // Pi 0.87.1 emits settled before its abort response.
          emit({ type: "agent_settled" });
          emit({ type: "response", id: command.id, command: "abort", success: true });
        } else if (command.type === "prompt") {
          options.onPrompt?.(command.message ?? "");
          emit({ type: "response", id: command.id, command: "prompt", success: true });
          emit({ type: "agent_start" });
          if (options.emitEmptyFailure) {
            emit({
              type: "message_end",
              message: {
                role: "assistant",
                content: [],
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                },
                stopReason: "error",
                errorMessage: "fixture secret must not escape into the chat",
              },
            });
            emit({ type: "agent_settled" });
            return;
          }
          if (options.emitConcurrentApprovals) {
            for (const call of [
              { id: "approve-1", callId: "call-1", command: "echo one" },
              { id: "approve-2", callId: "call-2", command: "echo two" },
            ]) {
              emit({
                type: "extension_ui_request",
                id: call.id,
                method: "confirm",
                title: "FT3 tool approval: bash " + call.callId,
                message: JSON.stringify({
                  protocol: 1,
                  toolName: "bash",
                  toolCallId: call.callId,
                  reason: "shell command: " + call.command,
                  input: { command: call.command },
                }),
              });
            }
            return;
          }
          const message = command.message ?? "";
          emit({
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              delta: message.includes("HANG") ? "old-output" : "new-output",
            },
          });
          if (!message.includes("HANG")) emit({ type: "agent_settled" });
        }
      },
      endStdin: () => {},
      kill: () => {},
      onStdout: (listener) => stdout.push(listener),
      onStderr: () => {},
      onExit: () => {},
      onClose: () => {},
      onError: () => {},
    };
    return child;
  };
  return { factory, count: () => childCount, launchArgs };
}

const piSettings: PiSettings = {
  enabled: true,
  binaryPath: "pi",
  baseUrl: "http://127.0.0.1:11434/v1",
  apiKey: "ollama",
  model: "fixture-model",
  inferenceServerExecutablePath: "",
  inferenceServerModelPath: "",
  inferenceServerProfiles: [],
  inferenceServerAutoStart: false,
  inferenceServerGpuLayers: 48,
  inferenceServerContextSize: 81920,
  inferenceServerParallel: 1,
  inferenceServerTemperature: 1,
  inferenceServerTopP: 0.95,
  inferenceServerTopK: 20,
  inferenceServerMinP: 0.05,
  inferenceServerFlashAttention: true,
  inferenceServerCacheTypeK: "q4_0",
  inferenceServerCacheTypeV: "q4_0",
  inferenceServerJinja: true,
  inferenceServerReasoning: true,
  inferenceServerReasoningEffort: "medium",
  customModels: [],
};

const makeStartInput = (
  threadId: ThreadId,
  modelSelection?: { readonly instanceId: ProviderInstanceId; readonly model: string },
) => ({
  threadId,
  cwd: process.cwd(),
  runtimeMode: "auto" as const,
  ...(modelSelection ? { modelSelection } : {}),
});

it.layer(Layer.merge(NodeServices.layer, TestClock.layer()))(
  "Pi adapter session acceptance",
  (it) => {
    it.effect("rejects an explicitly configured missing AGENTS.md before Pi spawn", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const processFactory = makeProcessFactory();
          const adapter = yield* makePiAdapter({
            instanceId: ProviderInstanceId.make("pi-missing-personal-agents"),
            config: {
              ...piSettings,
              personalInstructionsPath: NodePath.join(
                NodeOS.tmpdir(),
                "ft3-no-such-personal-agents",
                "AGENTS.md",
              ),
            },
            environment: {},
            runtimeHooks: { processFactory: processFactory.factory },
          });
          const failure = yield* Effect.flip(
            adapter.startSession(makeStartInput(ThreadId.make("pi-missing-personal-agents"))),
          );
          NodeAssert.match(failure.message, /Personal Pi AGENTS.md/);
          NodeAssert.equal(processFactory.count(), 0);
        }),
      ).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-missing-personal-" }),
        ),
        TestClock.withLive,
      ),
    );
    it.effect(
      "loads personal Codex resources before Pi spawn and reports their original sources",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const root = yield* Effect.promise(() =>
              NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-pi-personal-session-")),
            );
            yield* Effect.addFinalizer(() =>
              Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
            );
            const personalRoot = NodePath.join(root, "codex-home");
            const instructionsPath = NodePath.join(personalRoot, "AGENTS.md");
            const skillsDirectory = NodePath.join(personalRoot, "skills");
            const cwd = NodePath.join(root, "workspace");
            const skillDirectory = NodePath.join(skillsDirectory, "shared-skill");
            yield* Effect.promise(() => NodeFSP.mkdir(cwd));
            yield* Effect.promise(() => NodeFSP.mkdir(skillDirectory, { recursive: true }));
            yield* Effect.promise(() => NodeFSP.writeFile(instructionsPath, "PERSONAL_CONTEXT"));
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                NodePath.join(skillDirectory, "SKILL.md"),
                "---\nname: shared-skill\ndescription: shared\n---\nbody",
              ),
            );
            const reports: Array<{
              agents: ReadonlyArray<{ source: string }>;
              skills: ReadonlyArray<{ source: string }>;
            }> = [];
            const processFactory = makeProcessFactory();
            const threadId = ThreadId.make("pi-personal-resources");
            const adapter = yield* makePiAdapter({
              instanceId: ProviderInstanceId.make("pi-personal-resources"),
              config: {
                ...piSettings,
                personalInstructionsPath: instructionsPath,
                personalSkillsDirectory: skillsDirectory,
              },
              environment: {},
              onResourcesLoaded: (report) => reports.push(report),
              runtimeHooks: { processFactory: processFactory.factory },
            });
            yield* adapter.startSession({ ...makeStartInput(threadId), cwd });
            NodeAssert.equal(processFactory.count(), 1);
            NodeAssert.deepEqual(
              reports[0]?.agents.map((resource) => resource.source),
              [instructionsPath],
            );
            NodeAssert.deepEqual(
              reports[0]?.skills.map((resource) => resource.source),
              [NodePath.join(skillDirectory, "SKILL.md")],
            );
            const config = yield* ServerConfig;
            const hash = NodeCrypto.createHash("sha256").update(String(threadId)).digest("hex");
            const sessionsDirectory = NodePath.join(
              config.stateDir,
              "pi",
              "pi-personal-resources",
              "agent",
              "sessions",
              hash,
            );
            const sessionDirectory = (yield* Effect.promise(() =>
              NodeFSP.readdir(sessionsDirectory),
            ))[0]!;
            const agentFile = NodePath.join(sessionsDirectory, sessionDirectory, "AGENTS.md");
            NodeAssert.equal(
              yield* Effect.promise(() => NodeFSP.readFile(agentFile, "utf8")),
              "PERSONAL_CONTEXT",
            );
            yield* adapter.stopSession(threadId);
            const changedInstructions = NodePath.join(root, "other-codex-home", "AGENTS.md");
            yield* Effect.promise(() => NodeFSP.mkdir(NodePath.dirname(changedInstructions)));
            yield* Effect.promise(() =>
              NodeFSP.writeFile(changedInstructions, "CHANGED_PERSONAL_CONTEXT"),
            );
            const restarted = yield* makePiAdapter({
              instanceId: ProviderInstanceId.make("pi-personal-resources"),
              config: {
                ...piSettings,
                personalInstructionsPath: changedInstructions,
                personalSkillsDirectory: skillsDirectory,
              },
              environment: {},
              onResourcesLoaded: (report) => reports.push(report),
              runtimeHooks: { processFactory: processFactory.factory },
            });
            yield* restarted.startSession({ ...makeStartInput(threadId), cwd });
            NodeAssert.equal(processFactory.count(), 2);
            NodeAssert.deepEqual(
              reports[1]?.agents.map((resource) => resource.source),
              [changedInstructions],
            );
            const restartedDirectory = (yield* Effect.promise(() =>
              NodeFSP.readdir(sessionsDirectory),
            ))[0]!;
            NodeAssert.equal(
              yield* Effect.promise(() =>
                NodeFSP.readFile(
                  NodePath.join(sessionsDirectory, restartedDirectory, "AGENTS.md"),
                  "utf8",
                ),
              ),
              "CHANGED_PERSONAL_CONTEXT",
            );
          }),
        ).pipe(
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-personal-session-" }),
          ),
          TestClock.withLive,
        ),
    );
    it.effect(
      "loads representative .agents and plugin skill roots and reports partial provenance",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const root = yield* Effect.promise(() =>
              NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-pi-codex-defaults-")),
            );
            yield* Effect.addFinalizer(() =>
              Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
            );
            const cwd = NodePath.join(root, "workspace");
            yield* Effect.promise(() => NodeFSP.mkdir(cwd));
            const agentsSkill = NodePath.join(root, "host", ".agents", "skills", "agents-skill");
            const pluginSkill = NodePath.join(
              root,
              "codex-home",
              "plugins",
              "cache",
              "unity-agent-plugin",
              "unity",
              "0.1.6-beta",
              "skills",
              "unity-skill",
            );
            const instructionsPath = NodePath.join(root, "codex-home", "AGENTS.md");
            for (const directory of [agentsSkill, pluginSkill]) {
              yield* Effect.promise(() =>
                NodeFSP.mkdir(directory, { recursive: true }).then(() =>
                  NodeFSP.writeFile(
                    NodePath.join(directory, "SKILL.md"),
                    `---\nname: ${NodePath.basename(directory)}\ndescription: fixture\n---\nbody`,
                  ),
                ),
              );
            }
            yield* Effect.promise(() =>
              NodeFSP.writeFile(instructionsPath, "CODEX_DEFAULT_AGENTS"),
            );
            const reports: Array<{
              skills: ReadonlyArray<{ name: string; source: string; kind: string }>;
              warnings: ReadonlyArray<string>;
            }> = [];
            const processFactory = makeProcessFactory();
            const adapter = yield* makePiAdapter({
              instanceId: ProviderInstanceId.make("pi-codex-defaults"),
              config: piSettings,
              environment: {},
              resolvePersonalResources: async () => ({
                instructionsPath,
                skillsDirectories: [agentsSkill, pluginSkill],
                warnings: ["Pi personal Codex skills are a partial subset: fixture."],
              }),
              onResourcesLoaded: (report) => reports.push(report),
              runtimeHooks: { processFactory: processFactory.factory },
            });
            yield* adapter.startSession({
              ...makeStartInput(ThreadId.make("pi-codex-defaults")),
              cwd,
            });
            NodeAssert.deepEqual(
              reports[0]?.skills.map((skill) => skill.source).sort(),
              [
                NodePath.join(agentsSkill, "SKILL.md"),
                NodePath.join(pluginSkill, "SKILL.md"),
              ].sort(),
            );
            NodeAssert.ok(
              reports[0]?.warnings.some((warning) => warning.includes("partial subset")),
            );
            const skillArgs = processFactory.launchArgs[0]!.filter(
              (argument, index, args) => args[index - 1] === "--skill" && argument.length > 0,
            );
            NodeAssert.equal(skillArgs.length, 2);
            NodeAssert.deepEqual(
              reports[0]?.skills.map((skill) => skill.kind),
              ["personal", "personal"],
            );
          }),
        ).pipe(
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-codex-defaults-" }),
          ),
          TestClock.withLive,
        ),
    );
    it.effect(
      "does not rewrite the shared agent catalog when the selected model profile is missing",
      () =>
        Effect.gen(function* () {
          const instanceId = ProviderInstanceId.make("pi-missing-model-profile");
          const threadId = ThreadId.make("pi-missing-model-profile-thread");
          const processFactory = makeProcessFactory();
          const config = yield* ServerConfig;
          const agentDir = NodePath.join(config.stateDir, "pi", instanceId, "agent");
          const adapter = yield* makePiAdapter({
            instanceId,
            config: {
              ...piSettings,
              inferenceServerExecutablePath: "C:/Bonsai/bin/llama-server.exe",
              inferenceServerModelPath: "C:/Bonsai/models/8B.gguf",
            },
            environment: {},
            runtimeHooks: { processFactory: processFactory.factory },
          });

          const failure = yield* Effect.flip(
            adapter.startSession(
              makeStartInput(threadId, {
                instanceId,
                model: "ft3-local/bonsai-2-27b",
              }),
            ),
          );
          NodeAssert.match(failure.message, /Configure a managed llama-server profile/);
          NodeAssert.equal(processFactory.count(), 0);
          yield* Effect.promise(() =>
            NodeAssert.rejects(NodeFSP.stat(NodePath.join(agentDir, "models.json")), {
              code: "ENOENT",
            }),
          );
        }).pipe(
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-missing-model-profile-" }),
          ),
          TestClock.withLive,
        ),
    );

    it.effect("passes Pi a staged skill snapshot outside the mutable worktree", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const temp = yield* Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-pi-adapter-skills-")),
          );
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => NodeFSP.rm(temp, { recursive: true, force: true })),
          );
          const repo = NodePath.join(temp, "worktree");
          const sourceSkill = NodePath.join(repo, ".agents", "skills", "adapter-skill", "SKILL.md");
          const original =
            "---\nname: adapter-skill\ndescription: fixture\n---\nRead scripts/check.js and references/guide.md.";
          yield* Effect.promise(() =>
            NodeFSP.mkdir(NodePath.join(repo, ".git"), { recursive: true }),
          );
          yield* Effect.promise(() =>
            NodeFSP.mkdir(NodePath.dirname(sourceSkill), { recursive: true }),
          );
          yield* Effect.promise(() =>
            NodeFSP.mkdir(NodePath.join(NodePath.dirname(sourceSkill), "scripts"), {
              recursive: true,
            }),
          );
          yield* Effect.promise(() =>
            NodeFSP.mkdir(NodePath.join(NodePath.dirname(sourceSkill), "references"), {
              recursive: true,
            }),
          );
          yield* Effect.promise(() => NodeFSP.writeFile(sourceSkill, original));
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(NodePath.dirname(sourceSkill), "scripts", "check.js"),
              "captured script",
            ),
          );
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(NodePath.dirname(sourceSkill), "references", "guide.md"),
              "captured reference",
            ),
          );

          const processFactory = makeProcessFactory();
          const threadId = ThreadId.make("pi-staged-skill");
          const adapter = yield* makePiAdapter({
            instanceId: ProviderInstanceId.make("pi-staged-skill"),
            config: piSettings,
            environment: {},
            runtimeHooks: { processFactory: processFactory.factory },
          });
          yield* adapter.startSession({ ...makeStartInput(threadId), cwd: repo });

          const args = processFactory.launchArgs[0] ?? [];
          const skillArg = args.indexOf("--skill");
          NodeAssert.ok(skillArg >= 0, "Pi receives an explicit --skill path");
          const stagedSkill = args[skillArg + 1];
          NodeAssert.ok(stagedSkill);
          NodeAssert.ok(!stagedSkill.startsWith(repo));

          // Pi can read the argument after session startup. A later worktree
          // replacement does not change the bytes staged for that path.
          yield* Effect.promise(() => NodeFSP.writeFile(sourceSkill, "replacement"));
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(NodePath.dirname(sourceSkill), "scripts", "check.js"),
              "replacement script",
            ),
          );
          NodeAssert.equal(
            yield* Effect.promise(() => NodeFSP.readFile(stagedSkill, "utf8")),
            original,
          );
          NodeAssert.equal(
            yield* Effect.promise(() =>
              NodeFSP.readFile(
                NodePath.join(NodePath.dirname(stagedSkill), "scripts", "check.js"),
                "utf8",
              ),
            ),
            "captured script",
          );
          NodeAssert.equal(
            yield* Effect.promise(() =>
              NodeFSP.readFile(
                NodePath.join(NodePath.dirname(stagedSkill), "references", "guide.md"),
                "utf8",
              ),
            ),
            "captured reference",
          );
          yield* adapter.stopSession(threadId);
        }),
      ).pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-staged-skill-" })),
        TestClock.withLive,
      ),
    );

    it.effect(
      "releases Pi endpoint claims when the provider scope closes without another RPC",
      () =>
        Effect.gen(function* () {
          const instanceId = ProviderInstanceId.make("pi-scope-lifecycle");
          const threadId = ThreadId.make("pi-scope-lifecycle-thread");
          const releasedInstances: Array<ProviderInstanceId> = [];
          const releasedActivities: Array<ThreadId> = [];
          const fakeManager = {
            releaseInstance: (id: ProviderInstanceId) => releasedInstances.push(id),
            releaseActivity: (_id: ProviderInstanceId, thread: ThreadId) =>
              releasedActivities.push(thread),
          } as unknown as typeof piInferenceServerManager;

          yield* Effect.scoped(
            Effect.gen(function* () {
              const adapter = yield* makePiAdapter({
                instanceId,
                config: piSettings,
                environment: {},
                runtimeHooks: {
                  processFactory: makeProcessFactory().factory,
                  inferenceServerManager: fakeManager,
                },
              });
              yield* adapter.startSession(makeStartInput(threadId));
              NodeAssert.deepEqual(releasedInstances, []);
            }),
          );

          NodeAssert.deepEqual(releasedInstances, [instanceId]);
          NodeAssert.deepEqual(releasedActivities, [threadId]);
        }).pipe(
          Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-scope-close-" })),
          TestClock.withLive,
        ),
    );

    it.effect("emits inference-server activity without opening an agent turn", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const threadId = ThreadId.make("pi-inference-activity");
          const adapter = yield* makePiAdapter({
            instanceId: ProviderInstanceId.make("pi-test"),
            config: piSettings,
            environment: {},
          });
          const received = yield* Queue.unbounded<ProviderRuntimeEvent>();
          const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
            Queue.offer(received, event),
          ).pipe(Effect.forkChild);
          yield* TestClock.adjust("10 millis");

          yield* adapter.emitInferenceActivity(threadId, "Start requested (manual).");
          const event = yield* Queue.take(received);
          NodeAssert.equal(event.type, "runtime.warning");
          NodeAssert.equal(event.threadId, threadId);
          NodeAssert.equal(event.turnId, undefined);
          if (event.type === "runtime.warning") {
            NodeAssert.match(event.payload.message, /Start requested \(manual\)/);
          }
          yield* Fiber.interrupt(eventFiber);
        }),
      ).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-inference-activity-" }),
        ),
        TestClock.withLive,
      ),
    );

    it.effect("holds the first user prompt until managed endpoint readiness", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const threadId = ThreadId.make("pi-wait-for-inference-ready");
          const sentPrompts: Array<string> = [];
          const processFactory = makeProcessFactory({
            onPrompt: (message) => sentPrompts.push(message),
          });
          let markEnsureStarted!: () => void;
          const ensureStarted = new Promise<void>((resolve) => {
            markEnsureStarted = resolve;
          });
          let markReady!: () => void;
          const readiness = new Promise<void>((resolve) => {
            markReady = resolve;
          });
          let ensureCount = 0;
          const fakeManager = {
            ensureReady: async () => {
              ensureCount += 1;
              markEnsureStarted();
              await readiness;
              return { ready: true, modelIds: [PI_BONSAI_MODEL_ID] };
            },
            acquireRequestSlot: async () => () => undefined,
            releaseActivity: () => undefined,
          } as unknown as typeof piInferenceServerManager;
          const adapter = yield* makePiAdapter({
            instanceId: ProviderInstanceId.make("pi-test"),
            config: {
              ...piSettings,
              model: PI_BONSAI_MODEL_ID,
              inferenceServerExecutablePath: "C:\\fake\\llama-server.exe",
              inferenceServerModelPath: "C:\\fake\\model.gguf",
              inferenceServerProfiles: [
                {
                  model: `ft3-local/${PI_BONSAI_MODEL_ID}`,
                  baseUrl: "http://127.0.0.1:11434/v1",
                  executablePath: "C:\\fake\\llama-server.exe",
                  modelPath: "C:\\fake\\model.gguf",
                },
              ],
              inferenceServerAutoStart: true,
            },
            environment: {},
            runtimeHooks: {
              processFactory: processFactory.factory,
              inferenceServerManager: fakeManager,
            },
          });
          yield* adapter.startSession(
            makeStartInput(threadId, {
              instanceId: ProviderInstanceId.make("pi-test"),
              model: PI_BONSAI_MODEL_ID,
            }),
          );
          const launchArgs = processFactory.launchArgs[0] ?? [];
          NodeAssert.equal(
            launchArgs[launchArgs.indexOf("--model") + 1],
            `ft3-local/${PI_BONSAI_MODEL_ID}`,
          );
          NodeAssert.equal(ensureCount, 0, "creating an empty chat must not launch llama-server");

          const turnFiber = yield* Effect.forkChild(
            adapter.sendTurn({ threadId, input: "keep this prompt pending" }),
          );
          yield* Effect.promise(() => ensureStarted);
          NodeAssert.deepEqual(sentPrompts, []);
          markReady();
          yield* Fiber.join(turnFiber);
          NodeAssert.deepEqual(sentPrompts, ["keep this prompt pending"]);
          yield* adapter.stopSession(threadId);
        }),
      ).pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-wait-ready-" })),
        TestClock.withLive,
      ),
    );

    it.effect("auto-start resolves the exact selected model profile", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const threadId = ThreadId.make("pi-model-profile-autostart");
          let launchedPath = "";
          const fakeManager = {
            ensureReady: async (_id: unknown, config: PiSettings) => {
              launchedPath = config.inferenceServerModelPath;
              return { ready: true, modelIds: ["bonsai-2-8b"] };
            },
            acquireRequestSlot: async () => () => undefined,
            releaseActivity: () => undefined,
          } as unknown as typeof piInferenceServerManager;
          const config: PiSettings = {
            ...piSettings,
            model: PI_BONSAI_MODEL_ID,
            inferenceServerAutoStart: true,
            inferenceServerProfiles: [
              {
                model: "ft3-local/bonsai-2-8b",
                baseUrl: "http://127.0.0.1:8181/v1",
                executablePath: "C:\\fake\\llama-server.exe",
                modelPath: "C:\\fake\\8B.gguf",
              },
            ],
          };
          const adapter = yield* makePiAdapter({
            instanceId: ProviderInstanceId.make("pi-test"),
            config,
            environment: {},
            runtimeHooks: {
              processFactory: makeProcessFactory().factory,
              inferenceServerManager: fakeManager,
            },
          });
          yield* adapter.startSession(
            makeStartInput(threadId, {
              instanceId: ProviderInstanceId.make("pi-test"),
              model: "ft3-local/bonsai-2-8b",
            }),
          );
          yield* adapter.sendTurn({ threadId, input: "use selected 8B" });
          NodeAssert.equal(launchedPath, "C:\\fake\\8B.gguf");
          yield* adapter.stopSession(threadId);
        }),
      ).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-profile-autostart-" }),
        ),
        TestClock.withLive,
      ),
    );

    it.effect("reports empty Pi failures instead of silently completing the turn", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const threadId = ThreadId.make("pi-empty-failure");
          const processFactory = makeProcessFactory({ emitEmptyFailure: true });
          const adapter = yield* makePiAdapter({
            instanceId: ProviderInstanceId.make("pi-test"),
            config: piSettings,
            environment: {},
            runtimeHooks: { processFactory: processFactory.factory },
          });
          const received = yield* Queue.unbounded<ProviderRuntimeEvent>();
          const captured: Array<ProviderRuntimeEvent> = [];
          const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.gen(function* () {
              yield* Effect.sync(() => captured.push(event));
              yield* Queue.offer(received, event);
            }),
          ).pipe(Effect.forkChild);
          yield* TestClock.adjust("10 millis");

          yield* adapter.startSession(makeStartInput(threadId));
          yield* takeMatching(received, (event) => event.type === "session.started");
          const sent = yield* adapter.sendTurn({
            threadId,
            input: "trigger an empty provider error",
          });
          const terminal = yield* takeMatching(
            received,
            (event) => event.type === "turn.completed" && event.turnId === sent.turnId,
          );
          if (terminal.type === "turn.completed") {
            NodeAssert.equal(terminal.payload.state, "failed");
            NodeAssert.equal(terminal.payload.outputStatus, "empty");
            NodeAssert.match(terminal.payload.errorMessage ?? "", /selected model.*Pi catalog/i);
            NodeAssert.doesNotMatch(
              terminal.payload.errorMessage ?? "",
              /fixture secret/i,
              "provider error details must not be copied into the chat",
            );
          }
          NodeAssert.equal(
            captured.some((event) => event.type === "content.delta"),
            false,
          );
          yield* adapter.stopSession(threadId);
          yield* Fiber.interrupt(eventFiber);
        }),
      ).pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-empty-failure-" })),
        TestClock.withLive,
      ),
    );

    it.effect("waits for a manual start without auto-starting and then sends the prompt", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const threadId = ThreadId.make("pi-manual-start-wait");
          const sentPrompts: Array<string> = [];
          const processFactory = makeProcessFactory({
            onPrompt: (message) => sentPrompts.push(message),
          });
          let markWaitStarted!: () => void;
          const waitStarted = new Promise<void>((resolve) => {
            markWaitStarted = resolve;
          });
          let markReady!: () => void;
          const readiness = new Promise<void>((resolve) => {
            markReady = resolve;
          });
          let autoStartCount = 0;
          const fakeManager = {
            ensureReady: async () => {
              autoStartCount += 1;
              throw new Error("auto-start is disabled for this test");
            },
            waitForExistingReady: async () => {
              markWaitStarted();
              await readiness;
              return { ready: true, modelIds: [PI_BONSAI_MODEL_ID] };
            },
            acquireRequestSlot: async () => () => undefined,
            releaseActivity: () => undefined,
          } as unknown as typeof piInferenceServerManager;
          const adapter = yield* makePiAdapter({
            instanceId: ProviderInstanceId.make("pi-test"),
            config: {
              ...piSettings,
              model: PI_BONSAI_MODEL_ID,
              inferenceServerExecutablePath: "C:\\fake\\llama-server.exe",
              inferenceServerModelPath: "C:\\fake\\model.gguf",
              inferenceServerProfiles: [
                {
                  model: `ft3-local/${PI_BONSAI_MODEL_ID}`,
                  baseUrl: "http://127.0.0.1:11434/v1",
                  executablePath: "C:\\fake\\llama-server.exe",
                  modelPath: "C:\\fake\\model.gguf",
                },
              ],
              inferenceServerAutoStart: false,
            },
            environment: {},
            runtimeHooks: {
              processFactory: processFactory.factory,
              inferenceServerManager: fakeManager,
            },
          });
          yield* adapter.startSession(
            makeStartInput(threadId, {
              instanceId: ProviderInstanceId.make("pi-test"),
              model: PI_BONSAI_MODEL_ID,
            }),
          );
          const launchArgs = processFactory.launchArgs[0] ?? [];
          NodeAssert.equal(
            launchArgs[launchArgs.indexOf("--model") + 1],
            `ft3-local/${PI_BONSAI_MODEL_ID}`,
          );

          const turnFiber = yield* Effect.forkChild(
            adapter.sendTurn({ threadId, input: "wait for manual startup" }),
          );
          yield* Effect.promise(() => waitStarted);
          NodeAssert.deepEqual(sentPrompts, []);
          NodeAssert.equal(autoStartCount, 0);
          markReady();
          yield* Fiber.join(turnFiber);
          NodeAssert.deepEqual(sentPrompts, ["wait for manual startup"]);
          yield* adapter.stopSession(threadId);
        }),
      ).pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-manual-wait-" })),
        TestClock.withLive,
      ),
    );

    it.effect("does not submit a prompt when a configured manual server is stopped", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const threadId = ThreadId.make("pi-manual-start-required");
          const sentPrompts: Array<string> = [];
          const processFactory = makeProcessFactory({
            onPrompt: (message) => sentPrompts.push(message),
          });
          let autoStartCount = 0;
          const fakeManager = {
            ensureReady: async () => {
              autoStartCount += 1;
              throw new Error("auto-start must remain disabled");
            },
            waitForExistingReady: async () => undefined,
            acquireRequestSlot: async () => () => undefined,
            releaseActivity: () => undefined,
          } as unknown as typeof piInferenceServerManager;
          const adapter = yield* makePiAdapter({
            instanceId: ProviderInstanceId.make("pi-test"),
            config: {
              ...piSettings,
              inferenceServerExecutablePath: "C:\\fake\\llama-server.exe",
              inferenceServerModelPath: "C:\\fake\\model.gguf",
              inferenceServerAutoStart: false,
            },
            environment: {},
            runtimeHooks: {
              processFactory: processFactory.factory,
              inferenceServerManager: fakeManager,
            },
          });
          yield* adapter.startSession(makeStartInput(threadId));

          const result = yield* adapter
            .sendTurn({ threadId, input: "keep this until the server is started" })
            .pipe(Effect.result);
          NodeAssert.equal(result._tag, "Failure");
          NodeAssert.equal(autoStartCount, 0);
          NodeAssert.deepEqual(sentPrompts, []);
          yield* adapter.stopSession(threadId);
        }),
      ).pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-manual-stopped-" })),
        TestClock.withLive,
      ),
    );

    it.effect("does not send a selected 27B prompt when a joined server reports 8B", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const threadId = ThreadId.make("pi-wrong-model-joined-start");
          const sentPrompts: Array<string> = [];
          const processFactory = makeProcessFactory({
            onPrompt: (message) => sentPrompts.push(message),
          });
          const fakeManager = {
            ensureReady: async () => ({ ready: true, modelIds: ["bonsai-2-8b"] }),
            waitForExistingReady: async () => ({ ready: true, modelIds: ["bonsai-2-8b"] }),
            acquireRequestSlot: async () => () => undefined,
            releaseActivity: () => undefined,
          } as unknown as typeof piInferenceServerManager;
          const adapter = yield* makePiAdapter({
            instanceId: ProviderInstanceId.make("pi-test"),
            config: {
              ...piSettings,
              model: PI_BONSAI_MODEL_ID,
              inferenceServerExecutablePath: "C:\\fake\\llama-server.exe",
              inferenceServerModelPath: "C:\\fake\\27B.gguf",
              inferenceServerProfiles: [
                {
                  model: `ft3-local/${PI_BONSAI_MODEL_ID}`,
                  baseUrl: "http://127.0.0.1:11434/v1",
                  executablePath: "C:\\fake\\llama-server.exe",
                  modelPath: "C:\\fake\\27B.gguf",
                },
              ],
              inferenceServerAutoStart: false,
            },
            environment: {},
            runtimeHooks: {
              processFactory: processFactory.factory,
              inferenceServerManager: fakeManager,
            },
          });
          yield* adapter.startSession(
            makeStartInput(threadId, {
              instanceId: ProviderInstanceId.make("pi-test"),
              model: PI_BONSAI_MODEL_ID,
            }),
          );
          const result = yield* adapter
            .sendTurn({ threadId, input: "only send this to 27B" })
            .pipe(Effect.result);
          NodeAssert.equal(result._tag, "Failure");
          if (result._tag === "Failure")
            NodeAssert.match(String(result.failure), /does not serve the selected Pi model/);
          NodeAssert.deepEqual(sentPrompts, []);
          yield* adapter.stopSession(threadId);
        }),
      ).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-wrong-joined-model-" }),
        ),
        TestClock.withLive,
      ),
    );

    it.effect("evicts a failed first handshake and retries with a fresh process", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const threadId = ThreadId.make("pi-handshake-retry");
          const processFactory = makeProcessFactory({ failReadyCount: 1 });
          const adapter = yield* makePiAdapter({
            instanceId: ProviderInstanceId.make("pi-test"),
            config: piSettings,
            environment: {},
            runtimeHooks: {
              processFactory: processFactory.factory,
              guardReadyTimeoutMs: 20,
            },
          });

          const firstResult = yield* adapter
            .startSession(makeStartInput(threadId))
            .pipe(Effect.result, TestClock.withLive);
          NodeAssert.equal(firstResult._tag, "Failure");
          NodeAssert.equal(yield* adapter.hasSession(threadId), false);
          NodeAssert.equal((yield* adapter.listSessions()).length, 0);

          const session = yield* adapter.startSession(makeStartInput(threadId));
          NodeAssert.equal(session.status, "ready");
          NodeAssert.equal(processFactory.count(), 2);
          NodeAssert.ok(processFactory.launchArgs[1]?.includes("--model"));
          NodeAssert.ok(processFactory.launchArgs[1]?.includes("ft3-local/fixture-model"));
          NodeAssert.equal(yield* adapter.hasSession(threadId), true);
          yield* adapter.stopSession(threadId);
        }),
      ).pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-retry-" })),
        TestClock.withLive,
      ),
    );

    it.effect("keeps old and new turn events attributed across accepted steer and abort", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const threadId = ThreadId.make("pi-turn-attribution");
          const processFactory = makeProcessFactory();
          const adapter = yield* makePiAdapter({
            instanceId: ProviderInstanceId.make("pi-test"),
            config: piSettings,
            environment: {},
            runtimeHooks: { processFactory: processFactory.factory },
          });
          const received = yield* Queue.unbounded<ProviderRuntimeEvent>();
          const captured: Array<ProviderRuntimeEvent> = [];
          const eventFiber = yield* Effect.gen(function* () {
            yield* Stream.runForEach(adapter.streamEvents, (event) =>
              Effect.gen(function* () {
                yield* Effect.sync(() => captured.push(event));
                yield* Queue.offer(received, event);
              }),
            );
          }).pipe(Effect.forkChild);
          yield* TestClock.adjust("10 millis");

          yield* adapter.startSession(makeStartInput(threadId));
          yield* takeMatching(received, (event) => event.type === "session.started");
          const oldTurn = yield* adapter.sendTurn({ threadId, input: "HANG old turn" });
          const oldDelta = yield* takeMatching(
            received,
            (event) =>
              event.type === "content.delta" &&
              (event.payload as { delta?: unknown }).delta === "old-output",
          );
          NodeAssert.equal(oldDelta.turnId, oldTurn.turnId);

          const nextTurn = yield* adapter.sendTurn({
            threadId,
            input: "new steered turn",
            followUpBehavior: "steer",
          });
          NodeAssert.equal(nextTurn.supersededTurnId, oldTurn.turnId);
          const newDelta = yield* takeMatching(
            received,
            (event) =>
              event.type === "content.delta" &&
              (event.payload as { delta?: unknown }).delta === "new-output",
          );
          NodeAssert.equal(newDelta.turnId, nextTurn.turnId);
          NodeAssert.ok(
            captured.some(
              (event) => event.type === "turn.aborted" && event.turnId === oldTurn.turnId,
            ),
            "the interrupted Pi run must close the old FT3 turn as aborted",
          );
          NodeAssert.ok(
            !captured.some(
              (event) => event.type === "turn.completed" && event.turnId === oldTurn.turnId,
            ),
            "agent_settled from an explicit abort must not complete the old FT3 turn",
          );
          yield* adapter.stopSession(threadId);
          yield* Fiber.interrupt(eventFiber);
        }),
      ).pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-turns-" })),
        TestClock.withLive,
      ),
    );

    it.effect("surfaces concurrent Pi tool approvals without serially blocking the second", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const threadId = ThreadId.make("pi-parallel-approvals");
          const processFactory = makeProcessFactory({ emitConcurrentApprovals: true });
          const adapter = yield* makePiAdapter({
            instanceId: ProviderInstanceId.make("pi-test"),
            config: piSettings,
            environment: {},
            runtimeHooks: { processFactory: processFactory.factory },
          });
          const received = yield* Queue.unbounded<ProviderRuntimeEvent>();
          yield* Stream.runForEach(adapter.streamEvents, (event) =>
            Queue.offer(received, event),
          ).pipe(Effect.forkChild);
          yield* TestClock.adjust("10 millis");
          yield* adapter.startSession(makeStartInput(threadId));
          yield* takeMatching(received, (event) => event.type === "session.started");
          yield* adapter.sendTurn({ threadId, input: "request two approvals" });

          const first = yield* takeMatching(
            received,
            (event) =>
              event.type === "request.opened" &&
              event.payload.requestType === "exec_command_approval",
          );
          const second = yield* takeMatching(
            received,
            (event) =>
              event.type === "request.opened" &&
              event.payload.requestType === "exec_command_approval" &&
              event.requestId !== first.requestId,
          ).pipe(Effect.timeoutOption("1 second"));
          NodeAssert.equal(second._tag, "Some");
          if (second._tag === "Some") {
            yield* adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(first.requestId!),
              "accept",
            );
            yield* adapter.interruptTurn(threadId);
            yield* Effect.yieldNow;
            const staleApproval = yield* adapter
              .respondToRequest(threadId, ApprovalRequestId.make(second.value.requestId!), "accept")
              .pipe(Effect.result);
            NodeAssert.equal(staleApproval._tag, "Failure");
          }
          yield* adapter.stopSession(threadId);
        }),
      ).pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-approvals-" })),
        TestClock.withLive,
      ),
    );
  },
);

function takeMatching(
  queue: Queue.Queue<ProviderRuntimeEvent>,
  predicate: (event: ProviderRuntimeEvent) => boolean,
): Effect.Effect<ProviderRuntimeEvent> {
  return Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(queue);
      if (predicate(event)) return event;
    }
  });
}

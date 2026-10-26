import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { OrchestratorCommandRejectedError } from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const codexInstanceId = ProviderInstanceId.make("codex");
const claudeCleanInstanceId = ProviderInstanceId.make("claude-clean");
const claudeBypassInstanceId = ProviderInstanceId.make("claude-bypass");
const codexDriver = ProviderDriverKind.make("codex");
const claudeDriver = ProviderDriverKind.make("claudeAgent");

const providerFor = (
  instanceId: ReturnType<typeof ProviderInstanceId.make>,
  driver: ReturnType<typeof ProviderDriverKind.make>,
): ServerProvider => ({
  instanceId,
  driver,
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-13T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

const providers = [
  providerFor(codexInstanceId, codexDriver),
  providerFor(claudeCleanInstanceId, claudeDriver),
  providerFor(claudeBypassInstanceId, claudeDriver),
];

const adapterRegistryLayer = Layer.succeed(
  ProviderAdapterRegistry.ProviderAdapterRegistryV2,
  ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
    list: () => Effect.succeed(providers.map((provider) => provider.instanceId)),
    get: (instanceId) =>
      providers.some((provider) => provider.instanceId === instanceId)
        ? Effect.succeed({ instanceId } as unknown as ProviderAdapter.ProviderAdapterV2["Service"])
        : Effect.fail(
            new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
          ),
  }),
);

const settingsLayer = ServerSettings.layerTest({
  providerInstances: {
    [codexInstanceId]: { driver: codexDriver, config: {} },
    [claudeCleanInstanceId]: { driver: claudeDriver, config: {} },
    [claudeBypassInstanceId]: {
      driver: claudeDriver,
      config: { launchArgs: "--permission-mode bypassPermissions" },
    },
  },
});

const layerOrchestratorService = OrchestratorMcpService.layer.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

const scopeFor = (threadId: ThreadId): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:ft3-envelope"),
  requestNamespace: "provider-session:ft3-envelope",
  thread: {
    threadId,
    providerSessionId: "provider-session:ft3-envelope",
    providerInstanceId: codexInstanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

const parentProjection = (threadId: ThreadId) =>
  ({
    thread: {
      id: threadId,
      projectId: ProjectId.make("project:ft3-envelope"),
      title: "Parent",
      modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
      runtimeMode: "auto",
      interactionMode: "default",
    },
    runs: [
      {
        id: RunId.make("run:ft3-envelope-parent"),
        ordinal: 1,
        status: "running",
        rootNodeId: NodeId.make("node:ft3-envelope-root"),
        providerInstanceId: codexInstanceId,
        modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
      },
    ],
    contextTransfers: [],
    subagents: [],
  }) as unknown as OrchestrationV2ThreadProjection;

const layerDependencies = (threadId: ThreadId, dispatched: Ref.Ref<number>) =>
  Layer.mergeAll(
    NodeServices.layer,
    settingsLayer,
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(providers),
    }),
    adapterRegistryLayer,
    Layer.mock(ProjectService.ProjectService)({}),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      hasReceipt: () => Effect.succeed(false),
      getThreadRecords: () => Effect.succeed(parentProjection(threadId)),
      isProviderInstanceEnabledForProject: () => Effect.succeed(true),
      dispatch: (command: OrchestrationV2ServerCommand) =>
        Ref.update(dispatched, (count) => count + 1).pipe(
          Effect.andThen(
            Effect.fail(
              new OrchestratorCommandRejectedError({
                commandId: command.commandId,
                commandType: command.type,
              }),
            ),
          ),
        ),
    }),
  );

const run = (
  threadId: ThreadId,
  dispatchState: Ref.Ref<number>,
  target: {
    readonly providerInstanceId: ReturnType<typeof ProviderInstanceId.make>;
    readonly model: string;
  },
) =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    return yield* service
      .delegateTask(scopeFor(threadId), {
        task: "Summarize the parser changes.",
        target,
        mode: "async",
        clientRequestId: "delegate-envelope",
      })
      .pipe(Effect.flip);
  }).pipe(
    Effect.provide(
      layerOrchestratorService.pipe(Layer.provide(layerDependencies(threadId, dispatchState))),
    ),
  );

describe("OrchestratorMcpService delegation permission envelope", () => {
  it.effect("refuses a target whose provider configuration runs broader than the parent", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:ft3-envelope-denied");
      const dispatched = yield* Ref.make(0);
      const error = yield* run(threadId, dispatched, {
        providerInstanceId: claudeBypassInstanceId,
        model: "claude-sonnet",
      });
      assert.equal(error.code, "runtime_mode_escalation_denied");
      assert.equal(yield* Ref.get(dispatched), 0);
    }),
  );

  it.effect("dispatches a target whose provider configuration matches the parent", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:ft3-envelope-allowed");
      const dispatched = yield* Ref.make(0);
      const error = yield* run(threadId, dispatched, {
        providerInstanceId: claudeCleanInstanceId,
        model: "claude-sonnet",
      });
      assert.equal(error.code, "orchestration_error");
      assert.equal(yield* Ref.get(dispatched), 1);
    }),
  );
});

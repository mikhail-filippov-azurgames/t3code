import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const providerToken = `ghp_${"A".repeat(32)}`;

const layerOrchestratorService = OrchestratorMcpService.layer.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

const scopeFor = (threadId: ThreadId): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:ft3-delegation"),
  requestNamespace: "provider-session:ft3-delegation",
  thread: {
    threadId,
    providerSessionId: "provider-session:ft3-delegation",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

const codexInstanceId = ProviderInstanceId.make("codex");
const codexDriver = ProviderDriverKind.make("codex");

const codexProvider: ServerProvider = {
  instanceId: codexInstanceId,
  driver: codexDriver,
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-13T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const adapterRegistryLayer = Layer.succeed(
  ProviderAdapterRegistry.ProviderAdapterRegistryV2,
  ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
    list: () => Effect.succeed([codexInstanceId]),
    get: (instanceId) =>
      instanceId === codexInstanceId
        ? Effect.succeed({ instanceId } as unknown as ProviderAdapter.ProviderAdapterV2["Service"])
        : Effect.fail(
            new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
          ),
  }),
);

const baseLayers = () =>
  Layer.mergeAll(
    NodeServices.layer,
    ServerSettings.layerTest(),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([codexProvider]),
    }),
    adapterRegistryLayer,
    Layer.mock(ProjectService.ProjectService)({}),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  );

describe("OrchestratorMcpService delegation text policy", () => {
  it.effect("rejects a delegated task that contains a credential", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:delegation-text-parent");
      const dispatched = yield* Ref.make(0);
      const parentProjection = {
        thread: {
          id: parentThreadId,
          projectId: ProjectId.make("project:delegation-text"),
          title: "Parent",
          modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        },
        runs: [
          {
            id: RunId.make("run:delegation-text-parent"),
            ordinal: 1,
            status: "running",
            rootNodeId: NodeId.make("node:delegation-text-root"),
            providerInstanceId: codexInstanceId,
            modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
          },
        ],
        contextTransfers: [],
        subagents: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        baseLayers(),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: () => Effect.succeed(parentProjection),
          dispatch: () => Ref.update(dispatched, (count) => count + 1).pipe(Effect.as({} as never)),
        }),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .delegateTask(scopeFor(parentThreadId), {
            task: `Use ${providerToken} for access.`,
            title: "Safe title",
            target: { providerInstanceId: codexInstanceId },
            mode: "async",
            clientRequestId: "delegate-secret-task",
          })
          .pipe(Effect.flip);
        assert.equal(error.code, "capability_denied");
        assert.isFalse(error.message.includes(providerToken));
        assert.equal(yield* Ref.get(dispatched), 0);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("rejects a delegated title that contains a credential", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:delegation-title-parent");
      const dispatched = yield* Ref.make(0);
      const parentProjection = {
        thread: {
          id: parentThreadId,
          projectId: ProjectId.make("project:delegation-title"),
          title: "Parent",
          modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        },
        runs: [
          {
            id: RunId.make("run:delegation-title-parent"),
            ordinal: 1,
            status: "running",
            rootNodeId: NodeId.make("node:delegation-title-root"),
            providerInstanceId: codexInstanceId,
            modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
          },
        ],
        contextTransfers: [],
        subagents: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        baseLayers(),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: () => Effect.succeed(parentProjection),
          dispatch: () => Ref.update(dispatched, (count) => count + 1).pipe(Effect.as({} as never)),
        }),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .delegateTask(scopeFor(parentThreadId), {
            task: "Summarize the parser changes.",
            title: `Incident ${providerToken}`,
            target: { providerInstanceId: codexInstanceId },
            mode: "async",
            clientRequestId: "delegate-secret-title",
          })
          .pipe(Effect.flip);
        assert.equal(error.code, "capability_denied");
        assert.equal(yield* Ref.get(dispatched), 0);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("redacts a delegated result in task_status without changing the canonical result", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:delegation-result-parent");
      const childThreadId = ThreadId.make("thread:delegation-result-child");
      const taskId = NodeId.make("node:delegation-result-task");
      const canonicalResult = `Report: ${providerToken}`;
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: codexDriver,
            model: "gpt-5.4",
            status: "completed",
            result: canonicalResult,
            completionDelivery: { state: "acknowledged" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId, title: "Child result" },
        runs: [
          {
            id: RunId.make("run:delegation-result-child"),
            ordinal: 1,
            status: "completed",
            delegatedTaskId: taskId,
          },
        ],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
        turnItems: [],
        nodes: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        baseLayers(),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: (threadId: ThreadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          dispatch: () => Effect.succeed({} as never),
        }),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.taskStatus(scopeFor(parentThreadId), taskId);
        assert.equal(result.summary, "Report: [REDACTED]");
        assert.isNull(result.latestTerminalSummary);
        assert.equal(parentProjection.subagents[0]!.result, canonicalResult);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("redacts a delegated result in readThread", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:delegation-read");
      const shell = liveThreadShell(threadId);
      const projection = idleThreadProjection(shell);
      const secretResult = `Report: ${providerToken}`;
      const layerDependencies = Layer.mergeAll(
        baseLayers(),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(projection),
          getThreadShell: () => Effect.succeed(shell as OrchestrationV2ThreadShell),
          getProjectThreadRecords: () => Effect.succeed(projection),
          getTimelinePage: () =>
            Effect.succeed({
              items: [
                {
                  position: 1,
                  visibility: "visible",
                  sourceThreadId: threadId,
                  sourceItemId: "item:delegation-read",
                  item: {
                    type: "subagent",
                    runId: null,
                    subagentId: "node:delegation-read-task",
                    status: "completed",
                    title: "Child result",
                    result: secretResult,
                    progress: null,
                    prompt: "Inspect the parser.",
                    updatedAt: shell.updatedAt,
                  },
                },
              ],
              hasMore: false,
              totalItems: 1,
            } as never),
        }),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.readThread(scopeFor(threadId), { threadId });
        const item = result.items[0];
        assert.equal(item?.type, "subagent");
        assert.equal(item?.text, "Report: [REDACTED]");
        assert.isFalse((item?.text ?? "").includes(providerToken));
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );
});

// @effect-diagnostics nodeBuiltinImport:off - tests write role files into a temporary directory.
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
  type OrchestratorMcpTaskRole,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { OrchestratorCommandRejectedError } from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const rolesDirEnv = "T3CODE_FT3_ROLES_DIR";

const makeRolesDir = (roles: ReadonlyArray<string>): string => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ft3-delegation-roles-"));
  for (const role of roles) NodeFS.writeFileSync(NodePath.join(dir, `${role}.md`), role);
  return dir;
};

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

const layerOrchestratorService = OrchestratorMcpService.layer.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

const scopeFor = (threadId: ThreadId): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:ft3-delegation-roles"),
  requestNamespace: "provider-session:ft3-delegation-roles",
  thread: {
    threadId,
    providerSessionId: "provider-session:ft3-delegation-roles",
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
      projectId: ProjectId.make("project:ft3-delegation-roles"),
      title: "Parent",
      modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
    },
    runs: [
      {
        id: RunId.make("run:ft3-delegation-roles-parent"),
        ordinal: 1,
        status: "running",
        rootNodeId: NodeId.make("node:ft3-delegation-roles-root"),
        providerInstanceId: codexInstanceId,
        modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
      },
    ],
    contextTransfers: [],
    subagents: [],
  }) as unknown as OrchestrationV2ThreadProjection;

type Dispatched = ReadonlyArray<{ readonly task: string; readonly role?: string }>;

const layerFor = (
  threadId: ThreadId,
  dispatched: Ref.Ref<Dispatched>,
  rolesDir: string | undefined,
) =>
  layerOrchestratorService.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([codexProvider]),
        }),
        adapterRegistryLayer,
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: () => Effect.succeed(parentProjection(threadId)),
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
          dispatch: (command: OrchestrationV2ServerCommand) =>
            Effect.gen(function* () {
              if (command.type === "delegated_task.request") {
                yield* Ref.update(dispatched, (entries) => [
                  ...entries,
                  {
                    task: command.task,
                    ...(command.role === undefined ? {} : { role: command.role }),
                  },
                ]);
              }
              return yield* new OrchestratorCommandRejectedError({
                commandId: command.commandId,
                commandType: command.type,
              });
            }),
        }),
      ),
    ),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv(
          rolesDir === undefined ? { env: {} } : { env: { [rolesDirEnv]: rolesDir } },
        ),
      ),
    ),
  );

const delegate = (
  threadId: ThreadId,
  dispatched: Ref.Ref<Dispatched>,
  rolesDir: string | undefined,
  input: { readonly task: string; readonly role?: OrchestratorMcpTaskRole },
) =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    return yield* service
      .delegateTask(scopeFor(threadId), {
        ...input,
        target: { providerInstanceId: codexInstanceId, model: "gpt-5.4" },
        mode: "async",
        clientRequestId: "delegate-roles",
      })
      .pipe(Effect.flip);
  }).pipe(Effect.provide(layerFor(threadId, dispatched, rolesDir)));

describe("OrchestratorMcpService delegation roles", () => {
  it.effect("keeps today's prompt while the roles directory is unset", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:ft3-roles-off");
      const dispatched = yield* Ref.make<Dispatched>([]);
      const error = yield* delegate(threadId, dispatched, undefined, { task: "Fix the parser." });
      assert.equal(error.code, "orchestration_error");
      const entries = yield* Ref.get(dispatched);
      assert.deepStrictEqual(entries, [{ task: "Fix the parser." }]);
    }),
  );

  it.effect("sends the general role line when the caller names no role", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:ft3-roles-default");
      const dispatched = yield* Ref.make<Dispatched>([]);
      const dir = makeRolesDir(["general", "lead"]);
      yield* delegate(threadId, dispatched, dir, { task: "Fix the parser." });
      const [entry] = yield* Ref.get(dispatched);
      assert.equal(entry!.role, "general");
      assert.isTrue(
        entry!.task.startsWith(
          `Your role is general. Before any work, read the whole file ${dir.replace(/\\/g, "/")}/general.md and follow it.`,
        ),
      );
      assert.include(entry!.task, "Fix the parser.");
    }),
  );

  it.effect("sends the named role's instruction first", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:ft3-roles-lead");
      const dispatched = yield* Ref.make<Dispatched>([]);
      const dir = makeRolesDir(["general", "lead"]);
      yield* delegate(threadId, dispatched, dir, { task: "Run the wave.", role: "lead" });
      const [entry] = yield* Ref.get(dispatched);
      assert.equal(entry!.role, "lead");
      assert.isTrue(
        entry!.task.startsWith(
          `Your role is lead. Before any work, read the whole file ${dir.replace(/\\/g, "/")}/lead.md and follow it.`,
        ),
      );
    }),
  );

  it.effect("accepts planner and resolves architecture to architect.md", () =>
    Effect.gen(function* () {
      const dir = makeRolesDir(["architect", "planner"]);
      const plannerThread = ThreadId.make("thread:ft3-roles-planner");
      const plannerDispatched = yield* Ref.make<Dispatched>([]);
      yield* delegate(plannerThread, plannerDispatched, dir, {
        task: "Write the plan.",
        role: "planner",
      });
      const [planner] = yield* Ref.get(plannerDispatched);
      assert.equal(planner!.role, "planner");
      assert.isTrue(
        planner!.task.startsWith(
          `Your role is planner. Before any work, read the whole file ${dir.replace(/\\/g, "/")}/planner.md and follow it.`,
        ),
      );

      const architectThread = ThreadId.make("thread:ft3-roles-architecture");
      const architectDispatched = yield* Ref.make<Dispatched>([]);
      yield* delegate(architectThread, architectDispatched, dir, {
        task: "Advise on the schema.",
        role: "architecture",
      });
      const [architect] = yield* Ref.get(architectDispatched);
      assert.equal(architect!.role, "architecture");
      assert.isTrue(
        architect!.task.startsWith(
          `Your role is architect. Before any work, read the whole file ${dir.replace(/\\/g, "/")}/architect.md and follow it.`,
        ),
      );
    }),
  );

  it.effect("rejects a role id without a role file and lists the available roles", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:ft3-roles-missing");
      const dispatched = yield* Ref.make<Dispatched>([]);
      const dir = makeRolesDir(["general", "lead", "review-common"]);
      const error = yield* delegate(threadId, dispatched, dir, {
        task: "Design the schema.",
        role: "architect-data",
      });
      assert.equal(error.code, "invalid_request");
      assert.include(error.message, "architect-data.md");
      assert.include(error.message, "review-common");
      assert.deepStrictEqual(yield* Ref.get(dispatched), []);
    }),
  );

  it.effect("rejects a roles-only role id while the roles directory is unset", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:ft3-roles-off-rejected");
      const dispatched = yield* Ref.make<Dispatched>([]);
      const error = yield* delegate(threadId, dispatched, undefined, {
        task: "Run the wave.",
        role: "lead",
      });
      assert.equal(error.code, "invalid_request");
      assert.include(error.message, rolesDirEnv);
      assert.deepStrictEqual(yield* Ref.get(dispatched), []);
    }),
  );
});

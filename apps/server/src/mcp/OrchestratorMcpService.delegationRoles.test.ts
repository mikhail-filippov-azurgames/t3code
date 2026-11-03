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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { layerMemory as policyAppliedStoreLayer } from "../../../../packages/ft3-policies/src/policyAppliedStore.ts";
import {
  PolicyChangeTracker,
  layer as policyChangeTrackerLayer,
} from "../../../../packages/ft3-policies/src/policyChangeTracker.ts";
import { layer as policyDocumentLoaderLayer } from "../../../../packages/ft3-policies/src/policyDocumentLoader.ts";
import { memoryPolicyDocumentPort } from "../../../../packages/ft3-policies/src/policyDocuments.testkit.ts";
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

const ROLES_MANIFEST_PATH = "policies/roles/roles.json";

const manifest = (roles: ReadonlyArray<{ id: string; roleId: string; upstreamRole?: string }>) =>
  [
    "{",
    '  "schema": "corvis-role-map-v1",',
    '  "revision": 1,',
    '  "configured": true,',
    '  "roles": [',
    roles
      .map(
        (role) =>
          `    { "id": "${role.id}", "roleId": "${role.roleId}", "file": "${role.roleId}.md"${
            role.upstreamRole === undefined ? "" : `, "upstreamRole": "${role.upstreamRole}"`
          } }`,
      )
      .join(",\n"),
    "  ]",
    "}",
    "",
  ].join("\n");

const roleFile = (roleId: string, body: string): string =>
  [
    "---",
    "schema: corvis-role-v1",
    `roleId: ${roleId}`,
    "revision: 1",
    "configured: true",
    "---",
    "",
    body,
    "",
  ].join("\n");

/** An applied roles document: the general role plus the roles each case names. */
const appliedRoles = (
  roles: ReadonlyArray<{ id: string; roleId: string; upstreamRole?: string; body: string }>,
): ReadonlyMap<string, string> => {
  const files = new Map<string, string>();
  files.set(ROLES_MANIFEST_PATH, manifest(roles));
  for (const role of roles) {
    files.set(`policies/roles/${role.roleId}.md`, roleFile(role.roleId, role.body));
  }
  return files;
};

const rolesSource = {
  routingPolicy: { kind: "builtin" },
  roles: { kind: "doc", address: { kind: "path", relPath: ROLES_MANIFEST_PATH } },
  leadSkills: { kind: "builtin" },
} as const;

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

const trackerLayerFor = (files: ReadonlyMap<string, string>) =>
  policyChangeTrackerLayer.pipe(
    Layer.provide(policyDocumentLoaderLayer(memoryPolicyDocumentPort(files))),
    Layer.provide(policyAppliedStoreLayer),
  );

type TestSettings = Parameters<typeof ServerSettings.layerTest>[0];

const layerFor = (
  threadId: ThreadId,
  dispatched: Ref.Ref<Dispatched>,
  applied: ReadonlyMap<string, string> | undefined,
  settings?: TestSettings,
) =>
  Layer.mergeAll(
    layerOrchestratorService.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          ServerSettings.layerTest(settings),
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
    ),
    applied === undefined ? Layer.empty : trackerLayerFor(applied),
  );

const delegate = (
  threadId: ThreadId,
  dispatched: Ref.Ref<Dispatched>,
  applied: ReadonlyMap<string, string> | undefined,
  input: { readonly task: string; readonly role?: OrchestratorMcpTaskRole },
  settings?: TestSettings,
) =>
  Effect.gen(function* () {
    const tracker = yield* Effect.serviceOption(PolicyChangeTracker);
    if (Option.isSome(tracker)) {
      yield* tracker.value.refresh({ sources: rolesSource, features: { board: true } });
    }
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    return yield* service
      .delegateTask(scopeFor(threadId), {
        ...input,
        target: { providerInstanceId: codexInstanceId, model: "gpt-5.4" },
        mode: "async",
        clientRequestId: "delegate-roles",
      })
      .pipe(Effect.flip);
  }).pipe(Effect.provide(layerFor(threadId, dispatched, applied, settings)));

describe("OrchestratorMcpService delegation roles", () => {
  it.effect("refuses a delegated role with mail_required while mail is on", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:ft3-mail-required");
      const dispatched = yield* Ref.make<Dispatched>([]);
      const error = yield* delegate(
        threadId,
        dispatched,
        undefined,
        { task: "Fix the parser.", role: "implementation" },
        { ft3: { policies: { features: { roles: true, board: true, mail: true } } } },
      );
      assert.equal(error.code, "mail_required");
      assert.deepStrictEqual(yield* Ref.get(dispatched), []);
    }),
  );

  it.effect("keeps today's prompt while no roles document is applied", () =>
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
      const applied = appliedRoles([
        { id: "general", roleId: "general", upstreamRole: "general", body: "# General\n\nDo it." },
        { id: "lead", roleId: "lead", body: "# Lead\n\nOwn it." },
      ]);
      yield* delegate(threadId, dispatched, applied, { task: "Fix the parser." });
      const [entry] = yield* Ref.get(dispatched);
      assert.equal(entry!.role, "general");
      assert.isTrue(
        entry!.task.startsWith(
          "Your role is general. Follow this role instruction before any work.\n\n# General\n\nDo it.",
        ),
      );
      assert.include(entry!.task, "Fix the parser.");
    }),
  );

  it.effect("sends the named role's instruction first", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:ft3-roles-lead");
      const dispatched = yield* Ref.make<Dispatched>([]);
      const applied = appliedRoles([
        { id: "general", roleId: "general", upstreamRole: "general", body: "# General\n\nDo it." },
        { id: "lead", roleId: "lead", body: "# Lead\n\nOwn the wave." },
      ]);
      yield* delegate(threadId, dispatched, applied, { task: "Run the wave.", role: "lead" });
      const [entry] = yield* Ref.get(dispatched);
      assert.equal(entry!.role, "lead");
      assert.isTrue(
        entry!.task.startsWith(
          "Your role is lead. Follow this role instruction before any work.\n\n# Lead\n\nOwn the wave.",
        ),
      );
    }),
  );

  it.effect("accepts planner and resolves architecture to the architect role", () =>
    Effect.gen(function* () {
      const applied = appliedRoles([
        { id: "lead", roleId: "lead", body: "# Lead\n\nOwn the wave." },
        { id: "planner", roleId: "planner", body: "# Planner\n\nWrite the plan." },
        {
          id: "architect",
          roleId: "architect",
          upstreamRole: "architecture",
          body: "# Architect\n\nAdvise once.",
        },
      ]);
      const plannerThread = ThreadId.make("thread:ft3-roles-planner");
      const plannerDispatched = yield* Ref.make<Dispatched>([]);
      yield* delegate(plannerThread, plannerDispatched, applied, {
        task: "Write the plan.",
        role: "planner",
      });
      const [planner] = yield* Ref.get(plannerDispatched);
      assert.equal(planner!.role, "planner");
      assert.isTrue(
        planner!.task.startsWith(
          "Your role is planner. Follow this role instruction before any work.\n\n# Planner\n\nWrite the plan.",
        ),
      );

      const architectThread = ThreadId.make("thread:ft3-roles-architecture");
      const architectDispatched = yield* Ref.make<Dispatched>([]);
      yield* delegate(architectThread, architectDispatched, applied, {
        task: "Advise on the schema.",
        role: "architecture",
      });
      const [architect] = yield* Ref.get(architectDispatched);
      assert.equal(architect!.role, "architecture");
      assert.isTrue(
        architect!.task.startsWith(
          "Your role is architect. Follow this role instruction before any work.\n\n# Architect\n\nAdvise once.",
        ),
      );
    }),
  );

  it.effect("rejects a role id the applied document does not declare", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:ft3-roles-missing");
      const dispatched = yield* Ref.make<Dispatched>([]);
      const applied = appliedRoles([
        { id: "general", roleId: "general", upstreamRole: "general", body: "# General\n\nDo it." },
        { id: "review", roleId: "review-common", upstreamRole: "review", body: "# Review." },
      ]);
      const error = yield* delegate(threadId, dispatched, applied, {
        task: "Design the schema.",
        role: "architect-data",
      });
      assert.equal(error.code, "invalid_request");
      assert.include(error.message, "architect-data");
      assert.include(error.message, "review");
      assert.deepStrictEqual(yield* Ref.get(dispatched), []);
    }),
  );

  it.effect("rejects a roles-only role id while no roles document is applied", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:ft3-roles-off-rejected");
      const dispatched = yield* Ref.make<Dispatched>([]);
      const error = yield* delegate(threadId, dispatched, undefined, {
        task: "Run the wave.",
        role: "lead",
      });
      assert.equal(error.code, "invalid_request");
      assert.include(error.message, "needs a configured roles document");
      assert.deepStrictEqual(yield* Ref.get(dispatched), []);
    }),
  );
});

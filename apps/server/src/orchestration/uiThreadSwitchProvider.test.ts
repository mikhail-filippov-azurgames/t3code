import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type OrchestratorMcpSwitchProviderInput,
  type OrchestratorMcpSwitchProviderResult,
  type ProviderInstanceConfig,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import type { OrchestratorMcpDependencies } from "../mcp/toolkits/orchestrator/service.ts";
import { normalizeDelegationPermissionEnvelope } from "../provider/DelegationPermissionEnvelope.ts";
import {
  handleUiThreadSwitchProvider,
  type UiThreadSwitchProviderCommand,
} from "./uiThreadSwitchProvider.ts";

const now = "2026-09-14T10:00:00.000Z";
const childThreadId = ThreadId.make("delegated-child");
const parentThreadId = ThreadId.make("parent-thread");
const projectId = ProjectId.make("project-one");
const parentEnvironmentId = "environment-one";
const providerInstanceId = ProviderInstanceId.make("codex_one");
const targetInstanceId = ProviderInstanceId.make("codex_two");
const driverKind = ProviderDriverKind.make("codex");
const workspaceRoot = "C:/repo";

const instanceConfig: ProviderInstanceConfig = {
  driver: driverKind,
  enabled: true,
  config: { binaryPath: "codex", launchArgs: "" },
};

const provider = {
  instanceId: providerInstanceId,
  driver: driverKind,
  displayName: "Codex work",
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  availability: "available",
  version: "1.0.0",
  checkedAt: now,
  models: [{ slug: "gpt-test", name: "GPT Test", isCustom: false }],
} as unknown as ServerProvider;

const settings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: { [providerInstanceId]: instanceConfig },
} satisfies ServerSettings;

function parentShell(): OrchestrationThreadShell {
  return {
    id: parentThreadId,
    projectId,
    title: "Parent",
    modelSelection: { instanceId: providerInstanceId, model: "gpt-test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    latestTurn: null,
    session: {
      threadId: parentThreadId,
      status: "running",
      providerName: "codex",
      providerInstanceId,
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: now,
    },
  } as OrchestrationThreadShell;
}

const project = {
  id: projectId,
  title: "Project",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: now,
  updatedAt: now,
} as OrchestrationProjectShell;

function childShell(): OrchestrationThreadShell {
  return {
    id: childThreadId,
    projectId,
    title: "Child",
    modelSelection: { instanceId: providerInstanceId, model: "gpt-test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    latestTurn: null,
    session: null,
    delegationParent: {
      parentThreadId,
      parentEnvironmentId,
      role: "implementation",
    },
  } as OrchestrationThreadShell;
}

function ordinaryShell(): OrchestrationThreadShell {
  return {
    id: childThreadId,
    projectId,
    title: "Ordinary",
    modelSelection: { instanceId: providerInstanceId, model: "gpt-test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    latestTurn: null,
    session: {
      threadId: childThreadId,
      status: "running",
      providerName: "codex",
      providerInstanceId,
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: now,
    },
  } as OrchestrationThreadShell;
}

const command: UiThreadSwitchProviderCommand = {
  type: "thread.switch-provider",
  commandId: CommandId.make("switch-command"),
  threadId: childThreadId,
  target: {
    providerInstanceId: targetInstanceId,
    driverKind,
    model: "gpt-test",
  },
  reason: "quota exhausted",
};

const unused = () => Effect.die(new Error("unused dependency")) as never;

function makeDependencies(shells: ReadonlyMap<ThreadId, OrchestrationThreadShell>) {
  const dependencies: OrchestratorMcpDependencies = {
    dispatch: unused,
    subscribeDomainEvents: Effect.die(
      new Error("unused dependency"),
    ) as OrchestratorMcpDependencies["subscribeDomainEvents"],
    getThreadShellById: (threadId) => {
      const shell = shells.get(threadId);
      return Effect.succeed(shell === undefined ? Option.none() : Option.some(shell));
    },
    getProjectShellById: (requestedProjectId) =>
      Effect.succeed(requestedProjectId === projectId ? Option.some(project) : Option.none()),
    getThreadDetailById: unused,
    listTurnsByThreadId: unused,
    getProviders: Effect.succeed([provider]),
    getSettings: Effect.succeed(settings),
    loadPermissionEnvelope: (input) =>
      Effect.succeed(
        normalizeDelegationPermissionEnvelope({
          ...input,
          environment: {},
          providerConfigurationFiles: [],
        }),
      ),
    now: Effect.succeed(now),
  };
  return dependencies;
}

interface SeenSwitch {
  readonly scope: McpInvocationScope;
  readonly input: OrchestratorMcpSwitchProviderInput;
}

describe("handleUiThreadSwitchProvider", () => {
  it.effect("builds a parent-owned scope and delegates to the engine switch", () =>
    Effect.gen(function* () {
      const dependencies = makeDependencies(
        new Map([
          [childThreadId, childShell()],
          [parentThreadId, parentShell()],
        ]),
      );
      const seen: Array<SeenSwitch> = [];
      const canned = { taskId: childThreadId } as OrchestratorMcpSwitchProviderResult;
      const result = yield* handleUiThreadSwitchProvider(dependencies, command, {
        switchProvider: (scope, input) =>
          Effect.sync(() => {
            seen.push({ scope, input });
            return canned;
          }),
      });

      expect(result).toBe(canned);
      expect(seen).toHaveLength(1);
      const first = seen[0]!;
      expect(first.scope.threadId).toBe(parentThreadId);
      expect(String(first.scope.environmentId)).toBe(parentEnvironmentId);
      expect(first.scope.capabilities.has("orchestration")).toBe(true);
      expect(first.scope.orchestration?.projectId).toBe(projectId);
      expect(first.scope.orchestration?.permissionEnvelope.status).toBe("verified");
      expect(first.scope.issuedAt).toBe(Date.parse(now));
      expect(first.input).toEqual({
        taskId: childThreadId,
        target: command.target,
        reason: command.reason,
      });
    }),
  );

  it.effect("reports a non-delegated thread as not found", () =>
    Effect.gen(function* () {
      const dependencies = makeDependencies(
        new Map([
          [childThreadId, { ...childShell(), delegationParent: null }],
          [parentThreadId, parentShell()],
        ]),
      );
      const error = yield* handleUiThreadSwitchProvider(dependencies, command).pipe(Effect.flip);

      expect(error).toBeInstanceOf(OrchestratorMcpFailure);
      expect(error.code).toBe("task_not_found");
    }),
  );

  it.effect("builds a thread-owned scope for an ordinary thread with a session", () =>
    Effect.gen(function* () {
      const serverEnvironmentId = EnvironmentId.make("server-environment");
      const dependencies = makeDependencies(new Map([[childThreadId, ordinaryShell()]]));
      const seen: Array<SeenSwitch> = [];
      const canned = { taskId: childThreadId } as OrchestratorMcpSwitchProviderResult;
      const result = yield* handleUiThreadSwitchProvider(
        dependencies,
        command,
        {
          switchProvider: (scope, input) =>
            Effect.sync(() => {
              seen.push({ scope, input });
              return canned;
            }),
        },
        { serverEnvironmentId },
      );

      expect(result).toBe(canned);
      expect(seen).toHaveLength(1);
      const first = seen[0]!;
      expect(first.scope.threadId).toBe(childThreadId);
      expect(String(first.scope.environmentId)).toBe("server-environment");
      expect(first.scope.providerInstanceId).toBe(providerInstanceId);
      expect(first.scope.capabilities.has("orchestration")).toBe(true);
      expect(first.scope.orchestration?.projectId).toBe(projectId);
      expect(first.scope.orchestration?.permissionEnvelope.status).toBe("verified");
      expect(first.scope.issuedAt).toBe(Date.parse(now));
      expect(first.input).toEqual({
        taskId: childThreadId,
        target: command.target,
        reason: command.reason,
      });
    }),
  );

  it.effect("refuses an ordinary switch without a serving environment", () =>
    Effect.gen(function* () {
      const dependencies = makeDependencies(new Map([[childThreadId, ordinaryShell()]]));
      const error = yield* handleUiThreadSwitchProvider(dependencies, command).pipe(Effect.flip);

      expect(error).toBeInstanceOf(OrchestratorMcpFailure);
      expect(error.code).toBe("orchestration_error");
    }),
  );

  it.effect("propagates the engine failure code untouched", () =>
    Effect.gen(function* () {
      const dependencies = makeDependencies(
        new Map([
          [childThreadId, childShell()],
          [parentThreadId, parentShell()],
        ]),
      );
      const error = yield* handleUiThreadSwitchProvider(dependencies, command, {
        switchProvider: () =>
          Effect.fail(
            new OrchestratorMcpFailure({
              code: "provider_handoff_unsupported",
              message: "target cannot accept the handoff",
            }),
          ),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(OrchestratorMcpFailure);
      expect(error.code).toBe("provider_handoff_unsupported");
      expect(error.message).toBe("target cannot accept the handoff");
    }),
  );

  it.effect("tags a gone parent with the engine reason token", () =>
    Effect.gen(function* () {
      const dependencies = makeDependencies(new Map([[childThreadId, childShell()]]));
      const error = yield* handleUiThreadSwitchProvider(dependencies, command).pipe(Effect.flip);

      expect(error).toBeInstanceOf(OrchestratorMcpFailure);
      expect(error.code).toBe("parent_not_active");
      expect(error.message).toContain("[reason=parent_thread_gone]");
    }),
  );
});

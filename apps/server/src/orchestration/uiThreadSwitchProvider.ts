import {
  EnvironmentId,
  OrchestratorMcpFailure,
  type ClientOrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type OrchestratorMcpPermissionEnvelopeSummary,
  type OrchestratorMcpSwitchProviderResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { McpCapability, McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import {
  createOrchestratorMcpService,
  type OrchestratorMcpDependencies,
  type OrchestratorMcpServiceShape,
} from "../mcp/toolkits/orchestrator/service.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";

export type UiThreadSwitchProviderCommand = Extract<
  ClientOrchestrationCommand,
  { readonly type: "thread.switch-provider" }
>;

export interface UiThreadSwitchProviderOptions {
  /**
   * The serving environment, for an ordinary-thread switch whose scope is
   * the thread itself (delegated switches take it from the lineage). The WS
   * dispatch handler supplies its own server environment id.
   */
  readonly serverEnvironmentId?: EnvironmentId | undefined;
}

/**
 * Capabilities a UI-initiated switch acts with. UI callers are authorized by
 * the operate scope (they can already run any provider via turn.start), not
 * by per-tool MCP grants — so the caller parent envelope is computed with
 * the full set. The delegated target envelope is never built from this set:
 * the engine anchors it to the delegation's canonical frozen child caps and
 * the original target envelope, so a broader UI surface cannot smuggle new
 * rights into the child.
 */
const UI_SWITCH_MCP_CAPABILITIES: ReadonlySet<McpCapability> = new Set<McpCapability>([
  "preview",
  "device",
  "pull-requests",
  "orchestration",
]);

const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);

function failure(code: OrchestratorMcpFailure["code"], message: string): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({ code, message });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { readonly message: unknown }).message);
  }
  return String(error);
}

function asOrchestrationFailure(operation: string) {
  return (error: unknown) =>
    isOrchestratorMcpFailure(error)
      ? error
      : failure("orchestration_error", `Could not ${operation}: ${errorMessage(error)}`);
}

// Every parent_not_active refusal carries a stable [reason=...] token, using
// the same wording as the engine so agents and the UI handle both uniformly.
const parentNotActive = (reason: string, message: string, hint: string) =>
  failure("parent_not_active", `${message} [reason=${reason}] ${hint}`);

/**
 * Synthesize the MCP invocation scope the engine `switchProvider` requires
 * from live thread/project shells. The caller slice is rebuilt from the
 * parent's current state (so the drift check passes by construction — the
 * UI just read this state); it carries caller authority only and is never
 * the frozen delegation authority. Lineage ownership, capability gates, the
 * canonical child caps, and the original-target anchor stay inside the
 * engine.
 *
 * Parent authority for the permission comparison is the parent thread's
 * current session provider, falling back to its stored model selection when
 * the parent is idle. When neither resolves, the parent envelope stays
 * unverifiable and the engine refuses with provider_handoff_unsupported.
 * For an ordinary thread the "parent" is the thread itself; the scope
 * thread id is then the switched thread id.
 */
const loadScopePermissionEnvelope = Effect.fn("UiThreadSwitchProvider.loadScopePermissionEnvelope")(
  function* (
    dependencies: OrchestratorMcpDependencies,
    input: {
      readonly scopeThread: OrchestrationThreadShell;
      readonly project: OrchestrationProjectShell;
      readonly worktreePath: string;
      readonly authorityInstanceId: OrchestrationThreadShell["modelSelection"]["instanceId"];
    },
  ) {
    const providers = yield* dependencies.getProviders.pipe(
      Effect.mapError(asOrchestrationFailure("read providers")),
    );
    const provider = providers.find(
      (candidate) => candidate.instanceId === input.authorityInstanceId,
    );
    const settings = yield* dependencies.getSettings;
    const instanceConfig = deriveProviderInstanceConfigMap(settings)[input.authorityInstanceId];
    if (
      provider === undefined ||
      instanceConfig === undefined ||
      instanceConfig.driver !== provider.driver
    ) {
      return {
        status: "unverifiable" as const,
        reason: `Parent provider instance ${input.authorityInstanceId} has no matching effective configuration.`,
      };
    }
    return yield* dependencies
      .loadPermissionEnvelope({
        driverKind: provider.driver,
        runtimeMode: input.scopeThread.runtimeMode,
        interactionMode: input.scopeThread.interactionMode,
        instanceConfig,
        environment: process.env,
        workspaceRoot: input.project.workspaceRoot,
        worktreePath: input.worktreePath,
        branch: input.scopeThread.branch,
        t3McpCapabilities: UI_SWITCH_MCP_CAPABILITIES,
      })
      .pipe(Effect.mapError(asOrchestrationFailure("read parent permission envelope")));
  },
);

const buildUiSwitchScope = Effect.fn("UiThreadSwitchProvider.buildScope")(function* (
  dependencies: OrchestratorMcpDependencies,
  command: UiThreadSwitchProviderCommand,
  options?: UiThreadSwitchProviderOptions,
) {
  const threadOption = yield* dependencies
    .getThreadShellById(command.threadId)
    .pipe(Effect.mapError(asOrchestrationFailure(`read thread ${command.threadId}`)));
  if (threadOption._tag === "None") {
    return yield* failure("task_not_found", "The delegated task was not found.");
  }
  const switched = threadOption.value;
  const delegationParent = switched.delegationParent ?? null;
  if (delegationParent === null) {
    return yield* buildOrdinaryThreadScope(dependencies, command, switched, options);
  }
  const parentOption = yield* dependencies
    .getThreadShellById(delegationParent.parentThreadId)
    .pipe(
      Effect.mapError(asOrchestrationFailure(`read thread ${delegationParent.parentThreadId}`)),
    );
  if (parentOption._tag === "None") {
    return yield* parentNotActive(
      "parent_thread_gone",
      "The parent thread no longer exists.",
      "Do not retry delegation; report reason parent_thread_gone.",
    );
  }
  const parent = parentOption.value;
  const projectOption = yield* dependencies
    .getProjectShellById(parent.projectId)
    .pipe(Effect.mapError(asOrchestrationFailure(`read project ${parent.projectId}`)));
  if (projectOption._tag === "None") {
    return yield* parentNotActive(
      "parent_project_gone",
      "The parent project no longer exists.",
      "Do not retry delegation; report reason parent_project_gone.",
    );
  }
  const project = projectOption.value;
  const worktreePath = parent.worktreePath ?? project.workspaceRoot;
  const authorityInstanceId =
    parent.session?.providerInstanceId ?? parent.modelSelection.instanceId;
  const permissionEnvelope = yield* loadScopePermissionEnvelope(dependencies, {
    scopeThread: parent,
    project,
    worktreePath,
    authorityInstanceId,
  });
  // The issued-at instant comes from the engine clock dependency (an ISO
  // timestamp), not a direct clock read, so tests can pin it.
  const issuedAt = Date.parse(yield* dependencies.now);
  return {
    environmentId: EnvironmentId.make(delegationParent.parentEnvironmentId),
    threadId: delegationParent.parentThreadId,
    providerSessionId: `ui-switch-provider:${command.commandId}`,
    providerInstanceId: authorityInstanceId,
    capabilities: UI_SWITCH_MCP_CAPABILITIES,
    orchestration: {
      projectId: parent.projectId,
      runtimeMode: parent.runtimeMode,
      interactionMode: parent.interactionMode,
      branch: parent.branch,
      workspaceRoot: project.workspaceRoot,
      worktreePath,
      permissionEnvelope,
    },
    issuedAt,
  };
});

/**
 * Scope for an ordinary (non-delegated) thread switch: the scope is the
 * thread itself. A provider session is required — without one the engine
 * has no provider to switch from, and the thread stays hidden behind
 * task_not_found exactly like a non-delegated thread the engine cannot
 * serve. History, target, and capability checks stay entirely inside the
 * engine.
 */
const buildOrdinaryThreadScope = Effect.fn("UiThreadSwitchProvider.buildOrdinaryScope")(function* (
  dependencies: OrchestratorMcpDependencies,
  command: UiThreadSwitchProviderCommand,
  thread: OrchestrationThreadShell,
  options?: UiThreadSwitchProviderOptions,
) {
  if (thread.session === null || thread.session === undefined) {
    return yield* failure("task_not_found", "The delegated task was not found.");
  }
  const serverEnvironmentId = options?.serverEnvironmentId;
  if (serverEnvironmentId === undefined) {
    return yield* failure(
      "orchestration_error",
      "Could not determine the server environment for this thread.",
    );
  }
  const projectOption = yield* dependencies
    .getProjectShellById(thread.projectId)
    .pipe(Effect.mapError(asOrchestrationFailure(`read project ${thread.projectId}`)));
  if (projectOption._tag === "None") {
    return yield* parentNotActive(
      "parent_project_gone",
      "The parent project no longer exists.",
      "Do not retry delegation; report reason parent_project_gone.",
    );
  }
  const project = projectOption.value;
  const worktreePath = thread.worktreePath ?? project.workspaceRoot;
  const authorityInstanceId = thread.session.providerInstanceId ?? thread.modelSelection.instanceId;
  const permissionEnvelope = yield* loadScopePermissionEnvelope(dependencies, {
    scopeThread: thread,
    project,
    worktreePath,
    authorityInstanceId,
  });
  const issuedAt = Date.parse(yield* dependencies.now);
  return {
    environmentId: serverEnvironmentId,
    threadId: command.threadId,
    providerSessionId: `ui-switch-provider:${command.commandId}`,
    providerInstanceId: authorityInstanceId,
    capabilities: UI_SWITCH_MCP_CAPABILITIES,
    orchestration: {
      projectId: thread.projectId,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      branch: thread.branch,
      workspaceRoot: project.workspaceRoot,
      worktreePath,
      permissionEnvelope,
    },
    issuedAt,
  };
});

/**
 * Serve a UI `thread.switch-provider` dispatch command with the existing
 * orchestrator `switchProvider` engine — capability checks, ownership
 * checks, and failure codes included. Delegated threads switch through
 * their parent scope; ordinary threads with a provider session switch
 * through their own scope (no lineage). Engine failures propagate untouched
 * so their codes (provider_handoff_unsupported, thread_has_no_history, …)
 * reach the UI structurally.
 */
export const handleUiThreadSwitchProvider = Effect.fn("UiThreadSwitchProvider.handle")(function* (
  dependencies: OrchestratorMcpDependencies,
  command: UiThreadSwitchProviderCommand,
  serviceOverride?: Pick<OrchestratorMcpServiceShape, "switchProvider">,
  options?: UiThreadSwitchProviderOptions,
) {
  const scope = yield* buildUiSwitchScope(dependencies, command, options);
  const service = serviceOverride ?? createOrchestratorMcpService(dependencies);
  return yield* service.switchProvider(scope, {
    taskId: command.threadId,
    target: command.target,
    reason: command.reason,
  });
});

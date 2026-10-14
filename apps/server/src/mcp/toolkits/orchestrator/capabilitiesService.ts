import {
  EXECUTOR_ROLES,
  ORCHESTRATOR_MCP_DEFAULT_WAIT_TIMEOUT_MS,
  ORCHESTRATOR_MCP_MAX_WAIT_TIMEOUT_MS,
  ORCHESTRATOR_MCP_PROTOCOL_VERSION,
  OrchestratorMcpFailure,
  type OrchestratorMcpCapabilitiesResult,
  type OrchestratorMcpProviderCapability,
  type ProviderInstanceConfigMap,
  type ServerProvider,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { deriveProviderInstanceConfigMap } from "../../../provider/Layers/ProviderInstanceRegistryHydration.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import type { ControlPlaneCaller, ParentContext } from "./delegationService.ts";

interface CapabilitiesServiceDependencies {
  readonly getProviders: ProviderRegistry.ProviderRegistryShape["getProviders"];
  readonly getSettings: Effect.Effect<ServerSettingsValue, OrchestratorMcpFailure>;
  readonly requireActiveParent: (
    scope: McpInvocationScope,
  ) => Effect.Effect<ParentContext, OrchestratorMcpFailure>;
  readonly resolveControlPlaneCaller: (
    scope: McpInvocationScope,
  ) => Effect.Effect<ControlPlaneCaller, OrchestratorMcpFailure>;
  readonly denyArchitectCaller: (
    caller: ControlPlaneCaller,
    operation: string,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly providerCapability: (
    scope: McpInvocationScope,
    parent: ParentContext,
    providerInstances: ProviderInstanceConfigMap,
    provider: ServerProvider,
  ) => Effect.Effect<OrchestratorMcpProviderCapability, OrchestratorMcpFailure>;
  readonly isOrchestratorMcpFailure: (value: unknown) => value is OrchestratorMcpFailure;
  readonly orchestrationFailure: (operation: string) => (error: unknown) => OrchestratorMcpFailure;
}

interface CapabilitiesServiceShape {
  readonly capabilities: (
    scope: McpInvocationScope,
  ) => Effect.Effect<OrchestratorMcpCapabilitiesResult, OrchestratorMcpFailure>;
}

export function makeCapabilitiesService(
  dependencies: CapabilitiesServiceDependencies,
): CapabilitiesServiceShape {
  const {
    getProviders,
    getSettings,
    requireActiveParent,
    resolveControlPlaneCaller,
    denyArchitectCaller,
    providerCapability,
    isOrchestratorMcpFailure,
    orchestrationFailure,
  } = dependencies;

  return {
    capabilities: (scope) =>
      Effect.gen(function* () {
        yield* denyArchitectCaller(
          yield* resolveControlPlaneCaller(scope),
          "read orchestration capabilities",
        );
        const parent = yield* requireActiveParent(scope);
        const providers = yield* getProviders;
        const settings = yield* getSettings;
        const providerInstances = deriveProviderInstanceConfigMap(settings);
        return {
          protocolVersion: ORCHESTRATOR_MCP_PROTOCOL_VERSION,
          parent: {
            environmentId: scope.environmentId,
            threadId: scope.threadId,
            turnId: parent.activeTurnId,
            projectId: parent.thread.projectId,
            runtimeMode: parent.thread.runtimeMode,
            interactionMode: parent.thread.interactionMode,
            branch: parent.thread.branch,
            worktreePath: parent.scope.worktreePath,
            permissionEnvelope: parent.scope.permissionEnvelope,
          },
          roles: EXECUTOR_ROLES,
          wait: {
            defaultTimeoutMs: ORCHESTRATOR_MCP_DEFAULT_WAIT_TIMEOUT_MS,
            maxTimeoutMs: ORCHESTRATOR_MCP_MAX_WAIT_TIMEOUT_MS,
          },
          providers: yield* Effect.forEach(providers, (provider) =>
            providerCapability(scope, parent, providerInstances, provider),
          ),
          workspacePolicy: "inherit-only",
          oclPolicy: "optional-stable-ref-plus-durable-handoff",
        } satisfies OrchestratorMcpCapabilitiesResult;
      }).pipe(
        Effect.mapError((error) =>
          isOrchestratorMcpFailure(error)
            ? error
            : orchestrationFailure("read orchestration capabilities")(error),
        ),
      ),
  };
}

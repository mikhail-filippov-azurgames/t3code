import {
  CommandId,
  EventId,
  MessageId,
  ORCHESTRATOR_MCP_DEFAULT_WAIT_TIMEOUT_MS,
  OrchestratorMcpFailure,
  OrchestratorMcpRequestedIdentity,
  OrchestratorMcpSendToTaskResult,
  ProjectId,
  ThreadId,
  type AgentRunOrigin,
  type CoordinatorArchitectBinding,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  type OrchestratorMcpFailureCode,
  type OrchestratorMcpHandoff,
  type OrchestratorMcpPermissionEnvelopeSummary,
  type OrchestratorMcpSendToTaskInput,
  type OrchestratorMcpTaskResult,
  type OrchestratorMcpTaskWaitResult,
  type ProviderInstanceConfig,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProvider,
  type TurnId,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import {
  compareDelegationPermissionEnvelopes,
  type DelegationPermissionEnvelopeInput,
} from "../../../provider/DelegationPermissionEnvelope.ts";
import { deriveProviderInstanceConfigMap } from "../../../provider/Layers/ProviderInstanceRegistryHydration.ts";
import type { ProjectionTurn } from "../../../persistence/Services/ProjectionTurns.ts";
import type * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import type * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import type { AuthorTextField } from "../../../security/SecretTextPolicy.ts";

export interface DelegationCreatedPayload {
  readonly version: 1;
  readonly taskId: ThreadId;
  readonly parentEnvironmentId: string;
  readonly parentThreadId: ThreadId;
  readonly parentTurnId: TurnId;
  readonly projectId: ProjectId;
  readonly childThreadId: ThreadId;
  readonly delegatedMessageId: MessageId;
  readonly callerRequestFingerprint: string;
  readonly requestFingerprint: string;
  readonly requested: OrchestratorMcpRequestedIdentity;
  readonly requestedAt: string;
  readonly role: OrchestratorMcpDelegateTaskInput["role"];
  readonly handoff?: OrchestratorMcpHandoff;
  readonly stage: string | null;
  readonly evidenceRefs: ReadonlyArray<string>;
  readonly ocl: null | {
    readonly contractRef: string;
    readonly requiredRevision: number;
    readonly implementsRevision: number;
  };
  readonly branch: string | null;
  readonly workspaceRoot: string;
  readonly worktreePath: string;
  // Additive snapshot of the canonical frozen child caps used for the
  // delegation fingerprint. Legacy lineage omits it and is recovered by
  // exact-subset search instead.
  readonly childCaps?: ReadonlyArray<string>;
}

export interface TargetParentContext {
  readonly thread: OrchestrationThreadShell;
  readonly project: OrchestrationProjectShell;
  readonly scope: NonNullable<McpInvocationScope["orchestration"]>;
}

export interface ParentContext extends TargetParentContext {
  readonly activeTurnId: TurnId;
}

export type TargetResolutionRequest = Pick<
  OrchestratorMcpDelegateTaskInput,
  "target" | "runtimeMode" | "interactionMode"
>;

interface DelegationFollowUpQueuedPayload {
  readonly version: 1;
  readonly taskId: ThreadId;
  readonly parentEnvironmentId: string;
  readonly parentThreadId: ThreadId;
  readonly idempotencyKeyFingerprint: string;
  readonly requestFingerprint: string;
  readonly result: OrchestratorMcpSendToTaskResult;
}

export interface ResolvedTarget {
  readonly provider: ServerProvider;
  readonly instanceConfig: ProviderInstanceConfig;
  readonly modelSelection: ModelSelection;
  readonly requested: OrchestratorMcpRequestedIdentity;
  readonly permissionEnvelope: OrchestratorMcpPermissionEnvelopeSummary;
}

export type ControlPlaneCaller =
  | { readonly kind: "architect"; readonly binding: CoordinatorArchitectBinding }
  | { readonly kind: "other" };

interface DelegationServiceDependencies {
  readonly dependencies: {
    readonly dispatch: OrchestrationEngine.OrchestrationEngineShape["dispatch"];
    readonly getProviders: ProviderRegistry.ProviderRegistryShape["getProviders"];
    readonly getSettings: Effect.Effect<ServerSettingsValue, OrchestratorMcpFailure>;
    readonly loadPermissionEnvelope: (
      input: DelegationPermissionEnvelopeInput,
    ) => Effect.Effect<OrchestratorMcpPermissionEnvelopeSummary>;
    readonly now: Effect.Effect<string>;
  };
  readonly activityVersion: 1;
  readonly delegationCreatedActivity: string;
  readonly followUpQueuedActivity: string;
  readonly providerSwitchedActivity: string;
  readonly failure: (code: OrchestratorMcpFailureCode, message: string) => OrchestratorMcpFailure;
  readonly orchestrationFailure: (operation: string) => (error: unknown) => OrchestratorMcpFailure;
  readonly dispatchDelegatedTurnStart: (input: {
    readonly taskId: ThreadId;
    readonly request: OrchestratorMcpDelegateTaskInput;
    readonly lineage: DelegationCreatedPayload;
    readonly target: ResolvedTarget;
    readonly runOrigin: Extract<
      AgentRunOrigin,
      { readonly _tag: "delegation-start" | "delegation-retry" }
    >;
  }) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly dispatchFollowUpTurn: (input: {
    readonly taskId: ThreadId;
    readonly message: string;
    readonly result: OrchestratorMcpSendToTaskResult;
  }) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly resolveControlPlaneCaller: (
    scope: McpInvocationScope,
  ) => Effect.Effect<ControlPlaneCaller, OrchestratorMcpFailure>;
  readonly denyArchitectCaller: (
    caller: ControlPlaneCaller,
    operation: string,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly denyArchitectTarget: (
    taskId: ThreadId,
    operation: string,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly requireActiveParent: (
    scope: McpInvocationScope,
  ) => Effect.Effect<ParentContext, OrchestratorMcpFailure>;
  readonly ensureAuthorTextAllowed: (
    field: AuthorTextField,
    text: string,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly ensureHandoffTextAllowed: (
    handoff: OrchestratorMcpHandoff | undefined,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly loadThreadDetail: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, OrchestratorMcpFailure>;
  readonly listTurns: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ProjectionTurn>, OrchestratorMcpFailure>;
  readonly findLineage: (thread: OrchestrationThread) => DelegationCreatedPayload | null;
  readonly findCurrentTaskIdentity: (
    thread: OrchestrationThread,
    lineage: DelegationCreatedPayload,
  ) => OrchestratorMcpRequestedIdentity;
  readonly requestedIdentityMatches: (
    left: OrchestratorMcpRequestedIdentity,
    right: OrchestratorMcpRequestedIdentity,
  ) => boolean;
  readonly wasCancelRequested: (
    thread: OrchestrationThread,
    lineage: DelegationCreatedPayload,
  ) => boolean;
  readonly readOwnedTask: (
    scope: McpInvocationScope,
    taskId: ThreadId,
  ) => Effect.Effect<OrchestratorMcpTaskResult, OrchestratorMcpFailure>;
  readonly waitForTask: (
    scope: McpInvocationScope,
    taskId: ThreadId,
    timeoutMs: number,
  ) => Effect.Effect<OrchestratorMcpTaskWaitResult, OrchestratorMcpFailure>;
  readonly isTerminalStatus: (status: OrchestratorMcpTaskResult["status"]) => boolean;
  readonly resolveCanonicalChildCaps: (lineage: DelegationCreatedPayload) => Effect.Effect<
    {
      readonly caps: ReadonlySet<string>;
      readonly envelope: OrchestratorMcpPermissionEnvelopeSummary;
    },
    OrchestratorMcpFailure
  >;
  readonly hash: (value: unknown) => string;
  readonly deterministicId: (prefix: string, ...parts: ReadonlyArray<string>) => string;
  readonly validateOptions: (
    selections: ReadonlyArray<ProviderOptionSelection>,
    descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
  ) => ReadonlyArray<string>;
  readonly providerUnavailableReason: (provider: ServerProvider) => string | null;
  readonly requestedModelSelection: (input: TargetResolutionRequest) => ModelSelection;
  readonly isOrchestratorMcpFailure: (value: unknown) => value is OrchestratorMcpFailure;
  readonly isOrchestratorMcpRequestedIdentity: (
    value: unknown,
  ) => value is OrchestratorMcpRequestedIdentity;
}

interface DelegationServiceShape {
  readonly delegateTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpDelegateTaskInput,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;
  readonly sendToTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpSendToTaskInput,
  ) => Effect.Effect<OrchestratorMcpSendToTaskResult, OrchestratorMcpFailure>;
}

export function makeDelegationService(
  input: DelegationServiceDependencies,
): DelegationServiceShape {
  const {
    dependencies,
    dispatchDelegatedTurnStart,
    dispatchFollowUpTurn,
    activityVersion: DELEGATION_ACTIVITY_VERSION,
    delegationCreatedActivity: DELEGATION_CREATED_ACTIVITY,
    followUpQueuedActivity: DELEGATION_FOLLOW_UP_QUEUED_ACTIVITY,
    providerSwitchedActivity: DELEGATION_PROVIDER_SWITCHED_ACTIVITY,
    failure,
    orchestrationFailure,
    resolveControlPlaneCaller,
    denyArchitectCaller,
    denyArchitectTarget,
    requireActiveParent,
    ensureAuthorTextAllowed,
    ensureHandoffTextAllowed,
    loadThreadDetail,
    listTurns,
    findLineage,
    findCurrentTaskIdentity,
    requestedIdentityMatches,
    wasCancelRequested,
    readOwnedTask,
    waitForTask,
    isTerminalStatus,
    resolveCanonicalChildCaps,
    hash,
    deterministicId,
    validateOptions,
    providerUnavailableReason,
    requestedModelSelection,
    isOrchestratorMcpFailure,
    isOrchestratorMcpRequestedIdentity,
  } = input;
  const isOrchestratorMcpSendToTaskResult = Schema.is(OrchestratorMcpSendToTaskResult);

  function parseFollowUpQueuedPayload(
    activity: OrchestrationThreadActivity,
  ): DelegationFollowUpQueuedPayload | null {
    if (
      activity.kind !== DELEGATION_FOLLOW_UP_QUEUED_ACTIVITY ||
      !Predicate.isObject(activity.payload)
    ) {
      return null;
    }
    const payload = activity.payload;
    if (
      payload.version !== DELEGATION_ACTIVITY_VERSION ||
      typeof payload.taskId !== "string" ||
      typeof payload.parentEnvironmentId !== "string" ||
      typeof payload.parentThreadId !== "string" ||
      typeof payload.idempotencyKeyFingerprint !== "string" ||
      typeof payload.requestFingerprint !== "string" ||
      !isOrchestratorMcpSendToTaskResult(payload.result)
    ) {
      return null;
    }
    return payload as unknown as DelegationFollowUpQueuedPayload;
  }

  function findFollowUpReceipt(
    thread: OrchestrationThread,
    idempotencyKeyFingerprint: string,
  ): DelegationFollowUpQueuedPayload | null {
    for (let index = thread.activities.length - 1; index >= 0; index--) {
      const payload = parseFollowUpQueuedPayload(thread.activities[index]!);
      if (payload?.idempotencyKeyFingerprint === idempotencyKeyFingerprint) return payload;
    }
    return null;
  }

  function hasCurrentTaskProviderSwitch(
    thread: OrchestrationThread,
    lineage: DelegationCreatedPayload,
  ): boolean {
    return thread.activities.some((activity) => {
      if (
        activity.kind !== DELEGATION_PROVIDER_SWITCHED_ACTIVITY ||
        !Predicate.isObject(activity.payload)
      ) {
        return false;
      }
      return (
        activity.payload.version === DELEGATION_ACTIVITY_VERSION &&
        activity.payload.taskId === lineage.taskId &&
        activity.payload.delegatedMessageId === lineage.delegatedMessageId &&
        isOrchestratorMcpRequestedIdentity(activity.payload.requested)
      );
    });
  }

  // Stale-session allowance shared by the follow-up admission path and the
  // follow-up resume path: after a sanctioned provider switch the runtime
  // session still names the old provider (only provider events rebind it), so
  // a session that is idle and bound to no live turn may keep the queued
  // follow-up. Anything else fails closed.
  function sessionAllowsFollowUpStart(
    thread: OrchestrationThread,
    lineage: DelegationCreatedPayload,
    currentIdentity: OrchestratorMcpRequestedIdentity,
    rows: ReadonlyArray<ProjectionTurn>,
  ): boolean {
    const session = thread.session;
    if (session === null) return true;
    if (session.providerInstanceId === undefined) return false;
    if (session.runtimeMode !== lineage.requested.runtimeMode) return false;
    if (session.providerInstanceId === currentIdentity.providerInstanceId) return true;
    return (
      hasCurrentTaskProviderSwitch(thread, lineage) &&
      session.activeTurnId === null &&
      session.status !== "running" &&
      session.status !== "starting" &&
      thread.latestTurn?.state !== "running" &&
      !rows.some((row) => row.turnId === null)
    );
  }

  function modelSelectionMatchesRequested(
    modelSelection: ModelSelection,
    requested: OrchestratorMcpRequestedIdentity,
  ): boolean {
    return (
      modelSelection.instanceId === requested.providerInstanceId &&
      modelSelection.model === requested.model &&
      hash(modelSelection.options ?? []) === hash(requested.options)
    );
  }

  const resolveTarget = (
    scope: McpInvocationScope,
    parent: TargetParentContext,
    input: TargetResolutionRequest,
    // Canonical frozen child caps for an existing delegation. New delegations
    // keep the caller surface set; switch/send must pass the recovered S.
    t3McpCapabilities: ReadonlySet<string> = scope.capabilities,
  ): Effect.Effect<ResolvedTarget, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const providers = yield* dependencies.getProviders;
      const provider = providers.find(
        (candidate) => candidate.instanceId === input.target.providerInstanceId,
      );
      if (provider === undefined) {
        return yield* failure(
          "provider_unavailable",
          `Provider instance ${input.target.providerInstanceId} is not registered.`,
        );
      }
      if (provider.driver !== input.target.driverKind) {
        return yield* failure(
          "provider_unavailable",
          `Provider instance ${provider.instanceId} uses driver ${provider.driver}, not ${input.target.driverKind}.`,
        );
      }
      const unavailableReason = providerUnavailableReason(provider);
      if (unavailableReason !== null) {
        return yield* failure("provider_unavailable", unavailableReason);
      }
      const model = provider.models.find((candidate) => candidate.slug === input.target.model);
      if (model === undefined) {
        return yield* failure(
          "model_unavailable",
          `Model ${input.target.model} is not advertised by provider ${provider.instanceId}.`,
        );
      }
      const invalidOptions = validateOptions(
        input.target.options ?? [],
        model.capabilities?.optionDescriptors,
      );
      if (invalidOptions.length > 0) {
        return yield* failure("invalid_model_options", invalidOptions.join(" "));
      }
      const settings = yield* dependencies.getSettings;
      const instanceConfig =
        deriveProviderInstanceConfigMap(settings)[input.target.providerInstanceId];
      if (instanceConfig === undefined || instanceConfig.driver !== input.target.driverKind) {
        return yield* failure(
          "provider_unavailable",
          `Provider instance ${input.target.providerInstanceId} has no matching effective configuration.`,
        );
      }
      const runtimeMode = input.runtimeMode ?? parent.thread.runtimeMode;
      const interactionMode = input.interactionMode ?? parent.thread.interactionMode;
      const childCapabilities = provider.driver === "pi" ? new Set<string>() : t3McpCapabilities;
      const permissionEnvelope = yield* dependencies.loadPermissionEnvelope({
        driverKind: input.target.driverKind,
        runtimeMode,
        interactionMode,
        instanceConfig,
        environment: process.env,
        workspaceRoot: parent.project.workspaceRoot,
        worktreePath: parent.scope.worktreePath,
        branch: parent.thread.branch,
        t3McpCapabilities: childCapabilities,
      });
      const comparison = compareDelegationPermissionEnvelopes({
        parent: parent.scope.permissionEnvelope,
        target: permissionEnvelope,
        parentInteractionMode: parent.thread.interactionMode,
        targetInteractionMode: interactionMode,
        parentWorkspace: {
          projectId: parent.thread.projectId,
          workspaceRoot: parent.project.workspaceRoot,
          worktreePath: parent.scope.worktreePath,
          branch: parent.thread.branch,
        },
        targetWorkspace: {
          projectId: parent.thread.projectId,
          workspaceRoot: parent.project.workspaceRoot,
          worktreePath: parent.scope.worktreePath,
          branch: parent.thread.branch,
        },
      });
      if (!comparison.allowed) return yield* failure(comparison.code, comparison.reason);
      if (permissionEnvelope.status !== "verified") {
        return yield* failure("permission_envelope_unverifiable", permissionEnvelope.reason);
      }
      return {
        provider,
        instanceConfig,
        modelSelection: requestedModelSelection(input),
        requested: {
          providerInstanceId: input.target.providerInstanceId,
          driverKind: input.target.driverKind,
          model: input.target.model,
          options: input.target.options ?? [],
          runtimeMode,
          interactionMode,
          providerConfigFingerprint: permissionEnvelope.fingerprint,
        },
        permissionEnvelope,
      };
    }).pipe(
      Effect.mapError((error) =>
        isOrchestratorMcpFailure(error)
          ? error
          : orchestrationFailure("resolve provider target")(error),
      ),
    );

  const resumeFollowUpTurn = Effect.fn("OrchestratorMcpService.resumeFollowUpTurn")(
    function* (input: {
      readonly taskId: ThreadId;
      readonly message: string;
      readonly receipt: DelegationFollowUpQueuedPayload;
      readonly child: OrchestrationThread;
    }) {
      const rows = yield* listTurns(input.taskId);
      const hasTurnRequest = rows.some(
        (row) => row.pendingMessageId === input.receipt.result.messageId,
      );
      const startFailed = input.child.activities.some(
        (activity) =>
          activity.kind === "provider.turn.start.failed" &&
          Predicate.isObject(activity.payload) &&
          activity.payload.requestId === input.receipt.result.messageId,
      );
      if (!hasTurnRequest && !startFailed) {
        const lineage = findLineage(input.child);
        const currentIdentity =
          lineage === null ? null : findCurrentTaskIdentity(input.child, lineage);
        // A sanctioned provider switch repoints the child at the current task
        // identity while a receipt queued before the switch still names the
        // previous one. Validate the child against the current identity so
        // the follow-up continues on the new provider; a child matching
        // neither still fails closed.
        const receiptMatchesCurrent =
          currentIdentity !== null &&
          requestedIdentityMatches(input.receipt.result.requested, currentIdentity);
        if (
          lineage === null ||
          currentIdentity === null ||
          (!receiptMatchesCurrent && !hasCurrentTaskProviderSwitch(input.child, lineage)) ||
          !modelSelectionMatchesRequested(input.child.modelSelection, currentIdentity) ||
          input.child.runtimeMode !== lineage.requested.runtimeMode ||
          input.child.interactionMode !== lineage.requested.interactionMode ||
          currentIdentity.runtimeMode !== lineage.requested.runtimeMode ||
          currentIdentity.interactionMode !== lineage.requested.interactionMode ||
          !sessionAllowsFollowUpStart(input.child, lineage, currentIdentity, rows)
        ) {
          return yield* failure(
            "provider_configuration_changed",
            "The child identity changed before the accepted follow-up could start.",
          );
        }
        const result = receiptMatchesCurrent
          ? input.receipt.result
          : { ...input.receipt.result, requested: currentIdentity };
        yield* dispatchFollowUpTurn({
          taskId: input.taskId,
          message: input.message,
          result,
        });
        return result;
      }
      return input.receipt.result;
    },
  );

  // Frozen-identity admission shared by fresh follow-ups and exact retries: the
  // child shell must still name the current task identity, and a runtime
  // session bound to a previous provider is accepted only under the
  // post-switch conditions of sessionAllowsFollowUpStart.
  const requireFollowUpIdentity = Effect.fn("OrchestratorMcpService.requireFollowUpIdentity")(
    function* (input: {
      readonly taskId: ThreadId;
      readonly child: OrchestrationThread;
      readonly lineage: DelegationCreatedPayload;
    }) {
      const rows = yield* listTurns(input.taskId);
      const currentIdentity = findCurrentTaskIdentity(input.child, input.lineage);
      if (
        !modelSelectionMatchesRequested(input.child.modelSelection, currentIdentity) ||
        input.child.runtimeMode !== input.lineage.requested.runtimeMode ||
        input.child.interactionMode !== input.lineage.requested.interactionMode ||
        currentIdentity.runtimeMode !== input.lineage.requested.runtimeMode ||
        currentIdentity.interactionMode !== input.lineage.requested.interactionMode
      ) {
        return yield* failure(
          "permission_escalation_denied",
          "The child no longer matches its frozen provider and permission identity.",
        );
      }
      if (input.child.session !== null) {
        if (input.child.session.providerInstanceId === undefined) {
          return yield* failure(
            "permission_envelope_unverifiable",
            "The child's active provider session has no verifiable provider instance.",
          );
        }
        if (!sessionAllowsFollowUpStart(input.child, input.lineage, currentIdentity, rows)) {
          return yield* failure(
            "provider_configuration_changed",
            "The child's active session no longer matches its delegated provider configuration.",
          );
        }
      }
      return currentIdentity;
    },
  );

  return {
    delegateTask: (scope, input) =>
      Effect.gen(function* () {
        yield* denyArchitectCaller(yield* resolveControlPlaneCaller(scope), "delegate tasks");
        const parent = yield* requireActiveParent(scope);
        yield* ensureAuthorTextAllowed("prompt", input.prompt);
        yield* ensureAuthorTextAllowed("title", input.title);
        yield* ensureHandoffTextAllowed(input.handoff);
        if (
          input.handoff !== undefined &&
          input.handoff.requiredRevision !== input.handoff.implementsRevision
        ) {
          return yield* failure(
            "ocl_handoff_invalid",
            "The supplied OCL handoff revisions do not match.",
          );
        }
        const target = yield* resolveTarget(scope, parent, input);
        const taskId = ThreadId.make(
          deterministicId(
            "delegated-task",
            scope.threadId,
            parent.activeTurnId,
            input.idempotencyKey,
          ),
        );
        const callerRequestFingerprint = hash({
          title: input.title,
          prompt: input.prompt,
          role: input.role,
          target: input.target,
          runtimeMode: target.requested.runtimeMode,
          interactionMode: target.requested.interactionMode,
          workspace: {
            projectId: parent.thread.projectId,
            branch: parent.thread.branch,
            workspaceRoot: parent.project.workspaceRoot,
            worktreePath: parent.scope.worktreePath,
          },
          handoff: input.handoff ?? null,
        });
        const requestFingerprint = hash({
          callerRequestFingerprint,
          providerConfigFingerprint: target.requested.providerConfigFingerprint,
        });
        const existingOption = yield* loadThreadDetail(taskId);
        if (Option.isSome(existingOption)) {
          const existingLineage = findLineage(existingOption.value);
          if (existingLineage !== null) {
            if (
              existingLineage.parentThreadId !== scope.threadId ||
              existingLineage.parentTurnId !== parent.activeTurnId ||
              existingLineage.callerRequestFingerprint !== callerRequestFingerprint
            ) {
              return yield* failure(
                "idempotency_conflict",
                "This idempotency key already belongs to a different delegation request.",
              );
            }
            if (
              existingLineage.requested.providerConfigFingerprint !==
              target.requested.providerConfigFingerprint
            ) {
              return yield* failure(
                "provider_configuration_changed",
                "The target provider configuration changed after this delegation was accepted.",
              );
            }
            const existingRows = yield* listTurns(taskId);
            const hasDelegatedTurnRequest = existingRows.some(
              (row) => row.pendingMessageId === existingLineage.delegatedMessageId,
            );
            const startFailed = existingOption.value.activities.some(
              (activity) =>
                activity.kind === "provider.turn.start.failed" &&
                Predicate.isObject(activity.payload) &&
                activity.payload.requestId === existingLineage.delegatedMessageId,
            );
            if (
              !hasDelegatedTurnRequest &&
              !startFailed &&
              !wasCancelRequested(existingOption.value, existingLineage)
            ) {
              yield* dispatchDelegatedTurnStart({
                taskId,
                request: input,
                lineage: existingLineage,
                target,
                runOrigin: { _tag: "delegation-retry" },
              });
            }
            const existing = yield* readOwnedTask(scope, taskId);
            const mode = input.execution?.mode ?? "async";
            return mode === "wait" && !isTerminalStatus(existing.status)
              ? yield* waitForTask(
                  scope,
                  taskId,
                  input.execution?.timeoutMs ?? ORCHESTRATOR_MCP_DEFAULT_WAIT_TIMEOUT_MS,
                )
              : existing;
          }
        }
        const requestedAt = yield* dependencies.now;
        const delegatedMessageId = MessageId.make(
          deterministicId("delegated-message", taskId, requestFingerprint),
        );
        const createCommandId = CommandId.make(
          deterministicId("mcp-delegation-create", taskId, requestFingerprint),
        );
        yield* dependencies
          .dispatch({
            type: "thread.create",
            commandId: createCommandId,
            threadId: taskId,
            projectId: parent.thread.projectId,
            title: input.title,
            modelSelection: target.modelSelection,
            runtimeMode: target.requested.runtimeMode,
            interactionMode: target.requested.interactionMode,
            branch: parent.thread.branch,
            worktreePath: parent.thread.worktreePath,
            createdAt: requestedAt,
          })
          .pipe(
            Effect.catchTags({
              OrchestrationCommandIdConflictError: () =>
                Effect.fail(
                  failure(
                    "idempotency_conflict",
                    "This idempotency key collides with a different orchestration command.",
                  ),
                ),
              OrchestrationCommandInvariantError: () =>
                Effect.fail(
                  failure(
                    "idempotency_conflict",
                    "This idempotency key already belongs to a different delegation request.",
                  ),
                ),
              OrchestrationCommandPreviouslyRejectedError: () =>
                Effect.fail(
                  failure(
                    "idempotency_conflict",
                    "The original create command for this idempotency key was rejected.",
                  ),
                ),
            }),
            Effect.mapError((error) =>
              isOrchestratorMcpFailure(error)
                ? error
                : orchestrationFailure("create delegated task thread")(error),
            ),
          );
        const lineage: DelegationCreatedPayload = {
          version: DELEGATION_ACTIVITY_VERSION,
          taskId,
          parentEnvironmentId: scope.environmentId,
          parentThreadId: scope.threadId,
          parentTurnId: parent.activeTurnId,
          projectId: parent.thread.projectId,
          childThreadId: taskId,
          delegatedMessageId,
          callerRequestFingerprint,
          requestFingerprint,
          requested: target.requested,
          requestedAt,
          role: input.role,
          ...(input.handoff === undefined ? {} : { handoff: input.handoff }),
          stage: input.handoff?.stage ?? null,
          evidenceRefs: input.handoff?.evidence ?? [],
          ocl:
            input.handoff === undefined
              ? null
              : {
                  contractRef: input.handoff.contractRef,
                  requiredRevision: input.handoff.requiredRevision,
                  implementsRevision: input.handoff.implementsRevision,
                },
          branch: parent.thread.branch,
          workspaceRoot: parent.project.workspaceRoot,
          worktreePath: parent.scope.worktreePath,
          childCaps:
            target.permissionEnvelope.status === "verified"
              ? [...target.permissionEnvelope.t3McpCapabilities].toSorted()
              : [],
        };
        yield* dependencies
          .dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(
              deterministicId("mcp-delegation-lineage", taskId, requestFingerprint),
            ),
            threadId: taskId,
            activity: {
              id: EventId.make(
                deterministicId("mcp-delegation-lineage", taskId, requestFingerprint),
              ),
              tone: "info",
              kind: DELEGATION_CREATED_ACTIVITY,
              summary: "Delegated task created",
              payload: lineage,
              turnId: null,
              createdAt: requestedAt,
            },
            createdAt: requestedAt,
          })
          .pipe(Effect.mapError(orchestrationFailure("persist delegated-task lineage")));
        const currentTarget = yield* resolveTarget(scope, parent, input);
        if (
          currentTarget.requested.providerConfigFingerprint !==
          target.requested.providerConfigFingerprint
        ) {
          return yield* failure(
            "provider_configuration_changed",
            "The target provider configuration changed before its turn could start.",
          );
        }
        yield* dispatchDelegatedTurnStart({
          taskId,
          request: input,
          lineage,
          target: currentTarget,
          runOrigin: { _tag: "delegation-start" },
        });
        const mode = input.execution?.mode ?? "async";
        return mode === "wait"
          ? yield* waitForTask(
              scope,
              taskId,
              input.execution?.timeoutMs ?? ORCHESTRATOR_MCP_DEFAULT_WAIT_TIMEOUT_MS,
            )
          : yield* readOwnedTask(scope, taskId);
      }),
    sendToTask: (scope, input) =>
      Effect.gen(function* () {
        yield* denyArchitectCaller(
          yield* resolveControlPlaneCaller(scope),
          "send messages to delegated tasks",
        );
        const parent = yield* requireActiveParent(scope);
        if (input.taskId === scope.threadId) {
          return yield* failure("task_not_found", "The delegated task was not found.");
        }
        yield* denyArchitectTarget(input.taskId, "send_to_task");
        yield* readOwnedTask(scope, input.taskId);
        const childOption = yield* loadThreadDetail(input.taskId);
        if (Option.isNone(childOption)) {
          return yield* failure("task_not_found", "The delegated task was not found.");
        }
        const child = childOption.value;
        const lineage = findLineage(child);
        if (
          lineage === null ||
          lineage.taskId !== input.taskId ||
          lineage.childThreadId !== input.taskId ||
          lineage.parentThreadId !== scope.threadId ||
          lineage.parentEnvironmentId !== scope.environmentId
        ) {
          return yield* failure("task_not_found", "The delegated task was not found.");
        }
        yield* ensureAuthorTextAllowed("message", input.message);
        const childWorktreePath = child.worktreePath ?? parent.scope.worktreePath;
        if (
          child.projectId !== lineage.projectId ||
          lineage.projectId !== parent.thread.projectId ||
          child.branch !== lineage.branch ||
          lineage.workspaceRoot !== parent.project.workspaceRoot ||
          childWorktreePath !== lineage.worktreePath
        ) {
          return yield* failure(
            "permission_escalation_denied",
            "The child no longer matches its delegated project and worktree scope.",
          );
        }

        const idempotencyKeyFingerprint = hash(input.idempotencyKey);
        const requestFingerprint = hash({ taskId: input.taskId, message: input.message });
        const existing = findFollowUpReceipt(child, idempotencyKeyFingerprint);
        if (existing !== null) {
          if (
            existing.taskId !== input.taskId ||
            existing.parentEnvironmentId !== scope.environmentId ||
            existing.parentThreadId !== scope.threadId ||
            existing.requestFingerprint !== requestFingerprint
          ) {
            return yield* failure(
              "idempotency_conflict",
              "This idempotency key already belongs to a different follow-up message.",
            );
          }
          // An exact retry replays the accepted follow-up, but the child may
          // have been repointed — or tampered with — since it was queued, so
          // it runs the same frozen-identity admission as a fresh follow-up.
          yield* requireFollowUpIdentity({ taskId: input.taskId, child, lineage });
          return yield* resumeFollowUpTurn({
            taskId: input.taskId,
            message: input.message,
            receipt: existing,
            child,
          });
        }

        const currentIdentity = yield* requireFollowUpIdentity({
          taskId: input.taskId,
          child,
          lineage,
        });

        // The target envelope is rebuilt with the canonical frozen child caps,
        // never the caller surface set, so a broader caller cannot smuggle in
        // rights the delegation never had.
        const canonical = yield* resolveCanonicalChildCaps(lineage);
        const target = yield* resolveTarget(
          scope,
          parent,
          {
            target: {
              providerInstanceId: currentIdentity.providerInstanceId,
              driverKind: currentIdentity.driverKind,
              model: currentIdentity.model,
              options: currentIdentity.options,
            },
            runtimeMode: lineage.requested.runtimeMode,
            interactionMode: lineage.requested.interactionMode,
          },
          canonical.caps,
        );
        if (!requestedIdentityMatches(target.requested, currentIdentity)) {
          return yield* failure(
            "provider_configuration_changed",
            "The child's provider configuration changed after its current identity was recorded.",
          );
        }

        const queuedAt = yield* dependencies.now;
        const messageId = MessageId.make(
          deterministicId("mcp-send-to-task-message", input.taskId, idempotencyKeyFingerprint),
        );
        const commandId = CommandId.make(
          deterministicId("mcp-send-to-task-start", input.taskId, idempotencyKeyFingerprint),
        );
        const session = child.session;
        const observed = {
          provider:
            session?.providerInstanceId === undefined
              ? null
              : {
                  providerInstanceId: session.providerInstanceId,
                  driverKind: currentIdentity.driverKind,
                  evidence: "runtime-session-bound" as const,
                  observedAt: session.updatedAt,
                },
          model: null,
        };
        const result: OrchestratorMcpSendToTaskResult = {
          taskId: input.taskId,
          messageId,
          commandId,
          status: "queued",
          requested: target.requested,
          observed,
          queuedAt,
        };
        const receipt: DelegationFollowUpQueuedPayload = {
          version: DELEGATION_ACTIVITY_VERSION,
          taskId: input.taskId,
          parentEnvironmentId: scope.environmentId,
          parentThreadId: scope.threadId,
          idempotencyKeyFingerprint,
          requestFingerprint,
          result,
        };
        yield* dependencies
          .dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(
              deterministicId("mcp-send-to-task-receipt", input.taskId, idempotencyKeyFingerprint),
            ),
            threadId: input.taskId,
            activity: {
              id: EventId.make(
                deterministicId(
                  "mcp-send-to-task-receipt",
                  input.taskId,
                  idempotencyKeyFingerprint,
                ),
              ),
              tone: "info",
              kind: DELEGATION_FOLLOW_UP_QUEUED_ACTIVITY,
              summary: "Follow-up message queued",
              payload: receipt,
              turnId: null,
              createdAt: queuedAt,
            },
            createdAt: queuedAt,
          })
          .pipe(
            Effect.catchTags({
              OrchestrationCommandIdConflictError: () =>
                Effect.fail(
                  failure(
                    "idempotency_conflict",
                    "This idempotency key collides with a different follow-up request.",
                  ),
                ),
              OrchestrationCommandInvariantError: () =>
                Effect.fail(
                  failure(
                    "idempotency_conflict",
                    "This idempotency key already belongs to a different follow-up message.",
                  ),
                ),
              OrchestrationCommandPreviouslyRejectedError: () =>
                Effect.fail(
                  failure(
                    "idempotency_conflict",
                    "The original receipt command for this idempotency key was rejected.",
                  ),
                ),
            }),
            Effect.mapError((error) =>
              isOrchestratorMcpFailure(error)
                ? error
                : orchestrationFailure("persist follow-up receipt")(error),
            ),
          );
        // Command-id dedupe preserves the first payload, so use its persisted receipt.
        const reservedChild = yield* loadThreadDetail(input.taskId);
        if (Option.isNone(reservedChild)) {
          return yield* failure("task_not_found", "The delegated task was not found.");
        }
        const reservedReceipt = findFollowUpReceipt(reservedChild.value, idempotencyKeyFingerprint);
        if (
          reservedReceipt === null ||
          reservedReceipt.taskId !== input.taskId ||
          reservedReceipt.parentEnvironmentId !== scope.environmentId ||
          reservedReceipt.parentThreadId !== scope.threadId ||
          reservedReceipt.requestFingerprint !== requestFingerprint
        ) {
          return yield* failure(
            "idempotency_conflict",
            "This idempotency key already belongs to a different follow-up message.",
          );
        }
        return yield* resumeFollowUpTurn({
          taskId: input.taskId,
          message: input.message,
          receipt: reservedReceipt,
          child: reservedChild.value,
        });
      }),
  };
}

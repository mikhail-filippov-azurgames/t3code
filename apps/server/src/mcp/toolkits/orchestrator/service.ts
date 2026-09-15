import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  EventId,
  MessageId,
  ORCHESTRATOR_MCP_DEFAULT_WAIT_TIMEOUT_MS,
  ORCHESTRATOR_MCP_MAX_WAIT_TIMEOUT_MS,
  ORCHESTRATOR_MCP_PROTOCOL_VERSION,
  OrchestratorMcpFailure,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type OrchestratorMcpCapabilitiesResult,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  type OrchestratorMcpFailureCode,
  type OrchestratorMcpHandoff,
  type OrchestratorMcpPermissionEnvelopeSummary,
  type OrchestratorMcpProviderCapability,
  type OrchestratorMcpRequestedIdentity,
  type OrchestratorMcpTaskCancelResult,
  type OrchestratorMcpTaskResult,
  type OrchestratorMcpTaskWaitResult,
  type ProviderInstanceConfig,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProvider,
  type ServerSettings as ServerSettingsValue,
  type TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  compareDelegationPermissionEnvelopes,
  loadDelegationPermissionEnvelope,
} from "../../../provider/DelegationPermissionEnvelope.ts";
import type { DelegationPermissionEnvelopeInput } from "../../../provider/DelegationPermissionEnvelope.ts";
import type { ProjectionTurn } from "../../../persistence/Services/ProjectionTurns.ts";
import * as ProjectionTurns from "../../../persistence/Services/ProjectionTurns.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as ServerSettingsService from "../../../serverSettings.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";

const DELEGATION_CREATED_ACTIVITY = "delegation.created";
const DELEGATION_CANCEL_REQUESTED_ACTIVITY = "delegation.cancel-requested";
const DELEGATION_CANCELLED_ACTIVITY = "delegation.cancelled";
const DELEGATION_PROVIDER_BOUND_ACTIVITY = "delegation.provider-bound";
const DELEGATION_MODEL_OBSERVED_ACTIVITY = "delegation.model-observed";
const DELEGATION_ACTIVITY_VERSION = 1 as const;
const TASK_ACTIVITY_KINDS = [
  DELEGATION_CREATED_ACTIVITY,
  DELEGATION_CANCEL_REQUESTED_ACTIVITY,
  DELEGATION_CANCELLED_ACTIVITY,
  DELEGATION_PROVIDER_BOUND_ACTIVITY,
  DELEGATION_MODEL_OBSERVED_ACTIVITY,
  "provider.turn.start.failed",
  "provider.turn.interrupt.failed",
  "approval.requested",
  "approval.resolved",
  "user-input.requested",
  "user-input.resolved",
] as const;
const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);

interface DelegationCreatedPayload {
  readonly version: typeof DELEGATION_ACTIVITY_VERSION;
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
}

interface ParentContext {
  readonly thread: OrchestrationThreadShell;
  readonly project: OrchestrationProjectShell;
  readonly activeTurnId: TurnId;
  readonly scope: NonNullable<McpInvocationScope["orchestration"]>;
}

interface DelegationProviderBoundPayload {
  readonly version: typeof DELEGATION_ACTIVITY_VERSION;
  readonly taskId: ThreadId;
  readonly delegatedMessageId: MessageId;
  readonly providerInstanceId: OrchestratorMcpRequestedIdentity["providerInstanceId"];
  readonly driverKind: OrchestratorMcpRequestedIdentity["driverKind"];
  readonly providerConfigFingerprint: string;
  readonly observedAt: string;
}

interface DelegationModelObservedPayload {
  readonly version: typeof DELEGATION_ACTIVITY_VERSION;
  readonly taskId: ThreadId;
  readonly delegatedMessageId: MessageId;
  readonly delegatedTurnId: TurnId;
  readonly model: string;
  readonly evidence: "provider-executed" | "provider-rerouted";
  readonly observedAt: string;
}

interface ResolvedTarget {
  readonly provider: ServerProvider;
  readonly instanceConfig: ProviderInstanceConfig;
  readonly modelSelection: ModelSelection;
  readonly requested: OrchestratorMcpRequestedIdentity;
  readonly permissionEnvelope: OrchestratorMcpPermissionEnvelopeSummary;
}

export interface OrchestratorMcpDependencies {
  readonly dispatch: OrchestrationEngine.OrchestrationEngineShape["dispatch"];
  readonly subscribeDomainEvents: OrchestrationEngine.OrchestrationEngineShape["subscribeDomainEvents"];
  readonly getThreadShellById: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["getThreadShellById"];
  readonly getProjectShellById: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["getProjectShellById"];
  readonly getThreadDetailById: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["getThreadDetailById"];
  readonly listTurnsByThreadId: ProjectionTurns.ProjectionTurnRepositoryShape["listByThreadId"];
  readonly getProviders: ProviderRegistry.ProviderRegistryShape["getProviders"];
  readonly getSettings: Effect.Effect<ServerSettingsValue, OrchestratorMcpFailure>;
  readonly loadPermissionEnvelope: (
    input: DelegationPermissionEnvelopeInput,
  ) => Effect.Effect<OrchestratorMcpPermissionEnvelopeSummary>;
  readonly now: Effect.Effect<string>;
}

export interface OrchestratorMcpServiceShape {
  readonly capabilities: (
    scope: McpInvocationScope,
  ) => Effect.Effect<OrchestratorMcpCapabilitiesResult, OrchestratorMcpFailure>;
  readonly delegateTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpDelegateTaskInput,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;
  readonly taskStatus: (
    scope: McpInvocationScope,
    taskId: ThreadId,
  ) => Effect.Effect<OrchestratorMcpTaskResult, OrchestratorMcpFailure>;
  readonly taskWait: (
    scope: McpInvocationScope,
    taskId: ThreadId,
    timeoutMs: number,
  ) => Effect.Effect<OrchestratorMcpTaskWaitResult, OrchestratorMcpFailure>;
  readonly taskCancel: (
    scope: McpInvocationScope,
    taskId: ThreadId,
  ) => Effect.Effect<OrchestratorMcpTaskCancelResult, OrchestratorMcpFailure>;
}

export class OrchestratorMcpService extends Context.Service<
  OrchestratorMcpService,
  OrchestratorMcpServiceShape
>()("t3/mcp/toolkits/orchestrator/service/OrchestratorMcpService") {}

function failure(code: OrchestratorMcpFailureCode, message: string): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({ code, message });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { readonly message: unknown }).message);
  }
  return String(error);
}

function orchestrationFailure(operation: string) {
  return (error: unknown) =>
    failure("orchestration_error", `Could not ${operation}: ${errorMessage(error)}`);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function hash(value: unknown): string {
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function deterministicId(prefix: string, ...parts: ReadonlyArray<string>): string {
  return `${prefix}:${hash(parts).slice(0, 40)}`;
}

function parseDelegationPayload(
  activity: OrchestrationThreadActivity,
): DelegationCreatedPayload | null {
  if (activity.kind !== DELEGATION_CREATED_ACTIVITY || !Predicate.isObject(activity.payload)) {
    return null;
  }
  const payload = activity.payload;
  if (
    payload.version !== DELEGATION_ACTIVITY_VERSION ||
    typeof payload.taskId !== "string" ||
    typeof payload.parentEnvironmentId !== "string" ||
    typeof payload.parentThreadId !== "string" ||
    typeof payload.parentTurnId !== "string" ||
    typeof payload.projectId !== "string" ||
    typeof payload.childThreadId !== "string" ||
    typeof payload.delegatedMessageId !== "string" ||
    typeof payload.callerRequestFingerprint !== "string" ||
    typeof payload.requestFingerprint !== "string" ||
    typeof payload.requestedAt !== "string" ||
    typeof payload.role !== "string" ||
    typeof payload.workspaceRoot !== "string" ||
    typeof payload.worktreePath !== "string" ||
    !Predicate.isObject(payload.requested)
  ) {
    return null;
  }
  return payload as unknown as DelegationCreatedPayload;
}

function findLineage(thread: OrchestrationThread): DelegationCreatedPayload | null {
  for (let index = thread.activities.length - 1; index >= 0; index--) {
    const parsed = parseDelegationPayload(thread.activities[index]!);
    if (parsed !== null) return parsed;
  }
  return null;
}

function wasCancelRequested(
  thread: OrchestrationThread,
  lineage: DelegationCreatedPayload,
): boolean {
  return thread.activities.some(
    (activity) =>
      activity.kind === DELEGATION_CANCEL_REQUESTED_ACTIVITY &&
      Predicate.isObject(activity.payload) &&
      activity.payload.taskId === lineage.taskId &&
      activity.payload.delegatedMessageId === lineage.delegatedMessageId,
  );
}

function cancellationCompletedAt(
  thread: OrchestrationThread,
  lineage: DelegationCreatedPayload,
): string | null {
  const completed = thread.activities.findLast(
    (activity) =>
      activity.kind === DELEGATION_CANCELLED_ACTIVITY &&
      Predicate.isObject(activity.payload) &&
      activity.payload.taskId === lineage.taskId &&
      activity.payload.delegatedMessageId === lineage.delegatedMessageId,
  );
  return completed?.createdAt ?? null;
}

function failedCancellationRequestIds(thread: OrchestrationThread): ReadonlySet<string> {
  return new Set(
    thread.activities.flatMap((activity) =>
      activity.kind === "provider.turn.interrupt.failed" &&
      Predicate.isObject(activity.payload) &&
      typeof activity.payload.requestId === "string"
        ? [activity.payload.requestId]
        : [],
    ),
  );
}

function findObservedProvider(
  thread: OrchestrationThread,
  lineage: DelegationCreatedPayload,
): DelegationProviderBoundPayload | null {
  for (let index = thread.activities.length - 1; index >= 0; index--) {
    const activity = thread.activities[index]!;
    if (
      activity.kind !== DELEGATION_PROVIDER_BOUND_ACTIVITY ||
      !Predicate.isObject(activity.payload)
    ) {
      continue;
    }
    const payload = activity.payload;
    if (
      payload.version === DELEGATION_ACTIVITY_VERSION &&
      payload.taskId === lineage.taskId &&
      payload.delegatedMessageId === lineage.delegatedMessageId &&
      payload.providerInstanceId === lineage.requested.providerInstanceId &&
      payload.driverKind === lineage.requested.driverKind &&
      payload.providerConfigFingerprint === lineage.requested.providerConfigFingerprint &&
      typeof payload.observedAt === "string"
    ) {
      return payload as unknown as DelegationProviderBoundPayload;
    }
  }
  return null;
}

function findObservedModel(
  thread: OrchestrationThread,
  lineage: DelegationCreatedPayload,
  delegatedTurnId: TurnId,
): DelegationModelObservedPayload | null {
  for (let index = thread.activities.length - 1; index >= 0; index--) {
    const activity = thread.activities[index]!;
    if (
      activity.kind !== DELEGATION_MODEL_OBSERVED_ACTIVITY ||
      !Predicate.isObject(activity.payload)
    ) {
      continue;
    }
    const payload = activity.payload;
    if (
      payload.version === DELEGATION_ACTIVITY_VERSION &&
      payload.taskId === lineage.taskId &&
      payload.delegatedMessageId === lineage.delegatedMessageId &&
      payload.delegatedTurnId === delegatedTurnId &&
      typeof payload.model === "string" &&
      (payload.evidence === "provider-executed" || payload.evidence === "provider-rerouted") &&
      typeof payload.observedAt === "string"
    ) {
      return payload as unknown as DelegationModelObservedPayload;
    }
  }
  return null;
}

function hasPendingLifecycleRequest(
  thread: OrchestrationThread,
  turnId: TurnId,
  requestKind: "approval.requested" | "user-input.requested",
  resolvedKind: "approval.resolved" | "user-input.resolved",
): boolean {
  const pending = new Set<string>();
  for (const activity of thread.activities) {
    if (!Predicate.isObject(activity.payload) || typeof activity.payload.requestId !== "string") {
      continue;
    }
    if (activity.kind === requestKind && activity.turnId === turnId) {
      pending.add(activity.payload.requestId);
    } else if (activity.kind === resolvedKind) {
      pending.delete(activity.payload.requestId);
    }
  }
  return pending.size > 0;
}

function isTerminalStatus(status: OrchestratorMcpTaskResult["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

function validateOptions(
  selections: ReadonlyArray<ProviderOptionSelection>,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): ReadonlyArray<string> {
  if (selections.length === 0) return [];
  const byId = new Map((descriptors ?? []).map((descriptor) => [descriptor.id, descriptor]));
  const invalid: Array<string> = [];
  for (const selection of selections) {
    const descriptor = byId.get(selection.id);
    if (descriptor === undefined) {
      invalid.push(`Unknown option ${selection.id}.`);
    } else if (descriptor.type === "boolean" && typeof selection.value !== "boolean") {
      invalid.push(`Option ${selection.id} requires a boolean value.`);
    } else if (
      descriptor.type === "select" &&
      (typeof selection.value !== "string" ||
        !descriptor.options.some((choice) => choice.id === selection.value))
    ) {
      invalid.push(`Option ${selection.id} has an unsupported value.`);
    }
  }
  return invalid;
}

function providerUnavailableReason(provider: ServerProvider): string | null {
  if (provider.availability === "unavailable") {
    return provider.unavailableReason ?? "Provider driver is unavailable.";
  }
  if (!provider.enabled) return "Provider instance is disabled.";
  if (!provider.installed) return "Provider executable is not installed.";
  if (provider.status === "error" || provider.status === "disabled") {
    return provider.message ?? `Provider status is ${provider.status}.`;
  }
  if (provider.auth.status === "unauthenticated") return "Provider is not authenticated.";
  return null;
}

function requestedModelSelection(input: OrchestratorMcpDelegateTaskInput): ModelSelection {
  return {
    instanceId: input.target.providerInstanceId,
    model: input.target.model,
    ...(input.target.options === undefined ? {} : { options: input.target.options }),
  };
}

function makeService(dependencies: OrchestratorMcpDependencies): OrchestratorMcpServiceShape {
  const loadThreadShell = (threadId: ThreadId) =>
    dependencies
      .getThreadShellById(threadId)
      .pipe(Effect.mapError(orchestrationFailure(`read thread ${threadId}`)));
  const loadProjectShell = (projectId: ProjectId) =>
    dependencies
      .getProjectShellById(projectId)
      .pipe(Effect.mapError(orchestrationFailure(`read project ${projectId}`)));
  const loadThreadDetail = (threadId: ThreadId) =>
    dependencies
      .getThreadDetailById(threadId, {
        activityKinds: [...TASK_ACTIVITY_KINDS],
        activityHistory: "complete",
      })
      .pipe(Effect.mapError(orchestrationFailure(`read thread detail ${threadId}`)));
  const listTurns = (threadId: ThreadId) =>
    dependencies
      .listTurnsByThreadId({ threadId })
      .pipe(Effect.mapError(orchestrationFailure(`read turns for ${threadId}`)));

  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("orchestration") && scope.orchestration !== undefined
      ? Effect.succeed(scope.orchestration)
      : Effect.fail(
          failure(
            "capability_denied",
            "This MCP credential does not grant orchestration capabilities.",
          ),
        );

  const requireActiveParent = (
    scope: McpInvocationScope,
  ): Effect.Effect<ParentContext, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const frozen = yield* requireCapability(scope);
      const threadOption = yield* loadThreadShell(scope.threadId);
      if (Option.isNone(threadOption)) {
        return yield* failure("parent_not_active", "The parent thread no longer exists.");
      }
      const thread = threadOption.value;
      const projectOption = yield* loadProjectShell(thread.projectId);
      if (Option.isNone(projectOption)) {
        return yield* failure("parent_not_active", "The parent project no longer exists.");
      }
      const project = projectOption.value;
      const activeTurnId = thread.session?.activeTurnId;
      if (
        activeTurnId === null ||
        activeTurnId === undefined ||
        thread.latestTurn?.turnId !== activeTurnId ||
        thread.latestTurn.state !== "running" ||
        thread.session?.providerInstanceId !== scope.providerInstanceId
      ) {
        return yield* failure(
          "parent_not_active",
          "Delegation requires an active parent turn owned by this provider session.",
        );
      }
      const worktreePath = thread.worktreePath ?? project.workspaceRoot;
      if (
        frozen.projectId !== thread.projectId ||
        frozen.runtimeMode !== thread.runtimeMode ||
        frozen.interactionMode !== thread.interactionMode ||
        frozen.branch !== thread.branch ||
        frozen.workspaceRoot !== project.workspaceRoot ||
        frozen.worktreePath !== worktreePath
      ) {
        return yield* failure(
          "parent_not_active",
          "The active parent no longer matches the permission scope frozen for this MCP session.",
        );
      }
      return { thread, project, activeTurnId, scope: frozen };
    });

  const resolveTarget = (
    scope: McpInvocationScope,
    parent: ParentContext,
    input: OrchestratorMcpDelegateTaskInput,
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
      const instanceConfig = settings.providerInstances[input.target.providerInstanceId];
      if (instanceConfig === undefined || instanceConfig.driver !== input.target.driverKind) {
        return yield* failure(
          "provider_unavailable",
          `Provider instance ${input.target.providerInstanceId} has no matching effective configuration.`,
        );
      }
      const runtimeMode = input.runtimeMode ?? parent.thread.runtimeMode;
      const interactionMode = input.interactionMode ?? parent.thread.interactionMode;
      const permissionEnvelope = yield* dependencies.loadPermissionEnvelope({
        driverKind: input.target.driverKind,
        runtimeMode,
        interactionMode,
        instanceConfig,
        environment: process.env,
        workspaceRoot: parent.project.workspaceRoot,
        worktreePath: parent.scope.worktreePath,
        branch: parent.thread.branch,
        t3McpCapabilities: scope.capabilities,
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

  const readOwnedTask = (
    scope: McpInvocationScope,
    taskId: ThreadId,
    waitTimedOut = false,
  ): Effect.Effect<OrchestratorMcpTaskResult, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      yield* requireCapability(scope);
      const threadOption = yield* loadThreadDetail(taskId);
      if (Option.isNone(threadOption)) {
        return yield* failure("task_not_found", "The delegated task was not found.");
      }
      const thread = threadOption.value;
      const lineage = findLineage(thread);
      if (
        lineage === null ||
        lineage.taskId !== taskId ||
        lineage.childThreadId !== taskId ||
        lineage.parentThreadId !== scope.threadId ||
        lineage.parentEnvironmentId !== scope.environmentId
      ) {
        return yield* failure("task_not_found", "The delegated task was not found.");
      }
      const rows = yield* listTurns(taskId);
      const matchingRows = rows.filter(
        (row) => row.pendingMessageId === lineage.delegatedMessageId,
      );
      const concreteRows = matchingRows.filter(
        (row): row is ProjectionTurn & { readonly turnId: TurnId } => row.turnId !== null,
      );
      if (concreteRows.length > 1) {
        return yield* failure(
          "orchestration_error",
          "The delegated message is bound to more than one provider turn.",
        );
      }
      const turn = concreteRows[0];
      const pending = matchingRows.some((row) => row.turnId === null);
      const startFailure = thread.activities.findLast(
        (activity) =>
          activity.kind === "provider.turn.start.failed" &&
          Predicate.isObject(activity.payload) &&
          activity.payload.requestId === lineage.delegatedMessageId,
      );
      const cancelRequested = wasCancelRequested(thread, lineage);
      const cancelledAt = cancellationCompletedAt(thread, lineage);
      const pendingApprovalForTurn =
        turn?.turnId === undefined
          ? false
          : hasPendingLifecycleRequest(
              thread,
              turn.turnId,
              "approval.requested",
              "approval.resolved",
            );
      const pendingUserInputForTurn =
        turn?.turnId === undefined
          ? false
          : hasPendingLifecycleRequest(
              thread,
              turn.turnId,
              "user-input.requested",
              "user-input.resolved",
            );
      let status: OrchestratorMcpTaskResult["status"];
      if (cancelledAt !== null) {
        status = "cancelled";
      } else if (turn !== undefined) {
        switch (turn.state) {
          case "pending":
            status = "queued";
            break;
          case "running":
            status =
              thread.session?.activeTurnId === turn.turnId &&
              (pendingApprovalForTurn || pendingUserInputForTurn)
                ? "waiting"
                : "running";
            break;
          case "completed":
            status = "completed";
            break;
          case "interrupted":
            status = cancelRequested
              ? thread.session?.activeTurnId === turn.turnId
                ? "running"
                : "queued"
              : "interrupted";
            break;
          case "error":
            status = "failed";
            break;
        }
      } else if (startFailure !== undefined) {
        status = "failed";
      } else if (cancelRequested) {
        status = "queued";
      } else {
        status = pending ? "queued" : "queued";
      }
      const delegatedTurnId = turn?.turnId ?? null;
      const assistant =
        delegatedTurnId === null
          ? undefined
          : thread.messages.findLast(
              (message) => message.role === "assistant" && message.turnId === delegatedTurnId,
            );
      const checkpoint =
        delegatedTurnId === null
          ? undefined
          : thread.checkpoints.findLast((candidate) => candidate.turnId === delegatedTurnId);
      const terminal = isTerminalStatus(status);
      const completedAt = terminal
        ? (cancelledAt ?? turn?.completedAt ?? startFailure?.createdAt ?? thread.updatedAt)
        : null;
      const result =
        status === "completed"
          ? {
              text: assistant?.text ?? "",
              assistantMessageId: assistant?.id ?? null,
              checkpointRef: checkpoint?.checkpointRef ?? null,
              evidenceRefs: [...lineage.evidenceRefs],
            }
          : null;
      const terminalError =
        status === "failed"
          ? {
              code:
                Predicate.isObject(startFailure?.payload) &&
                startFailure.payload.code === "provider_configuration_changed"
                  ? ("provider_configuration_changed" as const)
                  : ("orchestration_error" as const),
              message:
                (Predicate.isObject(startFailure?.payload) &&
                typeof startFailure.payload.detail === "string"
                  ? startFailure.payload.detail
                  : undefined) ?? "The delegated provider turn failed.",
            }
          : null;
      const providerEvidence = findObservedProvider(thread, lineage);
      const observedProvider =
        providerEvidence === null
          ? null
          : {
              providerInstanceId: providerEvidence.providerInstanceId,
              driverKind: providerEvidence.driverKind,
              evidence: "runtime-session-bound" as const,
              observedAt: providerEvidence.observedAt,
            };
      const modelEvidence =
        delegatedTurnId === null ? null : findObservedModel(thread, lineage, delegatedTurnId);
      const observedModel =
        observedProvider === null || modelEvidence === null
          ? null
          : {
              model: modelEvidence.model,
              evidence: modelEvidence.evidence,
              observedAt: modelEvidence.observedAt,
            };
      return {
        taskId,
        status,
        requested: lineage.requested,
        observed: { provider: observedProvider, model: observedModel },
        lineage: {
          taskId,
          parentEnvironmentId: scope.environmentId,
          parentThreadId: lineage.parentThreadId,
          parentTurnId: lineage.parentTurnId,
          projectId: lineage.projectId,
          childThreadId: taskId,
          delegatedMessageId: lineage.delegatedMessageId,
          delegatedTurnId,
        },
        pendingApproval:
          delegatedTurnId !== null && thread.session?.activeTurnId === delegatedTurnId
            ? pendingApprovalForTurn
            : false,
        pendingUserInput:
          delegatedTurnId !== null && thread.session?.activeTurnId === delegatedTurnId
            ? pendingUserInputForTurn
            : false,
        requestedAt: lineage.requestedAt,
        startedAt: turn?.startedAt ?? null,
        completedAt,
        updatedAt: turn?.completedAt ?? turn?.startedAt ?? thread.updatedAt,
        terminalError,
        result,
        waitTimedOut,
      };
    });

  const waitForTask = (
    scope: McpInvocationScope,
    taskId: ThreadId,
    timeoutMs: number,
  ): Effect.Effect<OrchestratorMcpTaskWaitResult, OrchestratorMcpFailure> =>
    Effect.scoped(
      Effect.gen(function* () {
        const changes = yield* dependencies.subscribeDomainEvents;
        const initial = yield* readOwnedTask(scope, taskId);
        if (isTerminalStatus(initial.status)) return initial;
        const terminal = yield* changes.pipe(
          Stream.mapEffect(() => readOwnedTask(scope, taskId)),
          Stream.filter((task) => isTerminalStatus(task.status)),
          Stream.runHead,
          Effect.timeoutOption(timeoutMs),
          Effect.map(Option.flatten),
        );
        if (Option.isSome(terminal)) return terminal.value;
        return yield* readOwnedTask(scope, taskId, true).pipe(
          Effect.map((current) =>
            isTerminalStatus(current.status) ? { ...current, waitTimedOut: false } : current,
          ),
        );
      }),
    );

  const providerCapability = Effect.fn("OrchestratorMcpService.providerCapability")(function* (
    scope: McpInvocationScope,
    parent: ParentContext,
    settings: ServerSettingsValue,
    provider: ServerProvider,
  ) {
    const unavailable = providerUnavailableReason(provider);
    const instanceConfig = settings.providerInstances[provider.instanceId];
    const permissionEnvelope =
      instanceConfig === undefined
        ? ({ status: "unverifiable", reason: "Provider configuration is unavailable." } as const)
        : yield* dependencies.loadPermissionEnvelope({
            driverKind: provider.driver,
            runtimeMode: parent.thread.runtimeMode,
            interactionMode: parent.thread.interactionMode,
            instanceConfig,
            environment: process.env,
            workspaceRoot: parent.project.workspaceRoot,
            worktreePath: parent.scope.worktreePath,
            branch: parent.thread.branch,
            t3McpCapabilities: scope.capabilities,
          });
    const comparison = compareDelegationPermissionEnvelopes({
      parent: parent.scope.permissionEnvelope,
      target: permissionEnvelope,
      parentInteractionMode: parent.thread.interactionMode,
      targetInteractionMode: parent.thread.interactionMode,
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
    const unavailableReason =
      unavailable ??
      (comparison.allowed
        ? null
        : comparison.code === "permission_envelope_unverifiable"
          ? "permission_envelope_unverifiable"
          : comparison.reason);
    return {
      providerInstanceId: provider.instanceId,
      driverKind: provider.driver,
      displayName: provider.displayName ?? null,
      models: provider.models.map((model) => ({
        id: model.slug,
        label: model.name ?? null,
        ...(model.capabilities?.optionDescriptors === undefined
          ? {}
          : { optionDescriptors: model.capabilities.optionDescriptors }),
      })),
      permissionEnvelope,
      delegatable: unavailableReason === null,
      unavailableReason,
    } satisfies OrchestratorMcpProviderCapability;
  });

  const dispatchDelegatedTurnStart = Effect.fn("OrchestratorMcpService.dispatchDelegatedTurnStart")(
    function* (input: {
      readonly taskId: ThreadId;
      readonly request: OrchestratorMcpDelegateTaskInput;
      readonly lineage: DelegationCreatedPayload;
      readonly target: ResolvedTarget;
    }) {
      yield* dependencies
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(
            deterministicId(
              "mcp-delegation-turn-start",
              input.taskId,
              input.lineage.requestFingerprint,
            ),
          ),
          threadId: input.taskId,
          message: {
            messageId: input.lineage.delegatedMessageId,
            role: "user",
            text: input.request.prompt,
            attachments: [],
          },
          modelSelection: input.target.modelSelection,
          runtimeMode: input.target.requested.runtimeMode,
          interactionMode: input.target.requested.interactionMode,
          delegationConfigFingerprint: input.lineage.requested.providerConfigFingerprint,
          createdAt: input.lineage.requestedAt,
        })
        .pipe(Effect.mapError(orchestrationFailure("start delegated provider turn")));
    },
  );

  const recordCancellationCompleted = Effect.fn(
    "OrchestratorMcpService.recordCancellationCompleted",
  )(function* (input: {
    readonly taskId: ThreadId;
    readonly lineage: DelegationCreatedPayload;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly reason: "provider-interrupted" | "provider-not-active" | "start-suppressed";
  }) {
    yield* dependencies
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(
          deterministicId(
            "mcp-delegation-cancelled",
            input.taskId,
            input.lineage.requestFingerprint,
          ),
        ),
        threadId: input.taskId,
        activity: {
          id: EventId.make(
            deterministicId(
              "mcp-delegation-cancelled",
              input.taskId,
              input.lineage.requestFingerprint,
            ),
          ),
          tone: "info",
          kind: DELEGATION_CANCELLED_ACTIVITY,
          summary: "Delegated task cancelled",
          payload: {
            taskId: input.taskId,
            delegatedMessageId: input.lineage.delegatedMessageId,
            delegatedTurnId: input.turnId,
            reason: input.reason,
          },
          turnId: input.turnId,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      })
      .pipe(Effect.mapError(orchestrationFailure("record delegated-task cancellation")));
  });

  return {
    capabilities: (scope) =>
      Effect.gen(function* () {
        const parent = yield* requireActiveParent(scope);
        const providers = yield* dependencies.getProviders;
        const settings = yield* dependencies.getSettings;
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
          roles: ["architecture", "implementation", "review", "test", "research", "general"],
          wait: {
            defaultTimeoutMs: ORCHESTRATOR_MCP_DEFAULT_WAIT_TIMEOUT_MS,
            maxTimeoutMs: ORCHESTRATOR_MCP_MAX_WAIT_TIMEOUT_MS,
          },
          providers: yield* Effect.forEach(providers, (provider) =>
            providerCapability(scope, parent, settings, provider),
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
    delegateTask: (scope, input) =>
      Effect.gen(function* () {
        const parent = yield* requireActiveParent(scope);
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
    taskStatus: (scope, taskId) => readOwnedTask(scope, taskId),
    taskWait: (scope, taskId, timeoutMs) => waitForTask(scope, taskId, timeoutMs),
    taskCancel: (scope, taskId) =>
      Effect.gen(function* () {
        const current = yield* readOwnedTask(scope, taskId);
        if (isTerminalStatus(current.status)) return current;
        const threadOption = yield* loadThreadDetail(taskId);
        if (Option.isNone(threadOption)) {
          return yield* failure("task_not_found", "The delegated task was not found.");
        }
        const thread = threadOption.value;
        const lineage = findLineage(thread);
        if (lineage === null) {
          return yield* failure("task_not_found", "The delegated task was not found.");
        }
        const rows = yield* listTurns(taskId);
        const bound = rows.find(
          (row) => row.pendingMessageId === lineage.delegatedMessageId && row.turnId !== null,
        );
        const pending = rows.filter(
          (row) => row.turnId === null && row.pendingMessageId === lineage.delegatedMessageId,
        );
        const activeTurnId = thread.session?.activeTurnId ?? null;
        if (
          wasCancelRequested(thread, lineage) &&
          bound?.turnId !== null &&
          bound?.turnId !== undefined &&
          bound.state === "interrupted" &&
          activeTurnId === null
        ) {
          const completedAt = yield* dependencies.now;
          yield* recordCancellationCompleted({
            taskId,
            lineage,
            turnId: bound.turnId,
            createdAt: completedAt,
            reason: "provider-not-active",
          });
          return yield* readOwnedTask(scope, taskId);
        }
        const canInterruptBound =
          bound?.turnId !== null && bound?.turnId !== undefined && activeTurnId === bound.turnId;
        const canInterruptPending =
          bound === undefined && pending.length === 1 && activeTurnId === null;
        if (!canInterruptBound && !canInterruptPending) {
          return yield* failure(
            "task_not_cancellable",
            "The delegated turn is not the child's active or uniquely pending turn.",
          );
        }
        const now = yield* dependencies.now;
        if (!wasCancelRequested(thread, lineage)) {
          yield* dependencies
            .dispatch({
              type: "thread.activity.append",
              commandId: CommandId.make(
                deterministicId("mcp-delegation-cancel", taskId, lineage.requestFingerprint),
              ),
              threadId: taskId,
              activity: {
                id: EventId.make(
                  deterministicId("mcp-delegation-cancel", taskId, lineage.requestFingerprint),
                ),
                tone: "info",
                kind: DELEGATION_CANCEL_REQUESTED_ACTIVITY,
                summary: "Delegated task cancellation requested",
                payload: {
                  taskId,
                  delegatedMessageId: lineage.delegatedMessageId,
                  delegatedTurnId: bound?.turnId ?? null,
                },
                turnId: bound?.turnId ?? null,
                createdAt: now,
              },
              createdAt: now,
            })
            .pipe(Effect.mapError(orchestrationFailure("record delegated-task cancellation")));
        }
        const failedRequestIds = failedCancellationRequestIds(thread);
        let attempt = 1;
        let interruptCommandId = CommandId.make(
          deterministicId(
            "mcp-delegation-interrupt",
            taskId,
            lineage.requestFingerprint,
            String(attempt),
          ),
        );
        while (failedRequestIds.has(interruptCommandId)) {
          attempt += 1;
          interruptCommandId = CommandId.make(
            deterministicId(
              "mcp-delegation-interrupt",
              taskId,
              lineage.requestFingerprint,
              String(attempt),
            ),
          );
        }
        yield* dependencies
          .dispatch({
            type: "thread.turn.interrupt",
            commandId: interruptCommandId,
            threadId: taskId,
            ...(bound?.turnId === null || bound?.turnId === undefined
              ? { pendingMessageId: lineage.delegatedMessageId }
              : { turnId: bound.turnId }),
            createdAt: now,
          })
          .pipe(Effect.mapError(orchestrationFailure("interrupt delegated provider turn")));
        return yield* readOwnedTask(scope, taskId);
      }),
  };
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const turns = yield* ProjectionTurns.ProjectionTurnRepository;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const settings = yield* ServerSettingsService.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return OrchestratorMcpService.of(
    makeService({
      dispatch: engine.dispatch,
      subscribeDomainEvents: engine.subscribeDomainEvents,
      getThreadShellById: snapshots.getThreadShellById,
      getProjectShellById: snapshots.getProjectShellById,
      getThreadDetailById: snapshots.getThreadDetailById,
      listTurnsByThreadId: turns.listByThreadId,
      getProviders: providers.getProviders,
      getSettings: settings.getSettings.pipe(
        Effect.mapError(orchestrationFailure("read server settings")),
      ),
      loadPermissionEnvelope: (input) =>
        loadDelegationPermissionEnvelope(input).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      now: DateTime.now.pipe(Effect.map(DateTime.formatIso)),
    }),
  );
});

export const layer = Layer.effect(OrchestratorMcpService, make);

export const __testing = {
  makeService,
  deterministicId,
  findLineage,
  validateOptions,
};

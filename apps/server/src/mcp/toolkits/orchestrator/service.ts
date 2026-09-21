import * as NodeCrypto from "node:crypto";

import {
  BoardCard,
  BoardCardId,
  BoardCardEvent,
  CommandId,
  EventId,
  isProviderDriverKind,
  MessageId,
  ORCHESTRATOR_MCP_DEFAULT_WAIT_TIMEOUT_MS,
  ORCHESTRATOR_MCP_MAX_WAIT_TIMEOUT_MS,
  ORCHESTRATOR_MCP_PROTOCOL_VERSION,
  OrchestratorMcpBoardCreateCardInput,
  OrchestratorMcpBoardCreateCardResult,
  OrchestratorMcpBoardDeleteCardInput,
  OrchestratorMcpBoardDeleteCardResult,
  OrchestratorMcpBoardListCardsResult,
  OrchestratorMcpBoardUpdateCardInput,
  OrchestratorMcpBoardUpdateCardResult,
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
  type OrchestratorMcpSwitchProviderInput,
  type OrchestratorMcpSwitchProviderResult,
  type OrchestratorMcpSwitchedProvider,
  type OrchestratorMcpTaskCancelResult,
  type OrchestratorMcpTaskResult,
  type OrchestratorMcpTaskWaitResult,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProvider,
  type ServerSettings as ServerSettingsValue,
  type TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
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
import { deriveProviderInstanceConfigMap } from "../../../provider/Layers/ProviderInstanceRegistryHydration.ts";
import type { ProjectionTurn } from "../../../persistence/Services/ProjectionTurns.ts";
import * as ProjectionTurns from "../../../persistence/Services/ProjectionTurns.ts";
import {
  BoardRepository,
  buildBoardCardEvent,
  type BoardRepositoryShape,
} from "../../../persistence/Services/Board.ts";
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
const DELEGATION_COMPLETED_ACTIVITY = "delegation.completed";
const DELEGATION_PROVIDER_SWITCHED_ACTIVITY = "delegation.provider-switched";
const DELEGATION_ACTIVITY_VERSION = 1 as const;
const TASK_ACTIVITY_KINDS = [
  DELEGATION_CREATED_ACTIVITY,
  DELEGATION_CANCEL_REQUESTED_ACTIVITY,
  DELEGATION_CANCELLED_ACTIVITY,
  DELEGATION_PROVIDER_BOUND_ACTIVITY,
  DELEGATION_MODEL_OBSERVED_ACTIVITY,
  DELEGATION_COMPLETED_ACTIVITY,
  DELEGATION_PROVIDER_SWITCHED_ACTIVITY,
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

interface TargetParentContext {
  readonly thread: OrchestrationThreadShell;
  readonly project: OrchestrationProjectShell;
  readonly scope: NonNullable<McpInvocationScope["orchestration"]>;
}

interface ParentContext extends TargetParentContext {
  readonly activeTurnId: TurnId;
}

type TargetResolutionRequest = Pick<
  OrchestratorMcpDelegateTaskInput,
  "target" | "runtimeMode" | "interactionMode"
>;

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

interface DelegationProviderSwitchedPayload {
  readonly version: typeof DELEGATION_ACTIVITY_VERSION;
  readonly taskId: ThreadId;
  // Null for an ordinary-thread switch: the thread carries no delegated
  // message, the scope is the thread itself.
  readonly delegatedMessageId: MessageId | null;
  readonly oldProvider: {
    readonly providerInstanceId: OrchestratorMcpRequestedIdentity["providerInstanceId"];
    readonly driverKind: OrchestratorMcpRequestedIdentity["driverKind"];
    readonly model: string;
  };
  readonly requested: OrchestratorMcpRequestedIdentity;
  readonly reason: string;
  readonly scope: {
    readonly messageCount: number;
    readonly pendingCount: number;
    readonly lineagePreserved: true;
  };
  readonly switchedAt: string;
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
  /** Optional so non-MCP constructors keep working; board tools fail closed without it. */
  readonly board?: BoardRepositoryShape;
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
  readonly switchProvider: (
    scope: McpInvocationScope,
    input: OrchestratorMcpSwitchProviderInput,
  ) => Effect.Effect<OrchestratorMcpSwitchProviderResult, OrchestratorMcpFailure>;
  readonly boardCreateCard: (
    scope: McpInvocationScope,
    input: OrchestratorMcpBoardCreateCardInput,
  ) => Effect.Effect<OrchestratorMcpBoardCreateCardResult, OrchestratorMcpFailure>;
  readonly boardUpdateCard: (
    scope: McpInvocationScope,
    input: OrchestratorMcpBoardUpdateCardInput,
  ) => Effect.Effect<OrchestratorMcpBoardUpdateCardResult, OrchestratorMcpFailure>;
  readonly boardDeleteCard: (
    scope: McpInvocationScope,
    input: OrchestratorMcpBoardDeleteCardInput,
  ) => Effect.Effect<OrchestratorMcpBoardDeleteCardResult, OrchestratorMcpFailure>;
  readonly boardListCards: (
    scope: McpInvocationScope,
  ) => Effect.Effect<OrchestratorMcpBoardListCardsResult, OrchestratorMcpFailure>;
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

function requestedModelSelection(input: TargetResolutionRequest): ModelSelection {
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

  // Every parent_not_active refusal carries a stable [reason=...] token.
  // The code stays a single literal for contract compatibility, but agents
  // can no longer mistake a transient projection lag for a dead session:
  // "settle" reasons deserve one retry after the turn settles, "stale"
  // reasons mean the credential no longer matches this thread.
  const parentNotActive = (reason: string, message: string, hint: string) =>
    failure("parent_not_active", `${message} [reason=${reason}] ${hint}`);
  // Parent shells without an active-turn requirement. taskCancel,
  // taskStatus/taskWait, and switchProvider only need capability plus
  // ownership: the parent may legitimately be waiting on the child.
  const loadSwitchParent = (
    scope: McpInvocationScope,
  ): Effect.Effect<TargetParentContext, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const frozen = yield* requireCapability(scope);
      const threadOption = yield* loadThreadShell(scope.threadId);
      if (Option.isNone(threadOption)) {
        return yield* parentNotActive(
          "parent_thread_gone",
          "The parent thread no longer exists.",
          "Do not retry delegation; report reason parent_thread_gone.",
        );
      }
      const thread = threadOption.value;
      const projectOption = yield* loadProjectShell(thread.projectId);
      if (Option.isNone(projectOption)) {
        return yield* parentNotActive(
          "parent_project_gone",
          "The parent project no longer exists.",
          "Do not retry delegation; report reason parent_project_gone.",
        );
      }
      const project = projectOption.value;
      const worktreePath = thread.worktreePath ?? project.workspaceRoot;
      if (
        frozen.projectId !== thread.projectId ||
        frozen.runtimeMode !== thread.runtimeMode ||
        frozen.interactionMode !== thread.interactionMode ||
        frozen.branch !== thread.branch ||
        frozen.workspaceRoot !== project.workspaceRoot ||
        frozen.worktreePath !== worktreePath
      ) {
        return yield* parentNotActive(
          "parent_scope_drift",
          "The active parent no longer matches the permission scope frozen for this MCP session.",
          "The thread moved project, mode, branch, or worktree after this credential was issued. Do not retry in a loop; report reason parent_scope_drift.",
        );
      }
      return { thread, project, scope: frozen };
    });

  const requireActiveParent = (
    scope: McpInvocationScope,
  ): Effect.Effect<ParentContext, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const base = yield* loadSwitchParent(scope);
      const thread = base.thread;
      const activeTurnId = thread.session?.activeTurnId;
      if (activeTurnId === null || activeTurnId === undefined) {
        return yield* parentNotActive(
          "parent_no_active_turn",
          "Delegation requires an active parent turn owned by this provider session.",
          "The parent turn is not running right now. Retry once after the turn state settles; if the reason repeats, report it instead of retrying in a loop.",
        );
      }
      if (thread.latestTurn?.turnId !== activeTurnId) {
        return yield* parentNotActive(
          "parent_turn_mismatch",
          "Delegation requires an active parent turn owned by this provider session.",
          "The latest turn is not the session's active turn (a steered message may still be settling). Retry once after the turn state settles; if the reason repeats, report it instead of retrying in a loop.",
        );
      }
      if (thread.latestTurn.state !== "running") {
        return yield* parentNotActive(
          "parent_turn_not_running",
          "Delegation requires an active parent turn owned by this provider session.",
          "The active parent turn is not running. Retry once after the turn state settles; if the reason repeats, report it instead of retrying in a loop.",
        );
      }
      if (thread.session?.providerInstanceId !== scope.providerInstanceId) {
        return yield* parentNotActive(
          "parent_session_instance_changed",
          "Delegation requires an active parent turn owned by this provider session.",
          "The thread moved to another provider instance, so this credential is stale. Do not retry in a loop; report reason parent_session_instance_changed.",
        );
      }
      return { ...base, activeTurnId };
    });

  const resolveTarget = (
    scope: McpInvocationScope,
    parent: TargetParentContext,
    input: TargetResolutionRequest,
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

  // Capability gate for a provider switch. Unlike resolveTarget (which keeps
  // delegateTask's historical codes), an existing-but-unusable target is an
  // explicit handoff refusal: the provider cannot accept the thread's
  // history, pending queue, and lineage.
  const resolveSwitchTarget = (
    scope: McpInvocationScope,
    parent: TargetParentContext,
    child: OrchestrationThread,
    target: OrchestratorMcpDelegateTaskInput["target"],
  ): Effect.Effect<ResolvedTarget, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const providers = yield* dependencies.getProviders;
      const provider = providers.find(
        (candidate) => candidate.instanceId === target.providerInstanceId,
      );
      if (provider === undefined) {
        return yield* failure(
          "provider_unavailable",
          `Provider instance ${target.providerInstanceId} is not registered.`,
        );
      }
      if (provider.driver !== target.driverKind) {
        return yield* failure(
          "provider_unavailable",
          `Provider instance ${provider.instanceId} uses driver ${provider.driver}, not ${target.driverKind}.`,
        );
      }
      const unavailableReason = providerUnavailableReason(provider);
      if (unavailableReason !== null) {
        return yield* failure(
          "provider_handoff_unsupported",
          `Provider instance ${provider.instanceId} cannot accept a handoff: ${unavailableReason}`,
        );
      }
      const model = provider.models.find((candidate) => candidate.slug === target.model);
      if (model === undefined) {
        return yield* failure(
          "model_unavailable",
          `Model ${target.model} is not advertised by provider ${provider.instanceId}.`,
        );
      }
      const invalidOptions = validateOptions(
        target.options ?? [],
        model.capabilities?.optionDescriptors,
      );
      if (invalidOptions.length > 0) {
        return yield* failure("invalid_model_options", invalidOptions.join(" "));
      }
      const settings = yield* dependencies.getSettings;
      const instanceConfig = deriveProviderInstanceConfigMap(settings)[target.providerInstanceId];
      if (instanceConfig === undefined || instanceConfig.driver !== target.driverKind) {
        return yield* failure(
          "provider_unavailable",
          `Provider instance ${target.providerInstanceId} has no matching effective configuration.`,
        );
      }
      const runtimeMode = child.runtimeMode;
      const interactionMode = child.interactionMode;
      const permissionEnvelope = yield* dependencies.loadPermissionEnvelope({
        driverKind: target.driverKind,
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
      if (!comparison.allowed) {
        return yield* failure(
          "provider_handoff_unsupported",
          `Provider instance ${provider.instanceId} cannot accept a handoff: ${comparison.reason}`,
        );
      }
      if (permissionEnvelope.status !== "verified") {
        return yield* failure(
          "provider_handoff_unsupported",
          `Provider instance ${provider.instanceId} cannot accept a handoff: ${permissionEnvelope.reason}`,
        );
      }
      return {
        provider,
        instanceConfig,
        modelSelection: requestedModelSelection({ target }),
        requested: {
          providerInstanceId: target.providerInstanceId,
          driverKind: target.driverKind,
          model: target.model,
          options: target.options ?? [],
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
          : orchestrationFailure("resolve switch provider target")(error),
      ),
    );

  // Identity of the provider an ordinary thread runs on, for the switch
  // record. The session owns it; the stored model selection is the fallback
  // when the session predates the instance id. Unlike the target, the old
  // provider is never availability-gated — an exhausted provider is the
  // reason to switch.
  const resolveOrdinaryOldProvider = Effect.fn("OrchestratorMcpService.resolveOrdinaryOldProvider")(
    function* (
      thread: OrchestrationThread,
      session: NonNullable<OrchestrationThreadShell["session"]>,
    ) {
      const providers = yield* dependencies.getProviders;
      const instanceId = session.providerInstanceId ?? thread.modelSelection.instanceId;
      const driverKind =
        providers.find((candidate) => candidate.instanceId === instanceId)?.driver ??
        (isProviderDriverKind(session.providerName) ? session.providerName : undefined);
      if (driverKind === undefined) {
        return yield* failure(
          "orchestration_error",
          `Could not determine the thread's current provider for instance ${instanceId}.`,
        );
      }
      return {
        providerInstanceId: instanceId,
        driverKind,
        model: thread.modelSelection.model,
      };
    },
  );

  // Provider switch for an ordinary (non-delegated) thread: the scope is the
  // thread itself, so no delegation lineage is required. Message history and
  // the pending queue are preserved by construction — the switch only
  // repoints the thread's default provider and records the switch. Failure
  // codes match the delegated path. The switch never starts a turn: queued
  // and running work drains on the old provider, the next send uses the new
  // one, and the result carries no owned task.
  const switchOrdinaryThread = Effect.fn("OrchestratorMcpService.switchOrdinaryThread")(function* (
    scope: McpInvocationScope,
    input: OrchestratorMcpSwitchProviderInput,
    thread: OrchestrationThread,
  ) {
    const parent = yield* loadSwitchParent(scope);
    const session = parent.thread.session;
    if (session === null || session === undefined) {
      return yield* parentNotActive(
        "parent_no_session",
        "Switching providers requires a provider session on this thread.",
        "Start the thread with a provider first; a thread that never ran has no provider to switch from.",
      );
    }
    const target = yield* resolveSwitchTarget(scope, parent, thread, input.target);
    // The history is the handoff: a thread with no messages cannot be
    // carried to a new provider and cannot be advanced.
    if (thread.messages.length === 0) {
      return yield* failure(
        "thread_has_no_history",
        "The thread has no message history to hand off. Send a message first, then switch providers.",
      );
    }
    const oldProvider = yield* resolveOrdinaryOldProvider(thread, session);
    const switchedAt = yield* dependencies.now;
    yield* dependencies
      .dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make(
          deterministicId(
            "mcp-provider-switch-meta",
            input.taskId,
            target.requested.providerConfigFingerprint,
          ),
        ),
        threadId: input.taskId,
        modelSelection: target.modelSelection,
      })
      .pipe(Effect.mapError(orchestrationFailure("repoint thread provider")));
    const rows = yield* listTurns(input.taskId);
    const pendingCount = rows.filter((row) => row.turnId === null).length;
    const switchScope = {
      messageCount: thread.messages.length,
      pendingCount,
      lineagePreserved: true as const,
    };
    const payload: DelegationProviderSwitchedPayload = {
      version: DELEGATION_ACTIVITY_VERSION,
      taskId: input.taskId,
      delegatedMessageId: null,
      oldProvider,
      requested: target.requested,
      reason: input.reason,
      scope: switchScope,
      switchedAt,
    };
    yield* dependencies
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(
          deterministicId(
            "mcp-provider-switch-lineage",
            input.taskId,
            target.requested.providerConfigFingerprint,
          ),
        ),
        threadId: input.taskId,
        activity: {
          id: EventId.make(
            deterministicId(
              "mcp-provider-switch-lineage",
              input.taskId,
              target.requested.providerConfigFingerprint,
            ),
          ),
          tone: "info",
          kind: DELEGATION_PROVIDER_SWITCHED_ACTIVITY,
          summary: "Thread switched provider",
          payload,
          turnId: thread.latestTurn?.turnId ?? null,
          createdAt: switchedAt,
        },
        createdAt: switchedAt,
      })
      .pipe(Effect.mapError(orchestrationFailure("persist provider-switch lineage")));
    return {
      taskId: input.taskId,
      switchedAt,
      oldProvider,
      requested: target.requested,
      reason: input.reason,
      scope: switchScope,
      advanced: false,
      task: null,
    };
  });

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
    providerInstances: ProviderInstanceConfigMap,
    provider: ServerProvider,
  ) {
    const unavailable = providerUnavailableReason(provider);
    const instanceConfig = providerInstances[provider.instanceId];
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

  const requireBoardRepository = (): Effect.Effect<BoardRepositoryShape, OrchestratorMcpFailure> =>
    dependencies.board === undefined
      ? Effect.fail(
          failure(
            "orchestration_error",
            "The board repository is unavailable in this server composition.",
          ),
        )
      : Effect.succeed(dependencies.board);

  // Creating a card is the one board write a non-orchestrator could otherwise
  // reach, so the caller must be a marked orchestrator before any card exists.
  const requireRegisteredOrchestrator = (
    repo: BoardRepositoryShape,
    scope: McpInvocationScope,
  ): Effect.Effect<void, OrchestratorMcpFailure> =>
    repo.listOrchestrators().pipe(
      Effect.mapError(orchestrationFailure("list board orchestrators")),
      Effect.flatMap((orchestrators) =>
        orchestrators.some((orchestrator) => orchestrator.threadId === scope.threadId)
          ? Effect.void
          : Effect.fail(
              failure(
                "capability_denied",
                "This thread is not a registered board orchestrator, so it has no board.",
              ),
            ),
      ),
    );

  // Ownership failure is reported as task_not_found so a card's existence never
  // leaks across orchestrator threads.
  const requireOwnedCard = (
    repo: BoardRepositoryShape,
    scope: McpInvocationScope,
    cardId: BoardCardId,
  ): Effect.Effect<BoardCard, OrchestratorMcpFailure> =>
    repo.getCard(cardId).pipe(
      Effect.mapError(orchestrationFailure(`read board card ${cardId}`)),
      Effect.flatMap((option) => {
        if (Option.isNone(option) || option.value.orchestratorThreadId !== scope.threadId) {
          return Effect.fail(failure("task_not_found", "The board card was not found."));
        }
        return Effect.succeed(option.value);
      }),
    );

  const nowIso = () => dependencies.now;

  return {
    capabilities: (scope) =>
      Effect.gen(function* () {
        const parent = yield* requireActiveParent(scope);
        const providers = yield* dependencies.getProviders;
        const settings = yield* dependencies.getSettings;
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
          roles: ["architecture", "implementation", "review", "test", "research", "general"],
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
    switchProvider: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const threadOption = yield* loadThreadDetail(input.taskId);
        if (Option.isNone(threadOption)) {
          return yield* failure("task_not_found", "The delegated task was not found.");
        }
        const thread = threadOption.value;
        const lineage = findLineage(thread);
        if (
          lineage === null ||
          lineage.taskId !== input.taskId ||
          lineage.childThreadId !== input.taskId ||
          lineage.parentThreadId !== scope.threadId ||
          lineage.parentEnvironmentId !== scope.environmentId
        ) {
          // No owned delegation lineage. An ordinary thread switches itself
          // (task = scope thread, no lineage); anything else stays hidden
          // behind task_not_found so task existence never leaks across
          // ownership.
          if (input.taskId !== scope.threadId || lineage !== null) {
            return yield* failure("task_not_found", "The delegated task was not found.");
          }
          return yield* switchOrdinaryThread(scope, input, thread);
        }
        const current = yield* readOwnedTask(scope, input.taskId);
        // A completed delegated turn still owns a live child thread: switching
        // it repoints the provider used by the next child turn. It must not
        // replay the already-completed work. Cancellation remains terminal so
        // a provider switch cannot accidentally resurrect a cancelled task.
        if (current.status === "cancelled") {
          return yield* failure(
            "task_not_cancellable",
            "A cancelled delegated task cannot switch providers.",
          );
        }
        const parent = yield* loadSwitchParent(scope);
        const target = yield* resolveSwitchTarget(scope, parent, thread, input.target);
        // The original prompt survives only as fingerprints in lineage, so a
        // thread with no messages cannot be carried to a new provider and
        // cannot be advanced: refuse instead of recording a no-op switch.
        if (thread.messages.length === 0) {
          return yield* failure(
            "thread_has_no_history",
            "The delegated thread has no message history to hand off. Create a fresh delegation instead.",
          );
        }
        const switchedAt = yield* dependencies.now;
        const oldProvider = {
          providerInstanceId: lineage.requested.providerInstanceId,
          driverKind: lineage.requested.driverKind,
          model: lineage.requested.model,
        };
        yield* dependencies
          .dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make(
              deterministicId(
                "mcp-provider-switch-meta",
                input.taskId,
                target.requested.providerConfigFingerprint,
              ),
            ),
            threadId: input.taskId,
            modelSelection: target.modelSelection,
          })
          .pipe(Effect.mapError(orchestrationFailure("repoint delegated thread provider")));
        const rows = yield* listTurns(input.taskId);
        const matchingRows = rows.filter(
          (row) => row.pendingMessageId === lineage.delegatedMessageId,
        );
        const concrete = matchingRows.find(
          (row): row is ProjectionTurn & { readonly turnId: TurnId } => row.turnId !== null,
        );
        const pendingCount = matchingRows.filter((row) => row.turnId === null).length;
        const switchScope = {
          messageCount: thread.messages.length,
          pendingCount,
          lineagePreserved: true as const,
        };
        const payload: DelegationProviderSwitchedPayload = {
          version: DELEGATION_ACTIVITY_VERSION,
          taskId: input.taskId,
          delegatedMessageId: lineage.delegatedMessageId,
          oldProvider,
          requested: target.requested,
          reason: input.reason,
          scope: switchScope,
          switchedAt,
        };
        yield* dependencies
          .dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(
              deterministicId(
                "mcp-provider-switch-lineage",
                input.taskId,
                target.requested.providerConfigFingerprint,
              ),
            ),
            threadId: input.taskId,
            activity: {
              id: EventId.make(
                deterministicId(
                  "mcp-provider-switch-lineage",
                  input.taskId,
                  target.requested.providerConfigFingerprint,
                ),
              ),
              tone: "info",
              kind: DELEGATION_PROVIDER_SWITCHED_ACTIVITY,
              summary: "Delegated task switched provider",
              payload,
              turnId: concrete?.turnId ?? null,
              createdAt: switchedAt,
            },
            createdAt: switchedAt,
          })
          .pipe(Effect.mapError(orchestrationFailure("persist provider-switch lineage")));
        // Advance only when nothing is queued or bound yet: the delegated
        // turn was rejected or suppressed before it could start, and the
        // stored prompt is replayed on the new provider. A queued or running
        // turn is never restarted; it drains on the old provider.
        let advanced = false;
        if (concrete === undefined && pendingCount === 0) {
          const delegatedMessage = thread.messages.find(
            (message) => message.id === lineage.delegatedMessageId && message.role === "user",
          );
          if (delegatedMessage !== undefined) {
            yield* dependencies
              .dispatch({
                type: "thread.turn.start",
                commandId: CommandId.make(
                  deterministicId(
                    "mcp-provider-switch-start",
                    input.taskId,
                    target.requested.providerConfigFingerprint,
                  ),
                ),
                threadId: input.taskId,
                message: {
                  messageId: lineage.delegatedMessageId,
                  role: "user",
                  text: delegatedMessage.text,
                  attachments: [],
                },
                modelSelection: target.modelSelection,
                runtimeMode: lineage.requested.runtimeMode,
                interactionMode: lineage.requested.interactionMode,
                delegationConfigFingerprint: target.requested.providerConfigFingerprint,
                createdAt: switchedAt,
              })
              .pipe(Effect.mapError(orchestrationFailure("start switched provider turn")));
            advanced = true;
          }
        }
        const task = yield* readOwnedTask(scope, input.taskId);
        return {
          taskId: input.taskId,
          switchedAt,
          oldProvider,
          requested: target.requested,
          reason: input.reason,
          scope: switchScope,
          advanced,
          task,
        };
      }),
    boardCreateCard: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const repo = yield* requireBoardRepository();
        yield* requireRegisteredOrchestrator(repo, scope);
        const at = yield* nowIso();
        const card: BoardCard = {
          cardId: BoardCardId.make(NodeCrypto.randomUUID()),
          orchestratorThreadId: scope.threadId,
          title: input.title,
          body: input.body,
          status: input.status ?? "orchestrator",
          createdBy: "orchestrator",
          assignee: input.assignee ?? null,
          executorRole: input.executorRole,
          executorThreadId: null,
          outcome: null,
          lastError: null,
          failureStreak: 0,
          order: 0,
          archived: false,
          createdAt: at,
          updatedAt: at,
        };
        yield* repo
          .createCard(card)
          .pipe(Effect.mapError(orchestrationFailure("create board card")));
        yield* repo
          .appendEvent(buildBoardCardEvent(card, { at }))
          .pipe(Effect.mapError(orchestrationFailure("append board card event")));
        return card;
      }),
    boardUpdateCard: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const repo = yield* requireBoardRepository();
        const card = yield* requireOwnedCard(repo, scope, BoardCardId.make(input.cardId));
        const at = yield* nowIso();
        const statusChanged = input.status !== undefined && input.status !== card.status;
        const executorChanged =
          (input.executorRole !== undefined && input.executorRole !== card.executorRole) ||
          (input.executorThreadId !== undefined &&
            input.executorThreadId !== card.executorThreadId) ||
          (input.assignee !== undefined && !Equal.equals(input.assignee, card.assignee));
        const next: BoardCard = {
          ...card,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.executorRole === undefined ? {} : { executorRole: input.executorRole }),
          ...(input.assignee === undefined ? {} : { assignee: input.assignee }),
          ...(input.executorThreadId === undefined
            ? {}
            : { executorThreadId: input.executorThreadId }),
          ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
          ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
          ...(input.failureStreak === undefined ? {} : { failureStreak: input.failureStreak }),
          ...(input.order === undefined ? {} : { order: input.order }),
          ...(input.archived === undefined ? {} : { archived: input.archived }),
          updatedAt: at,
        };
        // The reactor matches cards by executor thread; without a linked
        // executor and model a card would sit in progress forever.
        if (
          next.status === "in_progress" &&
          (next.executorThreadId === null || next.assignee === null)
        ) {
          return yield* failure(
            "executor_required",
            "Link assignee and executorThreadId before moving a card to in_progress.",
          );
        }
        yield* repo
          .updateCard(next)
          .pipe(Effect.mapError(orchestrationFailure("update board card")));
        if (statusChanged || executorChanged) {
          const body = statusChanged
            ? `status -> ${next.status}`
            : `executor -> ${next.executorRole}`;
          yield* repo
            .appendEvent(buildBoardCardEvent(next, { at, body }))
            .pipe(Effect.mapError(orchestrationFailure("append board card event")));
        }
        return next;
      }),
    boardDeleteCard: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const repo = yield* requireBoardRepository();
        const cardId = BoardCardId.make(input.cardId);
        yield* requireOwnedCard(repo, scope, cardId);
        yield* repo
          .deleteCard(cardId)
          .pipe(Effect.mapError(orchestrationFailure("delete board card")));
        return {};
      }),
    boardListCards: (scope) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const repo = yield* requireBoardRepository();
        const [cards, events] = yield* Effect.all([
          repo.listCards().pipe(Effect.mapError(orchestrationFailure("list board cards"))),
          repo.listEvents().pipe(Effect.mapError(orchestrationFailure("list board card events"))),
        ]);
        const eventsByCard = new Map<BoardCardId, Array<BoardCardEvent>>();
        for (const event of events) {
          const bucket = eventsByCard.get(event.cardId);
          if (bucket === undefined) eventsByCard.set(event.cardId, [event]);
          else bucket.push(event);
        }
        const owned = cards
          .filter((card) => card.orchestratorThreadId === scope.threadId)
          .toSorted((left, right) =>
            left.order === right.order
              ? left.cardId.localeCompare(right.cardId)
              : left.order - right.order,
          );
        return {
          cards: owned.map((card) => ({ card, events: eventsByCard.get(card.cardId) ?? [] })),
        };
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
  // serviceOption keeps the toolkit bootable when the board persistence layer
  // is absent; the board tools then fail closed at call time.
  const board = yield* Effect.serviceOption(BoardRepository).pipe(
    Effect.map(Option.getOrUndefined),
  );
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
      ...(board === undefined ? {} : { board }),
    }),
  );
});

export const layer = Layer.effect(OrchestratorMcpService, make);

/**
 * Build the orchestrator service from explicit dependencies without going
 * through the Layer stack. The UI `thread.switch-provider` dispatch handler
 * serves the same `switchProvider` engine outside an MCP session, so it
 * constructs the service directly from the WS handler's services.
 */
export function createOrchestratorMcpService(
  dependencies: OrchestratorMcpDependencies,
): OrchestratorMcpServiceShape {
  return makeService(dependencies);
}

export const __testing = {
  makeService,
  deterministicId,
  findLineage,
  validateOptions,
};

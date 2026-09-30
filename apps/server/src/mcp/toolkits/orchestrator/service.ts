import * as NodeCrypto from "node:crypto";

import {
  ARCHITECT_BOUND_ACTIVITY,
  ARCHITECT_UNBOUND_ACTIVITY,
  COORDINATOR_ARCHITECT_ACTIVITY_KINDS,
  PUBLISH_WAKE_DELIVERED_ACTIVITY,
  REVIEW_ANSWERED_ACTIVITY,
  REVIEW_CANCELLED_ACTIVITY,
  REVIEW_PUBLISHED_ACTIVITY,
  REVIEW_REQUESTED_ACTIVITY,
  REVIEW_REQUESTED_REF_ACTIVITY,
  REVIEW_WAKE_DELIVERED_ACTIVITY,
  assertNotArchitectThread,
  hasPublishWakeDelivered,
  hasReviewWakeDelivered,
  needsPublishWakeReplay,
  needsReviewWakeReplay,
  publishWakeDeliveredMarkerId,
  publishWakeMessageId,
  publishWakeTurnCommandId,
  reviewRefCommandId,
  reviewWakeDeliveredMarkerId,
  reviewWakeMessageId,
  reviewWakeTurnCommandId,
} from "../../../orchestration/coordinatorArchitect.ts";
import {
  ArchitectureReviewRefs,
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
  ORCHESTRATOR_MCP_TASK_PAGE_MAX,
  ORCHESTRATOR_MCP_TASK_SOURCE_TURN_IDS_MAX,
  EXECUTOR_ROLES,
  OrchestratorMcpArchitectCreateOrGetResult,
  OrchestratorMcpArchitectDetachResult,
  OrchestratorMcpArchitectReplaceResult,
  OrchestratorMcpBoardCreateCardInput,
  OrchestratorMcpBoardCreateCardResult,
  OrchestratorMcpBoardDeleteCardInput,
  OrchestratorMcpBoardDeleteCardResult,
  OrchestratorMcpBoardListCardsResult,
  OrchestratorMcpBoardUpdateCardInput,
  OrchestratorMcpBoardUpdateCardResult,
  OrchestratorMcpFailure,
  OrchestratorMcpGetCoordinatorBindingResult,
  OrchestratorMcpListArchitectureReviewsResult,
  OrchestratorMcpPublishToCoordinatorResult,
  OrchestratorMcpRequestedIdentity,
  OrchestratorMcpReviewAnswerResult,
  OrchestratorMcpReviewCancelResult,
  OrchestratorMcpReviewRequestResult,
  OrchestratorMcpSendToTaskResult,
  OrchestratorMcpTaskListInput,
  OrchestratorMcpTaskListResult,
  OrchestratorMcpTaskMemoryEntry,
  OrchestratorMcpTaskReadInput,
  OrchestratorMcpTaskReadResult,
  OrchestratorMcpTaskSearchInput,
  OrchestratorMcpTaskSearchResult,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type ArchitectureReviewRecord,
  type CoordinatorArchitectBinding,
  type CoordinatorArchitectRoutingEvidence,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type OrchestratorMcpArchitectCreateOrGetInput,
  type OrchestratorMcpArchitectDetachInput,
  type OrchestratorMcpArchitectReplaceInput,
  type OrchestratorMcpCapabilitiesResult,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpGetCoordinatorBindingInput,
  type OrchestratorMcpListArchitectureReviewsInput,
  type OrchestratorMcpPublishToCoordinatorInput,
  type OrchestratorMcpReviewAnswerInput,
  type OrchestratorMcpReviewCancelInput,
  type OrchestratorMcpReviewRequestInput,
  type OrchestratorMcpDelegateTaskResult,
  type OrchestratorMcpFailureCode,
  type OrchestratorMcpHandoff,
  type OrchestratorMcpPermissionEnvelopeSummary,
  type OrchestratorMcpProviderCapability,
  type OrchestratorMcpSendToTaskInput,
  type OrchestratorMcpSwitchProviderInput,
  type OrchestratorMcpSwitchProviderResult,
  type OrchestratorMcpSwitchedProvider,
  type OrchestratorMcpTaskCancelResult,
  type OrchestratorMcpTaskStatus,
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
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  compareDelegationPermissionEnvelopes,
  loadDelegationPermissionEnvelope,
  recoverDelegationChildCaps,
  sanitizeDelegationChildCapsSnapshot,
} from "../../../provider/DelegationPermissionEnvelope.ts";
import type { DelegationPermissionEnvelopeInput } from "../../../provider/DelegationPermissionEnvelope.ts";
import { deriveProviderInstanceConfigMap } from "../../../provider/Layers/ProviderInstanceRegistryHydration.ts";
import type { ProjectionTurn } from "../../../persistence/Services/ProjectionTurns.ts";
import * as ProjectionTurns from "../../../persistence/Services/ProjectionTurns.ts";
import { scrubDelegatedTaskText } from "../../../DelegatedTaskMemoryText.ts";
import {
  BoardRepository,
  buildBoardCardEvent,
  type BoardRepositoryShape,
} from "../../../persistence/Services/Board.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as ServerSettingsService from "../../../serverSettings.ts";
import {
  CoordinatorArchitectIdempotencyConflict,
  CoordinatorArchitectRepository,
  type CoordinatorArchitectRepositoryShape,
} from "../../../persistence/Services/CoordinatorArchitect.ts";
import { OrchestrationCommandReceiptRepository } from "../../../persistence/Services/OrchestrationCommandReceipts.ts";
import { McpSessionRegistry } from "../../McpSessionRegistry.ts";
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
const DELEGATION_FOLLOW_UP_QUEUED_ACTIVITY = "delegation.follow-up-queued";
const DELEGATION_ACTIVITY_VERSION = 1 as const;
const TASK_SEARCH_BATCH_SIZE = ORCHESTRATOR_MCP_TASK_PAGE_MAX;
const TASK_SEARCH_MAX_SCAN = 500;
const TASK_ACTIVITY_KINDS = [
  DELEGATION_CREATED_ACTIVITY,
  DELEGATION_CANCEL_REQUESTED_ACTIVITY,
  DELEGATION_CANCELLED_ACTIVITY,
  DELEGATION_PROVIDER_BOUND_ACTIVITY,
  DELEGATION_MODEL_OBSERVED_ACTIVITY,
  DELEGATION_COMPLETED_ACTIVITY,
  DELEGATION_PROVIDER_SWITCHED_ACTIVITY,
  DELEGATION_FOLLOW_UP_QUEUED_ACTIVITY,
  "provider.turn.start.failed",
  "provider.turn.interrupt.failed",
  "approval.requested",
  "approval.resolved",
  "user-input.requested",
  "user-input.resolved",
  ...COORDINATOR_ARCHITECT_ACTIVITY_KINDS,
] as const;
const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);
const isCoordinatorArchitectIdempotencyConflict = Schema.is(
  CoordinatorArchitectIdempotencyConflict,
);
const isOrchestratorMcpRequestedIdentity = Schema.is(OrchestratorMcpRequestedIdentity);
const isOrchestratorMcpSendToTaskResult = Schema.is(OrchestratorMcpSendToTaskResult);

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
  // Additive snapshot of the canonical frozen child caps used for the
  // delegation fingerprint. Legacy lineage omits it and is recovered by
  // exact-subset search instead.
  readonly childCaps?: ReadonlyArray<string>;
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
  // Durable transition lineage: this record's own transition hash. The next
  // switch folds it in as prev, so every command ID carries the whole switch
  // history and even an exact A→B→A→B cycle mints distinct IDs.
  // Pre-chain records omit it and read back as genesis (null prev).
  readonly prevTransition: string | null;
}

interface DelegationFollowUpQueuedPayload {
  readonly version: typeof DELEGATION_ACTIVITY_VERSION;
  readonly taskId: ThreadId;
  readonly parentEnvironmentId: string;
  readonly parentThreadId: ThreadId;
  readonly idempotencyKeyFingerprint: string;
  readonly requestFingerprint: string;
  readonly result: OrchestratorMcpSendToTaskResult;
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
  readonly getShellSnapshot?: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["getShellSnapshot"];
  readonly getArchivedShellSnapshot?: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["getArchivedShellSnapshot"];
  readonly getThreadDetailSnapshotIncludingArchived?: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["getThreadDetailSnapshotIncludingArchived"];
  readonly listDelegatedTaskMemoryRows?: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["listDelegatedTaskMemoryRows"];
  readonly listTurnsByThreadId: ProjectionTurns.ProjectionTurnRepositoryShape["listByThreadId"];
  readonly getProviders: ProviderRegistry.ProviderRegistryShape["getProviders"];
  readonly getSettings: Effect.Effect<ServerSettingsValue, OrchestratorMcpFailure>;
  readonly loadPermissionEnvelope: (
    input: DelegationPermissionEnvelopeInput,
  ) => Effect.Effect<OrchestratorMcpPermissionEnvelopeSummary>;
  readonly now: Effect.Effect<string>;
  /** Optional so non-MCP constructors keep working; board tools fail closed without it. */
  readonly board?: BoardRepositoryShape;
  /** Optional so non-MCP constructors keep working; architect/review tools fail closed without it. */
  readonly coordinatorArchitect?: CoordinatorArchitectRepositoryShape;
  /** Durable create receipt distinguishes a binding-first crash from a later missing thread. */
  readonly getArchitectCreateReceiptStatus?: (
    bindingId: string,
  ) => Effect.Effect<"accepted" | "rejected" | "missing" | "unavailable", OrchestratorMcpFailure>;
  /** Optional credential revocation; the durable binding check stays the primary deny without it. */
  readonly revokeThreadCredential?: (
    threadId: ThreadId,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
}

export interface OrchestratorMcpServiceShape {
  readonly capabilities: (
    scope: McpInvocationScope,
  ) => Effect.Effect<OrchestratorMcpCapabilitiesResult, OrchestratorMcpFailure>;
  readonly delegateTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpDelegateTaskInput,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;
  readonly sendToTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpSendToTaskInput,
  ) => Effect.Effect<OrchestratorMcpSendToTaskResult, OrchestratorMcpFailure>;
  readonly taskList: (
    scope: McpInvocationScope,
    input: OrchestratorMcpTaskListInput,
  ) => Effect.Effect<OrchestratorMcpTaskListResult, OrchestratorMcpFailure>;
  readonly taskSearch: (
    scope: McpInvocationScope,
    input: OrchestratorMcpTaskSearchInput,
  ) => Effect.Effect<OrchestratorMcpTaskSearchResult, OrchestratorMcpFailure>;
  readonly taskRead: (
    scope: McpInvocationScope,
    input: OrchestratorMcpTaskReadInput,
  ) => Effect.Effect<OrchestratorMcpTaskReadResult, OrchestratorMcpFailure>;
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
  readonly architectCreateOrGet: (
    scope: McpInvocationScope,
    input: OrchestratorMcpArchitectCreateOrGetInput,
  ) => Effect.Effect<OrchestratorMcpArchitectCreateOrGetResult, OrchestratorMcpFailure>;
  readonly architectReplace: (
    scope: McpInvocationScope,
    input: OrchestratorMcpArchitectReplaceInput,
  ) => Effect.Effect<OrchestratorMcpArchitectReplaceResult, OrchestratorMcpFailure>;
  readonly architectDetach: (
    scope: McpInvocationScope,
    input: OrchestratorMcpArchitectDetachInput,
  ) => Effect.Effect<OrchestratorMcpArchitectDetachResult, OrchestratorMcpFailure>;
  readonly architectureReviewRequest: (
    scope: McpInvocationScope,
    input: OrchestratorMcpReviewRequestInput,
  ) => Effect.Effect<OrchestratorMcpReviewRequestResult, OrchestratorMcpFailure>;
  readonly architectureReviewAnswer: (
    scope: McpInvocationScope,
    input: OrchestratorMcpReviewAnswerInput,
  ) => Effect.Effect<OrchestratorMcpReviewAnswerResult, OrchestratorMcpFailure>;
  readonly architectureReviewCancel: (
    scope: McpInvocationScope,
    input: OrchestratorMcpReviewCancelInput,
  ) => Effect.Effect<OrchestratorMcpReviewCancelResult, OrchestratorMcpFailure>;
  readonly publishToCoordinator: (
    scope: McpInvocationScope,
    input: OrchestratorMcpPublishToCoordinatorInput,
  ) => Effect.Effect<OrchestratorMcpPublishToCoordinatorResult, OrchestratorMcpFailure>;
  readonly getCoordinatorBinding: (
    scope: McpInvocationScope,
    input: OrchestratorMcpGetCoordinatorBindingInput,
  ) => Effect.Effect<OrchestratorMcpGetCoordinatorBindingResult, OrchestratorMcpFailure>;
  readonly listArchitectureReviews: (
    scope: McpInvocationScope,
    input: OrchestratorMcpListArchitectureReviewsInput,
  ) => Effect.Effect<OrchestratorMcpListArchitectureReviewsResult, OrchestratorMcpFailure>;
  /** Startup/restart reconciliation: detach missing architects, replay missing wakes from marker absence. */
  readonly reconcileAfterRestart: () => Effect.Effect<
    ReadonlyArray<{ readonly bindingId: string; readonly outcome: string }>,
    OrchestratorMcpFailure
  >;
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

// Stable token for the durable publish-failure record: the `[reason=...]`
// token when the failure carries one (parent_not_active refusals such as
// `parent_scope_drift`), otherwise the failure code. Bounded for the
// review column.
function publishFailureReasonToken(error: unknown): string {
  const message = isOrchestratorMcpFailure(error) ? error.message : errorMessage(error);
  const token = /\[reason=([^\]]+)\]/.exec(message)?.[1]?.trim();
  if (token !== undefined && token.length > 0) return token.slice(0, 256);
  if (isOrchestratorMcpFailure(error) && error.code.length > 0) {
    return error.code.slice(0, 256);
  }
  return "orchestration_error";
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
  const parsed = payload as unknown as DelegationCreatedPayload;
  const childCaps = sanitizeDelegationChildCapsSnapshot(
    (payload as Readonly<Record<string, unknown>>).childCaps,
  );
  return childCaps === undefined ? parsed : { ...parsed, childCaps: [...childCaps] };
}

function findLineage(thread: OrchestrationThread): DelegationCreatedPayload | null {
  for (let index = thread.activities.length - 1; index >= 0; index--) {
    const parsed = parseDelegationPayload(thread.activities[index]!);
    if (parsed !== null) return parsed;
  }
  return null;
}

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

function findCurrentTaskIdentity(
  thread: OrchestrationThread,
  lineage: DelegationCreatedPayload,
): OrchestratorMcpRequestedIdentity {
  const switched = thread.activities.findLast((activity) => {
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
  return switched !== undefined && Predicate.isObject(switched.payload)
    ? (switched.payload.requested as OrchestratorMcpRequestedIdentity)
    : lineage.requested;
}

function findLastProviderSwitch(
  thread: OrchestrationThread,
  lineage: DelegationCreatedPayload,
): DelegationProviderSwitchedPayload | null {
  for (let index = thread.activities.length - 1; index >= 0; index--) {
    const activity = thread.activities[index]!;
    if (
      activity.kind !== DELEGATION_PROVIDER_SWITCHED_ACTIVITY ||
      !Predicate.isObject(activity.payload)
    ) {
      continue;
    }
    const payload = activity.payload;
    if (
      payload.version === DELEGATION_ACTIVITY_VERSION &&
      payload.taskId === lineage.taskId &&
      payload.delegatedMessageId === lineage.delegatedMessageId &&
      isOrchestratorMcpRequestedIdentity(payload.requested) &&
      typeof payload.switchedAt === "string" &&
      Predicate.isObject(payload.oldProvider)
    ) {
      return payload as unknown as DelegationProviderSwitchedPayload;
    }
  }
  return null;
}

function findLastOrdinarySwitch(
  thread: OrchestrationThread,
  taskId: ThreadId,
): DelegationProviderSwitchedPayload | null {
  for (let index = thread.activities.length - 1; index >= 0; index--) {
    const activity = thread.activities[index]!;
    if (
      activity.kind !== DELEGATION_PROVIDER_SWITCHED_ACTIVITY ||
      !Predicate.isObject(activity.payload)
    ) {
      continue;
    }
    const payload = activity.payload;
    if (
      payload.version === DELEGATION_ACTIVITY_VERSION &&
      payload.taskId === taskId &&
      (payload.delegatedMessageId === null || payload.delegatedMessageId === undefined) &&
      isOrchestratorMcpRequestedIdentity(payload.requested) &&
      typeof payload.switchedAt === "string" &&
      Predicate.isObject(payload.oldProvider)
    ) {
      return payload as unknown as DelegationProviderSwitchedPayload;
    }
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

// Command IDs for a provider switch distinguish the full transition chain,
// not just the config fingerprint: the fingerprint excludes model and
// options, so an A→B→A→B cycle or parallel switches to different models
// would otherwise collide and yield false receipts. Every ID folds in the
// previous record's transition hash, so each committed switch advances a
// unique chain even when from/to repeat exactly. All inputs are
// activity-derived, so an exact retry after a partial crash reuses the same
// IDs.
//
// Concurrent switches against the same child/thread are serialized by a
// per-task commit lock: the chain head is re-read inside the lock, so a
// racing loser chains after the winner instead of forking the transition
// history with a stale head. The lock is module-scoped so the MCP service
// and per-request UI services share it within this process.
//
// Lifecycle: entries are refcounted and evicted once the last holder
// settles, so the map stays bounded by in-flight switches instead of every
// thread ever switched. Lookup, refcounting, and eviction each run in one
// synchronous block, which is atomic for Effect fibers: a newcomer either
// joins a live entry (and is counted before anyone can evict it) or creates
// a fresh one after eviction (when by definition nobody references the old
// semaphore). The release runs under `ensuring`, so interruption while
// queued or inside the commit still releases the holder.
interface SwitchCommitEntry {
  readonly semaphore: Semaphore.Semaphore;
  holders: number;
}
const switchCommitEntries = new Map<string, SwitchCommitEntry>();
const withSwitchCommitLock = <A, E, R>(
  taskId: ThreadId,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const key = String(taskId);
  let entry = switchCommitEntries.get(key);
  if (entry === undefined) {
    entry = { semaphore: Semaphore.makeUnsafe(1), holders: 0 };
    switchCommitEntries.set(key, entry);
  }
  entry.holders += 1;
  const captured = entry;
  return captured.semaphore.withPermit(effect).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        captured.holders -= 1;
        if (captured.holders === 0 && switchCommitEntries.get(key) === captured) {
          switchCommitEntries.delete(key);
        }
      }),
    ),
  );
};
function switchTransitionHash(
  from: DelegationProviderSwitchedPayload["oldProvider"],
  to: OrchestratorMcpRequestedIdentity,
  prev: string | null,
): string {
  return hash({ from, to, prev });
}

function switchTransitionId(
  prefix: string,
  taskId: ThreadId,
  from: DelegationProviderSwitchedPayload["oldProvider"],
  to: OrchestratorMcpRequestedIdentity,
  prev: string | null,
): string {
  return deterministicId(prefix, taskId, switchTransitionHash(from, to, prev));
}

function requestedIdentityMatches(
  left: OrchestratorMcpRequestedIdentity,
  right: OrchestratorMcpRequestedIdentity,
): boolean {
  return (
    left.providerInstanceId === right.providerInstanceId &&
    left.driverKind === right.driverKind &&
    left.model === right.model &&
    hash(left.options) === hash(right.options) &&
    left.runtimeMode === right.runtimeMode &&
    left.interactionMode === right.interactionMode &&
    left.providerConfigFingerprint === right.providerConfigFingerprint
  );
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

function toTaskMemoryEntry(
  row: ProjectionSnapshotQuery.DelegatedTaskMemoryRow,
): OrchestratorMcpTaskMemoryEntry {
  const role = scrubDelegatedTaskText(row.role).slice(0, 100);
  const title = scrubDelegatedTaskText(row.title).slice(0, 500);
  const latestStatus: OrchestratorMcpTaskStatus =
    row.hasPendingApprovals || row.hasPendingUserInput
      ? "waiting"
      : row.hasPendingFollowUp
        ? "queued"
        : row.latestTurnId === null
          ? "queued"
          : row.latestTurnState === "error"
            ? "failed"
            : row.latestTurnState === "pending"
              ? "queued"
              : (row.latestTurnState ?? "queued");
  const summary = row.summary;
  return {
    taskId: row.taskId,
    childThreadId: row.taskId,
    role,
    title,
    latestStatus,
    latestTurnId: row.latestTurnId,
    updatedAt: row.updatedAt,
    worktreePath:
      row.worktreePath === null ? null : scrubDelegatedTaskText(row.worktreePath).slice(0, 1_024),
    summary:
      summary === null
        ? {
            text: scrubDelegatedTaskText(`${role || "Task"}: ${title}`).slice(0, 240),
            source: "deterministic",
            sourceTurnIds: row.latestTurnId === null ? [] : [row.latestTurnId],
            watermark: 0,
            stale: true,
            state: "pending",
            error: null,
          }
        : {
            text: scrubDelegatedTaskText(summary.text).slice(0, 600),
            source: summary.source,
            sourceTurnIds: summary.sourceTurnIds.slice(-ORCHESTRATOR_MCP_TASK_SOURCE_TURN_IDS_MAX),
            watermark: summary.watermark,
            stale:
              summary.state !== "ready" ||
              summary.sourceTurnId !== row.latestTurnId ||
              summary.watermark < row.threadWatermark ||
              row.hasPendingFollowUp,
            state: summary.state,
            error: summary.error === null ? null : scrubDelegatedTaskText(summary.error),
          },
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
  const loadArchitectActivityDetail = (threadId: ThreadId) =>
    dependencies
      .getThreadDetailById(threadId, {
        activityKinds: [...COORDINATOR_ARCHITECT_ACTIVITY_KINDS],
        activityHistory: "complete",
      })
      .pipe(Effect.mapError(orchestrationFailure(`read architect activity history ${threadId}`)));
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

  const loadTaskMemoryRows = (
    scope: McpInvocationScope,
    input: {
      readonly afterTaskId?: ThreadId;
      readonly taskId?: ThreadId;
      readonly limit: number;
    },
  ) =>
    Effect.gen(function* () {
      yield* requireCapability(scope);
      if (dependencies.listDelegatedTaskMemoryRows === undefined) {
        return yield* failure("orchestration_error", "Delegated task memory is unavailable.");
      }
      return yield* dependencies
        .listDelegatedTaskMemoryRows({
          parentEnvironmentId: scope.environmentId,
          parentThreadId: scope.threadId,
          ...input,
        })
        .pipe(Effect.mapError(orchestrationFailure("read delegated task memory")));
    });

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

  // Capability gate for a provider switch. Unlike resolveTarget (which keeps
  // delegateTask's historical codes), an existing-but-unusable target is an
  // explicit handoff refusal: the provider cannot accept the thread's
  // history, pending queue, and lineage.
  const resolveSwitchTarget = (
    scope: McpInvocationScope,
    parent: TargetParentContext,
    child: OrchestrationThread,
    target: OrchestratorMcpDelegateTaskInput["target"],
    // Canonical frozen child caps plus the original target envelope the new
    // target must not exceed. Ordinary threads omit it and keep caller caps.
    original:
      | {
          readonly caps: ReadonlySet<string>;
          readonly envelope: OrchestratorMcpPermissionEnvelopeSummary;
          readonly interactionMode: OrchestratorMcpRequestedIdentity["interactionMode"];
          readonly projectId: ProjectId;
          readonly workspaceRoot: string;
          readonly worktreePath: string;
          readonly branch: string | null;
        }
      | undefined,
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
        t3McpCapabilities:
          provider.driver === "pi" ? new Set<string>() : (original?.caps ?? scope.capabilities),
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
      // Pre-fix switches may have broadened rights, so the original
      // delegation target (not a past switch record) anchors the new target.
      if (original !== undefined) {
        const anchor = compareDelegationPermissionEnvelopes({
          parent: original.envelope,
          target: permissionEnvelope,
          parentInteractionMode: original.interactionMode,
          targetInteractionMode: interactionMode,
          parentWorkspace: {
            projectId: original.projectId,
            workspaceRoot: original.workspaceRoot,
            worktreePath: original.worktreePath,
            branch: original.branch,
          },
          targetWorkspace: {
            projectId: parent.thread.projectId,
            workspaceRoot: parent.project.workspaceRoot,
            worktreePath: parent.scope.worktreePath,
            branch: parent.thread.branch,
          },
        });
        if (!anchor.allowed) {
          return yield* failure(
            "provider_handoff_unsupported",
            `Provider instance ${provider.instanceId} cannot accept a handoff: ${anchor.reason}`,
          );
        }
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

  // Canonical frozen child caps S for a delegated child. The snapshot in
  // new lineage is only a fast path: it must still reproduce the stored
  // fingerprint under the current config. Legacy lineage recovers S by exact
  // match over the 16 known subsets. Zero or several matches, or a removed
  // or changed config, fail closed — never the caller's surface set.
  const resolveCanonicalChildCaps = (
    lineage: DelegationCreatedPayload,
  ): Effect.Effect<
    {
      readonly caps: ReadonlySet<string>;
      readonly envelope: OrchestratorMcpPermissionEnvelopeSummary;
    },
    OrchestratorMcpFailure
  > =>
    Effect.gen(function* () {
      const settings = yield* dependencies.getSettings;
      const instanceConfig =
        deriveProviderInstanceConfigMap(settings)[lineage.requested.providerInstanceId];
      if (instanceConfig === undefined || instanceConfig.driver !== lineage.requested.driverKind) {
        return yield* failure(
          "provider_configuration_changed",
          "The delegated provider instance is no longer configured.",
        );
      }
      const recovery = yield* recoverDelegationChildCaps({
        expectedFingerprint: lineage.requested.providerConfigFingerprint,
        ...(lineage.childCaps === undefined
          ? {}
          : {
              preferredCaps: sanitizeDelegationChildCapsSnapshot(lineage.childCaps),
            }),
        loadWithCaps: (caps) =>
          dependencies.loadPermissionEnvelope({
            driverKind: lineage.requested.driverKind,
            runtimeMode: lineage.requested.runtimeMode,
            interactionMode: lineage.requested.interactionMode,
            instanceConfig,
            environment: process.env,
            workspaceRoot: lineage.workspaceRoot,
            worktreePath: lineage.worktreePath,
            branch: lineage.branch,
            t3McpCapabilities: caps,
          }),
      });
      if (recovery.status === "recovered") {
        return { caps: recovery.caps, envelope: recovery.envelope };
      }
      return yield* failure(
        "provider_configuration_changed",
        recovery.status === "ambiguous"
          ? "The delegated capability scope is ambiguous and cannot be verified."
          : "The delegated provider configuration changed after delegation was accepted.",
      );
    });

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
    const target = yield* resolveSwitchTarget(scope, parent, thread, input.target, undefined);
    // The commit — chain-head read plus every dispatch — runs under the
    // per-task lock so overlapping switches serialize: the loser re-reads
    // the winner's record and chains after it instead of forking the
    // history with a stale head.
    return yield* withSwitchCommitLock(
      input.taskId,
      Effect.gen(function* () {
        const committedOption = yield* loadThreadDetail(input.taskId);
        if (Option.isNone(committedOption)) {
          return yield* failure("task_not_found", "The delegated task was not found.");
        }
        const committed = committedOption.value;
        // The history is the handoff: a thread with no messages cannot be
        // carried to a new provider and cannot be advanced.
        if (committed.messages.length === 0) {
          return yield* failure(
            "thread_has_no_history",
            "The thread has no message history to hand off. Send a message first, then switch providers.",
          );
        }
        const oldProvider = yield* resolveOrdinaryOldProvider(committed, session);
        const switchedAt = yield* dependencies.now;
        const ordinaryPrev =
          findLastOrdinarySwitch(committed, input.taskId)?.prevTransition ?? null;
        const ordinaryTransition = (prefix: string) =>
          switchTransitionId(prefix, input.taskId, oldProvider, target.requested, ordinaryPrev);
        yield* dependencies
          .dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make(ordinaryTransition("mcp-provider-switch-meta")),
            threadId: input.taskId,
            modelSelection: target.modelSelection,
          })
          .pipe(Effect.mapError(orchestrationFailure("repoint thread provider")));
        const rows = yield* listTurns(input.taskId);
        const pendingCount = rows.filter((row) => row.turnId === null).length;
        const switchScope = {
          messageCount: committed.messages.length,
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
          prevTransition: switchTransitionHash(oldProvider, target.requested, ordinaryPrev),
        };
        const ordinaryLineageCommandId = ordinaryTransition("mcp-provider-switch-lineage");
        yield* dependencies
          .dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(ordinaryLineageCommandId),
            threadId: input.taskId,
            activity: {
              id: EventId.make(ordinaryLineageCommandId),
              tone: "info",
              kind: DELEGATION_PROVIDER_SWITCHED_ACTIVITY,
              summary: "Thread switched provider",
              payload,
              turnId: committed.latestTurn?.turnId ?? null,
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
      }),
    );
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
      let persistedOutputStatus: "available" | "empty" | "unavailable" | undefined;
      if (
        status === "completed" &&
        delegatedTurnId !== null &&
        lineage.requested.driverKind === ProviderDriverKind.make("museCode")
      ) {
        const parentOption = yield* loadThreadDetail(scope.threadId).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.succeed(Option.none()),
          ),
        );
        if (Option.isSome(parentOption)) {
          const completedActivity = parentOption.value.activities.findLast(
            (activity) =>
              activity.kind === DELEGATION_COMPLETED_ACTIVITY &&
              Predicate.isObject(activity.payload) &&
              activity.payload.childThreadId === taskId &&
              activity.payload.delegatedTurnId === delegatedTurnId,
          );
          if (completedActivity !== undefined && Predicate.isObject(completedActivity.payload)) {
            const candidate = completedActivity.payload.outputStatus;
            if (candidate === "available" || candidate === "empty" || candidate === "unavailable") {
              persistedOutputStatus = candidate;
            }
          }
        }
      }
      const reportedOutputStatus =
        status !== "completed"
          ? undefined
          : (persistedOutputStatus ??
            (lineage.requested.driverKind === ProviderDriverKind.make("museCode")
              ? "unavailable"
              : assistant?.text
                ? "available"
                : assistant !== undefined
                  ? "empty"
                  : "unavailable"));
      const outputStatus =
        reportedOutputStatus === "available" && !assistant?.text
          ? "unavailable"
          : reportedOutputStatus === "empty" && assistant?.text
            ? "unavailable"
            : reportedOutputStatus;
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
              outputStatus: outputStatus ?? "unavailable",
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
    mode?: {
      readonly runtimeMode?: OrchestrationThreadShell["runtimeMode"];
      readonly interactionMode?: OrchestrationThreadShell["interactionMode"];
      readonly t3McpCapabilities?: ReadonlySet<string>;
    },
  ) {
    const unavailable = providerUnavailableReason(provider);
    const instanceConfig = providerInstances[provider.instanceId];
    const permissionEnvelope =
      instanceConfig === undefined
        ? ({ status: "unverifiable", reason: "Provider configuration is unavailable." } as const)
        : yield* dependencies.loadPermissionEnvelope({
            driverKind: provider.driver,
            runtimeMode: mode?.runtimeMode ?? parent.thread.runtimeMode,
            interactionMode: mode?.interactionMode ?? parent.thread.interactionMode,
            instanceConfig,
            environment: process.env,
            workspaceRoot: parent.project.workspaceRoot,
            worktreePath: parent.scope.worktreePath,
            branch: parent.thread.branch,
            t3McpCapabilities:
              mode?.t3McpCapabilities ??
              (provider.driver === "pi" ? new Set<string>() : scope.capabilities),
          });
    const comparison = compareDelegationPermissionEnvelopes({
      parent: parent.scope.permissionEnvelope,
      target: permissionEnvelope,
      parentInteractionMode: parent.thread.interactionMode,
      targetInteractionMode: mode?.interactionMode ?? parent.thread.interactionMode,
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

  const validateArchitectSelection = Effect.fn("OrchestratorMcpService.validateArchitectSelection")(
    function* (input: {
      readonly scope: McpInvocationScope;
      readonly parent: ParentContext;
      readonly taskEffort: OrchestratorMcpArchitectCreateOrGetInput["taskEffort"];
      readonly modelSelection: ModelSelection;
      readonly routingEvidence: CoordinatorArchitectRoutingEvidence;
    }) {
      const evidence = input.routingEvidence;
      const selected = evidence.consideredCandidates[evidence.consideredCandidates.length - 1];
      if (
        evidence.role !== "architecture" ||
        evidence.taskEffort !== input.taskEffort ||
        selected === undefined ||
        selected.disposition !== "selected" ||
        selected.providerInstanceId !== input.modelSelection.instanceId ||
        selected.model !== input.modelSelection.model ||
        hash(selected.options) !== hash(input.modelSelection.options ?? [])
      ) {
        return yield* failure(
          "routing_evidence_mismatch",
          "The selected model does not match the accepted architecture routing evidence.",
        );
      }
      const providers = yield* dependencies.getProviders;
      const provider = providers.find(
        (candidate) => candidate.instanceId === input.modelSelection.instanceId,
      );
      if (provider === undefined || provider.driver !== selected.driverKind) {
        return yield* failure(
          "provider_unavailable",
          `Selected architecture provider ${input.modelSelection.instanceId} is not live under the recorded driver.`,
        );
      }
      const unavailable = providerUnavailableReason(provider);
      if (unavailable !== null) return yield* failure("provider_unavailable", unavailable);
      const model = provider.models.find(
        (candidate) => candidate.slug === input.modelSelection.model,
      );
      if (model === undefined) {
        return yield* failure(
          "model_unavailable",
          `Selected architecture model ${input.modelSelection.model} is not in the live provider catalog.`,
        );
      }
      const invalidOptions = validateOptions(
        input.modelSelection.options ?? [],
        model.capabilities?.optionDescriptors,
      );
      if (invalidOptions.length > 0) {
        return yield* failure("invalid_model_options", invalidOptions.join(" "));
      }
      const settings = yield* dependencies.getSettings;
      const permission = yield* providerCapability(
        input.scope,
        input.parent,
        deriveProviderInstanceConfigMap(settings),
        provider,
        {
          interactionMode: "plan",
          t3McpCapabilities: new Set(["orchestration"]),
        },
      );
      if (!permission.delegatable) {
        return yield* failure(
          permission.permissionEnvelope.status === "unverifiable"
            ? "permission_envelope_unverifiable"
            : "permission_escalation_denied",
          permission.unavailableReason ??
            "The selected architecture provider is not read-only eligible.",
        );
      }
      return input.modelSelection;
    },
  );

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

  const dispatchFollowUpTurn = Effect.fn("OrchestratorMcpService.dispatchFollowUpTurn")(
    function* (input: {
      readonly taskId: ThreadId;
      readonly message: string;
      readonly result: OrchestratorMcpSendToTaskResult;
    }) {
      yield* dependencies
        .dispatch({
          type: "thread.turn.start",
          commandId: input.result.commandId,
          threadId: input.taskId,
          message: {
            messageId: input.result.messageId,
            role: "user",
            text: input.message,
            attachments: [],
          },
          modelSelection: requestedModelSelection({ target: input.result.requested }),
          runtimeMode: input.result.requested.runtimeMode,
          interactionMode: input.result.requested.interactionMode,
          delegationConfigFingerprint: input.result.requested.providerConfigFingerprint,
          followUpBehavior: "queue",
          createdAt: input.result.queuedAt,
        })
        .pipe(
          Effect.catchTags({
            OrchestrationCommandIdConflictError: () =>
              Effect.fail(
                failure(
                  "idempotency_conflict",
                  "This idempotency key collides with a different follow-up command.",
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
                  "The original follow-up command for this idempotency key was rejected.",
                ),
              ),
          }),
          Effect.mapError((error) =>
            isOrchestratorMcpFailure(error)
              ? error
              : orchestrationFailure("queue follow-up message")(error),
          ),
        );
    },
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
        if (
          !modelSelectionMatchesRequested(
            input.child.modelSelection,
            input.receipt.result.requested,
          ) ||
          input.child.runtimeMode !== input.receipt.result.requested.runtimeMode ||
          input.child.interactionMode !== input.receipt.result.requested.interactionMode ||
          (input.child.session !== null &&
            (input.child.session.providerInstanceId !==
              input.receipt.result.requested.providerInstanceId ||
              input.child.session.runtimeMode !== input.receipt.result.requested.runtimeMode))
        ) {
          return yield* failure(
            "provider_configuration_changed",
            "The child identity changed before the accepted follow-up could start.",
          );
        }
        yield* dispatchFollowUpTurn({
          taskId: input.taskId,
          message: input.message,
          result: input.receipt.result,
        });
      }
      return input.receipt.result;
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

  // ── Phase 1 Coordinator/Architect (S3/S5/S6) ─────────────────────────────
  // Ordered safety boundary (§6): the durable binding row is the primary
  // deny on every architect path; credential revocation follows as
  // defense-in-depth and never reverts a committed transition.

  const requireArchitectStore = (): Effect.Effect<
    CoordinatorArchitectRepositoryShape,
    OrchestratorMcpFailure
  > =>
    dependencies.coordinatorArchitect === undefined
      ? Effect.fail(
          failure(
            "orchestration_error",
            "The coordinator/architect store is unavailable in this server composition.",
          ),
        )
      : Effect.succeed(dependencies.coordinatorArchitect);

  const requireSplitEnabled = (): Effect.Effect<void, OrchestratorMcpFailure> =>
    dependencies.getSettings.pipe(
      Effect.flatMap((settings) =>
        settings.coordinatorArchitectSplit === false
          ? Effect.fail(
              failure(
                "feature_disabled",
                "The coordinator/architect split is disabled by server settings.",
              ),
            )
          : Effect.void,
      ),
    );

  type ControlPlaneCaller =
    | { readonly kind: "architect"; readonly binding: CoordinatorArchitectBinding }
    | { readonly kind: "other" };

  const mapStoreError = (operation: string) => (error: unknown) =>
    isOrchestratorMcpFailure(error)
      ? error
      : isCoordinatorArchitectIdempotencyConflict(error)
        ? failure(
            "idempotency_conflict",
            `The same idempotency key was already used for a different ${operation} request.`,
          )
        : orchestrationFailure(operation)(error);

  const resolveControlPlaneCaller = (
    scope: McpInvocationScope,
  ): Effect.Effect<ControlPlaneCaller, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      if (dependencies.coordinatorArchitect === undefined) {
        // Legacy composition without the store: an explicit architect role
        // claim cannot be validated, so it is denied; everyone else keeps
        // pre-split behavior.
        if (scope.controlPlaneRole === "architect") {
          return yield* failure(
            "capability_denied",
            "This MCP credential claims an architect role that cannot be validated.",
          );
        }
        return { kind: "other" } as const;
      }
      const binding = yield* dependencies.coordinatorArchitect
        .getActiveBindingByArchitect(scope.threadId)
        .pipe(Effect.mapError(mapStoreError("read architect binding")));
      if (binding !== null) return { kind: "architect", binding } as const;
      if (scope.controlPlaneRole === "architect") {
        // Forged role in scope, or a stale pre-revoke credential: no durable
        // binding backs the claim, so it fails immediately.
        return yield* failure(
          "capability_denied",
          "This MCP credential claims an architect role with no active architect binding.",
        );
      }
      return { kind: "other" } as const;
    });

  const denyArchitectCaller = (caller: ControlPlaneCaller, operation: string) =>
    caller.kind === "architect"
      ? Effect.fail(
          failure(
            "architect_denied",
            `Architect threads cannot ${operation}; the architect is a read-only advisor and never owns execution lineage.`,
          ),
        )
      : Effect.void;

  const isArchitectThreadId = (threadId: ThreadId) =>
    dependencies.coordinatorArchitect === undefined
      ? Effect.succeed(String(threadId).startsWith("arch:"))
      : dependencies.coordinatorArchitect.getAnyBindingByArchitect(threadId).pipe(
          Effect.map((binding) => binding !== null || String(threadId).startsWith("arch:")),
          Effect.mapError(mapStoreError("read architect binding")),
        );

  const denyArchitectTarget = (threadId: ThreadId, operation: string) =>
    isArchitectThreadId(threadId).pipe(
      Effect.flatMap((isArchitect) => {
        const violation = assertNotArchitectThread(operation, threadId, isArchitect);
        return violation === null
          ? Effect.void
          : Effect.fail(failure("architect_denied", violation));
      }),
    );

  const checkCoordinatorIdentity = (
    scope: McpInvocationScope,
    coordinatorThreadId: ThreadId,
    thread: OrchestrationThreadShell,
    operation: string,
  ): Effect.Effect<ControlPlaneCaller, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const caller = yield* resolveControlPlaneCaller(scope);
      yield* denyArchitectCaller(caller, operation);
      if (scope.threadId !== coordinatorThreadId) {
        return yield* failure(
          "capability_denied",
          "Only the coordinator thread itself (or a human on it) may perform this operation.",
        );
      }
      if (thread.delegationParent !== null && thread.delegationParent !== undefined) {
        // Delegated executors may not act as coordinators on any lineage.
        return yield* failure(
          "delegated_executor_denied",
          "Delegated executor threads cannot perform coordinator control-plane operations.",
        );
      }
      return caller;
    });

  const denyExecutorCaller = (
    scope: McpInvocationScope,
    operation: string,
  ): Effect.Effect<void, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const shellOption = yield* loadThreadShell(scope.threadId);
      if (Option.isNone(shellOption)) {
        return yield* failure("capability_denied", "This thread no longer exists.");
      }
      if (
        shellOption.value.delegationParent !== null &&
        shellOption.value.delegationParent !== undefined
      ) {
        return yield* failure(
          "delegated_executor_denied",
          `Delegated executor threads cannot ${operation}.`,
        );
      }
    });

  const resolveReadScope = (
    scope: McpInvocationScope,
  ): Effect.Effect<McpInvocationScope, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const caller = yield* resolveControlPlaneCaller(scope);
      if (caller.kind !== "architect") return scope;
      yield* requireSplitEnabled();
      // Architect reads reuse the existing scoped paths against the linked
      // coordinator lineage, with the same named limits (single shared path).
      return { ...scope, threadId: caller.binding.coordinatorThreadId };
    });

  const appendPhase1Activity = (input: {
    readonly threadId: ThreadId;
    readonly commandId: string;
    readonly fallbackCommandId?: string;
    readonly activityId: string;
    readonly kind: string;
    readonly summary: string;
    readonly payload: unknown;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      const detail = yield* loadThreadDetail(input.threadId);
      if (
        Option.isSome(detail) &&
        detail.value.activities.some((activity) => activity.id === input.activityId)
      ) {
        return;
      }
      const dispatchActivity = (commandId: string) =>
        dependencies.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(commandId),
          threadId: input.threadId,
          activity: {
            id: EventId.make(input.activityId),
            tone: "info",
            kind: input.kind,
            summary: input.summary,
            payload: input.payload,
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        });
      yield* dispatchActivity(input.commandId).pipe(
        Effect.catchTag("OrchestrationCommandIdConflictError", (error) =>
          input.fallbackCommandId !== undefined &&
          error.receiptAggregateKind === "thread" &&
          error.receiptAggregateId !== input.threadId &&
          error.commandAggregateKind === "thread" &&
          error.commandAggregateId === input.threadId
            ? dispatchActivity(input.fallbackCommandId)
            : Effect.fail(error),
        ),
        Effect.mapError(orchestrationFailure("append coordinator/architect activity")),
      );
    });

  const dispatchWakeTurn = (input: {
    readonly threadId: ThreadId;
    readonly turnCommandId: string;
    readonly messageId: string;
    readonly fallbackTurnCommandId?: string;
    readonly fallbackMessageId?: string;
    readonly text: string;
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: OrchestrationThreadShell["runtimeMode"];
    readonly interactionMode: OrchestrationThreadShell["interactionMode"];
    readonly createdAt: string;
  }) => {
    const dispatchTurn = (turnCommandId: string, messageId: string) =>
      dependencies.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(turnCommandId),
        threadId: input.threadId,
        message: {
          messageId: MessageId.make(messageId),
          role: "user",
          text: input.text,
          attachments: [],
        },
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        createdAt: input.createdAt,
      });
    return dispatchTurn(input.turnCommandId, input.messageId).pipe(
      Effect.catchTag("OrchestrationCommandIdConflictError", (error) =>
        input.fallbackTurnCommandId !== undefined &&
        input.fallbackMessageId !== undefined &&
        error.receiptAggregateKind === "thread" &&
        error.receiptAggregateId !== input.threadId &&
        error.commandAggregateKind === "thread" &&
        error.commandAggregateId === input.threadId
          ? dispatchTurn(input.fallbackTurnCommandId, input.fallbackMessageId)
          : Effect.fail(error),
      ),
      Effect.catchTags({
        OrchestrationCommandInvariantError: (error) =>
          Effect.fail(orchestrationFailure("dispatch coordinator/architect wake turn")(error)),
        OrchestrationCommandPreviouslyRejectedError: (error) =>
          Effect.fail(orchestrationFailure("dispatch coordinator/architect wake turn")(error)),
      }),
      Effect.mapError((error) =>
        isOrchestratorMcpFailure(error)
          ? error
          : orchestrationFailure("dispatch coordinator/architect wake turn")(error),
      ),
    );
  };

  const revokeArchitectCredential = (
    threadId: ThreadId,
  ): Effect.Effect<{ readonly revoked: boolean; readonly attempts: number }, never> => {
    const revoke = dependencies.revokeThreadCredential;
    if (revoke === undefined) return Effect.succeed({ revoked: false, attempts: 0 });
    const attempt = (
      remaining: number,
      attempts: number,
    ): Effect.Effect<{ readonly revoked: boolean; readonly attempts: number }, never> =>
      Effect.matchCauseEffect(revoke(threadId), {
        onFailure: () =>
          remaining > 1
            ? attempt(remaining - 1, attempts + 1)
            : Effect.succeed({ revoked: false, attempts: attempts + 1 }),
        onSuccess: () => Effect.succeed({ revoked: true, attempts: attempts + 1 }),
      });
    return attempt(3, 0);
  };

  const softDeleteArchitectThread = (
    threadId: ThreadId,
  ): Effect.Effect<void, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const shell = yield* loadThreadShell(threadId);
      // The ordinary shell query already excludes deleted threads; if the
      // shell is absent there is nothing left to delete.
      if (Option.isNone(shell)) return;
      yield* dependencies
        .dispatch({
          type: "thread.delete",
          commandId: CommandId.make(`architect-delete:${threadId}`),
          threadId,
        })
        .pipe(
          Effect.catchTags({ OrchestrationCommandIdConflictError: () => Effect.void }),
          Effect.mapError((error) =>
            isOrchestratorMcpFailure(error)
              ? error
              : orchestrationFailure("soft-delete architect thread")(error),
          ),
        );
    });

  const createArchitectThread = (
    binding: CoordinatorArchitectBinding,
    coordinator: OrchestrationThreadShell,
  ): Effect.Effect<void, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const evidence = binding.routingEvidence;
      const selected = evidence?.consideredCandidates.at(-1);
      if (selected === undefined || selected.disposition !== "selected") {
        return yield* failure(
          "routing_evidence_mismatch",
          "The active Architect binding has no selected routing evidence for deterministic recovery.",
        );
      }
      const modelSelection: ModelSelection = {
        instanceId: selected.providerInstanceId,
        model: selected.model,
        options: selected.options,
      };
      yield* dependencies
        .dispatch({
          type: "thread.create",
          commandId: CommandId.make(`architect-create:${binding.bindingId}`),
          threadId: binding.architectThreadId,
          projectId: binding.projectId,
          title: "Architect",
          modelSelection,
          runtimeMode: coordinator.runtimeMode,
          // The architect never runs in plan mode: in plan it cannot use
          // its own MCP surface, and any later plan/default toggle would
          // invalidate its frozen credential at the drift gate below.
          interactionMode: "default",
          branch: coordinator.branch,
          worktreePath: coordinator.worktreePath,
          createdAt: binding.createdAt,
        })
        .pipe(
          Effect.catchTags({
            OrchestrationCommandIdConflictError: () => Effect.void,
            OrchestrationCommandInvariantError: (error) =>
              Effect.fail(
                failure(
                  "idempotency_conflict",
                  `The deterministic Architect create command conflicts with an existing thread: ${errorMessage(error)}`,
                ),
              ),
            OrchestrationCommandPreviouslyRejectedError: (error) =>
              Effect.fail(orchestrationFailure("create architect thread")(error)),
          }),
          Effect.mapError((error) =>
            isOrchestratorMcpFailure(error)
              ? error
              : orchestrationFailure("create architect thread")(error),
          ),
        );
    });

  const wakeArchitectForReview = (
    review: ArchitectureReviewRecord,
    binding: CoordinatorArchitectBinding,
    at: string,
  ): Effect.Effect<void, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const detailOption = yield* loadArchitectActivityDetail(binding.architectThreadId);
      if (Option.isNone(detailOption)) {
        return yield* failure(
          "orchestration_error",
          "The bound architect thread no longer exists.",
        );
      }
      if (
        hasReviewWakeDelivered(
          detailOption.value.activities,
          binding.architectThreadId,
          review.reviewId,
        )
      ) {
        return;
      }
      const shellOption = yield* loadThreadShell(binding.architectThreadId);
      if (Option.isNone(shellOption)) {
        return yield* failure(
          "orchestration_error",
          "The bound architect thread no longer exists.",
        );
      }
      const shell = shellOption.value;
      yield* dispatchWakeTurn({
        threadId: binding.architectThreadId,
        turnCommandId: reviewWakeTurnCommandId(review.reviewId),
        messageId: reviewWakeMessageId(review.reviewId),
        fallbackTurnCommandId: `arch:review-wake-turn:${binding.architectThreadId}:${review.reviewId}`,
        fallbackMessageId: `arch:review-wake:${binding.architectThreadId}:${review.reviewId}`,
        text: `Architecture review requested (${review.reason}; execution posture: ${review.executionPosture}):\n${review.question}`,
        modelSelection: shell.modelSelection,
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        createdAt: at,
      });
      yield* appendPhase1Activity({
        threadId: binding.architectThreadId,
        commandId: `arch:review-wake-delivered:${review.reviewId}`,
        activityId: reviewWakeDeliveredMarkerId(binding.architectThreadId, review.reviewId),
        fallbackCommandId: reviewWakeDeliveredMarkerId(binding.architectThreadId, review.reviewId),
        kind: REVIEW_WAKE_DELIVERED_ACTIVITY,
        summary: "Architect review wake delivered",
        payload: { reviewId: review.reviewId },
        createdAt: at,
      });
    });

  const wakeCoordinatorForPublish = (
    review: ArchitectureReviewRecord,
    binding: CoordinatorArchitectBinding,
    at: string,
  ): Effect.Effect<void, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const detailOption = yield* loadArchitectActivityDetail(binding.coordinatorThreadId);
      if (Option.isNone(detailOption)) {
        return yield* failure("orchestration_error", "The coordinator thread no longer exists.");
      }
      if (
        hasPublishWakeDelivered(
          detailOption.value.activities,
          binding.coordinatorThreadId,
          review.reviewId,
        )
      ) {
        return;
      }
      const shellOption = yield* loadThreadShell(binding.coordinatorThreadId);
      if (Option.isNone(shellOption)) {
        return yield* failure("orchestration_error", "The coordinator thread no longer exists.");
      }
      const shell = shellOption.value;
      const disposition = review.answerDisposition;
      if (disposition === null) {
        return yield* failure(
          "review_state_conflict",
          "An answered review must have a stored answer disposition before it can be published.",
        );
      }
      const summary = review.answerSummary ?? "";
      const refs = review.refs;
      yield* dispatchWakeTurn({
        threadId: binding.coordinatorThreadId,
        turnCommandId: publishWakeTurnCommandId(review.reviewId),
        messageId: publishWakeMessageId(review.reviewId),
        text: `Architecture review published [${disposition}]:\n${summary}\nStable references: ${reviewRefsJson(refs)}`,
        modelSelection: shell.modelSelection,
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        createdAt: at,
      });
      yield* appendPhase1Activity({
        threadId: binding.coordinatorThreadId,
        commandId: `arch:publish-wake-delivered:${review.reviewId}`,
        activityId: publishWakeDeliveredMarkerId(binding.coordinatorThreadId, review.reviewId),
        kind: PUBLISH_WAKE_DELIVERED_ACTIVITY,
        summary: "Coordinator publish wake delivered",
        payload: { reviewId: review.reviewId, disposition, summary, refs },
        createdAt: at,
      });
    });

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
                "This thread is not a registered board Coordinator, so it has no board.",
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
  const reviewRefsJson = Schema.encodeSync(Schema.fromJsonString(ArchitectureReviewRefs));

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
    delegateTask: (scope, input) =>
      Effect.gen(function* () {
        const parent = yield* requireActiveParent(scope);
        yield* denyArchitectCaller(yield* resolveControlPlaneCaller(scope), "delegate tasks");
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
        const parent = yield* requireActiveParent(scope);
        if (input.taskId === scope.threadId) {
          return yield* failure("task_not_found", "The delegated task was not found.");
        }
        yield* denyArchitectCaller(
          yield* resolveControlPlaneCaller(scope),
          "send messages to delegated tasks",
        );
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
          return yield* resumeFollowUpTurn({
            taskId: input.taskId,
            message: input.message,
            receipt: existing,
            child,
          });
        }

        const rows = yield* listTurns(input.taskId);
        const currentIdentity = findCurrentTaskIdentity(child, lineage);
        if (
          !modelSelectionMatchesRequested(child.modelSelection, currentIdentity) ||
          child.runtimeMode !== lineage.requested.runtimeMode ||
          child.interactionMode !== lineage.requested.interactionMode ||
          currentIdentity.runtimeMode !== lineage.requested.runtimeMode ||
          currentIdentity.interactionMode !== lineage.requested.interactionMode
        ) {
          return yield* failure(
            "permission_escalation_denied",
            "The child no longer matches its frozen provider and permission identity.",
          );
        }
        if (child.session !== null) {
          if (child.session.providerInstanceId === undefined) {
            return yield* failure(
              "permission_envelope_unverifiable",
              "The child's active provider session has no verifiable provider instance.",
            );
          }
          if (child.session.runtimeMode !== lineage.requested.runtimeMode) {
            return yield* failure(
              "provider_configuration_changed",
              "The child's active session no longer matches its delegated provider configuration.",
            );
          }
          if (child.session.providerInstanceId !== currentIdentity.providerInstanceId) {
            const canUseExplicitRepoint =
              hasCurrentTaskProviderSwitch(child, lineage) &&
              child.session.activeTurnId === null &&
              child.session.status !== "running" &&
              child.session.status !== "starting" &&
              child.latestTurn?.state !== "running" &&
              !rows.some((row) => row.turnId === null);
            if (!canUseExplicitRepoint) {
              return yield* failure(
                "provider_configuration_changed",
                "The child's active session no longer matches its delegated provider configuration.",
              );
            }
          }
        }

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
    taskList: (scope, input) =>
      Effect.gen(function* () {
        const readScope = yield* resolveReadScope(scope);
        const limit = input.limit ?? 50;
        const page = yield* loadTaskMemoryRows(readScope, {
          limit,
          ...(input.afterTaskId === undefined ? {} : { afterTaskId: input.afterTaskId }),
        });
        const tasks = page.rows.map(toTaskMemoryEntry);
        return {
          tasks,
          nextCursor: page.hasMore ? (tasks.at(-1)?.taskId ?? null) : null,
        };
      }),
    taskSearch: (scope, input) =>
      Effect.gen(function* () {
        const readScope = yield* resolveReadScope(scope);
        const limit = input.limit ?? 50;
        const query = scrubDelegatedTaskText(input.query).trim().slice(0, 256);
        const foldedQuery = query.toLocaleLowerCase();
        const matches: Array<OrchestratorMcpTaskMemoryEntry> = [];
        let cursor = input.afterTaskId;
        let scanned = 0;
        let hasMoreCandidates = true;
        while (scanned < TASK_SEARCH_MAX_SCAN && hasMoreCandidates && matches.length <= limit) {
          const batchLimit = Math.min(TASK_SEARCH_BATCH_SIZE, TASK_SEARCH_MAX_SCAN - scanned);
          const page = yield* loadTaskMemoryRows(readScope, {
            limit: batchLimit,
            ...(cursor === undefined ? {} : { afterTaskId: cursor }),
          });
          const tasks = page.rows.map(toTaskMemoryEntry);
          scanned += tasks.length;
          for (const task of tasks) {
            const searchable = [
              task.role,
              task.title,
              task.worktreePath ?? "",
              task.summary?.text ?? "",
            ]
              .join("\n")
              .toLocaleLowerCase();
            const exactIdMatch =
              task.taskId === query ||
              task.childThreadId === query ||
              task.latestTurnId === query ||
              task.summary?.sourceTurnIds.some((turnId) => turnId === query) === true;
            if (
              exactIdMatch ||
              task.worktreePath === query ||
              task.latestStatus === query ||
              searchable.includes(foldedQuery)
            ) {
              matches.push(task);
              if (matches.length > limit) break;
            }
          }
          cursor = tasks.at(-1)?.taskId ?? cursor;
          hasMoreCandidates = page.hasMore;
          if (tasks.length === 0 || matches.length > limit) break;
        }
        const tasks = matches.slice(0, limit);
        const nextCursor =
          matches.length > limit
            ? (tasks.at(-1)?.taskId ?? null)
            : hasMoreCandidates
              ? (cursor ?? null)
              : null;
        return {
          query,
          tasks,
          nextCursor,
        };
      }),
    taskRead: (scope, input) =>
      Effect.gen(function* () {
        const readScope = yield* resolveReadScope(scope);
        const ownership = yield* loadTaskMemoryRows(readScope, { taskId: input.taskId, limit: 1 });
        const child = ownership.rows[0];
        if (child === undefined) {
          return yield* failure("task_not_found", "The delegated task was not found.");
        }
        if (dependencies.getThreadDetailSnapshotIncludingArchived === undefined) {
          return yield* failure(
            "orchestration_error",
            "Delegated task transcript reads are unavailable.",
          );
        }
        const snapshot = yield* dependencies
          .getThreadDetailSnapshotIncludingArchived(input.taskId, {
            turnLimit: input.turnLimit ?? 8,
            ...(input.beforeCursor === undefined ? {} : { beforeCursor: input.beforeCursor }),
          })
          .pipe(Effect.mapError(orchestrationFailure("read delegated task transcript")));
        if (Option.isNone(snapshot)) {
          return yield* failure("task_not_found", "The delegated task was not found.");
        }
        const detail = snapshot.value;
        const page = detail.page;
        if (page === undefined) {
          return yield* failure(
            "orchestration_error",
            "Transcript pagination metadata is unavailable.",
          );
        }
        return {
          taskId: child.taskId,
          title: toTaskMemoryEntry(child).title,
          messages: detail.thread.messages,
          activities: detail.thread.activities,
          page,
        };
      }),
    taskStatus: (scope, taskId) =>
      Effect.gen(function* () {
        return yield* readOwnedTask(yield* resolveReadScope(scope), taskId);
      }),
    taskWait: (scope, taskId, timeoutMs) =>
      Effect.gen(function* () {
        return yield* waitForTask(yield* resolveReadScope(scope), taskId, timeoutMs);
      }),
    taskCancel: (scope, taskId) =>
      Effect.gen(function* () {
        yield* denyArchitectCaller(
          yield* resolveControlPlaneCaller(scope),
          "cancel delegated tasks",
        );
        yield* denyArchitectTarget(taskId, "task_cancel");
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
        yield* denyArchitectCaller(yield* resolveControlPlaneCaller(scope), "switch providers");
        yield* denyArchitectTarget(input.taskId, "switch_provider");
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
        const canonical = yield* resolveCanonicalChildCaps(lineage);
        const target = yield* resolveSwitchTarget(scope, parent, thread, input.target, {
          caps: canonical.caps,
          envelope: canonical.envelope,
          interactionMode: lineage.requested.interactionMode,
          projectId: lineage.projectId,
          workspaceRoot: lineage.workspaceRoot,
          worktreePath: lineage.worktreePath,
          branch: lineage.branch,
        });
        // The commit — chain-head read plus every dispatch — runs under the
        // per-task lock so overlapping switches serialize: the loser re-reads
        // the winner's record and chains after it instead of forking the
        // history with a stale head.
        return yield* withSwitchCommitLock(
          input.taskId,
          Effect.gen(function* () {
            const committedOption = yield* loadThreadDetail(input.taskId);
            if (Option.isNone(committedOption)) {
              return yield* failure("task_not_found", "The delegated task was not found.");
            }
            const committed = committedOption.value;
            // The original prompt survives only as fingerprints in lineage, so a
            // thread with no messages cannot be carried to a new provider and
            // cannot be advanced: refuse instead of recording a no-op switch.
            if (committed.messages.length === 0) {
              return yield* failure(
                "thread_has_no_history",
                "The delegated thread has no message history to hand off. Create a fresh delegation instead.",
              );
            }
            // Repeating the recorded target reuses the stored switch instead of
            // appending a misleading new record — but a replay lost to a crash
            // still has to start, or the child would sit queued forever.
            const lastSwitch = findLastProviderSwitch(committed, lineage);
            const repeatOf =
              lastSwitch !== null &&
              requestedIdentityMatches(target.requested, lastSwitch.requested)
                ? lastSwitch
                : null;
            const switchedFrom = repeatOf?.requested ?? findCurrentTaskIdentity(committed, lineage);
            const oldProvider = {
              providerInstanceId: switchedFrom.providerInstanceId,
              driverKind: switchedFrom.driverKind,
              model: switchedFrom.model,
            };
            const switchedAt = repeatOf?.switchedAt ?? (yield* dependencies.now);
            const prevTransition = lastSwitch?.prevTransition ?? null;
            const transition = switchTransitionHash(oldProvider, target.requested, prevTransition);
            const transitionId = (prefix: string) =>
              deterministicId(prefix, input.taskId, transition);
            if (repeatOf === null) {
              yield* dependencies
                .dispatch({
                  type: "thread.meta.update",
                  commandId: CommandId.make(transitionId("mcp-provider-switch-meta")),
                  threadId: input.taskId,
                  modelSelection: target.modelSelection,
                })
                .pipe(Effect.mapError(orchestrationFailure("repoint delegated thread provider")));
            }
            const rows = yield* listTurns(input.taskId);
            const matchingRows = rows.filter(
              (row) => row.pendingMessageId === lineage.delegatedMessageId,
            );
            const concrete = matchingRows.find(
              (row): row is ProjectionTurn & { readonly turnId: TurnId } => row.turnId !== null,
            );
            const pendingCount = matchingRows.filter((row) => row.turnId === null).length;
            const switchScope = {
              messageCount: committed.messages.length,
              pendingCount,
              lineagePreserved: true as const,
            };
            if (repeatOf === null) {
              const payload: DelegationProviderSwitchedPayload = {
                version: DELEGATION_ACTIVITY_VERSION,
                taskId: input.taskId,
                delegatedMessageId: lineage.delegatedMessageId,
                oldProvider,
                requested: target.requested,
                reason: input.reason,
                scope: switchScope,
                switchedAt,
                prevTransition: transition,
              };
              const lineageCommandId = transitionId("mcp-provider-switch-lineage");
              yield* dependencies
                .dispatch({
                  type: "thread.activity.append",
                  commandId: CommandId.make(lineageCommandId),
                  threadId: input.taskId,
                  activity: {
                    id: EventId.make(lineageCommandId),
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
            }
            // Advance only when nothing is queued or bound yet: the delegated
            // turn was rejected or suppressed before it could start, and the
            // stored prompt is replayed on the new provider. A queued or running
            // turn is never restarted; it drains on the old provider. The replay
            // carries followUpBehavior queue so startup recovery replays it after
            // a crash before the reactor runs; the transition command ID keeps
            // the replay once-only.
            let advanced = false;
            if (concrete === undefined && pendingCount === 0) {
              const delegatedMessage = committed.messages.find(
                (message) => message.id === lineage.delegatedMessageId && message.role === "user",
              );
              if (delegatedMessage !== undefined) {
                yield* dependencies
                  .dispatch({
                    type: "thread.turn.start",
                    commandId: CommandId.make(transitionId("mcp-provider-switch-start")),
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
                    followUpBehavior: "queue",
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
              requested: repeatOf?.requested ?? target.requested,
              reason: input.reason,
              scope: switchScope,
              advanced,
              task,
            };
          }),
        );
      }),
    boardCreateCard: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        yield* denyArchitectCaller(yield* resolveControlPlaneCaller(scope), "own boards");
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
        yield* denyArchitectCaller(yield* resolveControlPlaneCaller(scope), "own boards");
        const repo = yield* requireBoardRepository();
        const card = yield* requireOwnedCard(repo, scope, BoardCardId.make(input.cardId));
        if (input.executorThreadId !== undefined && input.executorThreadId !== null) {
          yield* denyArchitectTarget(input.executorThreadId, "board_update_card");
        }
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
        yield* denyArchitectCaller(yield* resolveControlPlaneCaller(scope), "own boards");
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
    architectCreateOrGet: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        yield* requireSplitEnabled();
        const store = yield* requireArchitectStore();
        const parent = yield* requireActiveParent(scope);
        yield* checkCoordinatorIdentity(
          scope,
          input.coordinatorThreadId,
          parent.thread,
          "create an architect",
        );
        const at = yield* nowIso();
        const coordinatorThreadId = input.coordinatorThreadId;
        const activeBeforeCreate = yield* store
          .getActiveBindingByCoordinator(coordinatorThreadId)
          .pipe(Effect.mapError(mapStoreError("read architect binding")));
        if (activeBeforeCreate === null) {
          yield* validateArchitectSelection({
            scope,
            parent,
            taskEffort: input.taskEffort,
            modelSelection: input.modelSelection,
            routingEvidence: input.routingEvidence,
          });
        }
        const bindingId = deterministicId(
          "architect-binding",
          coordinatorThreadId,
          input.idempotencyKey,
        );
        // Deterministic `arch:`-derived identity: stable for exact retry,
        // fresh across keys. Losers (created:false) never dispatch create,
        // so concurrent same-target creates converge to exactly one thread.
        const architectThreadId = ThreadId.make(
          `arch:${hash(["architect-thread", coordinatorThreadId, input.idempotencyKey]).slice(0, 40)}`,
        );
        const outcome = yield* store
          .createOrGetBinding({
            bindingId,
            coordinatorThreadId,
            architectThreadId,
            projectId: parent.thread.projectId,
            architectTaskEffort: input.taskEffort,
            routingEvidence: input.routingEvidence,
            createdAt: at,
            createdBy: scope.threadId,
            createIdempotencyKey: input.idempotencyKey,
            createRequestFingerprint: hash({
              taskEffort: input.taskEffort,
              modelSelection: input.modelSelection,
              routingEvidence: input.routingEvidence,
            }),
          })
          .pipe(Effect.mapError(mapStoreError("create architect binding")));
        const binding = outcome.binding;
        if (binding.status !== "active") {
          return yield* failure(
            "binding_not_found",
            "This Architect binding is terminal and cannot be recreated by replaying its create key.",
          );
        }
        const exactCreateReplay = binding.createIdempotencyKey === input.idempotencyKey;
        if (!outcome.created && !exactCreateReplay) {
          return {
            architectThreadId: binding.architectThreadId,
            created: false,
            binding,
          } satisfies OrchestratorMcpArchitectCreateOrGetResult;
        }
        const existingThread = yield* loadThreadShell(binding.architectThreadId);
        if (Option.isNone(existingThread)) {
          yield* createArchitectThread(binding, parent.thread);
        }
        yield* appendPhase1Activity({
          threadId: coordinatorThreadId,
          commandId: `architect-bound:${binding.bindingId}`,
          activityId: `architect-bound:${binding.bindingId}`,
          kind: ARCHITECT_BOUND_ACTIVITY,
          summary: "Architect bound",
          payload: {
            bindingId: binding.bindingId,
            coordinatorThreadId,
            architectThreadId: binding.architectThreadId,
            architectTaskEffort: binding.architectTaskEffort,
            modelSelection: input.modelSelection,
            routingEvidence: binding.routingEvidence,
          },
          createdAt: at,
        });
        return {
          architectThreadId: binding.architectThreadId,
          created: outcome.created,
          binding,
        } satisfies OrchestratorMcpArchitectCreateOrGetResult;
      }),
    architectReplace: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        yield* requireSplitEnabled();
        const store = yield* requireArchitectStore();
        const parent = yield* requireActiveParent(scope);
        yield* checkCoordinatorIdentity(
          scope,
          input.coordinatorThreadId,
          parent.thread,
          "replace the architect",
        );
        const at = yield* nowIso();
        const coordinatorThreadId = input.coordinatorThreadId;
        const newBindingId = deterministicId(
          "architect-binding",
          coordinatorThreadId,
          input.idempotencyKey,
        );
        const newArchitectThreadId = ThreadId.make(
          `arch:${hash(["architect-thread", newBindingId]).slice(0, 40)}`,
        );
        const taskEffort = input.taskEffort;
        const closeRequestFingerprint = hash({
          operation: "replace",
          reason: input.reason,
          taskEffort,
          modelSelection: input.modelSelection,
          routingEvidence: input.routingEvidence,
          replacedByBindingId: newBindingId,
        });
        const createRequestFingerprint = hash({
          taskEffort,
          modelSelection: input.modelSelection,
          routingEvidence: input.routingEvidence,
        });
        const createInput = {
          bindingId: newBindingId,
          coordinatorThreadId,
          architectThreadId: newArchitectThreadId,
          projectId: parent.thread.projectId,
          architectTaskEffort: taskEffort,
          routingEvidence: input.routingEvidence,
          createdAt: at,
          createdBy: scope.threadId,
          createIdempotencyKey: input.idempotencyKey,
          createRequestFingerprint,
        } as const;

        const priorReplacement = yield* store
          .findBindingByCreateKey({
            coordinatorThreadId,
            createIdempotencyKey: input.idempotencyKey,
          })
          .pipe(Effect.mapError(mapStoreError("read architect replacement")));
        if (priorReplacement !== null) {
          // Re-enter the repository's exact fingerprint check before returning
          // a same-key replay. This also closes the crash gap after insert.
          yield* store
            .createOrGetBinding(createInput)
            .pipe(Effect.mapError(mapStoreError("replay architect replacement")));
          if (priorReplacement.status === "active") {
            const existingThread = yield* loadThreadShell(priorReplacement.architectThreadId);
            if (Option.isNone(existingThread)) {
              yield* createArchitectThread(priorReplacement, parent.thread);
            }
            const replaced = yield* store
              .findReplaceReplay({
                coordinatorThreadId,
                closeIdempotencyKey: input.idempotencyKey,
                closeRequestFingerprint,
              })
              .pipe(Effect.mapError(mapStoreError("read replaced architect binding")));
            if (replaced !== null) {
              const linked = yield* store
                .linkReplacementWinner({
                  replacedBindingId: replaced.bindingId,
                  closeIdempotencyKey: input.idempotencyKey,
                  closeRequestFingerprint,
                  winnerBindingId: priorReplacement.bindingId,
                })
                .pipe(Effect.mapError(mapStoreError("link replacement winner")));
              if (linked === null) {
                return yield* failure(
                  "binding_conflict",
                  "The committed replacement could not be linked to its prior binding.",
                );
              }
              const receipt = yield* revokeArchitectCredential(replaced.architectThreadId);
              yield* appendPhase1Activity({
                threadId: coordinatorThreadId,
                commandId: `architect-unbound:${replaced.bindingId}`,
                activityId: `architect-unbound:${replaced.bindingId}`,
                kind: ARCHITECT_UNBOUND_ACTIVITY,
                summary: "Architect replaced",
                payload: {
                  bindingId: replaced.bindingId,
                  architectThreadId: replaced.architectThreadId,
                  reason: input.reason,
                  replacedByBindingId: linked.replacedByBindingId,
                  revokeReceipt: receipt,
                },
                createdAt: at,
              });
              yield* softDeleteArchitectThread(replaced.architectThreadId);
            }
            yield* appendPhase1Activity({
              threadId: coordinatorThreadId,
              commandId: `architect-bound:${priorReplacement.bindingId}`,
              activityId: `architect-bound:${priorReplacement.bindingId}`,
              kind: ARCHITECT_BOUND_ACTIVITY,
              summary: "Architect bound",
              payload: {
                bindingId: priorReplacement.bindingId,
                coordinatorThreadId,
                architectThreadId: priorReplacement.architectThreadId,
                architectTaskEffort: priorReplacement.architectTaskEffort,
                modelSelection: input.modelSelection,
                routingEvidence: priorReplacement.routingEvidence,
              },
              createdAt: at,
            });
          }
          return {
            architectThreadId: priorReplacement.architectThreadId,
            binding: priorReplacement,
          } satisfies OrchestratorMcpArchitectReplaceResult;
        }

        const active = yield* store
          .getActiveBindingByCoordinator(coordinatorThreadId)
          .pipe(Effect.mapError(mapStoreError("read architect binding")));
        let closed: CoordinatorArchitectBinding | null;
        if (active !== null) {
          yield* validateArchitectSelection({
            scope,
            parent,
            taskEffort,
            modelSelection: input.modelSelection,
            routingEvidence: input.routingEvidence,
          });
          closed = yield* store
            .closeBinding({
              bindingId: active.bindingId,
              status: "replaced",
              // The replacement row is not committed yet. Link only after
              // deterministic winner election commits its binding row.
              replacedByBindingId: null,
              detachReason: input.reason,
              idempotencyKey: input.idempotencyKey,
              closeRequestFingerprint,
            })
            .pipe(Effect.mapError(mapStoreError("close architect binding")));
          if (closed === null) {
            const winner = yield* store
              .getActiveBindingByCoordinator(coordinatorThreadId)
              .pipe(Effect.mapError(mapStoreError("resolve architect replacement race")));
            if (winner !== null) {
              return {
                architectThreadId: winner.architectThreadId,
                binding: winner,
              } satisfies OrchestratorMcpArchitectReplaceResult;
            }
            return yield* failure(
              "binding_conflict",
              "Another replacement committed the close; retry after its winner is visible.",
            );
          }
        } else {
          // Recover the committed close-before-create window without reviving
          // an unrelated terminal binding or accepting changed request data.
          closed = yield* store
            .findReplaceReplay({
              coordinatorThreadId,
              closeIdempotencyKey: input.idempotencyKey,
              closeRequestFingerprint,
            })
            .pipe(Effect.mapError(mapStoreError("recover architect replacement")));
          if (closed === null) {
            const winner = yield* store
              .getActiveBindingByCoordinator(coordinatorThreadId)
              .pipe(Effect.mapError(mapStoreError("resolve architect replacement race")));
            if (winner !== null) {
              return {
                architectThreadId: winner.architectThreadId,
                binding: winner,
              } satisfies OrchestratorMcpArchitectReplaceResult;
            }
            return yield* failure(
              "binding_not_found",
              "No active Architect or exact interrupted replacement exists for this coordinator.",
            );
          }
        }
        // Ordered boundary step (1): the durable active→replaced transition
        // commits before any thread or credential work.
        const created = yield* store
          .createOrGetBinding(createInput)
          .pipe(Effect.mapError(mapStoreError("create architect binding")));
        const linked = yield* store
          .linkReplacementWinner({
            replacedBindingId: closed.bindingId,
            closeIdempotencyKey: input.idempotencyKey,
            closeRequestFingerprint,
            winnerBindingId: created.binding.bindingId,
          })
          .pipe(Effect.mapError(mapStoreError("link replacement winner")));
        if (linked === null) {
          return yield* failure(
            "binding_conflict",
            "The committed replacement could not be linked to its prior binding.",
          );
        }
        if (created.binding.bindingId !== newBindingId) {
          // Lost the replace race: our thread.create never ran (binding-first
          // ordering), so converge on the winner. If our deterministic thread
          // id somehow exists (same-key replay after a crash), audit it as a
          // race loser rather than leaking a binding-less architect thread.
          const winner = created.binding;
          const oursOption = yield* loadThreadDetail(newArchitectThreadId);
          if (
            Option.isSome(oursOption) &&
            oursOption.value.id === newArchitectThreadId &&
            winner.architectThreadId !== newArchitectThreadId
          ) {
            const receipt = yield* revokeArchitectCredential(newArchitectThreadId);
            yield* appendPhase1Activity({
              threadId: coordinatorThreadId,
              commandId: `architect-unbound-race:${newBindingId}`,
              activityId: `architect-unbound-race:${newBindingId}`,
              kind: ARCHITECT_UNBOUND_ACTIVITY,
              summary: "Architect race loser soft-deleted",
              payload: {
                bindingId: newBindingId,
                architectThreadId: newArchitectThreadId,
                reason: "binding-race-lost",
                revokeReceipt: receipt,
              },
              createdAt: at,
            });
            yield* softDeleteArchitectThread(newArchitectThreadId);
          }
          return {
            architectThreadId: winner.architectThreadId,
            binding: winner,
          } satisfies OrchestratorMcpArchitectReplaceResult;
        }
        const binding = created.binding;
        yield* createArchitectThread(binding, parent.thread);
        const receipt = yield* revokeArchitectCredential(closed.architectThreadId);
        yield* appendPhase1Activity({
          threadId: coordinatorThreadId,
          commandId: `architect-unbound:${closed.bindingId}`,
          activityId: `architect-unbound:${closed.bindingId}`,
          kind: ARCHITECT_UNBOUND_ACTIVITY,
          summary: "Architect replaced",
          payload: {
            bindingId: closed.bindingId,
            architectThreadId: closed.architectThreadId,
            reason: input.reason,
            replacedByBindingId: linked.replacedByBindingId,
            revokeReceipt: receipt,
          },
          createdAt: at,
        });
        yield* softDeleteArchitectThread(closed.architectThreadId);
        yield* appendPhase1Activity({
          threadId: coordinatorThreadId,
          commandId: `architect-bound:${binding.bindingId}`,
          activityId: `architect-bound:${binding.bindingId}`,
          kind: ARCHITECT_BOUND_ACTIVITY,
          summary: "Architect bound",
          payload: {
            bindingId: binding.bindingId,
            coordinatorThreadId,
            architectThreadId: binding.architectThreadId,
            architectTaskEffort: binding.architectTaskEffort,
            modelSelection: input.modelSelection,
            routingEvidence: binding.routingEvidence,
          },
          createdAt: at,
        });
        return {
          architectThreadId: binding.architectThreadId,
          binding,
        } satisfies OrchestratorMcpArchitectReplaceResult;
      }),
    architectDetach: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        yield* requireSplitEnabled();
        const store = yield* requireArchitectStore();
        const parent = yield* requireActiveParent(scope);
        yield* checkCoordinatorIdentity(
          scope,
          input.coordinatorThreadId,
          parent.thread,
          "detach the architect",
        );
        const at = yield* nowIso();
        const coordinatorThreadId = input.coordinatorThreadId;
        const active = yield* store
          .getActiveBindingByCoordinator(coordinatorThreadId)
          .pipe(Effect.mapError(mapStoreError("read architect binding")));
        if (active === null) {
          // Idempotent replay returns the same terminal binding via the
          // exact close key; terminal bindings never restore.
          const replayed = yield* store
            .findDetachReplay({
              coordinatorThreadId,
              closeIdempotencyKey: input.idempotencyKey,
              closeRequestFingerprint: hash({ operation: "detach", reason: input.reason }),
            })
            .pipe(Effect.mapError(mapStoreError("read architect binding")));
          if (replayed !== null) {
            return { binding: replayed } satisfies OrchestratorMcpArchitectDetachResult;
          }
          return yield* failure(
            "binding_not_found",
            "No active architect binding for this coordinator.",
          );
        }
        const closed = yield* store
          .closeBinding({
            bindingId: active.bindingId,
            status: "detached",
            replacedByBindingId: null,
            detachReason: input.reason,
            idempotencyKey: input.idempotencyKey,
            closeRequestFingerprint: hash({ operation: "detach", reason: input.reason }),
          })
          .pipe(Effect.mapError(mapStoreError("close architect binding")));
        if (closed === null || closed.status !== "detached") {
          return yield* failure(
            "binding_conflict",
            "The Architect binding changed during detach; read the current binding before retrying.",
          );
        }
        const receipt = yield* revokeArchitectCredential(active.architectThreadId);
        yield* appendPhase1Activity({
          threadId: coordinatorThreadId,
          commandId: `architect-unbound:${active.bindingId}`,
          activityId: `architect-unbound:${active.bindingId}`,
          kind: ARCHITECT_UNBOUND_ACTIVITY,
          summary: "Architect detached",
          payload: {
            bindingId: active.bindingId,
            architectThreadId: active.architectThreadId,
            reason: input.reason,
            replacedByBindingId: null,
            revokeReceipt: receipt,
          },
          createdAt: at,
        });
        yield* softDeleteArchitectThread(active.architectThreadId);
        return {
          binding: closed,
        } satisfies OrchestratorMcpArchitectDetachResult;
      }),
    architectureReviewRequest: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        yield* requireSplitEnabled();
        const store = yield* requireArchitectStore();
        const parent = yield* requireActiveParent(scope);
        yield* checkCoordinatorIdentity(
          scope,
          input.coordinatorThreadId,
          parent.thread,
          "request an architecture review",
        );
        const posture = (input as { readonly executionPosture?: unknown }).executionPosture;
        if (posture !== "continue" && posture !== "pause-branch" && posture !== "pause-all") {
          // Schema requires executionPosture (no default); this is
          // defense-in-depth so a missing posture is a typed rejection with
          // no record created.
          return yield* failure(
            "orchestration_error",
            "A review request requires an explicit executionPosture: continue, pause-branch, or pause-all.",
          );
        }
        const at = yield* nowIso();
        const coordinatorThreadId = input.coordinatorThreadId;
        const binding = yield* store
          .getActiveBindingByCoordinator(coordinatorThreadId)
          .pipe(Effect.mapError(mapStoreError("read architect binding")));
        if (binding === null) {
          return yield* failure(
            "binding_not_found",
            "No active architect binding for this coordinator.",
          );
        }
        const reviewId = deterministicId(
          "architecture-review",
          coordinatorThreadId,
          input.idempotencyKey,
        );
        const outcome = yield* store
          .insertReview({
            reviewId,
            bindingId: binding.bindingId,
            coordinatorThreadId: binding.coordinatorThreadId,
            architectThreadId: binding.architectThreadId,
            subjectChildThreadId: input.subjectChildThreadId ?? null,
            reason: input.reason,
            question: input.question,
            refs: input.refs ?? {},
            executionPosture: input.executionPosture,
            requestIdempotencyKey: input.idempotencyKey,
            requestPayloadFingerprint: hash({
              subjectChildThreadId: input.subjectChildThreadId ?? null,
              reason: input.reason,
              question: input.question,
              refs: input.refs ?? {},
              executionPosture: input.executionPosture,
            }),
            createdAt: at,
          })
          .pipe(Effect.mapError(mapStoreError("insert architecture review")));
        const review = outcome.review;
        // Ordered intent first: architect aggregate carries the request,
        // coordinator aggregate carries only the typed no-wake reference.
        // Deterministic command ids also repair an exact retry after a crash
        // between the durable insert and either activity append.
        yield* appendPhase1Activity({
          threadId: binding.architectThreadId,
          commandId: `arch:review-requested:${reviewId}`,
          activityId: `arch:review-requested:${reviewId}`,
          kind: REVIEW_REQUESTED_ACTIVITY,
          summary: "Architecture review requested",
          payload: {
            reviewId,
            bindingId: binding.bindingId,
            reason: review.reason,
            question: review.question,
            refs: review.refs,
            executionPosture: review.executionPosture,
            subjectChildThreadId: review.subjectChildThreadId,
          },
          createdAt: at,
        });
        yield* appendPhase1Activity({
          threadId: binding.coordinatorThreadId,
          commandId: reviewRefCommandId(reviewId),
          activityId: reviewRefCommandId(reviewId),
          kind: REVIEW_REQUESTED_REF_ACTIVITY,
          summary: "Architecture review requested (no wake)",
          payload: {
            reviewId,
            bindingId: binding.bindingId,
            reason: review.reason,
            executionPosture: review.executionPosture,
          },
          createdAt: at,
        });
        // Marker-gated: exact replay and crash-gap recovery converge here.
        yield* wakeArchitectForReview(review, binding, at);
        return { reviewId, status: "open" } satisfies OrchestratorMcpReviewRequestResult;
      }),
    architectureReviewAnswer: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        yield* requireSplitEnabled();
        const store = yield* requireArchitectStore();
        const disposition = (input as { readonly disposition?: unknown }).disposition;
        if (
          disposition !== "recommendation" &&
          disposition !== "needs-human-decision" &&
          disposition !== "needs-more-evidence"
        ) {
          return yield* failure(
            "orchestration_error",
            "An architecture answer requires an explicit disposition: recommendation, needs-human-decision, or needs-more-evidence.",
          );
        }
        const at = yield* nowIso();
        const review = yield* store
          .getReviewById(input.reviewId)
          .pipe(Effect.mapError(mapStoreError("read architecture review")));
        if (review === null) {
          return yield* failure("review_not_found", "The architecture review was not found.");
        }
        // Architect-side only: the caller must hold the review's ACTIVE
        // binding. A stale pre-revoke credential finds no binding and fails
        // here even before registry revocation lands.
        const callerBinding = yield* store
          .getActiveBindingByArchitect(scope.threadId)
          .pipe(Effect.mapError(mapStoreError("read architect binding")));
        if (callerBinding === null || callerBinding.bindingId !== review.bindingId) {
          return yield* failure(
            "architect_denied",
            "Only the bound architect thread may answer its own reviews.",
          );
        }
        const fingerprint = hash({
          summary: input.summary,
          disposition: input.disposition,
          oclRefs: input.oclRefs ?? [],
        });
        const transition = yield* store
          .answerReview({
            reviewId: review.reviewId,
            disposition: input.disposition,
            summary: input.summary,
            oclRefs: [...(input.oclRefs ?? [])],
            answerIdempotencyKey: input.idempotencyKey,
            answerPayloadFingerprint: fingerprint,
            answeredAt: at,
          })
          .pipe(Effect.mapError(mapStoreError("answer architecture review")));
        if (transition._tag === "conflict") {
          return yield* failure(
            "idempotency_conflict",
            "This answer key already stored a different answer payload (summary, disposition, or refs).",
          );
        }
        if (transition._tag === "state") {
          return yield* failure(
            "review_state_conflict",
            "The review is no longer open for answering.",
          );
        }
        if (transition._tag === "applied" || transition._tag === "replay") {
          yield* appendPhase1Activity({
            threadId: review.architectThreadId,
            commandId: `arch:review-answered:${review.reviewId}`,
            activityId: `arch:review-answered:${review.reviewId}`,
            kind: REVIEW_ANSWERED_ACTIVITY,
            summary: "Architecture review answered",
            payload: {
              reviewId: review.reviewId,
              disposition: input.disposition,
              summary: input.summary,
              oclRefs: input.oclRefs ?? [],
            },
            createdAt: at,
          });
        }
        // NEVER wakes the coordinator (normative §7.3): no turn dispatch on
        // any answer path, regardless of disposition.
        const stored =
          transition._tag === "replay"
            ? ((yield* store
                .getReviewById(review.reviewId)
                .pipe(Effect.mapError(mapStoreError("read architecture review")))) ?? review)
            : review;
        return {
          reviewId: review.reviewId,
          status: "answered",
          disposition: stored.answerDisposition ?? input.disposition,
        } satisfies OrchestratorMcpReviewAnswerResult;
      }),
    architectureReviewCancel: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        yield* requireSplitEnabled();
        const store = yield* requireArchitectStore();
        const at = yield* nowIso();
        const review = yield* store
          .getReviewById(input.reviewId)
          .pipe(Effect.mapError(mapStoreError("read architecture review")));
        if (review === null) {
          return yield* failure("review_not_found", "The architecture review was not found.");
        }
        // Coordinator/human only: architect cancel is denied even for its
        // own reviews; anyone else is out of scope.
        const caller = yield* resolveControlPlaneCaller(scope);
        if (caller.kind === "architect") {
          return yield* failure(
            "architect_denied",
            "Architect threads cannot cancel reviews; cancellation is coordinator/human only.",
          );
        }
        if (scope.threadId !== review.coordinatorThreadId) {
          return yield* failure(
            "capability_denied",
            "Only the coordinator thread itself (or a human on it) may cancel this review.",
          );
        }
        const transition = yield* store
          .cancelReview({
            reviewId: review.reviewId,
            cancelIdempotencyKey: input.idempotencyKey,
            cancelPayloadFingerprint: hash({
              reason: input.reason,
              cancelledBy: scope.threadId,
            }),
            cancelledAt: at,
            cancelledBy: scope.threadId,
          })
          .pipe(Effect.mapError(mapStoreError("cancel architecture review")));
        if (transition._tag === "state") {
          return yield* failure(
            "review_state_conflict",
            "Only open or answered reviews can be cancelled.",
          );
        }
        if (transition._tag === "conflict") {
          return yield* failure(
            "idempotency_conflict",
            "This cancel key was already used with a different reason.",
          );
        }
        if (transition._tag === "applied" || transition._tag === "replay") {
          yield* appendPhase1Activity({
            threadId: review.coordinatorThreadId,
            commandId: `arch:review-cancelled:${review.reviewId}`,
            activityId: `arch:review-cancelled:${review.reviewId}`,
            kind: REVIEW_CANCELLED_ACTIVITY,
            summary: "Architecture review cancelled",
            payload: { reviewId: review.reviewId, reason: input.reason },
            createdAt: at,
          });
        }
        return {
          reviewId: review.reviewId,
          status: "cancelled",
        } satisfies OrchestratorMcpReviewCancelResult;
      }),
    publishToCoordinator: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        yield* requireSplitEnabled();
        const store = yield* requireArchitectStore();
        const at = yield* nowIso();
        // Durable refusal record: any publish failure for a known review is
        // written to that review with its stable reason token (the
        // `[reason=...]` token for parent_not_active refusals such as
        // `parent_scope_drift`, otherwise the failure code), so the
        // coordinator can see the cause in `list_architecture_reviews`
        // without reading logs. Status and idempotency semantics are
        // untouched: recording never changes them and never turns a failed
        // delivery into a success.
        const recordPublishFailure = (reviewId: string, error: unknown) => {
          const reason = publishFailureReasonToken(error);
          const message = isOrchestratorMcpFailure(error) ? error.message : errorMessage(error);
          return store
            .recordPublishFailure({
              reviewId,
              reason,
              message: message.slice(0, 2_000),
              attemptedAt: at,
            })
            .pipe(Effect.mapError(mapStoreError("record publish failure")), Effect.ignore);
        };
        const refuse = function* (
          reviewId: string,
          code: OrchestratorMcpFailureCode,
          message: string,
        ) {
          const error = failure(code, message);
          yield* recordPublishFailure(reviewId, error);
          return yield* error;
        };
        const review = yield* store
          .getReviewById(input.reviewId)
          .pipe(Effect.mapError(mapStoreError("read architecture review")));
        if (review === null) {
          return yield* failure("review_not_found", "The architecture review was not found.");
        }
        // Sole architect-originated coordinator wake: the caller is the bound
        // architect (own review) or the coordinator/human on it.
        const caller = yield* resolveControlPlaneCaller(scope);
        const isOwnerArchitect =
          caller.kind === "architect" && caller.binding.bindingId === review.bindingId;
        const isCoordinator = scope.threadId === review.coordinatorThreadId;
        if (!isOwnerArchitect && !isCoordinator) {
          return yield* refuse(
            review.reviewId,
            caller.kind === "architect" ? "architect_denied" : "capability_denied",
            "Only the bound architect or the coordinator may publish this review.",
          );
        }
        const binding = yield* store
          .getBindingById(review.bindingId)
          .pipe(Effect.mapError(mapStoreError("read architect binding")));
        if (binding === null) {
          return yield* refuse(
            review.reviewId,
            "binding_not_found",
            "The review binding no longer exists.",
          );
        }
        // Validate the credential's frozen scope before changing review state;
        // a drift refusal is recorded below and remains a failed publish.
        yield* loadSwitchParent(scope).pipe(
          Effect.tapError((error) => recordPublishFailure(review.reviewId, error)),
        );
        const transition = yield* store
          .publishReview({
            reviewId: review.reviewId,
            publishIdempotencyKey: input.idempotencyKey,
            publishedAt: at,
          })
          .pipe(Effect.mapError(mapStoreError("publish architecture review")));
        if (transition._tag === "conflict") {
          return yield* refuse(
            review.reviewId,
            "idempotency_conflict",
            "This publish key was already used for this review.",
          );
        }
        if (transition._tag === "state") {
          return yield* refuse(
            review.reviewId,
            "review_state_conflict",
            "Only answered reviews can be published.",
          );
        }
        const stored =
          transition._tag === "replay"
            ? ((yield* store
                .getReviewById(review.reviewId)
                .pipe(Effect.mapError(mapStoreError("read architecture review")))) ?? review)
            : review;
        // Publish content and wake delivery. A failure here must not become
        // a silent success: the wake error is recorded on the review and the
        // call still fails, so `published` without `publishDeliveredAt` plus
        // `lastPublishFailure` tells the coordinator delivery never fired.
        const deliver = Effect.gen(function* () {
          if (transition._tag === "applied" || transition._tag === "replay") {
            // The published content carries the STORED disposition with summary
            // and stable links — never a caller-supplied replacement.
            yield* appendPhase1Activity({
              threadId: binding.coordinatorThreadId,
              commandId: `arch:review-published:${review.reviewId}`,
              activityId: `arch:review-published:${review.reviewId}`,
              kind: REVIEW_PUBLISHED_ACTIVITY,
              summary: "Architecture review published",
              payload: {
                reviewId: stored.reviewId,
                disposition: stored.answerDisposition,
                summary: stored.answerSummary,
                refs: stored.refs,
              },
              createdAt: at,
            });
          }
          // Marker-gated: replay is a no-op once the wake marker exists, and a
          // crash between wake dispatch and marker reuses the deterministic
          // wake ids (receipt dedup → exactly one coordinator turn).
          yield* wakeCoordinatorForPublish(stored, binding, at);
        }).pipe(Effect.tapError((error) => recordPublishFailure(review.reviewId, error)));
        yield* deliver;
        // The wake fired: prove delivery durably and clear any prior refusal.
        // If this write fails the call fails too — never a silent success.
        yield* store
          .markPublishDelivered({ reviewId: review.reviewId, deliveredAt: at })
          .pipe(Effect.mapError(mapStoreError("mark publish delivered")));
        return {
          reviewId: review.reviewId,
          status: "published",
        } satisfies OrchestratorMcpPublishToCoordinatorResult;
      }),
    getCoordinatorBinding: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        yield* requireSplitEnabled();
        const store = yield* requireArchitectStore();
        yield* denyExecutorCaller(scope, "query architect bindings");
        // Query scope: coordinator thread itself, human on it, or the bound
        // architect (own binding only).
        const caller = yield* resolveControlPlaneCaller(scope);
        if (caller.kind === "architect") {
          if (caller.binding.coordinatorThreadId !== input.coordinatorThreadId) {
            return yield* failure(
              "architect_denied",
              "Architect threads may only query their own binding.",
            );
          }
        } else if (scope.threadId !== input.coordinatorThreadId) {
          return yield* failure(
            "capability_denied",
            "Only the coordinator thread itself (or a human on it) may query this binding.",
          );
        }
        const binding = yield* store
          .getActiveBindingByCoordinator(input.coordinatorThreadId)
          .pipe(Effect.mapError(mapStoreError("read architect binding")));
        return { binding } satisfies OrchestratorMcpGetCoordinatorBindingResult;
      }),
    listArchitectureReviews: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        yield* requireSplitEnabled();
        const store = yield* requireArchitectStore();
        yield* denyExecutorCaller(scope, "query architecture reviews");
        const caller = yield* resolveControlPlaneCaller(scope);
        if (caller.kind === "architect") {
          if (caller.binding.coordinatorThreadId !== input.coordinatorThreadId) {
            return yield* failure(
              "architect_denied",
              "Architect threads may only query their own reviews.",
            );
          }
        } else if (scope.threadId !== input.coordinatorThreadId) {
          return yield* failure(
            "capability_denied",
            "Only the coordinator thread itself (or a human on it) may query these reviews.",
          );
        }
        const reviews = yield* store
          .listReviewsByCoordinator({
            coordinatorThreadId: input.coordinatorThreadId,
            ...(input.status === undefined ? {} : { status: input.status }),
          })
          .pipe(Effect.mapError(mapStoreError("list architecture reviews")));
        return { reviews } satisfies OrchestratorMcpListArchitectureReviewsResult;
      }),
    reconcileAfterRestart: () =>
      Effect.gen(function* () {
        const store = yield* requireArchitectStore();
        const at = yield* nowIso();
        const outcomes: Array<{ readonly bindingId: string; readonly outcome: string }> = [];
        const actives = yield* store
          .listActiveBindings()
          .pipe(Effect.mapError(mapStoreError("list active bindings")));
        for (const binding of actives) {
          const shellOption = yield* loadThreadShell(binding.architectThreadId);
          if (Option.isNone(shellOption)) {
            const createReceiptStatus =
              dependencies.getArchitectCreateReceiptStatus === undefined
                ? "unavailable"
                : yield* dependencies.getArchitectCreateReceiptStatus(binding.bindingId);
            if (createReceiptStatus === "missing") {
              // A binding-first crash before dispatch has no create receipt.
              // Replay the stable command id to heal exactly that window.
              const coordinator = yield* loadThreadShell(binding.coordinatorThreadId);
              if (Option.isNone(coordinator)) {
                outcomes.push({
                  bindingId: binding.bindingId,
                  outcome: "architect-create-recovery-waiting-for-coordinator",
                });
                continue;
              }
              yield* createArchitectThread(binding, coordinator.value);
              const selected = binding.routingEvidence?.consideredCandidates.at(-1);
              yield* appendPhase1Activity({
                threadId: binding.coordinatorThreadId,
                commandId: `architect-bound:${binding.bindingId}`,
                activityId: `architect-bound:${binding.bindingId}`,
                kind: ARCHITECT_BOUND_ACTIVITY,
                summary: "Architect bound",
                payload: {
                  bindingId: binding.bindingId,
                  coordinatorThreadId: binding.coordinatorThreadId,
                  architectThreadId: binding.architectThreadId,
                  architectTaskEffort: binding.architectTaskEffort,
                  modelSelection:
                    selected === undefined
                      ? null
                      : {
                          instanceId: selected.providerInstanceId,
                          model: selected.model,
                          options: selected.options,
                        },
                  routingEvidence: binding.routingEvidence,
                },
                createdAt: binding.createdAt,
              });
              outcomes.push({
                bindingId: binding.bindingId,
                outcome: "architect-thread-recovered",
              });
            } else {
              // An accepted create receipt proves this is a thread lost while
              // the server was down. A rejected or unavailable receipt cannot
              // safely justify creating a new execution identity either.
              const missingReason = "thread-missing-after-restart";
              const closed = yield* store
                .closeBinding({
                  bindingId: binding.bindingId,
                  status: "detached",
                  replacedByBindingId: null,
                  detachReason: missingReason,
                  idempotencyKey: `architect-missing-thread:${binding.bindingId}`,
                  closeRequestFingerprint: hash({
                    operation: "reconcile-missing-thread",
                    reason: missingReason,
                  }),
                })
                .pipe(Effect.mapError(mapStoreError("detach missing architect thread")));
              if (closed === null) {
                const current = yield* store
                  .getBindingById(binding.bindingId)
                  .pipe(Effect.mapError(mapStoreError("resolve missing architect close race")));
                outcomes.push({
                  bindingId: binding.bindingId,
                  outcome:
                    current === null
                      ? "binding-missing-during-reconcile"
                      : `binding-closed-concurrently:${current.status}`,
                });
                continue;
              }
              const revokeReceipt = yield* revokeArchitectCredential(binding.architectThreadId);
              yield* appendPhase1Activity({
                threadId: binding.coordinatorThreadId,
                commandId: `architect-unbound:${binding.bindingId}`,
                activityId: `architect-unbound:${binding.bindingId}`,
                kind: ARCHITECT_UNBOUND_ACTIVITY,
                summary: "Architect missing after restart",
                payload: {
                  bindingId: binding.bindingId,
                  architectThreadId: binding.architectThreadId,
                  reason: missingReason,
                  replacedByBindingId: closed.replacedByBindingId,
                  revokeReceipt,
                },
                createdAt: at,
              });
              yield* softDeleteArchitectThread(binding.architectThreadId);
              outcomes.push({ bindingId: binding.bindingId, outcome: missingReason });
              continue;
            }
          }
          // Marker-gap replay derives missing wakes exclusively from marker
          // absence: open without review marker → re-wake architect once;
          // published without publish marker → wake coordinator once;
          // answered-unpublished → no wake to anyone.
          const reviews = yield* store
            .listReviewsByCoordinator({ coordinatorThreadId: binding.coordinatorThreadId })
            .pipe(Effect.mapError(mapStoreError("list architecture reviews")));
          for (const review of reviews) {
            if (review.status === "open") {
              const detailOption = yield* loadArchitectActivityDetail(binding.architectThreadId);
              if (
                Option.isSome(detailOption) &&
                needsReviewWakeReplay(
                  detailOption.value.activities,
                  binding.architectThreadId,
                  review.reviewId,
                )
              ) {
                yield* wakeArchitectForReview(review, binding, at);
                outcomes.push({
                  bindingId: binding.bindingId,
                  outcome: `review-wake-replayed:${review.reviewId}`,
                });
              }
            } else if (review.status === "published") {
              const detailOption = yield* loadArchitectActivityDetail(binding.coordinatorThreadId);
              if (
                Option.isSome(detailOption) &&
                needsPublishWakeReplay(
                  detailOption.value.activities,
                  binding.coordinatorThreadId,
                  review.reviewId,
                )
              ) {
                yield* wakeCoordinatorForPublish(review, binding, at);
                outcomes.push({
                  bindingId: binding.bindingId,
                  outcome: `publish-wake-replayed:${review.reviewId}`,
                });
              }
            }
          }
        }
        // Binding-less architect-thread sweep: any `arch:` thread with no
        // binding row at all is a race orphan (soft-deleted threads keep
        // their terminal rows, so they are never touched here).
        if (dependencies.getShellSnapshot !== undefined) {
          const snapshot = yield* dependencies
            .getShellSnapshot()
            .pipe(Effect.mapError(orchestrationFailure("read shell snapshot")));
          // A close is durable before credential revocation and the audit
          // notice. If the process stops in that gap while the Architect
          // shell is already missing, the active-binding loop cannot see it
          // next time; replay the terminal audit from retained binding rows.
          for (const coordinator of snapshot.threads) {
            if (coordinator.id.startsWith("arch:")) continue;
            const bindings = yield* store
              .listBindingsByCoordinator(coordinator.id)
              .pipe(Effect.mapError(mapStoreError("read architect binding history")));
            for (const binding of bindings) {
              if (
                binding.status !== "detached" ||
                binding.detachReason !== "thread-missing-after-restart"
              ) {
                continue;
              }
              const detailOption = yield* loadArchitectActivityDetail(coordinator.id);
              if (Option.isNone(detailOption)) {
                outcomes.push({
                  bindingId: binding.bindingId,
                  outcome: "missing-architect-close-audit-waiting-for-coordinator",
                });
                continue;
              }
              const unboundId = `architect-unbound:${binding.bindingId}`;
              if (detailOption.value.activities.some((activity) => activity.id === unboundId)) {
                continue;
              }
              const revokeReceipt = yield* revokeArchitectCredential(binding.architectThreadId);
              yield* appendPhase1Activity({
                threadId: binding.coordinatorThreadId,
                commandId: unboundId,
                activityId: unboundId,
                kind: ARCHITECT_UNBOUND_ACTIVITY,
                summary: "Architect missing after restart",
                payload: {
                  bindingId: binding.bindingId,
                  architectThreadId: binding.architectThreadId,
                  reason: "thread-missing-after-restart",
                  replacedByBindingId: binding.replacedByBindingId,
                  revokeReceipt,
                },
                createdAt: at,
              });
              outcomes.push({
                bindingId: binding.bindingId,
                outcome: "missing-architect-close-audit-replayed",
              });
            }
          }
          for (const thread of snapshot.threads) {
            if (!thread.id.startsWith("arch:")) continue;
            const known = yield* store
              .getAnyBindingByArchitect(thread.id)
              .pipe(Effect.mapError(mapStoreError("read architect binding")));
            if (known !== null) {
              if (known.status === "active") continue;
              const receipt = yield* revokeArchitectCredential(ThreadId.make(thread.id));
              yield* appendPhase1Activity({
                threadId: known.coordinatorThreadId,
                commandId: `architect-unbound:${known.bindingId}`,
                activityId: `architect-unbound:${known.bindingId}`,
                kind: ARCHITECT_UNBOUND_ACTIVITY,
                summary: "Architect soft-deleted during restart reconciliation",
                payload: {
                  bindingId: known.bindingId,
                  architectThreadId: thread.id,
                  reason: known.status,
                  replacedByBindingId: known.replacedByBindingId,
                  revokeReceipt: receipt,
                },
                createdAt: at,
              });
              yield* softDeleteArchitectThread(ThreadId.make(thread.id));
              outcomes.push({
                bindingId: known.bindingId,
                outcome: "terminal-thread-soft-deleted",
              });
              continue;
            }
            const receipt = yield* revokeArchitectCredential(ThreadId.make(thread.id));
            yield* appendPhase1Activity({
              threadId: ThreadId.make(thread.id),
              commandId: `architect-unbound-orphan:${thread.id}`,
              activityId: `architect-unbound-orphan:${thread.id}`,
              kind: ARCHITECT_UNBOUND_ACTIVITY,
              summary: "Binding-less architect thread soft-deleted",
              payload: {
                bindingId: null,
                architectThreadId: thread.id,
                reason: "binding-race-lost",
                revokeReceipt: receipt,
              },
              createdAt: at,
            });
            yield* softDeleteArchitectThread(ThreadId.make(thread.id));
            outcomes.push({ bindingId: thread.id, outcome: "orphan-soft-deleted" });
          }
        }
        return outcomes;
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
  // Same for the coordinator/architect store: the nine Phase 1 tools fail
  // closed without it, while pre-split tools keep working.
  const coordinatorArchitect = yield* Effect.serviceOption(CoordinatorArchitectRepository).pipe(
    Effect.map(Option.getOrUndefined),
  );
  const commandReceipts = yield* Effect.serviceOption(OrchestrationCommandReceiptRepository).pipe(
    Effect.map(Option.getOrUndefined),
  );
  const sessionRegistry = yield* Effect.serviceOption(McpSessionRegistry).pipe(
    Effect.map(Option.getOrUndefined),
  );
  const service = makeService({
    dispatch: engine.dispatch,
    subscribeDomainEvents: engine.subscribeDomainEvents,
    getThreadShellById: snapshots.getThreadShellById,
    getProjectShellById: snapshots.getProjectShellById,
    getThreadDetailById: snapshots.getThreadDetailById,
    getShellSnapshot: snapshots.getShellSnapshot,
    getArchivedShellSnapshot: snapshots.getArchivedShellSnapshot,
    getThreadDetailSnapshotIncludingArchived: snapshots.getThreadDetailSnapshotIncludingArchived,
    listDelegatedTaskMemoryRows: snapshots.listDelegatedTaskMemoryRows,
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
    ...(coordinatorArchitect === undefined ? {} : { coordinatorArchitect }),
    getArchitectCreateReceiptStatus: (bindingId) => {
      if (commandReceipts === undefined) return Effect.succeed("unavailable" as const);
      return commandReceipts
        .getByCommandId({ commandId: CommandId.make(`architect-create:${bindingId}`) })
        .pipe(
          Effect.mapError(orchestrationFailure("read architect create receipt")),
          Effect.map((receipt) =>
            Option.match(receipt, {
              onNone: () => "missing" as const,
              onSome: (value) => value.status,
            }),
          ),
        );
    },
    ...(sessionRegistry === undefined
      ? {}
      : {
          revokeThreadCredential: (threadId: ThreadId) => sessionRegistry.revokeThread(threadId),
        }),
  });
  // Run recovery once per server process without making HTTP readiness depend
  // on its success. A failed replay must not hide the desktop window.
  if (coordinatorArchitect !== undefined) {
    yield* Effect.forkScoped(
      service.reconcileAfterRestart().pipe(
        Effect.withSpan("server.mcp.orchestrator.reconcile"),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("coordinator/architect restart recovery failed", {
                cause: Cause.pretty(cause),
              }),
        ),
      ),
    );
  }
  return OrchestratorMcpService.of(service);
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
  publishFailureReasonToken,
  taskSearchBatchSize: TASK_SEARCH_BATCH_SIZE,
  switchCommitLockCount: () => switchCommitEntries.size,
};

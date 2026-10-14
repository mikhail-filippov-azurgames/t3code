import * as NodeCrypto from "node:crypto";

import {
  COORDINATOR_ARCHITECT_ACTIVITY_KINDS,
  assertNotArchitectThread,
} from "../../../orchestration/coordinatorArchitect.ts";
import {
  CommandId,
  EventId,
  MessageId,
  ORCHESTRATOR_MCP_TASK_PAGE_MAX,
  OrchestratorMcpArchitectCreateOrGetResult,
  OrchestratorMcpArchitectDetachResult,
  OrchestratorMcpArchitectReplaceResult,
  OrchestratorMcpBoardCreateCardInput,
  OrchestratorMcpBoardCreateCardResult,
  OrchestratorMcpBoardDeleteCardInput,
  OrchestratorMcpBoardDeleteCardResult,
  OrchestratorMcpBoardListCardsInput,
  OrchestratorMcpBoardListCardsResult,
  OrchestratorMcpBoardUpdateCardInput,
  OrchestratorMcpBoardUpdateCardResult,
  OrchestratorMcpFailure,
  OrchestratorMcpGetCoordinatorBindingResult,
  OrchestratorMcpListArchitectureReviewsResult,
  OrchestratorMcpPublishToCoordinatorResult,
  OrchestratorMcpPrepareCoordinatorPublicationResult,
  OrchestratorMcpRequestedIdentity,
  OrchestratorMcpReviewAnswerResult,
  OrchestratorMcpReviewCancelResult,
  OrchestratorMcpReviewRequestResult,
  OrchestratorMcpSendToTaskResult,
  OrchestratorMcpTaskListInput,
  OrchestratorMcpTaskListResult,
  OrchestratorMcpTaskReadInput,
  OrchestratorMcpTaskReadResult,
  OrchestratorMcpTaskSearchInput,
  OrchestratorMcpTaskSearchResult,
  OrchestratorMcpTaskSummaryHistoryInput,
  OrchestratorMcpTaskSummaryHistoryResult,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type AgentRunOrigin,
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
  type OrchestratorMcpPrepareCoordinatorPublicationInput,
  type OrchestratorMcpReviewAnswerInput,
  type OrchestratorMcpReviewCancelInput,
  type OrchestratorMcpReviewRequestInput,
  type OrchestrationPublishArchitectPublicationInput,
  type OrchestrationPublishArchitectPublicationResult,
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
import { BoardRepository, type BoardRepositoryShape } from "../../../persistence/Services/Board.ts";
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
import { makeCapabilitiesService } from "./capabilitiesService.ts";
import { makeArchitectService } from "./architectService.ts";
import {
  makeDelegationService,
  type ControlPlaneCaller,
  type DelegationCreatedPayload,
  type ParentContext,
  type ResolvedTarget,
  type TargetParentContext,
  type TargetResolutionRequest,
} from "./delegationService.ts";
import { makeBoardService } from "./boardService.ts";
import { makeSwitchSupport, switchCommitLockCount, withSwitchCommitLock } from "./switchSupport.ts";
import { makeTaskQueryService } from "./taskQueryService.ts";
import {
  applyAuthorTextPolicy,
  projectDerivedText,
  type AuthorTextField,
} from "../../../security/SecretTextPolicy.ts";

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
  readonly listDelegatedTaskSummaryHistory?: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["listDelegatedTaskSummaryHistory"];
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
  readonly taskSummaryHistory: (
    scope: McpInvocationScope,
    input: OrchestratorMcpTaskSummaryHistoryInput,
  ) => Effect.Effect<OrchestratorMcpTaskSummaryHistoryResult, OrchestratorMcpFailure>;
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
    input: OrchestratorMcpBoardListCardsInput,
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
  readonly prepareCoordinatorPublication: (
    scope: McpInvocationScope,
    input: OrchestratorMcpPrepareCoordinatorPublicationInput,
  ) => Effect.Effect<OrchestratorMcpPrepareCoordinatorPublicationResult, OrchestratorMcpFailure>;
  readonly publishToCoordinator: (
    scope: McpInvocationScope,
    input: OrchestratorMcpPublishToCoordinatorInput,
  ) => Effect.Effect<OrchestratorMcpPublishToCoordinatorResult, OrchestratorMcpFailure>;
  readonly publishArchitectPublication: (
    input: OrchestrationPublishArchitectPublicationInput,
  ) => Effect.Effect<OrchestrationPublishArchitectPublicationResult, OrchestratorMcpFailure>;
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

function ensureAuthorTextAllowed(field: AuthorTextField, text: string) {
  try {
    if (applyAuthorTextPolicy(field, text)._tag === "Accepted") return Effect.void;
  } catch {
    // A failed check must reject authored text just like a detected secret.
  }
  return Effect.fail(
    failure(
      "author_text_rejected",
      `The authored ${field} could not be confirmed secret-free. Remove sensitive values and try again.`,
    ),
  );
}

function ensureHandoffTextAllowed(handoff: OrchestratorMcpHandoff | undefined) {
  if (handoff === undefined) return Effect.void;
  return Effect.forEach(
    [
      handoff.contractRef,
      handoff.stage,
      ...handoff.owns,
      ...handoff.reads,
      ...handoff.forbidden,
      ...handoff.acceptance,
      ...handoff.outputs,
      ...handoff.evidence,
      ...handoff.predecessorRefs,
    ],
    (text) => ensureAuthorTextAllowed("handoff", text),
    { discard: true },
  );
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
  const switchSupport = makeSwitchSupport({
    activityKind: DELEGATION_PROVIDER_SWITCHED_ACTIVITY,
    activityVersion: DELEGATION_ACTIVITY_VERSION,
    isRequestedIdentity: isOrchestratorMcpRequestedIdentity,
    getProviders: dependencies.getProviders,
    failure,
    hash,
    deterministicId,
  });

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
        const oldProvider = yield* switchSupport.resolveOrdinaryOldProvider(committed, session);
        const switchedAt = yield* dependencies.now;
        const ordinaryPrev =
          switchSupport.findLastOrdinarySwitch(committed, input.taskId)?.prevTransition ?? null;
        const ordinaryTransition = (prefix: string) =>
          switchSupport.switchTransitionId(
            prefix,
            input.taskId,
            oldProvider,
            target.requested,
            ordinaryPrev,
          );
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
          prevTransition: switchSupport.switchTransitionHash(
            oldProvider,
            target.requested,
            ordinaryPrev,
          ),
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
              text: projectDerivedText("read", assistant?.text ?? ""),
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
              message: projectDerivedText(
                "read",
                thread.session?.lastError ??
                  (Predicate.isObject(startFailure?.payload) &&
                  typeof startFailure.payload.detail === "string"
                    ? startFailure.payload.detail
                    : undefined) ??
                  "The delegated provider turn failed.",
              ),
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

  const dispatchDelegatedTurnStart = Effect.fn("OrchestratorMcpService.dispatchDelegatedTurnStart")(
    function* (input: {
      readonly taskId: ThreadId;
      readonly request: OrchestratorMcpDelegateTaskInput;
      readonly lineage: DelegationCreatedPayload;
      readonly target: ResolvedTarget;
      readonly runOrigin: Extract<
        AgentRunOrigin,
        { readonly _tag: "delegation-start" | "delegation-retry" }
      >;
    }) {
      yield* dependencies
        .dispatch({
          type: "thread.turn.start",
          runOrigin: input.runOrigin,
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
          runOrigin: { _tag: "delegation-continuation" },
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

  // Coordinator reads that reveal coordinator-owned state (architect
  // binding/reviews queries) apply the same marked-orchestrator check, but
  // only when a board repository exists: boardless compositions (and their
  // tests) keep the legacy thread-identity behavior, while production — where
  // the board is always present — denies unmarked callers.
  const requireRegisteredOrchestratorWhenBoardPresent = (
    scope: McpInvocationScope,
  ): Effect.Effect<void, OrchestratorMcpFailure> =>
    dependencies.board === undefined
      ? Effect.void
      : Effect.flatMap(requireBoardRepository(), (repo) =>
          requireRegisteredOrchestrator(repo, scope),
        );

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

  const nowIso = () => dependencies.now;

  const boardService = makeBoardService({
    requireCapability,
    denyArchitectCaller: (scope, operation) =>
      Effect.flatMap(resolveControlPlaneCaller(scope), (caller) =>
        denyArchitectCaller(caller, operation),
      ),
    denyExecutorCaller,
    denyArchitectTarget,
    ensureAuthorTextAllowed,
    requireBoardRepository,
    requireRegisteredOrchestrator,
    nowIso,
    failure,
    orchestrationFailure,
  });

  const taskQueryService = makeTaskQueryService({
    dispatch: dependencies.dispatch,
    now: dependencies.now,
    ...(dependencies.listDelegatedTaskMemoryRows === undefined
      ? {}
      : { listDelegatedTaskMemoryRows: dependencies.listDelegatedTaskMemoryRows }),
    ...(dependencies.listDelegatedTaskSummaryHistory === undefined
      ? {}
      : { listDelegatedTaskSummaryHistory: dependencies.listDelegatedTaskSummaryHistory }),
    ...(dependencies.getThreadDetailSnapshotIncludingArchived === undefined
      ? {}
      : {
          getThreadDetailSnapshotIncludingArchived:
            dependencies.getThreadDetailSnapshotIncludingArchived,
        }),
    taskSearchBatchSize: TASK_SEARCH_BATCH_SIZE,
    cancelRequestedActivity: DELEGATION_CANCEL_REQUESTED_ACTIVITY,
    cancelledActivity: DELEGATION_CANCELLED_ACTIVITY,
    failure,
    orchestrationFailure,
    deterministicId,
    requireCapability,
    resolveReadScope,
    denyArchitectCaller: (scope, operation) =>
      Effect.flatMap(resolveControlPlaneCaller(scope), (caller) =>
        denyArchitectCaller(caller, operation),
      ),
    denyArchitectTarget,
    loadThreadDetail,
    listTurns,
    findLineage,
    wasCancelRequested,
    readOwnedTask,
    waitForTask,
    isTerminalStatus,
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
    readonly runOrigin: Extract<
      AgentRunOrigin,
      { readonly _tag: "architect-review-request-wake" | "coordinator-publication-wake" }
    >;
  }) => {
    const dispatchTurn = (turnCommandId: string, messageId: string) =>
      dependencies.dispatch({
        type: "thread.turn.start",
        runOrigin: input.runOrigin,
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

  const architectService = makeArchitectService({
    dependencies: {
      dispatch: dependencies.dispatch,
      getThreadDetailById: dependencies.getThreadDetailById,
      getProviders: dependencies.getProviders,
      getSettings: dependencies.getSettings,
      ...(dependencies.getShellSnapshot === undefined
        ? {}
        : { getShellSnapshot: dependencies.getShellSnapshot }),
      ...(dependencies.coordinatorArchitect === undefined
        ? {}
        : { coordinatorArchitect: dependencies.coordinatorArchitect }),
      ...(dependencies.getArchitectCreateReceiptStatus === undefined
        ? {}
        : { getArchitectCreateReceiptStatus: dependencies.getArchitectCreateReceiptStatus }),
    },
    requireCapability,
    requireSplitEnabled,
    resolveControlPlaneCaller,
    dispatchWakeTurn,
    revokeArchitectCredential,
    denyArchitectCaller,
    denyExecutorCaller,
    requireActiveParent,
    loadSwitchParent,
    loadThreadShell,
    loadThreadDetail,
    requireRegisteredOrchestratorWhenBoardPresent,
    ensureAuthorTextAllowed,
    nowIso,
    failure,
    mapStoreError,
    orchestrationFailure,
    errorMessage,
    hash,
    deterministicId,
    validateOptions,
    providerUnavailableReason,
    providerCapability,
    publishFailureReasonToken,
  });

  const delegationService = makeDelegationService({
    dependencies: {
      dispatch: dependencies.dispatch,
      getProviders: dependencies.getProviders,
      getSettings: dependencies.getSettings,
      loadPermissionEnvelope: dependencies.loadPermissionEnvelope,
      now: dependencies.now,
    },
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
  });

  const capabilitiesService = makeCapabilitiesService({
    getProviders: dependencies.getProviders,
    getSettings: dependencies.getSettings,
    requireActiveParent,
    resolveControlPlaneCaller,
    denyArchitectCaller,
    providerCapability,
    isOrchestratorMcpFailure,
    orchestrationFailure,
  });

  return {
    capabilities: capabilitiesService.capabilities,
    delegateTask: delegationService.delegateTask,
    sendToTask: delegationService.sendToTask,
    taskList: (scope, input) => taskQueryService.taskList(scope, input),
    taskSearch: (scope, input) => taskQueryService.taskSearch(scope, input),
    taskSummaryHistory: (scope, input) => taskQueryService.taskSummaryHistory(scope, input),
    taskRead: (scope, input) => taskQueryService.taskRead(scope, input),
    taskStatus: (scope, taskId) => taskQueryService.taskStatus(scope, taskId),
    taskWait: (scope, taskId, timeoutMs) => taskQueryService.taskWait(scope, taskId, timeoutMs),
    taskCancel: (scope, taskId) => taskQueryService.taskCancel(scope, taskId),
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
            const delegatedPrompt = committed.messages.find(
              (message) => message.id === lineage.delegatedMessageId && message.role === "user",
            );
            if (delegatedPrompt !== undefined) {
              yield* ensureAuthorTextAllowed("prompt", delegatedPrompt.text);
            }
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
            const lastSwitch = switchSupport.findLastProviderSwitch(committed, lineage);
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
            const transition = switchSupport.switchTransitionHash(
              oldProvider,
              target.requested,
              prevTransition,
            );
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
            // Advance only when no live turn exists for the delegated
            // message: the turn was rejected or suppressed before it could
            // start, or it ended terminally failed on the exhausted provider,
            // and the stored prompt is replayed on the new provider. A queued,
            // running, or already-completed turn is never restarted: queued
            // and running turns drain on the old provider, and completed work
            // must not run twice. The replay carries followUpBehavior queue
            // so startup recovery replays it after a crash before the reactor
            // runs; the transition command ID keeps the replay once-only.
            const hasLiveWork = matchingRows.some(
              (row) => row.turnId === null || row.state !== "error",
            );
            let advanced = false;
            if (!hasLiveWork) {
              const delegatedMessage = committed.messages.find(
                (message) => message.id === lineage.delegatedMessageId && message.role === "user",
              );
              if (delegatedMessage !== undefined) {
                yield* dependencies
                  .dispatch({
                    type: "thread.turn.start",
                    runOrigin: { _tag: "delegation-provider-switch-replay" },
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
    boardCreateCard: (scope, input) => boardService.boardCreateCard(scope, input),
    boardUpdateCard: (scope, input) => boardService.boardUpdateCard(scope, input),
    boardDeleteCard: (scope, input) => boardService.boardDeleteCard(scope, input),
    boardListCards: (scope, input) => boardService.boardListCards(scope, input),
    architectCreateOrGet: (scope, input) => architectService.architectCreateOrGet(scope, input),
    architectReplace: (scope, input) => architectService.architectReplace(scope, input),
    architectDetach: (scope, input) => architectService.architectDetach(scope, input),
    architectureReviewRequest: (scope, input) =>
      architectService.architectureReviewRequest(scope, input),
    architectureReviewAnswer: (scope, input) =>
      architectService.architectureReviewAnswer(scope, input),
    architectureReviewCancel: (scope, input) =>
      architectService.architectureReviewCancel(scope, input),
    prepareCoordinatorPublication: (scope, input) =>
      architectService.prepareCoordinatorPublication(scope, input),
    publishToCoordinator: (scope, input) => architectService.publishToCoordinator(scope, input),
    publishArchitectPublication: (input) => architectService.publishArchitectPublication(input),
    getCoordinatorBinding: (scope, input) => architectService.getCoordinatorBinding(scope, input),
    listArchitectureReviews: (scope, input) =>
      architectService.listArchitectureReviews(scope, input),
    reconcileAfterRestart: () => architectService.reconcileAfterRestart(),
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
    listDelegatedTaskSummaryHistory: snapshots.listDelegatedTaskSummaryHistory,
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
  switchCommitLockCount,
};

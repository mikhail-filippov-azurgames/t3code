import * as Schema from "effect/Schema";

import {
  CheckpointRef,
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import {
  BoardCard,
  BoardCardEvent,
  BoardCardOutcome,
  BoardCardStatus,
  BoardCreatedBy,
  ExecutorRole,
} from "./boardShared.ts";
import { ProviderOptionDescriptor, ProviderOptionSelection } from "./model.ts";
import {
  ModelSelection,
  OrchestrationMessage,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailPage,
  ProviderInteractionMode,
  RuntimeMode,
} from "./orchestration.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const ORCHESTRATOR_MCP_PROTOCOL_VERSION = 7 as const;
export const ORCHESTRATOR_MCP_DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
export const ORCHESTRATOR_MCP_MAX_WAIT_TIMEOUT_MS = 30 * 60 * 1_000;
export const ORCHESTRATOR_MCP_TOOL_NAMES = {
  capabilities: "orchestrator_capabilities",
  delegateTask: "delegate_task",
  sendToTask: "send_to_task",
  taskList: "task_list",
  taskSearch: "task_search",
  taskRead: "task_read",
  taskStatus: "task_status",
  taskWait: "task_wait",
  taskCancel: "task_cancel",
  switchProvider: "switch_provider",
  boardCreateCard: "board_create_card",
  boardUpdateCard: "board_update_card",
  boardDeleteCard: "board_delete_card",
  boardListCards: "board_list_cards",
  architectCreateOrGet: "architect_create_or_get",
  architectReplace: "architect_replace",
  architectDetach: "architect_detach",
  architectureReviewRequest: "architecture_review_request",
  architectureReviewAnswer: "architecture_review_answer",
  architectureReviewCancel: "architecture_review_cancel",
  publishToCoordinator: "publish_to_coordinator",
  getCoordinatorBinding: "get_coordinator_binding",
  listArchitectureReviews: "list_architecture_reviews",
} as const;

const BoundedIdempotencyKey = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const BoundedTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const BoundedPrompt = TrimmedNonEmptyString.check(Schema.isMaxLength(120_000));
const BoundedStage = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const BoundedHandoffItem = TrimmedNonEmptyString.check(Schema.isMaxLength(2_000));
const BoundedEvidenceRef = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096));
const BoundedFingerprint = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const BoundedReason = TrimmedNonEmptyString.check(Schema.isMaxLength(2_000));
const BoundedCapabilityName = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const WaitTimeoutMs = PositiveInt.check(
  Schema.isLessThanOrEqualTo(ORCHESTRATOR_MCP_MAX_WAIT_TIMEOUT_MS),
);

const boundedArray = <Element extends Schema.Top>(element: Element, maximum: number) =>
  Schema.Array(element).check(Schema.isMaxLength(maximum));

export const OrchestratorMcpOclDocumentRef = TrimmedNonEmptyString.check(
  Schema.isMaxLength(45),
  Schema.isPattern(
    /^oc:\/\/doc\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  ),
);
export type OrchestratorMcpOclDocumentRef = typeof OrchestratorMcpOclDocumentRef.Type;

const PolicyDocumentRef = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(
    /^oc:\/\/doc\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@[1-9][0-9]*$/i,
  ),
);

export const OrchestratorMcpTaskRole = ExecutorRole;
export type OrchestratorMcpTaskRole = typeof OrchestratorMcpTaskRole.Type;

export const OrchestratorMcpTaskStatus = Schema.Literals([
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type OrchestratorMcpTaskStatus = typeof OrchestratorMcpTaskStatus.Type;

export const OrchestratorMcpTerminalTaskStatus = Schema.Literals([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type OrchestratorMcpTerminalTaskStatus = typeof OrchestratorMcpTerminalTaskStatus.Type;

export const OrchestratorMcpTargetOptions = boundedArray(ProviderOptionSelection, 64).check(
  Schema.makeFilter((options) => {
    const ids = options.map((option) => option.id);
    return new Set(ids).size === ids.length || "Model option ids must be unique.";
  }),
);
export type OrchestratorMcpTargetOptions = typeof OrchestratorMcpTargetOptions.Type;

export const OrchestratorMcpTarget = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  model: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  options: Schema.optional(OrchestratorMcpTargetOptions),
});
export type OrchestratorMcpTarget = typeof OrchestratorMcpTarget.Type;

export const OrchestratorMcpExecution = Schema.Struct({
  mode: Schema.Literals(["async", "wait"]),
  timeoutMs: Schema.optional(WaitTimeoutMs),
}).check(
  Schema.makeFilter(
    (execution) =>
      execution.mode === "wait" ||
      execution.timeoutMs === undefined ||
      "timeoutMs is valid only when execution.mode is wait.",
  ),
);
export type OrchestratorMcpExecution = typeof OrchestratorMcpExecution.Type;

export const OrchestratorMcpHandoff = Schema.Struct({
  contractRef: OrchestratorMcpOclDocumentRef,
  requiredRevision: PositiveInt,
  implementsRevision: PositiveInt,
  stage: BoundedStage,
  owns: boundedArray(BoundedHandoffItem, 100),
  reads: boundedArray(BoundedHandoffItem, 100),
  forbidden: boundedArray(BoundedHandoffItem, 100),
  acceptance: boundedArray(BoundedHandoffItem, 100),
  outputs: boundedArray(BoundedHandoffItem, 100),
  evidence: boundedArray(BoundedEvidenceRef, 100),
  predecessorRefs: boundedArray(OrchestratorMcpOclDocumentRef, 100),
}).check(
  Schema.makeFilter(
    (handoff) =>
      handoff.requiredRevision === handoff.implementsRevision ||
      "requiredRevision must equal implementsRevision.",
  ),
);
export type OrchestratorMcpHandoff = typeof OrchestratorMcpHandoff.Type;

export const OrchestratorMcpDelegateTaskInput = Schema.Struct({
  idempotencyKey: BoundedIdempotencyKey,
  title: BoundedTitle,
  prompt: BoundedPrompt,
  role: OrchestratorMcpTaskRole,
  target: OrchestratorMcpTarget,
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  execution: Schema.optional(OrchestratorMcpExecution),
  handoff: Schema.optional(OrchestratorMcpHandoff),
});
export type OrchestratorMcpDelegateTaskInput = typeof OrchestratorMcpDelegateTaskInput.Type;

export const OrchestratorMcpSendToTaskInput = Schema.Struct({
  taskId: ThreadId,
  idempotencyKey: BoundedIdempotencyKey,
  message: BoundedPrompt,
});
export type OrchestratorMcpSendToTaskInput = typeof OrchestratorMcpSendToTaskInput.Type;

export const OrchestratorMcpTaskStatusInput = Schema.Struct({ taskId: ThreadId });
export type OrchestratorMcpTaskStatusInput = typeof OrchestratorMcpTaskStatusInput.Type;

export const OrchestratorMcpTaskWaitInput = Schema.Struct({
  taskId: ThreadId,
  timeoutMs: WaitTimeoutMs,
});
export type OrchestratorMcpTaskWaitInput = typeof OrchestratorMcpTaskWaitInput.Type;

export const OrchestratorMcpTaskCancelInput = Schema.Struct({ taskId: ThreadId });
export type OrchestratorMcpTaskCancelInput = typeof OrchestratorMcpTaskCancelInput.Type;

export const ORCHESTRATOR_MCP_TASK_PAGE_MAX = 100 as const;
export const ORCHESTRATOR_MCP_TASK_TURN_MAX = 20 as const;
export const ORCHESTRATOR_MCP_TASK_SOURCE_TURN_IDS_MAX = 32 as const;
export const TaskPageLimit = PositiveInt.check(
  Schema.isLessThanOrEqualTo(ORCHESTRATOR_MCP_TASK_PAGE_MAX),
);
export const TaskTranscriptTurnLimit = PositiveInt.check(
  Schema.isLessThanOrEqualTo(ORCHESTRATOR_MCP_TASK_TURN_MAX),
);
const BoundedTaskSearchQuery = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

export const OrchestratorMcpTaskListInput = Schema.Struct({
  limit: Schema.optional(TaskPageLimit),
  afterTaskId: Schema.optional(ThreadId),
});
export type OrchestratorMcpTaskListInput = typeof OrchestratorMcpTaskListInput.Type;

export const OrchestratorMcpTaskSearchInput = Schema.Struct({
  query: BoundedTaskSearchQuery,
  limit: Schema.optional(TaskPageLimit),
  afterTaskId: Schema.optional(ThreadId),
});
export type OrchestratorMcpTaskSearchInput = typeof OrchestratorMcpTaskSearchInput.Type;

export const OrchestratorMcpTaskReadInput = Schema.Struct({
  taskId: ThreadId,
  turnLimit: Schema.optional(TaskTranscriptTurnLimit),
  beforeCursor: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2_048))),
});
export type OrchestratorMcpTaskReadInput = typeof OrchestratorMcpTaskReadInput.Type;

export const OrchestratorMcpPermissionAutomaticity = Schema.Literals([
  "none",
  "approval-required",
  "automatic",
  "unrestricted",
]);
export type OrchestratorMcpPermissionAutomaticity =
  typeof OrchestratorMcpPermissionAutomaticity.Type;

export const OrchestratorMcpFilesystemAuthority = Schema.Literals([
  "read-only",
  "workspace-write",
  "unrestricted",
]);
export type OrchestratorMcpFilesystemAuthority = typeof OrchestratorMcpFilesystemAuthority.Type;

export const OrchestratorMcpVerifiedPermissionEnvelope = Schema.Struct({
  status: Schema.Literal("verified"),
  fingerprint: BoundedFingerprint,
  filesystem: OrchestratorMcpFilesystemAuthority,
  externalDirectories: OrchestratorMcpPermissionAutomaticity,
  commandExecution: OrchestratorMcpPermissionAutomaticity,
  network: OrchestratorMcpPermissionAutomaticity,
  approvalBypass: Schema.Boolean,
  providerTools: boundedArray(BoundedCapabilityName, 256),
  externalTools: boundedArray(BoundedCapabilityName, 256),
  t3McpCapabilities: boundedArray(BoundedCapabilityName, 64),
});
export type OrchestratorMcpVerifiedPermissionEnvelope =
  typeof OrchestratorMcpVerifiedPermissionEnvelope.Type;

export const OrchestratorMcpUnverifiablePermissionEnvelope = Schema.Struct({
  status: Schema.Literal("unverifiable"),
  reason: BoundedReason,
});
export type OrchestratorMcpUnverifiablePermissionEnvelope =
  typeof OrchestratorMcpUnverifiablePermissionEnvelope.Type;

export const OrchestratorMcpPermissionEnvelopeSummary = Schema.Union([
  OrchestratorMcpVerifiedPermissionEnvelope,
  OrchestratorMcpUnverifiablePermissionEnvelope,
]);
export type OrchestratorMcpPermissionEnvelopeSummary =
  typeof OrchestratorMcpPermissionEnvelopeSummary.Type;

export const OrchestratorMcpProviderCapability = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  displayName: Schema.NullOr(Schema.String),
  models: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      label: Schema.NullOr(Schema.String),
      optionDescriptors: Schema.optional(Schema.Array(ProviderOptionDescriptor)),
    }),
  ),
  permissionEnvelope: OrchestratorMcpPermissionEnvelopeSummary,
  delegatable: Schema.Boolean,
  unavailableReason: Schema.NullOr(BoundedReason),
}).check(
  Schema.makeFilter(
    (capability) =>
      !capability.delegatable ||
      (capability.permissionEnvelope.status === "verified" &&
        capability.unavailableReason === null) ||
      "A delegatable provider must have a verified permission envelope and no unavailable reason.",
  ),
);
export type OrchestratorMcpProviderCapability = typeof OrchestratorMcpProviderCapability.Type;

// `Schema.Struct({})` also accepts arrays in Effect 4 and therefore emits an
// `anyOf` root. MCP requires a root `type: "object"`; an empty record keeps the
// wire contract at exactly `{}` while producing the required object schema.
export const OrchestratorMcpCapabilitiesInput = Schema.Record(Schema.String, Schema.Never);
export type OrchestratorMcpCapabilitiesInput = typeof OrchestratorMcpCapabilitiesInput.Type;

export const OrchestratorMcpCapabilitiesResult = Schema.Struct({
  protocolVersion: Schema.Literal(ORCHESTRATOR_MCP_PROTOCOL_VERSION),
  parent: Schema.Struct({
    environmentId: EnvironmentId,
    threadId: ThreadId,
    turnId: TurnId,
    projectId: ProjectId,
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
    branch: Schema.NullOr(Schema.String),
    worktreePath: TrimmedNonEmptyString,
    permissionEnvelope: OrchestratorMcpPermissionEnvelopeSummary,
  }),
  roles: Schema.Array(OrchestratorMcpTaskRole),
  wait: Schema.Struct({
    defaultTimeoutMs: PositiveInt,
    maxTimeoutMs: PositiveInt,
  }),
  providers: Schema.Array(OrchestratorMcpProviderCapability),
  workspacePolicy: Schema.Literal("inherit-only"),
  oclPolicy: Schema.Literal("optional-stable-ref-plus-durable-handoff"),
});
export type OrchestratorMcpCapabilitiesResult = typeof OrchestratorMcpCapabilitiesResult.Type;

export const OrchestratorMcpRequestedIdentity = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  model: TrimmedNonEmptyString,
  options: Schema.Array(ProviderOptionSelection),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  providerConfigFingerprint: BoundedFingerprint,
});
export type OrchestratorMcpRequestedIdentity = typeof OrchestratorMcpRequestedIdentity.Type;

export const OrchestratorMcpObservedProviderIdentity = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  evidence: Schema.Literal("runtime-session-bound"),
  observedAt: Schema.optional(IsoDateTime),
});
export type OrchestratorMcpObservedProviderIdentity =
  typeof OrchestratorMcpObservedProviderIdentity.Type;

export const OrchestratorMcpObservedModelIdentity = Schema.Struct({
  model: TrimmedNonEmptyString,
  evidence: Schema.Literals(["provider-executed", "provider-rerouted"]),
  observedAt: Schema.optional(IsoDateTime),
});
export type OrchestratorMcpObservedModelIdentity = typeof OrchestratorMcpObservedModelIdentity.Type;

export const OrchestratorMcpObservedIdentity = Schema.Struct({
  provider: Schema.NullOr(OrchestratorMcpObservedProviderIdentity),
  model: Schema.NullOr(OrchestratorMcpObservedModelIdentity),
});
export type OrchestratorMcpObservedIdentity = typeof OrchestratorMcpObservedIdentity.Type;

export const OrchestratorMcpSendToTaskResult = Schema.Struct({
  taskId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  status: Schema.Literal("queued"),
  requested: OrchestratorMcpRequestedIdentity,
  observed: OrchestratorMcpObservedIdentity,
  queuedAt: IsoDateTime,
}).check(
  Schema.makeFilter((result) =>
    result.observed.model === null || result.observed.provider !== null
      ? true
      : "Observed model evidence requires a runtime-bound observed provider.",
  ),
);
export type OrchestratorMcpSendToTaskResult = typeof OrchestratorMcpSendToTaskResult.Type;

export const OrchestratorMcpTaskLineage = Schema.Struct({
  taskId: ThreadId,
  parentEnvironmentId: EnvironmentId,
  parentThreadId: ThreadId,
  parentTurnId: TurnId,
  projectId: ProjectId,
  childThreadId: ThreadId,
  delegatedMessageId: MessageId,
  delegatedTurnId: Schema.NullOr(TurnId),
});
export type OrchestratorMcpTaskLineage = typeof OrchestratorMcpTaskLineage.Type;

export const OrchestratorMcpTaskSummary = Schema.Struct({
  text: Schema.String,
  source: Schema.Literals(["model", "deterministic"]),
  sourceTurnIds: boundedArray(TurnId, ORCHESTRATOR_MCP_TASK_SOURCE_TURN_IDS_MAX),
  watermark: NonNegativeInt,
  stale: Schema.Boolean,
  state: Schema.Literals(["pending", "ready", "error"]),
  error: Schema.NullOr(Schema.String),
});
export type OrchestratorMcpTaskSummary = typeof OrchestratorMcpTaskSummary.Type;

export const OrchestratorMcpTaskMemoryEntry = Schema.Struct({
  taskId: ThreadId,
  childThreadId: ThreadId,
  role: Schema.String,
  title: Schema.String,
  latestStatus: OrchestratorMcpTaskStatus,
  latestTurnId: Schema.NullOr(TurnId),
  updatedAt: IsoDateTime,
  worktreePath: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(OrchestratorMcpTaskSummary),
});
export type OrchestratorMcpTaskMemoryEntry = typeof OrchestratorMcpTaskMemoryEntry.Type;

export const OrchestratorMcpTaskListResult = Schema.Struct({
  tasks: boundedArray(OrchestratorMcpTaskMemoryEntry, 100),
  nextCursor: Schema.NullOr(ThreadId),
});
export type OrchestratorMcpTaskListResult = typeof OrchestratorMcpTaskListResult.Type;

export const OrchestratorMcpTaskSearchResult = Schema.Struct({
  query: BoundedTaskSearchQuery,
  tasks: boundedArray(OrchestratorMcpTaskMemoryEntry, 100),
  nextCursor: Schema.NullOr(ThreadId),
});
export type OrchestratorMcpTaskSearchResult = typeof OrchestratorMcpTaskSearchResult.Type;

export const OrchestratorMcpTaskReadResult = Schema.Struct({
  taskId: ThreadId,
  title: Schema.String,
  messages: boundedArray(OrchestrationMessage, 10_000),
  activities: boundedArray(OrchestrationThreadActivity, 10_000),
  page: OrchestrationThreadDetailPage,
});
export type OrchestratorMcpTaskReadResult = typeof OrchestratorMcpTaskReadResult.Type;

/**
 * Board tools let a marked orchestrator thread manage its own kanban cards.
 * Card, event, and enum shapes are the canonical board definitions, aliased
 * here so the MCP tool schema cannot drift from the board contract.
 */
export const OrchestratorMcpBoardCardStatus = BoardCardStatus;
export type OrchestratorMcpBoardCardStatus = typeof OrchestratorMcpBoardCardStatus.Type;

export const OrchestratorMcpBoardCreatedBy = BoardCreatedBy;
export type OrchestratorMcpBoardCreatedBy = typeof OrchestratorMcpBoardCreatedBy.Type;

export const OrchestratorMcpBoardCardOutcome = BoardCardOutcome;
export type OrchestratorMcpBoardCardOutcome = typeof OrchestratorMcpBoardCardOutcome.Type;

export const OrchestratorMcpBoardCard = BoardCard;
export type OrchestratorMcpBoardCard = typeof OrchestratorMcpBoardCard.Type;

export const OrchestratorMcpBoardCardEvent = BoardCardEvent;
export type OrchestratorMcpBoardCardEvent = typeof OrchestratorMcpBoardCardEvent.Type;

export const OrchestratorMcpBoardCreateCardInput = Schema.Struct({
  title: BoundedTitle,
  body: Schema.String,
  executorRole: OrchestratorMcpTaskRole,
  assignee: Schema.optional(Schema.NullOr(ModelSelection)),
  status: Schema.optional(Schema.Literals(["todo", "orchestrator"])),
});
export type OrchestratorMcpBoardCreateCardInput = typeof OrchestratorMcpBoardCreateCardInput.Type;

export const OrchestratorMcpBoardCreateCardResult = OrchestratorMcpBoardCard;
export type OrchestratorMcpBoardCreateCardResult = typeof OrchestratorMcpBoardCreateCardResult.Type;

export const OrchestratorMcpBoardUpdateCardInput = Schema.Struct({
  cardId: BoundedIdempotencyKey,
  title: Schema.optional(BoundedTitle),
  body: Schema.optional(Schema.String),
  status: Schema.optional(OrchestratorMcpBoardCardStatus),
  executorRole: Schema.optional(OrchestratorMcpTaskRole),
  assignee: Schema.optional(Schema.NullOr(ModelSelection)),
  executorThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  outcome: Schema.optional(Schema.NullOr(OrchestratorMcpBoardCardOutcome)),
  lastError: Schema.optional(Schema.NullOr(Schema.String)),
  failureStreak: Schema.optional(NonNegativeInt),
  order: Schema.optional(NonNegativeInt),
  archived: Schema.optional(Schema.Boolean),
});
export type OrchestratorMcpBoardUpdateCardInput = typeof OrchestratorMcpBoardUpdateCardInput.Type;

export const OrchestratorMcpBoardUpdateCardResult = OrchestratorMcpBoardCard;
export type OrchestratorMcpBoardUpdateCardResult = typeof OrchestratorMcpBoardUpdateCardResult.Type;

export const OrchestratorMcpBoardDeleteCardInput = Schema.Struct({ cardId: BoundedIdempotencyKey });
export type OrchestratorMcpBoardDeleteCardInput = typeof OrchestratorMcpBoardDeleteCardInput.Type;

export const OrchestratorMcpBoardDeleteCardResult = Schema.Struct({});
export type OrchestratorMcpBoardDeleteCardResult = typeof OrchestratorMcpBoardDeleteCardResult.Type;

// Same empty-record trick as capabilities: MCP requires a root object schema.
export const OrchestratorMcpBoardListCardsInput = Schema.Record(Schema.String, Schema.Never);
export type OrchestratorMcpBoardListCardsInput = typeof OrchestratorMcpBoardListCardsInput.Type;

export const OrchestratorMcpBoardCardEntry = Schema.Struct({
  card: OrchestratorMcpBoardCard,
  events: Schema.Array(OrchestratorMcpBoardCardEvent),
});
export type OrchestratorMcpBoardCardEntry = typeof OrchestratorMcpBoardCardEntry.Type;

export const OrchestratorMcpBoardListCardsResult = Schema.Struct({
  cards: Schema.Array(OrchestratorMcpBoardCardEntry),
});
export type OrchestratorMcpBoardListCardsResult = typeof OrchestratorMcpBoardListCardsResult.Type;

export const OrchestratorMcpFailureCode = Schema.Literals([
  "capability_denied",
  "parent_not_active",
  "provider_unavailable",
  "model_unavailable",
  "invalid_model_options",
  "permission_escalation_denied",
  "permission_envelope_unverifiable",
  "provider_configuration_changed",
  "ocl_handoff_invalid",
  "routing_evidence_mismatch",
  "delegated_executor_denied",
  "idempotency_conflict",
  "task_not_found",
  "task_not_cancellable",
  "executor_required",
  "provider_handoff_unsupported",
  "thread_has_no_history",
  "orchestration_error",
  "architect_denied",
  "binding_not_found",
  "binding_conflict",
  "review_not_found",
  "review_state_conflict",
  "feature_disabled",
]);
export type OrchestratorMcpFailureCode = typeof OrchestratorMcpFailureCode.Type;

export const OrchestratorMcpTerminalError = Schema.Struct({
  code: OrchestratorMcpFailureCode,
  message: Schema.String,
});
export type OrchestratorMcpTerminalError = typeof OrchestratorMcpTerminalError.Type;

export const OrchestratorMcpTaskOutput = Schema.Struct({
  text: Schema.String,
  outputStatus: Schema.Literals(["available", "empty", "unavailable"]),
  assistantMessageId: Schema.NullOr(MessageId),
  checkpointRef: Schema.NullOr(CheckpointRef),
  evidenceRefs: boundedArray(BoundedEvidenceRef, 100),
});
export type OrchestratorMcpTaskOutput = typeof OrchestratorMcpTaskOutput.Type;

export const OrchestratorMcpTaskResult = Schema.Struct({
  taskId: ThreadId,
  status: OrchestratorMcpTaskStatus,
  requested: OrchestratorMcpRequestedIdentity,
  observed: OrchestratorMcpObservedIdentity,
  lineage: OrchestratorMcpTaskLineage,
  pendingApproval: Schema.Boolean,
  pendingUserInput: Schema.Boolean,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
  terminalError: Schema.NullOr(OrchestratorMcpTerminalError),
  result: Schema.NullOr(OrchestratorMcpTaskOutput),
  waitTimedOut: Schema.Boolean,
}).check(
  Schema.makeFilter((task) => {
    if (task.taskId !== task.lineage.taskId || task.taskId !== task.lineage.childThreadId) {
      return "taskId, lineage.taskId, and lineage.childThreadId must match.";
    }
    if (task.observed.model !== null && task.observed.provider === null) {
      return "Observed model evidence requires a runtime-bound observed provider.";
    }

    const terminal = new Set<string>(["completed", "failed", "cancelled", "interrupted"]).has(
      task.status,
    );
    if (task.waitTimedOut && terminal) {
      return "A timed-out wait must return a non-terminal task state.";
    }
    if (terminal && task.completedAt === null) {
      return "Terminal task states require completedAt.";
    }
    if (
      !terminal &&
      (task.completedAt !== null || task.terminalError !== null || task.result !== null)
    ) {
      return "Non-terminal task states cannot contain terminal fields.";
    }
    if (task.status === "completed" && (task.result === null || task.terminalError !== null)) {
      return "Completed tasks require a result and cannot contain terminalError.";
    }
    if (task.status === "failed" && task.terminalError === null) {
      return "Failed tasks require terminalError.";
    }
    return true;
  }),
);
export type OrchestratorMcpTaskResult = typeof OrchestratorMcpTaskResult.Type;

export const OrchestratorMcpDelegateTaskResult = OrchestratorMcpTaskResult;
export type OrchestratorMcpDelegateTaskResult = typeof OrchestratorMcpDelegateTaskResult.Type;
export const OrchestratorMcpTaskStatusResult = OrchestratorMcpTaskResult;
export type OrchestratorMcpTaskStatusResult = typeof OrchestratorMcpTaskStatusResult.Type;
export const OrchestratorMcpTaskWaitResult = OrchestratorMcpTaskResult;
export type OrchestratorMcpTaskWaitResult = typeof OrchestratorMcpTaskWaitResult.Type;
export const OrchestratorMcpTaskCancelResult = OrchestratorMcpTaskResult;
export type OrchestratorMcpTaskCancelResult = typeof OrchestratorMcpTaskCancelResult.Type;

export const OrchestratorMcpSwitchProviderInput = Schema.Struct({
  taskId: ThreadId,
  target: OrchestratorMcpTarget,
  reason: BoundedReason,
});
export type OrchestratorMcpSwitchProviderInput = typeof OrchestratorMcpSwitchProviderInput.Type;

export const OrchestratorMcpSwitchedProvider = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  model: TrimmedNonEmptyString,
});
export type OrchestratorMcpSwitchedProvider = typeof OrchestratorMcpSwitchedProvider.Type;

export const OrchestratorMcpSwitchScope = Schema.Struct({
  messageCount: NonNegativeInt,
  pendingCount: NonNegativeInt,
  lineagePreserved: Schema.Literal(true),
});
export type OrchestratorMcpSwitchScope = typeof OrchestratorMcpSwitchScope.Type;

export const OrchestratorMcpSwitchProviderResult = Schema.Struct({
  taskId: ThreadId,
  switchedAt: IsoDateTime,
  oldProvider: OrchestratorMcpSwitchedProvider,
  requested: OrchestratorMcpRequestedIdentity,
  reason: BoundedReason,
  scope: OrchestratorMcpSwitchScope,
  advanced: Schema.Boolean,
  // Null for an ordinary-thread switch: the thread itself is the scope, it
  // carries no delegation lineage, so there is no owned task to report.
  // Delegated switches carry the owned task snapshot here, including when the
  // completed child thread is being repointed for a future turn.
  task: Schema.NullOr(OrchestratorMcpTaskResult),
});
export type OrchestratorMcpSwitchProviderResult = typeof OrchestratorMcpSwitchProviderResult.Type;

// ── Phase 1 Coordinator/Architect split (accepted contract rev 7) ──────────
// The coordinator keeps the execution lineage (`orchestratorThreadId` is
// reinterpreted as the coordinator id; no mass rename in Phase 1). The
// architect is a sibling control-plane role, never a second parentThreadId.

export const ControlPlaneRole = Schema.Literals(["coordinator", "architect"]);
export type ControlPlaneRole = typeof ControlPlaneRole.Type;

export const ArchitectTaskEffort = Schema.Literals(["low", "medium", "high", "very-high"]);
export type ArchitectTaskEffort = typeof ArchitectTaskEffort.Type;

export const CoordinatorArchitectBindingStatus = Schema.Literals([
  "active",
  "detached",
  "replaced",
]);
export type CoordinatorArchitectBindingStatus = typeof CoordinatorArchitectBindingStatus.Type;

const CoordinatorArchitectRoutingCandidate = Schema.Struct({
  alias: TrimmedNonEmptyString,
  providerInstanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  model: TrimmedNonEmptyString,
  options: Schema.Array(ProviderOptionSelection),
  disposition: Schema.Literals(["ineligible", "selected"]),
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
});
export type CoordinatorArchitectRoutingCandidate = typeof CoordinatorArchitectRoutingCandidate.Type;

export const CoordinatorArchitectRoutingEvidence = Schema.Struct({
  policyRef: PolicyDocumentRef,
  policyRevision: PositiveInt,
  role: Schema.Literal("architecture"),
  taskEffort: ArchitectTaskEffort,
  consideredCandidates: boundedArray(CoordinatorArchitectRoutingCandidate, 16).check(
    Schema.makeFilter(
      (candidates) =>
        candidates.length > 0 &&
        candidates[candidates.length - 1]?.disposition === "selected" &&
        candidates.slice(0, -1).every((candidate) => candidate.disposition === "ineligible"),
    ),
  ),
}).check(
  Schema.makeFilter(
    (evidence) =>
      evidence.policyRef.slice(evidence.policyRef.lastIndexOf("@") + 1) ===
      String(evidence.policyRevision),
  ),
);
export type CoordinatorArchitectRoutingEvidence = typeof CoordinatorArchitectRoutingEvidence.Type;

export const ArchitectureReviewReason = Schema.Literals([
  "contract-conflict",
  "scope-expansion",
  "hard-bug",
  "milestone-review",
  "direct-advice",
]);
export type ArchitectureReviewReason = typeof ArchitectureReviewReason.Type;

export const ArchitectureReviewExecutionPosture = Schema.Literals([
  "continue",
  "pause-branch",
  "pause-all",
]);
export type ArchitectureReviewExecutionPosture = typeof ArchitectureReviewExecutionPosture.Type;

export const ArchitectureReviewAnswerDisposition = Schema.Literals([
  "recommendation",
  "needs-human-decision",
  "needs-more-evidence",
]);
export type ArchitectureReviewAnswerDisposition = typeof ArchitectureReviewAnswerDisposition.Type;

// Minimal machine: open → answered → published (terminal);
// open → cancelled and answered → cancelled (terminal). No "closed" state.
export const ArchitectureReviewStatus = Schema.Literals([
  "open",
  "answered",
  "published",
  "cancelled",
]);
export type ArchitectureReviewStatus = typeof ArchitectureReviewStatus.Type;

const BoundedReviewQuestion = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096));
const BoundedAnswerSummary = Schema.String.check(Schema.isMaxLength(2_000));
const BoundedDetachReason = TrimmedNonEmptyString.check(Schema.isMaxLength(2_000));

export const ArchitectureReviewRequestRefs = Schema.Struct({
  messageIds: Schema.optional(boundedArray(MessageId, 64)),
  checkpoint: Schema.optional(Schema.NullOr(CheckpointRef)),
  oclRefs: Schema.optional(boundedArray(OrchestratorMcpOclDocumentRef, 32)),
});
export type ArchitectureReviewRequestRefs = typeof ArchitectureReviewRequestRefs.Type;

export const ArchitectureReviewRefs = Schema.Struct({
  messageIds: Schema.optional(boundedArray(MessageId, 64)),
  checkpoint: Schema.optional(Schema.NullOr(CheckpointRef)),
  oclRefs: Schema.optional(boundedArray(OrchestratorMcpOclDocumentRef, 32)),
  architectOclRefs: Schema.optional(boundedArray(OrchestratorMcpOclDocumentRef, 32)),
});
export type ArchitectureReviewRefs = typeof ArchitectureReviewRefs.Type;

export const CoordinatorArchitectBinding = Schema.Struct({
  bindingId: TrimmedNonEmptyString,
  coordinatorThreadId: ThreadId,
  architectThreadId: ThreadId,
  projectId: ProjectId,
  architectTaskEffort: ArchitectTaskEffort,
  routingEvidence: Schema.NullOr(CoordinatorArchitectRoutingEvidence),
  status: CoordinatorArchitectBindingStatus,
  createdAt: IsoDateTime,
  createdBy: ThreadId,
  replacedByBindingId: Schema.NullOr(TrimmedNonEmptyString),
  detachReason: Schema.NullOr(Schema.String),
  createIdempotencyKey: BoundedIdempotencyKey,
});
export type CoordinatorArchitectBinding = typeof CoordinatorArchitectBinding.Type;

export const ArchitectureReviewDeliveryFailure = Schema.Struct({
  // Stable failure token: the `[reason=...]` token for parent_not_active
  // refusals (for example `parent_scope_drift`), otherwise the failure code.
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  message: Schema.String.check(Schema.isMaxLength(2_000)),
  attemptedAt: IsoDateTime,
});
export type ArchitectureReviewDeliveryFailure = typeof ArchitectureReviewDeliveryFailure.Type;

export const ArchitectureReviewRecord = Schema.Struct({
  reviewId: TrimmedNonEmptyString,
  bindingId: TrimmedNonEmptyString,
  coordinatorThreadId: ThreadId,
  architectThreadId: ThreadId,
  subjectChildThreadId: Schema.NullOr(ThreadId),
  reason: ArchitectureReviewReason,
  question: BoundedReviewQuestion,
  refs: ArchitectureReviewRefs,
  executionPosture: ArchitectureReviewExecutionPosture,
  answerDisposition: Schema.NullOr(ArchitectureReviewAnswerDisposition),
  status: ArchitectureReviewStatus,
  answerSummary: Schema.NullOr(BoundedAnswerSummary),
  requestIdempotencyKey: BoundedIdempotencyKey,
  answerIdempotencyKey: Schema.NullOr(BoundedIdempotencyKey),
  answerPayloadFingerprint: Schema.NullOr(BoundedFingerprint),
  publishIdempotencyKey: Schema.NullOr(BoundedIdempotencyKey),
  cancelIdempotencyKey: Schema.NullOr(BoundedIdempotencyKey),
  cancelledAt: Schema.NullOr(IsoDateTime),
  cancelledBy: Schema.NullOr(Schema.Union([ThreadId, Schema.Literal("human")])),
  createdAt: IsoDateTime,
  answeredAt: Schema.NullOr(IsoDateTime),
  publishedAt: Schema.NullOr(IsoDateTime),
  // Additive observability: `answeredAt` proves an answer was recorded,
  // `publishDeliveredAt` proves the coordinator wake actually fired. A
  // recorded answer without delivery (failed or refused publish) is
  // distinguishable from no answer; see `lastPublishFailure`.
  publishDeliveredAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  lastPublishFailure: Schema.optional(Schema.NullOr(ArchitectureReviewDeliveryFailure)),
});
export type ArchitectureReviewRecord = typeof ArchitectureReviewRecord.Type;

export const OrchestratorMcpArchitectCreateOrGetInput = Schema.Struct({
  coordinatorThreadId: ThreadId,
  taskEffort: ArchitectTaskEffort,
  modelSelection: ModelSelection,
  routingEvidence: CoordinatorArchitectRoutingEvidence,
  idempotencyKey: BoundedIdempotencyKey,
});
export type OrchestratorMcpArchitectCreateOrGetInput =
  typeof OrchestratorMcpArchitectCreateOrGetInput.Type;

export const OrchestratorMcpArchitectCreateOrGetResult = Schema.Struct({
  architectThreadId: ThreadId,
  created: Schema.Boolean,
  binding: CoordinatorArchitectBinding,
});
export type OrchestratorMcpArchitectCreateOrGetResult =
  typeof OrchestratorMcpArchitectCreateOrGetResult.Type;

export const OrchestratorMcpArchitectReplaceInput = Schema.Struct({
  coordinatorThreadId: ThreadId,
  taskEffort: ArchitectTaskEffort,
  modelSelection: ModelSelection,
  routingEvidence: CoordinatorArchitectRoutingEvidence,
  reason: BoundedDetachReason,
  idempotencyKey: BoundedIdempotencyKey,
});
export type OrchestratorMcpArchitectReplaceInput = typeof OrchestratorMcpArchitectReplaceInput.Type;

export const OrchestratorMcpArchitectReplaceResult = Schema.Struct({
  architectThreadId: ThreadId,
  binding: CoordinatorArchitectBinding,
});
export type OrchestratorMcpArchitectReplaceResult =
  typeof OrchestratorMcpArchitectReplaceResult.Type;

export const OrchestratorMcpArchitectDetachInput = Schema.Struct({
  coordinatorThreadId: ThreadId,
  reason: BoundedDetachReason,
  idempotencyKey: BoundedIdempotencyKey,
});
export type OrchestratorMcpArchitectDetachInput = typeof OrchestratorMcpArchitectDetachInput.Type;

export const OrchestratorMcpArchitectDetachResult = Schema.Struct({
  binding: CoordinatorArchitectBinding,
});
export type OrchestratorMcpArchitectDetachResult = typeof OrchestratorMcpArchitectDetachResult.Type;

export const OrchestratorMcpReviewRequestInput = Schema.Struct({
  coordinatorThreadId: ThreadId,
  subjectChildThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  reason: ArchitectureReviewReason,
  question: BoundedReviewQuestion,
  refs: Schema.optional(ArchitectureReviewRequestRefs),
  executionPosture: ArchitectureReviewExecutionPosture,
  idempotencyKey: BoundedIdempotencyKey,
});
export type OrchestratorMcpReviewRequestInput = typeof OrchestratorMcpReviewRequestInput.Type;

export const OrchestratorMcpReviewRequestResult = Schema.Struct({
  reviewId: TrimmedNonEmptyString,
  status: Schema.Literal("open"),
});
export type OrchestratorMcpReviewRequestResult = typeof OrchestratorMcpReviewRequestResult.Type;

export const OrchestratorMcpReviewAnswerInput = Schema.Struct({
  reviewId: TrimmedNonEmptyString,
  disposition: ArchitectureReviewAnswerDisposition,
  summary: BoundedAnswerSummary,
  oclRefs: Schema.optional(boundedArray(OrchestratorMcpOclDocumentRef, 32)),
  idempotencyKey: BoundedIdempotencyKey,
});
export type OrchestratorMcpReviewAnswerInput = typeof OrchestratorMcpReviewAnswerInput.Type;

export const OrchestratorMcpReviewAnswerResult = Schema.Struct({
  reviewId: TrimmedNonEmptyString,
  status: Schema.Literal("answered"),
  disposition: ArchitectureReviewAnswerDisposition,
});
export type OrchestratorMcpReviewAnswerResult = typeof OrchestratorMcpReviewAnswerResult.Type;

export const OrchestratorMcpReviewCancelInput = Schema.Struct({
  reviewId: TrimmedNonEmptyString,
  reason: BoundedDetachReason,
  idempotencyKey: BoundedIdempotencyKey,
});
export type OrchestratorMcpReviewCancelInput = typeof OrchestratorMcpReviewCancelInput.Type;

export const OrchestratorMcpReviewCancelResult = Schema.Struct({
  reviewId: TrimmedNonEmptyString,
  status: Schema.Literal("cancelled"),
});
export type OrchestratorMcpReviewCancelResult = typeof OrchestratorMcpReviewCancelResult.Type;

export const OrchestratorMcpPublishToCoordinatorInput = Schema.Struct({
  reviewId: TrimmedNonEmptyString,
  idempotencyKey: BoundedIdempotencyKey,
});
export type OrchestratorMcpPublishToCoordinatorInput =
  typeof OrchestratorMcpPublishToCoordinatorInput.Type;

export const OrchestratorMcpPublishToCoordinatorResult = Schema.Struct({
  reviewId: TrimmedNonEmptyString,
  status: Schema.Literal("published"),
});
export type OrchestratorMcpPublishToCoordinatorResult =
  typeof OrchestratorMcpPublishToCoordinatorResult.Type;

export const OrchestratorMcpGetCoordinatorBindingInput = Schema.Struct({
  coordinatorThreadId: ThreadId,
});
export type OrchestratorMcpGetCoordinatorBindingInput =
  typeof OrchestratorMcpGetCoordinatorBindingInput.Type;

export const OrchestratorMcpGetCoordinatorBindingResult = Schema.Struct({
  binding: Schema.NullOr(CoordinatorArchitectBinding),
});
export type OrchestratorMcpGetCoordinatorBindingResult =
  typeof OrchestratorMcpGetCoordinatorBindingResult.Type;

export const OrchestratorMcpListArchitectureReviewsInput = Schema.Struct({
  coordinatorThreadId: ThreadId,
  status: Schema.optional(ArchitectureReviewStatus),
});
export type OrchestratorMcpListArchitectureReviewsInput =
  typeof OrchestratorMcpListArchitectureReviewsInput.Type;

export const OrchestratorMcpListArchitectureReviewsResult = Schema.Struct({
  reviews: boundedArray(ArchitectureReviewRecord, 100),
});
export type OrchestratorMcpListArchitectureReviewsResult =
  typeof OrchestratorMcpListArchitectureReviewsResult.Type;

/** Read model for the human sidebar pin. It is a unary snapshot; thread
 * activity updates continue to arrive through the existing subscribeThread. */
export const OrchestratorMcpCoordinatorArchitectSidebarSnapshot = Schema.Struct({
  binding: Schema.NullOr(CoordinatorArchitectBinding),
  reviews: boundedArray(ArchitectureReviewRecord, 100),
});
export type OrchestratorMcpCoordinatorArchitectSidebarSnapshot =
  typeof OrchestratorMcpCoordinatorArchitectSidebarSnapshot.Type;

export class OrchestratorMcpFailure extends Schema.TaggedError<OrchestratorMcpFailure>()(
  "OrchestratorMcpFailure",
  {
    code: OrchestratorMcpFailureCode,
    message: Schema.String,
  },
) {}

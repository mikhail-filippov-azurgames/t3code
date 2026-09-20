import * as Schema from "effect/Schema";

import {
  CheckpointRef,
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
import { ProviderOptionDescriptor, ProviderOptionSelection } from "./model.ts";
import { ProviderInteractionMode, RuntimeMode } from "./orchestration.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const ORCHESTRATOR_MCP_PROTOCOL_VERSION = 3 as const;
export const ORCHESTRATOR_MCP_DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
export const ORCHESTRATOR_MCP_MAX_WAIT_TIMEOUT_MS = 30 * 60 * 1_000;
export const ORCHESTRATOR_MCP_TOOL_NAMES = {
  capabilities: "orchestrator_capabilities",
  delegateTask: "delegate_task",
  taskStatus: "task_status",
  taskWait: "task_wait",
  taskCancel: "task_cancel",
  switchProvider: "switch_provider",
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

export const OrchestratorMcpTaskRole = Schema.Literals([
  "architecture",
  "implementation",
  "review",
  "test",
  "research",
  "general",
]);
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

export const OrchestratorMcpTaskStatusInput = Schema.Struct({ taskId: ThreadId });
export type OrchestratorMcpTaskStatusInput = typeof OrchestratorMcpTaskStatusInput.Type;

export const OrchestratorMcpTaskWaitInput = Schema.Struct({
  taskId: ThreadId,
  timeoutMs: WaitTimeoutMs,
});
export type OrchestratorMcpTaskWaitInput = typeof OrchestratorMcpTaskWaitInput.Type;

export const OrchestratorMcpTaskCancelInput = Schema.Struct({ taskId: ThreadId });
export type OrchestratorMcpTaskCancelInput = typeof OrchestratorMcpTaskCancelInput.Type;

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
  "idempotency_conflict",
  "task_not_found",
  "task_not_cancellable",
  "provider_handoff_unsupported",
  "thread_has_no_history",
  "orchestration_error",
]);
export type OrchestratorMcpFailureCode = typeof OrchestratorMcpFailureCode.Type;

export const OrchestratorMcpTerminalError = Schema.Struct({
  code: OrchestratorMcpFailureCode,
  message: Schema.String,
});
export type OrchestratorMcpTerminalError = typeof OrchestratorMcpTerminalError.Type;

export const OrchestratorMcpTaskOutput = Schema.Struct({
  text: Schema.String,
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

export class OrchestratorMcpFailure extends Schema.TaggedError<OrchestratorMcpFailure>()(
  "OrchestratorMcpFailure",
  {
    code: OrchestratorMcpFailureCode,
    message: Schema.String,
  },
) {}

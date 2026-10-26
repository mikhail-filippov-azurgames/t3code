import {
  CheckpointRef,
  IsoDateTime,
  MessageId,
  ModelSelection,
  OrchestratorMcpFailure,
  PositiveInt,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderOptionSelection,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const ArchitectTaskEffort = Schema.Literals(["low", "medium", "high", "very-high"]);
export type ArchitectTaskEffort = typeof ArchitectTaskEffort.Type;
export const CoordinatorArchitectBindingStatus = Schema.Literals([
  "active",
  "detached",
  "replaced",
]);
export type CoordinatorArchitectBindingStatus = typeof CoordinatorArchitectBindingStatus.Type;
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
export const ArchitectureReviewStatus = Schema.Literals([
  "open",
  "answered",
  "published",
  "cancelled",
]);
export type ArchitectureReviewStatus = typeof ArchitectureReviewStatus.Type;
export const ArchitectureReviewOrigin = Schema.Literals([
  "coordinator-request",
  "architect-advice",
]);
export type ArchitectureReviewOrigin = typeof ArchitectureReviewOrigin.Type;
export const ArchitectureReviewPublishedBy = Schema.Literals(["architect", "coordinator", "human"]);
export type ArchitectureReviewPublishedBy = typeof ArchitectureReviewPublishedBy.Type;

const BoundedIdempotencyKey = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const BoundedFingerprint = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const BoundedReviewQuestion = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096));
const BoundedAnswerSummary = Schema.String.check(Schema.isMaxLength(2_000));
const DocumentRef = TrimmedNonEmptyString.check(Schema.isMaxLength(45));
const PolicyDocumentRef = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
const boundedArray = <Element extends Schema.Top>(element: Element, maximum: number) =>
  Schema.Array(element).check(Schema.isMaxLength(maximum));

const RoutingCandidate = Schema.Struct({
  alias: TrimmedNonEmptyString,
  providerInstanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  model: TrimmedNonEmptyString,
  options: Schema.Array(ProviderOptionSelection),
  disposition: Schema.Literals(["ineligible", "selected"]),
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
});
export const CoordinatorArchitectRoutingEvidence = Schema.Struct({
  policyRef: PolicyDocumentRef,
  policyRevision: PositiveInt,
  role: Schema.Literal("architecture"),
  taskEffort: ArchitectTaskEffort,
  consideredCandidates: boundedArray(RoutingCandidate, 16),
});
export type CoordinatorArchitectRoutingEvidence = typeof CoordinatorArchitectRoutingEvidence.Type;

export const ArchitectureReviewRefs = Schema.Struct({
  messageIds: Schema.optional(boundedArray(MessageId, 64)),
  checkpoint: Schema.optional(Schema.NullOr(CheckpointRef)),
  oclRefs: Schema.optional(boundedArray(DocumentRef, 32)),
  architectOclRefs: Schema.optional(boundedArray(DocumentRef, 32)),
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
  requestWakeDeliveredAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  origin: ArchitectureReviewOrigin,
  publishedBy: Schema.NullOr(ArchitectureReviewPublishedBy),
  publishDeliveredAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  lastPublishFailure: Schema.optional(Schema.NullOr(ArchitectureReviewDeliveryFailure)),
});
export type ArchitectureReviewRecord = typeof ArchitectureReviewRecord.Type;

export const ArchitectGetCoordinatorBindingInput = Schema.Struct({
  coordinatorThreadId: ThreadId,
});
export type ArchitectGetCoordinatorBindingInput = typeof ArchitectGetCoordinatorBindingInput.Type;
export const ArchitectGetCoordinatorBindingResult = Schema.Struct({
  binding: Schema.NullOr(CoordinatorArchitectBinding),
});
export type ArchitectGetCoordinatorBindingResult = typeof ArchitectGetCoordinatorBindingResult.Type;

export const ArchitectListArchitectureReviewsInput = Schema.Struct({
  coordinatorThreadId: ThreadId,
  status: Schema.optional(ArchitectureReviewStatus),
});
export type ArchitectListArchitectureReviewsInput =
  typeof ArchitectListArchitectureReviewsInput.Type;
export const ArchitectListArchitectureReviewsResult = Schema.Struct({
  reviews: boundedArray(ArchitectureReviewRecord, 100),
});
export type ArchitectListArchitectureReviewsResult =
  typeof ArchitectListArchitectureReviewsResult.Type;

export const ArchitectCreateOrGetInput = Schema.Struct({
  coordinatorThreadId: ThreadId,
  taskEffort: ArchitectTaskEffort,
  modelSelection: ModelSelection,
  routingEvidence: CoordinatorArchitectRoutingEvidence,
  idempotencyKey: BoundedIdempotencyKey,
});
export type ArchitectCreateOrGetInput = typeof ArchitectCreateOrGetInput.Type;

export const ArchitectCreateOrGetResult = Schema.Struct({
  architectThreadId: ThreadId,
  created: Schema.Boolean,
  binding: CoordinatorArchitectBinding,
});
export type ArchitectCreateOrGetResult = typeof ArchitectCreateOrGetResult.Type;

const BoundedDetachReason = TrimmedNonEmptyString.check(Schema.isMaxLength(2_000));

export const ArchitectReplaceInput = Schema.Struct({
  coordinatorThreadId: ThreadId,
  taskEffort: ArchitectTaskEffort,
  modelSelection: ModelSelection,
  routingEvidence: CoordinatorArchitectRoutingEvidence,
  reason: BoundedDetachReason,
  idempotencyKey: BoundedIdempotencyKey,
});
export type ArchitectReplaceInput = typeof ArchitectReplaceInput.Type;

export const ArchitectReplaceResult = Schema.Struct({
  architectThreadId: ThreadId,
  binding: CoordinatorArchitectBinding,
});
export type ArchitectReplaceResult = typeof ArchitectReplaceResult.Type;

export const ArchitectDetachInput = Schema.Struct({
  coordinatorThreadId: ThreadId,
  reason: BoundedDetachReason,
  idempotencyKey: BoundedIdempotencyKey,
});
export type ArchitectDetachInput = typeof ArchitectDetachInput.Type;

export const ArchitectDetachResult = Schema.Struct({
  binding: CoordinatorArchitectBinding,
});
export type ArchitectDetachResult = typeof ArchitectDetachResult.Type;

export const ArchitectReviewRequestInput = Schema.Struct({
  coordinatorThreadId: ThreadId,
  subjectChildThreadId: Schema.optional(ThreadId),
  reason: ArchitectureReviewReason,
  question: BoundedReviewQuestion,
  refs: Schema.optional(ArchitectureReviewRefs),
  executionPosture: ArchitectureReviewExecutionPosture,
  idempotencyKey: BoundedIdempotencyKey,
});
export type ArchitectReviewRequestInput = typeof ArchitectReviewRequestInput.Type;

export const ArchitectReviewRequestResult = Schema.Struct({
  reviewId: TrimmedNonEmptyString,
  status: Schema.Literal("open"),
});
export type ArchitectReviewRequestResult = typeof ArchitectReviewRequestResult.Type;

export const ArchitectReviewAnswerInput = Schema.Struct({
  reviewId: TrimmedNonEmptyString,
  disposition: ArchitectureReviewAnswerDisposition,
  summary: BoundedAnswerSummary,
  oclRefs: Schema.optional(boundedArray(DocumentRef, 32)),
  idempotencyKey: BoundedIdempotencyKey,
});
export type ArchitectReviewAnswerInput = typeof ArchitectReviewAnswerInput.Type;

export const ArchitectReviewAnswerResult = Schema.Struct({
  reviewId: TrimmedNonEmptyString,
  status: Schema.Literal("answered"),
  disposition: ArchitectureReviewAnswerDisposition,
});
export type ArchitectReviewAnswerResult = typeof ArchitectReviewAnswerResult.Type;

export const ArchitectReviewCancelInput = Schema.Struct({
  reviewId: TrimmedNonEmptyString,
  reason: BoundedDetachReason,
  idempotencyKey: BoundedIdempotencyKey,
});
export type ArchitectReviewCancelInput = typeof ArchitectReviewCancelInput.Type;

export const ArchitectReviewCancelResult = Schema.Struct({
  reviewId: TrimmedNonEmptyString,
  status: Schema.Literal("cancelled"),
});
export type ArchitectReviewCancelResult = typeof ArchitectReviewCancelResult.Type;

export const ArchitectPrepareCoordinatorPublicationInput = Schema.Struct({
  summary: BoundedAnswerSummary,
  disposition: ArchitectureReviewAnswerDisposition,
  oclRefs: Schema.optional(boundedArray(DocumentRef, 32)),
  executionPosture: ArchitectureReviewExecutionPosture,
  idempotencyKey: BoundedIdempotencyKey,
});
export type ArchitectPrepareCoordinatorPublicationInput =
  typeof ArchitectPrepareCoordinatorPublicationInput.Type;

export const ArchitectPrepareCoordinatorPublicationResult = Schema.Struct({
  reviewId: TrimmedNonEmptyString,
  status: Schema.Literal("answered"),
});
export type ArchitectPrepareCoordinatorPublicationResult =
  typeof ArchitectPrepareCoordinatorPublicationResult.Type;

export const ArchitectPublishToCoordinatorInput = Schema.Struct({
  reviewId: TrimmedNonEmptyString,
  idempotencyKey: BoundedIdempotencyKey,
});
export type ArchitectPublishToCoordinatorInput = typeof ArchitectPublishToCoordinatorInput.Type;

export const ArchitectPublishToCoordinatorResult = Schema.Struct({
  reviewId: TrimmedNonEmptyString,
  status: Schema.Literal("published"),
});
export type ArchitectPublishToCoordinatorResult = typeof ArchitectPublishToCoordinatorResult.Type;

export const ArchitectHumanPublicationInput = ArchitectPublishToCoordinatorInput;
export type ArchitectHumanPublicationInput = typeof ArchitectHumanPublicationInput.Type;
export const ArchitectHumanPublicationResult = ArchitectPublishToCoordinatorResult;
export type ArchitectHumanPublicationResult = typeof ArchitectHumanPublicationResult.Type;

export const ArchitectPublishableRecord = Schema.Struct({
  reviewId: TrimmedNonEmptyString,
  origin: ArchitectureReviewOrigin,
  summary: BoundedAnswerSummary,
  disposition: ArchitectureReviewAnswerDisposition,
  refs: ArchitectureReviewRefs,
  question: Schema.optional(BoundedReviewQuestion),
});
export type ArchitectPublishableRecord = typeof ArchitectPublishableRecord.Type;

export const ArchitectCoordinatorArchitectSidebarSnapshot = Schema.Struct({
  binding: Schema.NullOr(CoordinatorArchitectBinding),
  reviews: boundedArray(ArchitectureReviewRecord, 100),
  publishable: boundedArray(ArchitectPublishableRecord, 100).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type ArchitectCoordinatorArchitectSidebarSnapshot =
  typeof ArchitectCoordinatorArchitectSidebarSnapshot.Type;

export const ArchitectGetCoordinatorSidebarInput = Schema.Struct({
  coordinatorThreadId: ThreadId,
});
export type ArchitectGetCoordinatorSidebarInput = typeof ArchitectGetCoordinatorSidebarInput.Type;

export const ArchitectGetSidebarByArchitectInput = Schema.Struct({
  architectThreadId: ThreadId,
});
export type ArchitectGetSidebarByArchitectInput = typeof ArchitectGetSidebarByArchitectInput.Type;

export interface ArchitectInsertReviewInput {
  readonly reviewId: string;
  readonly bindingId: string;
  readonly coordinatorThreadId: ThreadId;
  readonly architectThreadId: ThreadId;
  readonly subjectChildThreadId: ThreadId | null;
  readonly reason: ArchitectureReviewReason;
  readonly question: string;
  readonly refs: ArchitectureReviewRefs;
  readonly executionPosture: ArchitectureReviewExecutionPosture;
  readonly requestIdempotencyKey: string;
  readonly requestPayloadFingerprint: string;
  readonly createdAt: string;
}

export interface ArchitectAnswerReviewInput {
  readonly reviewId: string;
  readonly disposition: ArchitectureReviewAnswerDisposition;
  readonly summary: string;
  readonly refs: ArchitectureReviewRefs;
  readonly answerIdempotencyKey: string;
  readonly answerPayloadFingerprint: string;
  readonly answeredAt: string;
}

export interface ArchitectCancelReviewInput {
  readonly reviewId: string;
  readonly reason: string;
  readonly cancelIdempotencyKey: string;
  readonly cancelPayloadFingerprint: string;
  readonly cancelledAt: string;
  readonly cancelledBy: ThreadId;
}

export interface ArchitectPreparedPublicationUpsertInput {
  readonly reviewId: string;
  readonly bindingId: string;
  readonly coordinatorThreadId: ThreadId;
  readonly architectThreadId: ThreadId;
  readonly summary: string;
  readonly disposition: ArchitectureReviewAnswerDisposition;
  readonly oclRefs: ReadonlyArray<string>;
  readonly executionPosture: ArchitectureReviewExecutionPosture;
  readonly idempotencyKey: string;
  readonly payloadFingerprint: string;
  readonly preparedAt: string;
}

export interface ArchitectReviewPublishInput {
  readonly reviewId: string;
  readonly publishIdempotencyKey: string;
  readonly publishedAt: string;
  readonly publishedBy: ArchitectureReviewPublishedBy;
}

export interface ArchitectReviewPublishDeliveredInput {
  readonly reviewId: string;
  readonly deliveredAt: string;
}

export interface ArchitectReviewPublishFailureInput {
  readonly reviewId: string;
  readonly reason: string;
  readonly message: string;
  readonly attemptedAt: string;
}

export type ArchitectReviewTransition =
  | { readonly _tag: "applied" }
  | { readonly _tag: "replay" }
  | { readonly _tag: "conflict" }
  | { readonly _tag: "state" };

export interface ArchitectCreateBindingInput {
  readonly bindingId: string;
  readonly coordinatorThreadId: ThreadId;
  readonly architectThreadId: ThreadId;
  readonly projectId: ProjectId;
  readonly architectTaskEffort: ArchitectTaskEffort;
  readonly routingEvidence: CoordinatorArchitectRoutingEvidence;
  readonly createdAt: string;
  readonly createdBy: ThreadId;
  readonly createIdempotencyKey: string;
  readonly createRequestFingerprint: string;
}

export interface ArchitectCloseBindingInput {
  readonly bindingId: string;
  readonly status: "detached" | "replaced";
  readonly replacedByBindingId: string | null;
  readonly detachReason: string | null;
  readonly idempotencyKey: string;
  readonly closeRequestFingerprint: string;
}

export interface ArchitectLinkReplacementWinnerInput {
  readonly replacedBindingId: string;
  readonly closeIdempotencyKey: string;
  readonly closeRequestFingerprint: string;
  readonly winnerBindingId: string;
}

export const ArchitectReconcileOutcomeKind = Schema.Literals([
  "thread-delete-replayed",
  "review-wake-delivered",
  "publish-wake-delivered",
]);
export type ArchitectReconcileOutcomeKind = typeof ArchitectReconcileOutcomeKind.Type;

export const ArchitectReconcileOutcome = Schema.Struct({
  kind: ArchitectReconcileOutcomeKind,
  bindingId: TrimmedNonEmptyString,
  reviewId: Schema.optional(TrimmedNonEmptyString),
});
export type ArchitectReconcileOutcome = typeof ArchitectReconcileOutcome.Type;

export interface ArchitectBindingReplayLookup {
  readonly coordinatorThreadId: ThreadId;
  readonly closeIdempotencyKey: string;
  readonly closeRequestFingerprint: string;
}

export class ArchitectMcpFailure extends Schema.TaggedError<ArchitectMcpFailure>()(
  "OrchestratorMcpFailure",
  {
    code: Schema.Union([
      OrchestratorMcpFailure.fields.code,
      Schema.Literals([
        "architect_denied",
        "delegated_executor_denied",
        "routing_evidence_mismatch",
        "idempotency_conflict",
        "binding_not_found",
        "binding_conflict",
        "review_not_found",
        "review_state_conflict",
        "author_text_rejected",
        "human_publish_required",
      ]),
    ]),
    message: Schema.String,
  },
) {}

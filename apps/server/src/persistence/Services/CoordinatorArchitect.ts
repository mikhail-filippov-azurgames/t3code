import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  ArchitectureReviewAnswerDisposition,
  ArchitectureReviewRecord,
  ArchitectureReviewRequestRefs,
  ArchitectureReviewRefs,
  ArchitectureReviewStatus,
  CoordinatorArchitectBinding,
  CoordinatorArchitectRoutingEvidence,
  OrchestratorMcpOclDocumentRef,
} from "@t3tools/contracts";

export class CoordinatorArchitectRepositoryError extends Schema.TaggedError<CoordinatorArchitectRepositoryError>()(
  "CoordinatorArchitectRepositoryError",
  { operation: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/** Same idempotency key, different request fingerprint: exact-retry conflict. */
export class CoordinatorArchitectIdempotencyConflict extends Schema.TaggedError<CoordinatorArchitectIdempotencyConflict>()(
  "CoordinatorArchitectIdempotencyConflict",
  { operation: Schema.String, existingId: Schema.String },
) {}

export interface BindingCreateInput {
  readonly bindingId: string;
  readonly coordinatorThreadId: string;
  readonly architectThreadId: string;
  readonly projectId: string;
  readonly architectTaskEffort: CoordinatorArchitectBinding["architectTaskEffort"];
  readonly routingEvidence: CoordinatorArchitectRoutingEvidence;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly createIdempotencyKey: string;
  readonly createRequestFingerprint: string;
}

export interface BindingCloseInput {
  readonly bindingId: string;
  readonly status: "detached" | "replaced";
  readonly replacedByBindingId: string | null;
  readonly detachReason: string | null;
  readonly idempotencyKey: string;
  readonly closeRequestFingerprint: string;
}

export interface BindingReplacementWinnerInput {
  readonly replacedBindingId: string;
  readonly closeIdempotencyKey: string;
  readonly closeRequestFingerprint: string;
  readonly winnerBindingId: string;
}

export interface BindingReplayLookup {
  readonly coordinatorThreadId: string;
  readonly closeIdempotencyKey: string;
  readonly closeRequestFingerprint: string;
}

export interface ReviewInsertInput {
  readonly reviewId: string;
  readonly bindingId: string;
  readonly coordinatorThreadId: string;
  readonly architectThreadId: string;
  readonly subjectChildThreadId: string | null;
  readonly reason: ArchitectureReviewRecord["reason"];
  readonly question: string;
  readonly refs: ArchitectureReviewRequestRefs;
  readonly executionPosture: ArchitectureReviewRecord["executionPosture"];
  readonly requestIdempotencyKey: string;
  readonly requestPayloadFingerprint: string;
  readonly createdAt: string;
}

export interface ReviewAnswerInput {
  readonly reviewId: string;
  readonly disposition: ArchitectureReviewAnswerDisposition;
  readonly summary: string;
  readonly oclRefs: ReadonlyArray<OrchestratorMcpOclDocumentRef>;
  readonly answerIdempotencyKey: string;
  readonly answerPayloadFingerprint: string;
  readonly answeredAt: string;
}

export interface ReviewPublishInput {
  readonly reviewId: string;
  readonly publishIdempotencyKey: string;
  readonly publishedAt: string;
}

export interface ReviewPublishDeliveredInput {
  readonly reviewId: string;
  readonly deliveredAt: string;
}

export interface ReviewPublishFailureInput {
  readonly reviewId: string;
  readonly reason: string;
  readonly message: string;
  readonly attemptedAt: string;
}

export interface ReviewCancelInput {
  readonly reviewId: string;
  readonly cancelIdempotencyKey: string;
  readonly cancelPayloadFingerprint: string;
  readonly cancelledAt: string;
  readonly cancelledBy: string;
}

export type ReviewTransitionResult =
  | { readonly _tag: "applied" }
  | { readonly _tag: "replay" }
  | { readonly _tag: "conflict" }
  | { readonly _tag: "state" };

export interface CoordinatorArchitectRepositoryShape {
  /**
   * Binding-first create with deterministic winner election. Repeat create
   * (any key) while an active binding exists returns it with created:false.
   * Same key + same fingerprint replays; same key + different fingerprint is
   * an idempotency conflict. Concurrent same-target creates converge to one
   * binding; losers return the winner with created:false.
   */
  readonly createOrGetBinding: (
    input: BindingCreateInput,
  ) => Effect.Effect<
    { readonly binding: CoordinatorArchitectBinding; readonly created: boolean },
    CoordinatorArchitectRepositoryError | CoordinatorArchitectIdempotencyConflict
  >;
  readonly getActiveBindingByCoordinator: (
    coordinatorThreadId: string,
  ) => Effect.Effect<CoordinatorArchitectBinding | null, CoordinatorArchitectRepositoryError>;
  readonly getActiveBindingByArchitect: (
    architectThreadId: string,
  ) => Effect.Effect<CoordinatorArchitectBinding | null, CoordinatorArchitectRepositoryError>;
  readonly getBindingById: (
    bindingId: string,
  ) => Effect.Effect<CoordinatorArchitectBinding | null, CoordinatorArchitectRepositoryError>;
  /** Latest binding row for an architect thread id, active or terminal (reconcile/audit). */
  readonly getAnyBindingByArchitect: (
    architectThreadId: string,
  ) => Effect.Effect<CoordinatorArchitectBinding | null, CoordinatorArchitectRepositoryError>;
  /** All active bindings, for startup reconciliation. */
  readonly listActiveBindings: () => Effect.Effect<
    ReadonlyArray<CoordinatorArchitectBinding>,
    CoordinatorArchitectRepositoryError
  >;
  /** Exact-retry lookup for replace replay: binding created under one key. */
  readonly findBindingByCreateKey: (input: {
    readonly coordinatorThreadId: string;
    readonly createIdempotencyKey: string;
  }) => Effect.Effect<CoordinatorArchitectBinding | null, CoordinatorArchitectRepositoryError>;
  /** Exact-retry lookup for detach replay: terminal binding closed under one key. */
  readonly findDetachReplay: (
    input: BindingReplayLookup,
  ) => Effect.Effect<
    CoordinatorArchitectBinding | null,
    CoordinatorArchitectRepositoryError | CoordinatorArchitectIdempotencyConflict
  >;
  /** Exact-retry lookup for a replace whose old binding closed before its new row committed. */
  readonly findReplaceReplay: (
    input: BindingReplayLookup,
  ) => Effect.Effect<
    CoordinatorArchitectBinding | null,
    CoordinatorArchitectRepositoryError | CoordinatorArchitectIdempotencyConflict
  >;
  /** Ordered boundary step (1): durable active→terminal transition commits first. */
  readonly closeBinding: (
    input: BindingCloseInput,
  ) => Effect.Effect<
    CoordinatorArchitectBinding | null,
    CoordinatorArchitectRepositoryError | CoordinatorArchitectIdempotencyConflict
  >;
  /** Link a terminal replacement to a binding row that has already committed. */
  readonly linkReplacementWinner: (
    input: BindingReplacementWinnerInput,
  ) => Effect.Effect<
    CoordinatorArchitectBinding | null,
    CoordinatorArchitectRepositoryError | CoordinatorArchitectIdempotencyConflict
  >;
  readonly listBindingsByCoordinator: (
    coordinatorThreadId: string,
  ) => Effect.Effect<
    ReadonlyArray<CoordinatorArchitectBinding>,
    CoordinatorArchitectRepositoryError
  >;
  readonly insertReview: (
    input: ReviewInsertInput,
  ) => Effect.Effect<
    { readonly review: ArchitectureReviewRecord; readonly created: boolean },
    CoordinatorArchitectRepositoryError | CoordinatorArchitectIdempotencyConflict
  >;
  readonly getReviewById: (
    reviewId: string,
  ) => Effect.Effect<ArchitectureReviewRecord | null, CoordinatorArchitectRepositoryError>;
  readonly getReviewByRequestKey: (input: {
    readonly coordinatorThreadId: string;
    readonly requestIdempotencyKey: string;
  }) => Effect.Effect<ArchitectureReviewRecord | null, CoordinatorArchitectRepositoryError>;
  readonly listReviewsByCoordinator: (input: {
    readonly coordinatorThreadId: string;
    readonly status?: ArchitectureReviewStatus;
  }) => Effect.Effect<ReadonlyArray<ArchitectureReviewRecord>, CoordinatorArchitectRepositoryError>;
  /** First-wins answer: same key + same fingerprint replays, different payload conflicts. */
  readonly answerReview: (
    input: ReviewAnswerInput,
  ) => Effect.Effect<ReviewTransitionResult, CoordinatorArchitectRepositoryError>;
  readonly publishReview: (
    input: ReviewPublishInput,
  ) => Effect.Effect<ReviewTransitionResult, CoordinatorArchitectRepositoryError>;
  /** Additive observability: proves the coordinator wake fired. Never changes status. */
  readonly markPublishDelivered: (
    input: ReviewPublishDeliveredInput,
  ) => Effect.Effect<void, CoordinatorArchitectRepositoryError>;
  /** Additive observability: records a refused/failed publish with its stable reason. Never changes status. */
  readonly recordPublishFailure: (
    input: ReviewPublishFailureInput,
  ) => Effect.Effect<void, CoordinatorArchitectRepositoryError>;
  readonly cancelReview: (
    input: ReviewCancelInput,
  ) => Effect.Effect<ReviewTransitionResult, CoordinatorArchitectRepositoryError>;
}

export class CoordinatorArchitectRepository extends Context.Service<
  CoordinatorArchitectRepository,
  CoordinatorArchitectRepositoryShape
>()("t3/persistence/Services/CoordinatorArchitect/CoordinatorArchitectRepository") {}

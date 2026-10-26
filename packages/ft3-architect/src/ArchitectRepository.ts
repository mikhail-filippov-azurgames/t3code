import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Contracts from "./contracts.ts";

export class ArchitectRepositoryError extends Schema.TaggedError<ArchitectRepositoryError>()(
  "ArchitectRepositoryError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `The architect repository could not ${this.operation}.`;
  }
}

export class ArchitectRepository extends Context.Service<
  ArchitectRepository,
  {
    readonly getActiveBindingByCoordinator: (
      coordinatorThreadId: ThreadId,
    ) => Effect.Effect<Contracts.CoordinatorArchitectBinding | null, ArchitectRepositoryError>;
    readonly getActiveBindingByArchitect: (
      architectThreadId: ThreadId,
    ) => Effect.Effect<Contracts.CoordinatorArchitectBinding | null, ArchitectRepositoryError>;
    readonly listReviewsByCoordinator: (input: {
      readonly coordinatorThreadId: ThreadId;
      readonly status?: Contracts.ArchitectureReviewStatus;
    }) => Effect.Effect<
      ReadonlyArray<Contracts.ArchitectureReviewRecord>,
      ArchitectRepositoryError
    >;
    readonly getReviewById: (
      reviewId: string,
    ) => Effect.Effect<Contracts.ArchitectureReviewRecord | null, ArchitectRepositoryError>;
    readonly insertReview: (
      input: Contracts.ArchitectInsertReviewInput,
    ) => Effect.Effect<
      { readonly review: Contracts.ArchitectureReviewRecord; readonly created: boolean },
      ArchitectRepositoryError | Contracts.ArchitectMcpFailure
    >;
    readonly answerReview: (
      input: Contracts.ArchitectAnswerReviewInput,
    ) => Effect.Effect<Contracts.ArchitectReviewTransition, ArchitectRepositoryError>;
    readonly cancelReview: (
      input: Contracts.ArchitectCancelReviewInput,
    ) => Effect.Effect<Contracts.ArchitectReviewTransition, ArchitectRepositoryError>;
    readonly markReviewWakeDelivered: (input: {
      readonly reviewId: string;
      readonly deliveredAt: string;
    }) => Effect.Effect<void, ArchitectRepositoryError>;
    readonly getBindingById: (
      bindingId: string,
    ) => Effect.Effect<Contracts.CoordinatorArchitectBinding | null, ArchitectRepositoryError>;
    readonly upsertPreparedPublication: (
      input: Contracts.ArchitectPreparedPublicationUpsertInput,
    ) => Effect.Effect<
      Contracts.ArchitectureReviewRecord,
      ArchitectRepositoryError | Contracts.ArchitectMcpFailure
    >;
    readonly publishReview: (
      input: Contracts.ArchitectReviewPublishInput,
    ) => Effect.Effect<Contracts.ArchitectReviewTransition, ArchitectRepositoryError>;
    readonly markPublishDelivered: (
      input: Contracts.ArchitectReviewPublishDeliveredInput,
    ) => Effect.Effect<void, ArchitectRepositoryError>;
    readonly recordPublishFailure: (
      input: Contracts.ArchitectReviewPublishFailureInput,
    ) => Effect.Effect<void, ArchitectRepositoryError>;
    readonly createOrGetBinding: (
      input: Contracts.ArchitectCreateBindingInput,
    ) => Effect.Effect<
      { readonly binding: Contracts.CoordinatorArchitectBinding; readonly created: boolean },
      ArchitectRepositoryError | Contracts.ArchitectMcpFailure
    >;
    readonly findBindingByCreateKey: (input: {
      readonly coordinatorThreadId: ThreadId;
      readonly createIdempotencyKey: string;
    }) => Effect.Effect<Contracts.CoordinatorArchitectBinding | null, ArchitectRepositoryError>;
    readonly findDetachReplay: (
      input: Contracts.ArchitectBindingReplayLookup,
    ) => Effect.Effect<
      Contracts.CoordinatorArchitectBinding | null,
      ArchitectRepositoryError | Contracts.ArchitectMcpFailure
    >;
    readonly findReplaceReplay: (
      input: Contracts.ArchitectBindingReplayLookup,
    ) => Effect.Effect<
      Contracts.CoordinatorArchitectBinding | null,
      ArchitectRepositoryError | Contracts.ArchitectMcpFailure
    >;
    readonly closeBinding: (
      input: Contracts.ArchitectCloseBindingInput,
    ) => Effect.Effect<
      Contracts.CoordinatorArchitectBinding | null,
      ArchitectRepositoryError | Contracts.ArchitectMcpFailure
    >;
    readonly linkReplacementWinner: (
      input: Contracts.ArchitectLinkReplacementWinnerInput,
    ) => Effect.Effect<
      Contracts.CoordinatorArchitectBinding | null,
      ArchitectRepositoryError | Contracts.ArchitectMcpFailure
    >;
  }
>()("@t3tools/ft3-architect/ArchitectRepository") {}

const BindingRow = Schema.Struct({
  bindingId: Schema.String,
  coordinatorThreadId: ThreadId,
  architectThreadId: ThreadId,
  projectId: ProjectId,
  architectTaskEffort: Contracts.ArchitectTaskEffort,
  status: Contracts.CoordinatorArchitectBindingStatus,
  createdAt: Schema.String,
  createdBy: ThreadId,
  replacedByBindingId: Schema.NullOr(Schema.String),
  detachReason: Schema.NullOr(Schema.String),
  createIdempotencyKey: Schema.String,
  closeIdempotencyKey: Schema.NullOr(Schema.String),
  closeRequestFingerprint: Schema.NullOr(Schema.String),
  routingEvidenceJson: Schema.NullOr(Schema.String),
});

const ReviewRow = Schema.Struct({
  reviewId: Schema.String,
  bindingId: Schema.String,
  coordinatorThreadId: ThreadId,
  architectThreadId: ThreadId,
  subjectChildThreadId: Schema.NullOr(ThreadId),
  reason: Contracts.ArchitectureReviewReason,
  question: Schema.String,
  refsJson: Schema.String,
  executionPosture: Contracts.ArchitectureReviewExecutionPosture,
  answerDisposition: Schema.NullOr(Contracts.ArchitectureReviewAnswerDisposition),
  status: Contracts.ArchitectureReviewStatus,
  answerSummary: Schema.NullOr(Schema.String),
  requestIdempotencyKey: Schema.String,
  answerIdempotencyKey: Schema.NullOr(Schema.String),
  answerPayloadFingerprint: Schema.NullOr(Schema.String),
  publishIdempotencyKey: Schema.NullOr(Schema.String),
  cancelIdempotencyKey: Schema.NullOr(Schema.String),
  cancelledAt: Schema.NullOr(Schema.String),
  cancelledBy: Schema.NullOr(Schema.Union([ThreadId, Schema.Literal("human")])),
  createdAt: Schema.String,
  answeredAt: Schema.NullOr(Schema.String),
  publishedAt: Schema.NullOr(Schema.String),
  requestWakeDeliveredAt: Schema.NullOr(Schema.String),
  origin: Contracts.ArchitectureReviewOrigin,
  publishedBy: Schema.NullOr(Contracts.ArchitectureReviewPublishedBy),
  publishDeliveredAt: Schema.NullOr(Schema.String),
  lastPublishFailureReason: Schema.NullOr(Schema.String),
  lastPublishFailureMessage: Schema.NullOr(Schema.String),
  lastPublishFailureAt: Schema.NullOr(Schema.String),
});

const decodeBindings = Schema.decodeUnknownEffect(Schema.Array(BindingRow));
const decodeReviews = Schema.decodeUnknownEffect(Schema.Array(ReviewRow));
const decodeRoutingEvidence = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Contracts.CoordinatorArchitectRoutingEvidence),
);
const encodeRoutingEvidence = Schema.encodeSync(
  Schema.fromJsonString(Contracts.CoordinatorArchitectRoutingEvidence),
);
const decodeRefs = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Contracts.ArchitectureReviewRefs),
);
const encodeRefs = Schema.encodeSync(Schema.fromJsonString(Contracts.ArchitectureReviewRefs));

const databaseError = (operation: string) => (cause: unknown) =>
  new ArchitectRepositoryError({ operation, cause });

const preserveError = (operation: string) => (error: unknown) => {
  const tagged = error as { readonly _tag?: string } | null;
  return tagged !== null &&
    (tagged._tag === "OrchestratorMcpFailure" || tagged._tag === "ArchitectRepositoryError")
    ? (error as ArchitectRepositoryError | Contracts.ArchitectMcpFailure)
    : databaseError(operation)(error);
};

const bindingColumns = (sql: SqlClient.SqlClient) => sql`
  binding_id AS "bindingId", coordinator_thread_id AS "coordinatorThreadId",
  architect_thread_id AS "architectThreadId", project_id AS "projectId",
  architect_task_effort AS "architectTaskEffort", status, created_at AS "createdAt",
  created_by AS "createdBy", replaced_by_binding_id AS "replacedByBindingId",
  detach_reason AS "detachReason", create_idempotency_key AS "createIdempotencyKey",
  close_idempotency_key AS "closeIdempotencyKey",
  close_request_fingerprint AS "closeRequestFingerprint",
  routing_evidence_json AS "routingEvidenceJson"
`;

const reviewColumns = (sql: SqlClient.SqlClient) => sql`
  review_id AS "reviewId", binding_id AS "bindingId",
  coordinator_thread_id AS "coordinatorThreadId", architect_thread_id AS "architectThreadId",
  subject_child_thread_id AS "subjectChildThreadId", reason, question, refs_json AS "refsJson",
  execution_posture AS "executionPosture", answer_disposition AS "answerDisposition", status,
  answer_summary AS "answerSummary", request_idempotency_key AS "requestIdempotencyKey",
  answer_idempotency_key AS "answerIdempotencyKey",
  answer_payload_fingerprint AS "answerPayloadFingerprint",
  publish_idempotency_key AS "publishIdempotencyKey",
  cancel_idempotency_key AS "cancelIdempotencyKey",
  cancelled_at AS "cancelledAt", cancelled_by AS "cancelledBy", created_at AS "createdAt",
  answered_at AS "answeredAt", published_at AS "publishedAt",
  request_wake_delivered_at AS "requestWakeDeliveredAt", origin,
  published_by AS "publishedBy", publish_delivered_at AS "publishDeliveredAt",
  last_publish_failure_reason AS "lastPublishFailureReason",
  last_publish_failure_message AS "lastPublishFailureMessage",
  last_publish_failure_at AS "lastPublishFailureAt"
`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const bindingSelect = bindingColumns(sql);
  const reviewSelect = reviewColumns(sql);

  const bindingsFromRows = Effect.fn("Ft3ArchitectRepository.bindingsFromRows")(function* (
    rows: unknown,
  ) {
    const decoded = yield* decodeBindings(rows);
    return yield* Effect.forEach(decoded, (row) =>
      Effect.gen(function* () {
        const routingEvidence =
          row.routingEvidenceJson === null
            ? null
            : yield* decodeRoutingEvidence(row.routingEvidenceJson);
        return {
          bindingId: row.bindingId,
          coordinatorThreadId: row.coordinatorThreadId,
          architectThreadId: row.architectThreadId,
          projectId: row.projectId,
          architectTaskEffort: row.architectTaskEffort,
          routingEvidence,
          status: row.status,
          createdAt: row.createdAt,
          createdBy: row.createdBy,
          replacedByBindingId: row.replacedByBindingId,
          detachReason: row.detachReason,
          createIdempotencyKey: row.createIdempotencyKey,
          closeIdempotencyKey: row.closeIdempotencyKey,
          closeRequestFingerprint: row.closeRequestFingerprint,
        };
      }),
    );
  });

  const reviewsFromRows = Effect.fn("Ft3ArchitectRepository.reviewsFromRows")(function* (
    rows: unknown,
  ) {
    const decoded = yield* decodeReviews(rows);
    return yield* Effect.forEach(decoded, (row) =>
      Effect.gen(function* () {
        const refs = yield* decodeRefs(row.refsJson);
        return {
          reviewId: row.reviewId,
          bindingId: row.bindingId,
          coordinatorThreadId: row.coordinatorThreadId,
          architectThreadId: row.architectThreadId,
          subjectChildThreadId: row.subjectChildThreadId,
          reason: row.reason,
          question: row.question,
          refs,
          executionPosture: row.executionPosture,
          answerDisposition: row.answerDisposition,
          status: row.status,
          answerSummary: row.answerSummary,
          requestIdempotencyKey: row.requestIdempotencyKey,
          answerIdempotencyKey: row.answerIdempotencyKey,
          answerPayloadFingerprint: row.answerPayloadFingerprint,
          publishIdempotencyKey: row.publishIdempotencyKey,
          cancelIdempotencyKey: row.cancelIdempotencyKey,
          cancelledAt: row.cancelledAt,
          cancelledBy: row.cancelledBy,
          createdAt: row.createdAt,
          answeredAt: row.answeredAt,
          publishedAt: row.publishedAt,
          requestWakeDeliveredAt: row.requestWakeDeliveredAt,
          origin: row.origin,
          publishedBy: row.publishedBy,
          publishDeliveredAt: row.publishDeliveredAt,
          lastPublishFailure:
            row.lastPublishFailureReason === null || row.lastPublishFailureAt === null
              ? null
              : {
                  reason: row.lastPublishFailureReason,
                  message: row.lastPublishFailureMessage ?? "",
                  attemptedAt: row.lastPublishFailureAt,
                },
        };
      }),
    );
  });

  return ArchitectRepository.of({
    getActiveBindingByCoordinator: Effect.fn(
      "Ft3ArchitectRepository.getActiveBindingByCoordinator",
    )(
      function* (coordinatorThreadId) {
        const rows =
          yield* sql`SELECT ${bindingSelect} FROM ft3_architect_binding WHERE coordinator_thread_id = ${coordinatorThreadId} AND status = 'active'`;
        const bindings = yield* bindingsFromRows(rows);
        return bindings[0] ?? null;
      },
      Effect.mapError(databaseError("read active binding by coordinator")),
    ),
    getActiveBindingByArchitect: Effect.fn("Ft3ArchitectRepository.getActiveBindingByArchitect")(
      function* (architectThreadId) {
        const rows =
          yield* sql`SELECT ${bindingSelect} FROM ft3_architect_binding WHERE architect_thread_id = ${architectThreadId} AND status = 'active'`;
        const bindings = yield* bindingsFromRows(rows);
        return bindings[0] ?? null;
      },
      Effect.mapError(databaseError("read active binding by architect")),
    ),
    listReviewsByCoordinator: Effect.fn("Ft3ArchitectRepository.listReviewsByCoordinator")(
      function* (input) {
        const rows =
          input.status === undefined
            ? yield* sql`SELECT ${reviewSelect} FROM ft3_architect_review WHERE coordinator_thread_id = ${input.coordinatorThreadId} ORDER BY created_at ASC, review_id ASC`
            : yield* sql`SELECT ${reviewSelect} FROM ft3_architect_review WHERE coordinator_thread_id = ${input.coordinatorThreadId} AND status = ${input.status} ORDER BY created_at ASC, review_id ASC`;
        return yield* reviewsFromRows(rows);
      },
      Effect.mapError(databaseError("list architecture reviews")),
    ),
    getReviewById: Effect.fn("Ft3ArchitectRepository.getReviewById")(
      function* (reviewId) {
        const rows =
          yield* sql`SELECT ${reviewSelect} FROM ft3_architect_review WHERE review_id = ${reviewId}`;
        const reviews = yield* reviewsFromRows(rows);
        return reviews[0] ?? null;
      },
      Effect.mapError(databaseError("read architecture review")),
    ),
    insertReview: Effect.fn("Ft3ArchitectRepository.insertReview")(function* (input) {
      const byKey = sql`SELECT ${reviewSelect} FROM ft3_architect_review WHERE coordinator_thread_id = ${input.coordinatorThreadId} AND request_idempotency_key = ${input.requestIdempotencyKey}`;
      const fingerprint = sql<{ readonly fingerprint: string | null }>`
        SELECT request_payload_fingerprint AS fingerprint
        FROM ft3_architect_review
        WHERE coordinator_thread_id = ${input.coordinatorThreadId}
          AND request_idempotency_key = ${input.requestIdempotencyKey}`;
      const byId = sql`SELECT ${reviewSelect} FROM ft3_architect_review WHERE review_id = ${input.reviewId}`;
      const conflict = () =>
        new Contracts.ArchitectMcpFailure({
          code: "idempotency_conflict",
          message: "This review request key was already used with a different request payload.",
        });
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const priorFingerprint = yield* fingerprint;
            if (priorFingerprint[0] !== undefined) {
              if (
                priorFingerprint[0].fingerprint !== null &&
                priorFingerprint[0].fingerprint !== input.requestPayloadFingerprint
              ) {
                return yield* conflict();
              }
              const prior = yield* reviewsFromRows(yield* byKey);
              return { review: prior[0]!, created: false };
            }
            yield* sql`INSERT INTO ft3_architect_review (review_id, binding_id, coordinator_thread_id, architect_thread_id, subject_child_thread_id, reason, question, refs_json, execution_posture, status, request_idempotency_key, request_payload_fingerprint, created_at, origin) VALUES (${input.reviewId}, ${input.bindingId}, ${input.coordinatorThreadId}, ${input.architectThreadId}, ${input.subjectChildThreadId}, ${input.reason}, ${input.question}, ${encodeRefs(input.refs)}, ${input.executionPosture}, 'open', ${input.requestIdempotencyKey}, ${input.requestPayloadFingerprint}, ${input.createdAt}, 'coordinator-request') ON CONFLICT (coordinator_thread_id, request_idempotency_key) DO NOTHING`;
            const inserted = yield* reviewsFromRows(yield* byId);
            if (inserted[0] === undefined) {
              const winner = yield* reviewsFromRows(yield* byKey);
              if (winner[0] === undefined) {
                return yield* new ArchitectRepositoryError({
                  operation: "insert review",
                  cause: new Error("ft3_architect_review winner missing after insert"),
                });
              }
              return { review: winner[0]!, created: false };
            }
            return { review: inserted[0]!, created: true };
          }),
        )
        .pipe(Effect.mapError(preserveError("insert architecture review")));
    }),
    answerReview: Effect.fn("Ft3ArchitectRepository.answerReview")(function* (input) {
      const byId = sql`SELECT ${reviewSelect} FROM ft3_architect_review WHERE review_id = ${input.reviewId}`;
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const found = yield* reviewsFromRows(yield* byId);
            if (found[0] === undefined)
              return { _tag: "state" } as Contracts.ArchitectReviewTransition;
            const review = found[0]!;
            if (review.status === "answered") {
              if (review.answerIdempotencyKey !== input.answerIdempotencyKey) {
                return { _tag: "conflict" } as Contracts.ArchitectReviewTransition;
              }
              return (
                review.answerPayloadFingerprint === input.answerPayloadFingerprint
                  ? { _tag: "replay" }
                  : { _tag: "conflict" }
              ) as Contracts.ArchitectReviewTransition;
            }
            if (review.status !== "open")
              return { _tag: "state" } as Contracts.ArchitectReviewTransition;
            yield* sql`UPDATE ft3_architect_review SET status = 'answered', answer_disposition = ${input.disposition}, answer_summary = ${input.summary}, refs_json = ${encodeRefs(input.refs)}, answer_idempotency_key = ${input.answerIdempotencyKey}, answer_payload_fingerprint = ${input.answerPayloadFingerprint}, answered_at = ${input.answeredAt} WHERE review_id = ${input.reviewId} AND status = 'open'`;
            return { _tag: "applied" } as Contracts.ArchitectReviewTransition;
          }),
        )
        .pipe(Effect.mapError(databaseError("answer architecture review")));
    }),
    cancelReview: Effect.fn("Ft3ArchitectRepository.cancelReview")(function* (input) {
      const byId = sql`SELECT ${reviewSelect} FROM ft3_architect_review WHERE review_id = ${input.reviewId}`;
      const fingerprint = sql<{ readonly key: string | null; readonly fingerprint: string | null }>`
        SELECT cancel_idempotency_key AS key, cancel_payload_fingerprint AS fingerprint
        FROM ft3_architect_review WHERE review_id = ${input.reviewId}`;
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const found = yield* reviewsFromRows(yield* byId);
            if (found[0] === undefined)
              return { _tag: "state" } as Contracts.ArchitectReviewTransition;
            const review = found[0]!;
            if (review.status === "cancelled") {
              const row = yield* fingerprint;
              if (row[0]?.key !== input.cancelIdempotencyKey) {
                return { _tag: "state" } as Contracts.ArchitectReviewTransition;
              }
              return (
                row[0]?.fingerprint === input.cancelPayloadFingerprint
                  ? { _tag: "replay" }
                  : { _tag: "conflict" }
              ) as Contracts.ArchitectReviewTransition;
            }
            if (review.status !== "open" && review.status !== "answered") {
              return { _tag: "state" } as Contracts.ArchitectReviewTransition;
            }
            yield* sql`UPDATE ft3_architect_review SET status = 'cancelled', cancel_idempotency_key = ${input.cancelIdempotencyKey}, cancel_payload_fingerprint = ${input.cancelPayloadFingerprint}, cancelled_at = ${input.cancelledAt}, cancelled_by = ${input.cancelledBy} WHERE review_id = ${input.reviewId} AND status IN ('open', 'answered')`;
            return { _tag: "applied" } as Contracts.ArchitectReviewTransition;
          }),
        )
        .pipe(Effect.mapError(databaseError("cancel architecture review")));
    }),
    markReviewWakeDelivered: Effect.fn("Ft3ArchitectRepository.markReviewWakeDelivered")(
      function* (input) {
        yield* sql`UPDATE ft3_architect_review SET request_wake_delivered_at = ${input.deliveredAt} WHERE review_id = ${input.reviewId}`;
      },
      Effect.mapError(databaseError("mark review wake delivered")),
    ),
    getBindingById: Effect.fn("Ft3ArchitectRepository.getBindingById")(
      function* (bindingId) {
        const rows =
          yield* sql`SELECT ${bindingSelect} FROM ft3_architect_binding WHERE binding_id = ${bindingId}`;
        const bindings = yield* bindingsFromRows(rows);
        return bindings[0] ?? null;
      },
      Effect.mapError(databaseError("read binding by id")),
    ),
    upsertPreparedPublication: Effect.fn("Ft3ArchitectRepository.upsertPreparedPublication")(
      function* (input) {
        const fingerprintByKey = sql<{ readonly fingerprint: string | null }>`
        SELECT request_payload_fingerprint AS fingerprint
        FROM ft3_architect_review
        WHERE coordinator_thread_id = ${input.coordinatorThreadId}
          AND request_idempotency_key = ${input.idempotencyKey}`;
        const byKey = sql`SELECT ${reviewSelect} FROM ft3_architect_review WHERE coordinator_thread_id = ${input.coordinatorThreadId} AND request_idempotency_key = ${input.idempotencyKey}`;
        const byBinding = sql`SELECT ${reviewSelect} FROM ft3_architect_review WHERE binding_id = ${input.bindingId} AND origin = 'architect-advice' AND status = 'answered'`;
        const byId = (reviewId: string) =>
          sql`SELECT ${reviewSelect} FROM ft3_architect_review WHERE review_id = ${reviewId}`;
        const refsJson = encodeRefs({ architectOclRefs: [...input.oclRefs] });
        const conflict = () =>
          new Contracts.ArchitectMcpFailure({
            code: "idempotency_conflict",
            message: "This prepare key was already used with a different publication.",
          });
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const priorFingerprint = yield* fingerprintByKey;
              if (priorFingerprint[0] !== undefined) {
                if (
                  priorFingerprint[0].fingerprint !== null &&
                  priorFingerprint[0].fingerprint !== input.payloadFingerprint
                ) {
                  return yield* conflict();
                }
                const prior = yield* reviewsFromRows(yield* byKey);
                return prior[0]!;
              }
              const existing = yield* reviewsFromRows(yield* byBinding);
              if (existing[0] !== undefined) {
                const existingId = existing[0]!.reviewId;
                yield* sql`UPDATE ft3_architect_review SET coordinator_thread_id = ${input.coordinatorThreadId}, architect_thread_id = ${input.architectThreadId}, subject_child_thread_id = NULL, reason = 'direct-advice', question = ${input.summary}, refs_json = ${refsJson}, execution_posture = ${input.executionPosture}, answer_disposition = ${input.disposition}, status = 'answered', answer_summary = ${input.summary}, request_idempotency_key = ${input.idempotencyKey}, request_payload_fingerprint = ${input.payloadFingerprint}, answer_idempotency_key = ${input.idempotencyKey}, answer_payload_fingerprint = ${input.payloadFingerprint}, publish_idempotency_key = NULL, cancel_idempotency_key = NULL, cancel_payload_fingerprint = NULL, cancelled_at = NULL, cancelled_by = NULL, created_at = ${input.preparedAt}, answered_at = ${input.preparedAt}, published_at = NULL, origin = 'architect-advice', published_by = NULL, publish_delivered_at = NULL, last_publish_failure_reason = NULL, last_publish_failure_message = NULL, last_publish_failure_at = NULL WHERE review_id = ${existingId} AND origin = 'architect-advice' AND status = 'answered'`;
                const stored = yield* reviewsFromRows(yield* byId(existingId));
                if (stored[0] === undefined) {
                  return yield* new ArchitectRepositoryError({
                    operation: "upsert prepared publication",
                    cause: new Error("ft3_architect_review advice missing after update"),
                  });
                }
                return stored[0]!;
              }
              yield* sql`INSERT INTO ft3_architect_review (review_id, binding_id, coordinator_thread_id, architect_thread_id, subject_child_thread_id, reason, question, refs_json, execution_posture, answer_disposition, status, answer_summary, request_idempotency_key, request_payload_fingerprint, answer_idempotency_key, answer_payload_fingerprint, publish_idempotency_key, cancel_idempotency_key, cancel_payload_fingerprint, cancelled_at, cancelled_by, created_at, answered_at, published_at, publish_delivered_at, last_publish_failure_reason, last_publish_failure_message, last_publish_failure_at, origin, published_by) VALUES (${input.reviewId}, ${input.bindingId}, ${input.coordinatorThreadId}, ${input.architectThreadId}, NULL, 'direct-advice', ${input.summary}, ${refsJson}, ${input.executionPosture}, ${input.disposition}, 'answered', ${input.summary}, ${input.idempotencyKey}, ${input.payloadFingerprint}, ${input.idempotencyKey}, ${input.payloadFingerprint}, NULL, NULL, NULL, NULL, NULL, ${input.preparedAt}, ${input.preparedAt}, NULL, NULL, NULL, NULL, NULL, 'architect-advice', NULL)`;
              const stored = yield* reviewsFromRows(yield* byId(input.reviewId));
              if (stored[0] === undefined) {
                const winner = yield* reviewsFromRows(yield* byKey);
                if (winner[0] === undefined) {
                  return yield* new ArchitectRepositoryError({
                    operation: "upsert prepared publication",
                    cause: new Error("ft3_architect_review advice missing after insert"),
                  });
                }
                return winner[0]!;
              }
              return stored[0]!;
            }),
          )
          .pipe(Effect.mapError(preserveError("upsert prepared publication")));
      },
    ),
    publishReview: Effect.fn("Ft3ArchitectRepository.publishReview")(function* (input) {
      const byId = sql`SELECT ${reviewSelect} FROM ft3_architect_review WHERE review_id = ${input.reviewId}`;
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const found = yield* reviewsFromRows(yield* byId);
            if (found[0] === undefined)
              return { _tag: "state" } as Contracts.ArchitectReviewTransition;
            const review = found[0]!;
            if (review.status === "published") {
              return (
                review.publishIdempotencyKey === input.publishIdempotencyKey
                  ? { _tag: "replay" }
                  : { _tag: "conflict" }
              ) as Contracts.ArchitectReviewTransition;
            }
            if (review.status !== "answered")
              return { _tag: "state" } as Contracts.ArchitectReviewTransition;
            yield* sql`UPDATE ft3_architect_review SET status = 'published', publish_idempotency_key = ${input.publishIdempotencyKey}, published_at = ${input.publishedAt}, published_by = ${input.publishedBy} WHERE review_id = ${input.reviewId} AND status = 'answered'`;
            return { _tag: "applied" } as Contracts.ArchitectReviewTransition;
          }),
        )
        .pipe(Effect.mapError(databaseError("publish architecture review")));
    }),
    markPublishDelivered: Effect.fn("Ft3ArchitectRepository.markPublishDelivered")(
      function* (input) {
        yield* sql`UPDATE ft3_architect_review SET publish_delivered_at = ${input.deliveredAt}, last_publish_failure_reason = NULL, last_publish_failure_message = NULL, last_publish_failure_at = NULL WHERE review_id = ${input.reviewId}`;
      },
      Effect.mapError(databaseError("mark publish delivered")),
    ),
    recordPublishFailure: Effect.fn("Ft3ArchitectRepository.recordPublishFailure")(
      function* (input) {
        yield* sql`UPDATE ft3_architect_review SET last_publish_failure_reason = ${input.reason}, last_publish_failure_message = ${input.message}, last_publish_failure_at = ${input.attemptedAt} WHERE review_id = ${input.reviewId}`;
      },
      Effect.mapError(databaseError("record publish failure")),
    ),
    createOrGetBinding: Effect.fn("Ft3ArchitectRepository.createOrGetBinding")(function* (input) {
      const fingerprintByKey = sql<{ readonly fingerprint: string }>`
        SELECT create_request_fingerprint AS fingerprint
        FROM ft3_architect_binding
        WHERE coordinator_thread_id = ${input.coordinatorThreadId}
          AND create_idempotency_key = ${input.createIdempotencyKey}`;
      const bindingByKey = sql`SELECT ${bindingSelect} FROM ft3_architect_binding WHERE coordinator_thread_id = ${input.coordinatorThreadId} AND create_idempotency_key = ${input.createIdempotencyKey}`;
      const active = sql`SELECT ${bindingSelect} FROM ft3_architect_binding WHERE coordinator_thread_id = ${input.coordinatorThreadId} AND status = 'active'`;
      const conflict = () =>
        new Contracts.ArchitectMcpFailure({
          code: "idempotency_conflict",
          message: "This create key was already used with a different model or routing evidence.",
        });
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const priorFingerprint = yield* fingerprintByKey;
            if (priorFingerprint[0] !== undefined) {
              if (priorFingerprint[0].fingerprint !== input.createRequestFingerprint) {
                return yield* conflict();
              }
              const prior = yield* bindingsFromRows(yield* bindingByKey);
              return { binding: prior[0]!, created: false };
            }
            const activeRows = yield* active;
            if (activeRows[0] !== undefined) {
              const winner = yield* bindingsFromRows(activeRows);
              return { binding: winner[0]!, created: false };
            }
            yield* sql`INSERT INTO ft3_architect_binding (binding_id, coordinator_thread_id, architect_thread_id, project_id, architect_task_effort, status, created_at, created_by, replaced_by_binding_id, detach_reason, create_idempotency_key, create_request_fingerprint, routing_evidence_json) VALUES (${input.bindingId}, ${input.coordinatorThreadId}, ${input.architectThreadId}, ${input.projectId}, ${input.architectTaskEffort}, 'active', ${input.createdAt}, ${input.createdBy}, NULL, NULL, ${input.createIdempotencyKey}, ${input.createRequestFingerprint}, ${encodeRoutingEvidence(input.routingEvidence)}) ON CONFLICT(coordinator_thread_id) WHERE status = 'active' DO NOTHING`;
            const winnerRows = yield* active;
            if (winnerRows[0] === undefined) {
              return yield* new ArchitectRepositoryError({
                operation: "create binding",
                cause: new Error("ft3_architect_binding winner missing after insert"),
              });
            }
            const winner = yield* bindingsFromRows(winnerRows);
            return { binding: winner[0]!, created: winner[0]!.bindingId === input.bindingId };
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "OrchestratorMcpFailure" || error._tag === "ArchitectRepositoryError"
              ? error
              : databaseError("create architect binding")(error),
          ),
        );
    }),
    findBindingByCreateKey: Effect.fn("Ft3ArchitectRepository.findBindingByCreateKey")(
      function* (input) {
        const rows =
          yield* sql`SELECT ${bindingSelect} FROM ft3_architect_binding WHERE coordinator_thread_id = ${input.coordinatorThreadId} AND create_idempotency_key = ${input.createIdempotencyKey}`;
        const bindings = yield* bindingsFromRows(rows);
        return bindings[0] ?? null;
      },
      Effect.mapError(databaseError("read binding by create key")),
    ),
    findDetachReplay: Effect.fn("Ft3ArchitectRepository.findDetachReplay")(
      function* (input) {
        const rows =
          yield* sql`SELECT ${bindingSelect} FROM ft3_architect_binding WHERE coordinator_thread_id = ${input.coordinatorThreadId}`;
        const bindings = yield* bindingsFromRows(rows);
        const match = bindings.find(
          (binding) =>
            binding.status === "detached" &&
            binding.closeIdempotencyKey === input.closeIdempotencyKey,
        );
        if (match === undefined) return null;
        if (match.closeRequestFingerprint !== input.closeRequestFingerprint) {
          return yield* new Contracts.ArchitectMcpFailure({
            code: "idempotency_conflict",
            message: "This detach key was already used with a different request.",
          });
        }
        return match;
      },
      Effect.mapError(preserveError("replay detach architect binding")),
    ),
    findReplaceReplay: Effect.fn("Ft3ArchitectRepository.findReplaceReplay")(
      function* (input) {
        const rows =
          yield* sql`SELECT ${bindingSelect} FROM ft3_architect_binding WHERE coordinator_thread_id = ${input.coordinatorThreadId}`;
        const bindings = yield* bindingsFromRows(rows);
        const match = bindings.find(
          (binding) =>
            binding.status === "replaced" &&
            binding.closeIdempotencyKey === input.closeIdempotencyKey,
        );
        if (match === undefined) return null;
        if (match.closeRequestFingerprint !== input.closeRequestFingerprint) {
          return yield* new Contracts.ArchitectMcpFailure({
            code: "idempotency_conflict",
            message: "This replacement key was already used with a different request.",
          });
        }
        return match;
      },
      Effect.mapError(preserveError("replay replace architect binding")),
    ),
    closeBinding: Effect.fn("Ft3ArchitectRepository.closeBinding")(function* (input) {
      const byId = (bindingId: string) =>
        sql`SELECT ${bindingSelect} FROM ft3_architect_binding WHERE binding_id = ${bindingId}`;
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const found = yield* bindingsFromRows(yield* byId(input.bindingId));
            if (found[0] === undefined) return null;
            const current = found[0]!;
            if (current.status !== "active") {
              if (current.closeIdempotencyKey !== input.idempotencyKey) return null;
              if (current.closeRequestFingerprint !== input.closeRequestFingerprint) {
                return yield* new Contracts.ArchitectMcpFailure({
                  code: "idempotency_conflict",
                  message: "This close key was already used with a different request.",
                });
              }
              return current;
            }
            yield* sql`UPDATE ft3_architect_binding SET status = ${input.status}, replaced_by_binding_id = ${input.replacedByBindingId}, detach_reason = ${input.detachReason}, close_idempotency_key = ${input.idempotencyKey}, close_request_fingerprint = ${input.closeRequestFingerprint} WHERE binding_id = ${input.bindingId} AND status = 'active'`;
            const updated = yield* bindingsFromRows(yield* byId(input.bindingId));
            return updated[0] ?? null;
          }),
        )
        .pipe(Effect.mapError(preserveError("close architect binding")));
    }),
    linkReplacementWinner: Effect.fn("Ft3ArchitectRepository.linkReplacementWinner")(
      function* (input) {
        const byId = (bindingId: string) =>
          sql`SELECT ${bindingSelect} FROM ft3_architect_binding WHERE binding_id = ${bindingId}`;
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const replacedRows = yield* bindingsFromRows(yield* byId(input.replacedBindingId));
              if (replacedRows[0] === undefined) return null;
              const replaced = replacedRows[0]!;
              if (
                replaced.status !== "replaced" ||
                replaced.closeIdempotencyKey !== input.closeIdempotencyKey
              ) {
                return null;
              }
              if (replaced.closeRequestFingerprint !== input.closeRequestFingerprint) {
                return yield* new Contracts.ArchitectMcpFailure({
                  code: "idempotency_conflict",
                  message: "This replacement close key was already used with a different request.",
                });
              }
              const winnerRows = yield* bindingsFromRows(yield* byId(input.winnerBindingId));
              if (
                winnerRows[0] === undefined ||
                winnerRows[0]!.coordinatorThreadId !== replaced.coordinatorThreadId
              ) {
                return null;
              }
              if (replaced.replacedByBindingId !== input.winnerBindingId) {
                yield* sql`UPDATE ft3_architect_binding SET replaced_by_binding_id = ${input.winnerBindingId} WHERE binding_id = ${input.replacedBindingId} AND status = 'replaced' AND close_idempotency_key = ${input.closeIdempotencyKey} AND close_request_fingerprint = ${input.closeRequestFingerprint}`;
              }
              const linked = yield* bindingsFromRows(yield* byId(input.replacedBindingId));
              return linked[0] ?? null;
            }),
          )
          .pipe(Effect.mapError(preserveError("link replacement winner")));
      },
    ),
  });
});

export const layer = Layer.effect(ArchitectRepository, make);

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import {
  ArchitectureReviewAnswerDisposition,
  ArchitectureReviewExecutionPosture,
  ArchitectureReviewReason,
  ArchitectureReviewRefs,
  ArchitectureReviewStatus,
  ArchitectTaskEffort,
  CoordinatorArchitectBindingStatus,
  CoordinatorArchitectRoutingEvidence,
  ProjectId,
  ThreadId,
  type ArchitectureReviewRecord,
  type CoordinatorArchitectBinding,
} from "@t3tools/contracts";

import {
  CoordinatorArchitectIdempotencyConflict,
  CoordinatorArchitectRepository,
  CoordinatorArchitectRepositoryError,
  type BindingCloseInput,
  type BindingCreateInput,
  type BindingReplacementWinnerInput,
  type ReviewAnswerInput,
  type ReviewCancelInput,
  type ReviewInsertInput,
  type ReviewPublishInput,
  type ReviewTransitionResult,
  type CoordinatorArchitectRepositoryShape,
  type ReviewPublishDeliveredInput,
  type ReviewPublishFailureInput,
} from "../Services/CoordinatorArchitect.ts";

const toRepositoryError = (operation: string) => (cause: unknown) =>
  new CoordinatorArchitectRepositoryError({ operation, cause });

const isIdempotencyConflict = (cause: unknown): cause is CoordinatorArchitectIdempotencyConflict =>
  Predicate.isObject(cause) &&
  (cause as { readonly _tag?: unknown })._tag === "CoordinatorArchitectIdempotencyConflict";

const DbBindingRow = Schema.Struct({
  bindingId: Schema.String,
  coordinatorThreadId: ThreadId,
  architectThreadId: ThreadId,
  projectId: ProjectId,
  architectTaskEffort: ArchitectTaskEffort,
  status: CoordinatorArchitectBindingStatus,
  createdAt: Schema.String,
  createdBy: ThreadId,
  replacedByBindingId: Schema.NullOr(Schema.String),
  detachReason: Schema.NullOr(Schema.String),
  createIdempotencyKey: Schema.String,
  createRequestFingerprint: Schema.String,
  closeIdempotencyKey: Schema.NullOr(Schema.String),
  closeRequestFingerprint: Schema.NullOr(Schema.String),
  routingEvidenceJson: Schema.NullOr(Schema.String),
});

const DbReviewRow = Schema.Struct({
  reviewId: Schema.String,
  bindingId: Schema.String,
  coordinatorThreadId: ThreadId,
  architectThreadId: ThreadId,
  subjectChildThreadId: Schema.NullOr(ThreadId),
  reason: ArchitectureReviewReason,
  question: Schema.String,
  refsJson: Schema.String,
  executionPosture: ArchitectureReviewExecutionPosture,
  answerDisposition: Schema.NullOr(ArchitectureReviewAnswerDisposition),
  status: ArchitectureReviewStatus,
  answerSummary: Schema.NullOr(Schema.String),
  requestIdempotencyKey: Schema.String,
  answerIdempotencyKey: Schema.NullOr(Schema.String),
  answerPayloadFingerprint: Schema.NullOr(Schema.String),
  requestPayloadFingerprint: Schema.NullOr(Schema.String),
  publishIdempotencyKey: Schema.NullOr(Schema.String),
  cancelIdempotencyKey: Schema.NullOr(Schema.String),
  cancelPayloadFingerprint: Schema.NullOr(Schema.String),
  cancelledAt: Schema.NullOr(Schema.String),
  cancelledBy: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  answeredAt: Schema.NullOr(Schema.String),
  publishedAt: Schema.NullOr(Schema.String),
  publishDeliveredAt: Schema.NullOr(Schema.String),
  lastPublishFailureReason: Schema.NullOr(Schema.String),
  lastPublishFailureMessage: Schema.NullOr(Schema.String),
  lastPublishFailureAt: Schema.NullOr(Schema.String),
});

const toBinding = (row: typeof DbBindingRow.Type): CoordinatorArchitectBinding => ({
  bindingId: row.bindingId,
  coordinatorThreadId: row.coordinatorThreadId,
  architectThreadId: row.architectThreadId,
  projectId: row.projectId,
  architectTaskEffort: row.architectTaskEffort,
  status: row.status,
  createdAt: row.createdAt,
  createdBy: row.createdBy,
  replacedByBindingId: row.replacedByBindingId,
  detachReason: row.detachReason,
  createIdempotencyKey: row.createIdempotencyKey,
  routingEvidence:
    row.routingEvidenceJson === null
      ? null
      : Schema.decodeSync(Schema.fromJsonString(CoordinatorArchitectRoutingEvidence))(
          row.routingEvidenceJson,
        ),
});

const RefsJsonCodec = Schema.fromJsonString(ArchitectureReviewRefs);
const RoutingEvidenceJsonCodec = Schema.fromJsonString(CoordinatorArchitectRoutingEvidence);

const parseRefs = (refsJson: string): ArchitectureReviewRefs =>
  Schema.decodeSync(RefsJsonCodec)(refsJson);

const encodeRefs = (refs: ArchitectureReviewRefs): string => Schema.encodeSync(RefsJsonCodec)(refs);

const encodeRoutingEvidence = (evidence: CoordinatorArchitectRoutingEvidence): string =>
  Schema.encodeSync(RoutingEvidenceJsonCodec)(evidence);

const StringArrayJsonCodec = Schema.fromJsonString(Schema.Array(Schema.String));

const encodeStringArray = (values: ReadonlyArray<string>): string =>
  Schema.encodeSync(StringArrayJsonCodec)([...values]);

const toReview = (row: typeof DbReviewRow.Type): ArchitectureReviewRecord => ({
  reviewId: row.reviewId,
  bindingId: row.bindingId,
  coordinatorThreadId: row.coordinatorThreadId,
  architectThreadId: row.architectThreadId,
  subjectChildThreadId: row.subjectChildThreadId,
  reason: row.reason,
  question: row.question,
  refs: parseRefs(row.refsJson),
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
  cancelledBy: row.cancelledBy as ArchitectureReviewRecord["cancelledBy"],
  createdAt: row.createdAt,
  answeredAt: row.answeredAt,
  publishedAt: row.publishedAt,
  publishDeliveredAt: row.publishDeliveredAt,
  lastPublishFailure:
    row.lastPublishFailureReason === null || row.lastPublishFailureAt === null
      ? null
      : {
          reason: row.lastPublishFailureReason,
          message: row.lastPublishFailureMessage ?? "",
          attemptedAt: row.lastPublishFailureAt,
        },
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // S2 spike: the SQLite SqlClient starts with plain BEGIN, so nesting
  // BEGIN IMMEDIATE fails (pinned by CoordinatorArchitect.test.ts). Reserve one
  // connection and keep the raw transaction and all schema queries on that same
  // connection. Only classified SQLite busy/locked failures get bounded retry.
  const withImmediateTransaction = <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* sql.reserve;
          yield* connection.executeUnprepared("BEGIN IMMEDIATE", [], undefined);
          const result = yield* Effect.exit(
            Effect.provideService(restore(self), sql.transactionService, [connection, 0] as const),
          );
          if (result._tag === "Failure") {
            yield* connection.executeUnprepared("ROLLBACK", [], undefined).pipe(Effect.ignore);
            return yield* Effect.failCause(result.cause);
          }
          const commit = yield* Effect.exit(connection.executeUnprepared("COMMIT", [], undefined));
          if (commit._tag === "Failure") {
            yield* connection.executeUnprepared("ROLLBACK", [], undefined).pipe(Effect.ignore);
            return yield* Effect.failCause(commit.cause);
          }
          return result.value;
        }),
      ),
    );

  const withImmediateTransactionRetry = <A, E, R>(self: Effect.Effect<A, E, R>) =>
    withImmediateTransaction(self).pipe(
      Effect.retry({
        times: 2,
        while: (error) => SqlError.isSqlError(error) && error.reason._tag === "LockTimeoutError",
      }),
    );

  const selectActiveByCoordinator = SqlSchema.findOneOption({
    Request: Schema.Struct({ coordinatorThreadId: Schema.String }),
    Result: DbBindingRow,
    execute: ({ coordinatorThreadId }) => sql`
      SELECT
        binding_id AS "bindingId", coordinator_thread_id AS "coordinatorThreadId",
        architect_thread_id AS "architectThreadId", project_id AS "projectId",
        architect_task_effort AS "architectTaskEffort", status, created_at AS "createdAt",
        created_by AS "createdBy", replaced_by_binding_id AS "replacedByBindingId",
        detach_reason AS "detachReason", create_idempotency_key AS "createIdempotencyKey",
        create_request_fingerprint AS "createRequestFingerprint",
        close_idempotency_key AS "closeIdempotencyKey",
        close_request_fingerprint AS "closeRequestFingerprint",
        routing_evidence_json AS "routingEvidenceJson"
      FROM coordinator_architect_binding
      WHERE coordinator_thread_id = ${coordinatorThreadId} AND status = 'active'
    `,
  });
  const selectActiveByArchitect = SqlSchema.findOneOption({
    Request: Schema.Struct({ architectThreadId: Schema.String }),
    Result: DbBindingRow,
    execute: ({ architectThreadId }) => sql`
      SELECT
        binding_id AS "bindingId", coordinator_thread_id AS "coordinatorThreadId",
        architect_thread_id AS "architectThreadId", project_id AS "projectId",
        architect_task_effort AS "architectTaskEffort", status, created_at AS "createdAt",
        created_by AS "createdBy", replaced_by_binding_id AS "replacedByBindingId",
        detach_reason AS "detachReason", create_idempotency_key AS "createIdempotencyKey",
        create_request_fingerprint AS "createRequestFingerprint",
        close_idempotency_key AS "closeIdempotencyKey",
        close_request_fingerprint AS "closeRequestFingerprint",
        routing_evidence_json AS "routingEvidenceJson"
      FROM coordinator_architect_binding
      WHERE architect_thread_id = ${architectThreadId} AND status = 'active'
    `,
  });
  const selectBindingById = SqlSchema.findOneOption({
    Request: Schema.Struct({ bindingId: Schema.String }),
    Result: DbBindingRow,
    execute: ({ bindingId }) => sql`
      SELECT
        binding_id AS "bindingId", coordinator_thread_id AS "coordinatorThreadId",
        architect_thread_id AS "architectThreadId", project_id AS "projectId",
        architect_task_effort AS "architectTaskEffort", status, created_at AS "createdAt",
        created_by AS "createdBy", replaced_by_binding_id AS "replacedByBindingId",
        detach_reason AS "detachReason", create_idempotency_key AS "createIdempotencyKey",
        create_request_fingerprint AS "createRequestFingerprint",
        close_idempotency_key AS "closeIdempotencyKey",
        close_request_fingerprint AS "closeRequestFingerprint",
        routing_evidence_json AS "routingEvidenceJson"
      FROM coordinator_architect_binding
      WHERE binding_id = ${bindingId}
    `,
  });
  const selectAnyByArchitect = SqlSchema.findOneOption({
    Request: Schema.Struct({ architectThreadId: Schema.String }),
    Result: DbBindingRow,
    execute: ({ architectThreadId }) => sql`
      SELECT
        binding_id AS "bindingId", coordinator_thread_id AS "coordinatorThreadId",
        architect_thread_id AS "architectThreadId", project_id AS "projectId",
        architect_task_effort AS "architectTaskEffort", status, created_at AS "createdAt",
        created_by AS "createdBy", replaced_by_binding_id AS "replacedByBindingId",
        detach_reason AS "detachReason", create_idempotency_key AS "createIdempotencyKey",
        create_request_fingerprint AS "createRequestFingerprint",
        close_idempotency_key AS "closeIdempotencyKey",
        close_request_fingerprint AS "closeRequestFingerprint",
        routing_evidence_json AS "routingEvidenceJson"
      FROM coordinator_architect_binding
      WHERE architect_thread_id = ${architectThreadId}
      ORDER BY created_at DESC, binding_id DESC
      LIMIT 1
    `,
  });
  const selectActiveBindings = SqlSchema.findAll({
    Request: Schema.Void,
    Result: DbBindingRow,
    execute: () => sql`
      SELECT
        binding_id AS "bindingId", coordinator_thread_id AS "coordinatorThreadId",
        architect_thread_id AS "architectThreadId", project_id AS "projectId",
        architect_task_effort AS "architectTaskEffort", status, created_at AS "createdAt",
        created_by AS "createdBy", replaced_by_binding_id AS "replacedByBindingId",
        detach_reason AS "detachReason", create_idempotency_key AS "createIdempotencyKey",
        create_request_fingerprint AS "createRequestFingerprint",
        close_idempotency_key AS "closeIdempotencyKey",
        close_request_fingerprint AS "closeRequestFingerprint",
        routing_evidence_json AS "routingEvidenceJson"
      FROM coordinator_architect_binding
      WHERE status = 'active'
      ORDER BY created_at ASC, binding_id ASC
    `,
  });
  const selectBindingByKey = SqlSchema.findOneOption({
    Request: Schema.Struct({
      coordinatorThreadId: Schema.String,
      createIdempotencyKey: Schema.String,
    }),
    Result: DbBindingRow,
    execute: ({ coordinatorThreadId, createIdempotencyKey }) => sql`
      SELECT
        binding_id AS "bindingId", coordinator_thread_id AS "coordinatorThreadId",
        architect_thread_id AS "architectThreadId", project_id AS "projectId",
        architect_task_effort AS "architectTaskEffort", status, created_at AS "createdAt",
        created_by AS "createdBy", replaced_by_binding_id AS "replacedByBindingId",
        detach_reason AS "detachReason", create_idempotency_key AS "createIdempotencyKey",
        create_request_fingerprint AS "createRequestFingerprint",
        close_idempotency_key AS "closeIdempotencyKey",
        close_request_fingerprint AS "closeRequestFingerprint",
        routing_evidence_json AS "routingEvidenceJson"
      FROM coordinator_architect_binding
      WHERE coordinator_thread_id = ${coordinatorThreadId}
        AND create_idempotency_key = ${createIdempotencyKey}
    `,
  });
  const selectReviewById = SqlSchema.findOneOption({
    Request: Schema.Struct({ reviewId: Schema.String }),
    Result: DbReviewRow,
    execute: ({ reviewId }) => sql`
      SELECT
        review_id AS "reviewId", binding_id AS "bindingId",
        coordinator_thread_id AS "coordinatorThreadId", architect_thread_id AS "architectThreadId",
        subject_child_thread_id AS "subjectChildThreadId", reason, question,
        refs_json AS "refsJson", execution_posture AS "executionPosture",
        answer_disposition AS "answerDisposition", status, answer_summary AS "answerSummary",
        request_idempotency_key AS "requestIdempotencyKey",
        request_payload_fingerprint AS "requestPayloadFingerprint",
        answer_idempotency_key AS "answerIdempotencyKey",
        answer_payload_fingerprint AS "answerPayloadFingerprint",
        publish_idempotency_key AS "publishIdempotencyKey",
        cancel_idempotency_key AS "cancelIdempotencyKey",
        cancel_payload_fingerprint AS "cancelPayloadFingerprint",
        cancelled_at AS "cancelledAt",
        cancelled_by AS "cancelledBy", created_at AS "createdAt",
        answered_at AS "answeredAt", published_at AS "publishedAt",
        publish_delivered_at AS "publishDeliveredAt",
        last_publish_failure_reason AS "lastPublishFailureReason",
        last_publish_failure_message AS "lastPublishFailureMessage",
        last_publish_failure_at AS "lastPublishFailureAt"
      FROM architecture_review
      WHERE review_id = ${reviewId}
    `,
  });
  const selectReviewByRequestKey = SqlSchema.findOneOption({
    Request: Schema.Struct({
      coordinatorThreadId: Schema.String,
      requestIdempotencyKey: Schema.String,
    }),
    Result: DbReviewRow,
    execute: ({ coordinatorThreadId, requestIdempotencyKey }) => sql`
      SELECT
        review_id AS "reviewId", binding_id AS "bindingId",
        coordinator_thread_id AS "coordinatorThreadId", architect_thread_id AS "architectThreadId",
        subject_child_thread_id AS "subjectChildThreadId", reason, question,
        refs_json AS "refsJson", execution_posture AS "executionPosture",
        answer_disposition AS "answerDisposition", status, answer_summary AS "answerSummary",
        request_idempotency_key AS "requestIdempotencyKey",
        request_payload_fingerprint AS "requestPayloadFingerprint",
        answer_idempotency_key AS "answerIdempotencyKey",
        answer_payload_fingerprint AS "answerPayloadFingerprint",
        publish_idempotency_key AS "publishIdempotencyKey",
        cancel_idempotency_key AS "cancelIdempotencyKey",
        cancel_payload_fingerprint AS "cancelPayloadFingerprint",
        cancelled_at AS "cancelledAt",
        cancelled_by AS "cancelledBy", created_at AS "createdAt",
        answered_at AS "answeredAt", published_at AS "publishedAt",
        publish_delivered_at AS "publishDeliveredAt",
        last_publish_failure_reason AS "lastPublishFailureReason",
        last_publish_failure_message AS "lastPublishFailureMessage",
        last_publish_failure_at AS "lastPublishFailureAt"
      FROM architecture_review
      WHERE coordinator_thread_id = ${coordinatorThreadId}
        AND request_idempotency_key = ${requestIdempotencyKey}
    `,
  });
  const selectReviewsByCoordinator = SqlSchema.findAll({
    Request: Schema.Struct({
      coordinatorThreadId: Schema.String,
      status: Schema.NullOr(ArchitectureReviewStatus),
    }),
    Result: DbReviewRow,
    execute: ({ coordinatorThreadId, status }) => sql`
      SELECT
        review_id AS "reviewId", binding_id AS "bindingId",
        coordinator_thread_id AS "coordinatorThreadId", architect_thread_id AS "architectThreadId",
        subject_child_thread_id AS "subjectChildThreadId", reason, question,
        refs_json AS "refsJson", execution_posture AS "executionPosture",
        answer_disposition AS "answerDisposition", status, answer_summary AS "answerSummary",
        request_idempotency_key AS "requestIdempotencyKey",
        request_payload_fingerprint AS "requestPayloadFingerprint",
        answer_idempotency_key AS "answerIdempotencyKey",
        answer_payload_fingerprint AS "answerPayloadFingerprint",
        publish_idempotency_key AS "publishIdempotencyKey",
        cancel_idempotency_key AS "cancelIdempotencyKey",
        cancel_payload_fingerprint AS "cancelPayloadFingerprint",
        cancelled_at AS "cancelledAt",
        cancelled_by AS "cancelledBy", created_at AS "createdAt",
        answered_at AS "answeredAt", published_at AS "publishedAt",
        publish_delivered_at AS "publishDeliveredAt",
        last_publish_failure_reason AS "lastPublishFailureReason",
        last_publish_failure_message AS "lastPublishFailureMessage",
        last_publish_failure_at AS "lastPublishFailureAt"
      FROM architecture_review
      WHERE coordinator_thread_id = ${coordinatorThreadId}
        AND (${status} IS NULL OR status = ${status})
      ORDER BY created_at ASC, review_id ASC
    `,
  });

  const readActiveBinding = (coordinatorThreadId: string) =>
    selectActiveByCoordinator({ coordinatorThreadId }).pipe(
      Effect.map(Option.match({ onNone: () => null, onSome: toBinding })),
      Effect.mapError(toRepositoryError("readActiveBinding")),
    );

  // Binding-first election in one transaction: exact-retry by key first
  // (same key + same fingerprint replays, different fingerprint conflicts),
  // then reuse of the active row, else insert-or-ignore against the
  // partial-unique index and re-read the winner. Losers converge on the
  // winner with created:false.
  const runCreateBinding = (input: BindingCreateInput) =>
    withImmediateTransactionRetry(
      Effect.gen(function* () {
        const prior = yield* selectBindingByKey({
          coordinatorThreadId: input.coordinatorThreadId,
          createIdempotencyKey: input.createIdempotencyKey,
        });
        if (Option.isSome(prior)) {
          if (prior.value.createRequestFingerprint !== input.createRequestFingerprint) {
            return yield* new CoordinatorArchitectIdempotencyConflict({
              operation: "createOrGetBinding",
              existingId: prior.value.bindingId,
            });
          }
          if (prior.value.status === "active") {
            return { binding: toBinding(prior.value), created: false };
          }
          const superseding = yield* selectActiveByCoordinator({
            coordinatorThreadId: input.coordinatorThreadId,
          });
          return {
            binding: toBinding(Option.getOrElse(superseding, () => prior.value)),
            created: false,
          };
        }
        const active = yield* selectActiveByCoordinator({
          coordinatorThreadId: input.coordinatorThreadId,
        });
        if (Option.isSome(active)) {
          return { binding: toBinding(active.value), created: false };
        }
        yield* sql`
          INSERT INTO coordinator_architect_binding (
            binding_id, coordinator_thread_id, architect_thread_id, project_id,
            architect_task_effort, status, created_at, created_by,
            replaced_by_binding_id, detach_reason,
            create_idempotency_key, create_request_fingerprint, routing_evidence_json
          ) VALUES (
            ${input.bindingId}, ${input.coordinatorThreadId}, ${input.architectThreadId},
            ${input.projectId}, ${input.architectTaskEffort}, 'active', ${input.createdAt},
            ${input.createdBy}, NULL, NULL,
            ${input.createIdempotencyKey}, ${input.createRequestFingerprint},
            ${encodeRoutingEvidence(input.routingEvidence)}
          )
          ON CONFLICT(coordinator_thread_id)
          WHERE status = 'active'
          DO NOTHING
        `;
        const winner = yield* selectBindingByKey({
          coordinatorThreadId: input.coordinatorThreadId,
          createIdempotencyKey: input.createIdempotencyKey,
        });
        // Same-key row with a different fingerprint: exact-retry conflict.
        // Otherwise the active winner may carry another key (parallel
        // create); fall through to the active re-read below.
        if (
          Option.isSome(winner) &&
          winner.value.createRequestFingerprint !== input.createRequestFingerprint
        ) {
          return yield* new CoordinatorArchitectIdempotencyConflict({
            operation: "createOrGetBinding",
            existingId: winner.value.bindingId,
          });
        }
        const current = yield* selectActiveByCoordinator({
          coordinatorThreadId: input.coordinatorThreadId,
        });
        if (Option.isNone(current)) {
          return yield* Effect.die(
            new Error("coordinator_architect_binding winner missing after insert"),
          );
        }
        return {
          binding: toBinding(current.value),
          created: current.value.bindingId === input.bindingId,
        };
      }),
    );

  const isRepositoryError = (cause: unknown): boolean =>
    Predicate.isObject(cause) &&
    (cause as { readonly _tag?: unknown })._tag === "CoordinatorArchitectRepositoryError";

  const createOrGetBinding: CoordinatorArchitectRepositoryShape["createOrGetBinding"] = (input) =>
    Effect.matchCauseEffect(runCreateBinding(input), {
      // Residual race (e.g. parallel replace committed first): the
      // transaction aborted, so converge on the committed winner outside
      // it. No winner means a real failure — report the original cause.
      onFailure: (cause) =>
        Effect.gen(function* () {
          const failureValue = Cause.findErrorOption(cause);
          if (Option.isSome(failureValue) && isIdempotencyConflict(failureValue.value)) {
            return yield* failureValue.value;
          }
          const recovered = yield* readActiveBinding(input.coordinatorThreadId).pipe(
            Effect.matchCauseEffect({
              onFailure: () => Effect.fail(toRepositoryError("createOrGetBinding")(cause)),
              onSuccess: (winner) =>
                winner === null
                  ? Effect.fail(toRepositoryError("createOrGetBinding")(cause))
                  : Effect.succeed({ binding: winner, created: false }),
            }),
          );
          return recovered;
        }),
      onSuccess: (result) => Effect.succeed(result),
    }).pipe(
      Effect.mapError((cause) =>
        isIdempotencyConflict(cause) || isRepositoryError(cause)
          ? cause
          : toRepositoryError("createOrGetBinding")(cause),
      ),
    );

  const closeBinding: CoordinatorArchitectRepositoryShape["closeBinding"] = (input) =>
    withImmediateTransactionRetry(
      Effect.gen(function* () {
        const found = yield* selectBindingById({ bindingId: input.bindingId });
        if (Option.isNone(found)) return null;
        const current = found.value;
        if (current.status !== "active") {
          if (current.closeIdempotencyKey !== input.idempotencyKey) return null;
          if (current.closeRequestFingerprint !== input.closeRequestFingerprint) {
            return yield* new CoordinatorArchitectIdempotencyConflict({
              operation: "closeBinding",
              existingId: current.bindingId,
            });
          }
          return toBinding(current);
        }
        yield* sql`
          UPDATE coordinator_architect_binding
          SET status = ${input.status},
            replaced_by_binding_id = ${input.replacedByBindingId},
            detach_reason = ${input.detachReason},
            close_idempotency_key = ${input.idempotencyKey},
            close_request_fingerprint = ${input.closeRequestFingerprint}
          WHERE binding_id = ${input.bindingId} AND status = 'active'
        `;
        const updated = yield* selectBindingById({ bindingId: input.bindingId });
        return Option.match(updated, { onNone: () => null, onSome: toBinding });
      }),
    ).pipe(
      Effect.mapError((cause) =>
        isIdempotencyConflict(cause) ? cause : toRepositoryError("closeBinding")(cause),
      ),
    );

  const linkReplacementWinner: CoordinatorArchitectRepositoryShape["linkReplacementWinner"] = (
    input: BindingReplacementWinnerInput,
  ) =>
    withImmediateTransactionRetry(
      Effect.gen(function* () {
        const replacedOption = yield* selectBindingById({ bindingId: input.replacedBindingId });
        if (Option.isNone(replacedOption)) return null;
        const replaced = replacedOption.value;
        if (
          replaced.status !== "replaced" ||
          replaced.closeIdempotencyKey !== input.closeIdempotencyKey
        ) {
          return null;
        }
        if (replaced.closeRequestFingerprint !== input.closeRequestFingerprint) {
          return yield* new CoordinatorArchitectIdempotencyConflict({
            operation: "linkReplacementWinner",
            existingId: replaced.bindingId,
          });
        }
        const winnerOption = yield* selectBindingById({ bindingId: input.winnerBindingId });
        if (
          Option.isNone(winnerOption) ||
          winnerOption.value.coordinatorThreadId !== replaced.coordinatorThreadId
        ) {
          return null;
        }
        if (replaced.replacedByBindingId !== input.winnerBindingId) {
          yield* sql`
            UPDATE coordinator_architect_binding
            SET replaced_by_binding_id = ${input.winnerBindingId}
            WHERE binding_id = ${input.replacedBindingId}
              AND status = 'replaced'
              AND close_idempotency_key = ${input.closeIdempotencyKey}
              AND close_request_fingerprint = ${input.closeRequestFingerprint}
          `;
        }
        const linked = yield* selectBindingById({ bindingId: input.replacedBindingId });
        return Option.match(linked, { onNone: () => null, onSome: toBinding });
      }),
    ).pipe(
      Effect.mapError((cause) =>
        isIdempotencyConflict(cause) ? cause : toRepositoryError("linkReplacementWinner")(cause),
      ),
    );

  const selectBindingsByCoordinator = SqlSchema.findAll({
    Request: Schema.Struct({ coordinatorThreadId: Schema.String }),
    Result: DbBindingRow,
    execute: ({ coordinatorThreadId }) => sql`
      SELECT
        binding_id AS "bindingId", coordinator_thread_id AS "coordinatorThreadId",
        architect_thread_id AS "architectThreadId", project_id AS "projectId",
        architect_task_effort AS "architectTaskEffort", status, created_at AS "createdAt",
        created_by AS "createdBy", replaced_by_binding_id AS "replacedByBindingId",
        detach_reason AS "detachReason", create_idempotency_key AS "createIdempotencyKey",
        create_request_fingerprint AS "createRequestFingerprint",
        close_idempotency_key AS "closeIdempotencyKey",
        close_request_fingerprint AS "closeRequestFingerprint",
        routing_evidence_json AS "routingEvidenceJson"
      FROM coordinator_architect_binding
      WHERE coordinator_thread_id = ${coordinatorThreadId}
      ORDER BY created_at ASC, binding_id ASC
    `,
  });

  const listBindingsByCoordinator: CoordinatorArchitectRepositoryShape["listBindingsByCoordinator"] =
    (coordinatorThreadId) =>
      selectBindingsByCoordinator({ coordinatorThreadId }).pipe(
        Effect.map((rows) => rows.map(toBinding)),
        Effect.mapError(toRepositoryError("listBindingsByCoordinator")),
      );

  const runInsertReview = (input: ReviewInsertInput) =>
    withImmediateTransactionRetry(
      Effect.gen(function* () {
        const existing = yield* selectReviewByRequestKey({
          coordinatorThreadId: input.coordinatorThreadId,
          requestIdempotencyKey: input.requestIdempotencyKey,
        });
        if (Option.isSome(existing)) {
          if (existing.value.requestPayloadFingerprint !== input.requestPayloadFingerprint) {
            return yield* new CoordinatorArchitectIdempotencyConflict({
              operation: "insertReview",
              existingId: existing.value.reviewId,
            });
          }
          return { review: toReview(existing.value), created: false };
        }
        yield* sql`
          INSERT INTO architecture_review (
            review_id, binding_id, coordinator_thread_id, architect_thread_id,
            subject_child_thread_id, reason, question, refs_json, execution_posture,
            answer_disposition, status, answer_summary,
            request_idempotency_key, request_payload_fingerprint,
            answer_idempotency_key, answer_payload_fingerprint,
            publish_idempotency_key, cancel_idempotency_key, cancel_payload_fingerprint,
            cancelled_at, cancelled_by, created_at, answered_at, published_at,
            publish_delivered_at, last_publish_failure_reason,
            last_publish_failure_message, last_publish_failure_at
          ) VALUES (
            ${input.reviewId}, ${input.bindingId}, ${input.coordinatorThreadId},
            ${input.architectThreadId}, ${input.subjectChildThreadId}, ${input.reason},
            ${input.question}, ${encodeRefs(input.refs)}, ${input.executionPosture},
            NULL, 'open', NULL,
            ${input.requestIdempotencyKey}, ${input.requestPayloadFingerprint},
            NULL, NULL, NULL, NULL, NULL, NULL, NULL,
            ${input.createdAt}, NULL, NULL, NULL, NULL, NULL, NULL
          )
          ON CONFLICT(coordinator_thread_id, request_idempotency_key) DO NOTHING
        `;
        const winner = yield* selectReviewByRequestKey({
          coordinatorThreadId: input.coordinatorThreadId,
          requestIdempotencyKey: input.requestIdempotencyKey,
        });
        if (Option.isNone(winner)) {
          return yield* Effect.die(new Error("architecture_review winner missing after insert"));
        }
        if (winner.value.requestPayloadFingerprint !== input.requestPayloadFingerprint) {
          return yield* new CoordinatorArchitectIdempotencyConflict({
            operation: "insertReview",
            existingId: winner.value.reviewId,
          });
        }
        return {
          review: toReview(winner.value),
          created: winner.value.reviewId === input.reviewId,
        };
      }),
    );

  const sameKeyReplay = (
    storedKey: string | null,
    inputKey: string,
    storedFingerprint: string | null,
    inputFingerprint: string,
  ): ReviewTransitionResult => {
    if (storedKey !== inputKey) return { _tag: "conflict" };
    return storedFingerprint === inputFingerprint ? { _tag: "replay" } : { _tag: "conflict" };
  };

  const answerReview: CoordinatorArchitectRepositoryShape["answerReview"] = (
    input: ReviewAnswerInput,
  ) =>
    withImmediateTransactionRetry(
      Effect.gen(function* () {
        const found = yield* selectReviewById({ reviewId: input.reviewId });
        if (Option.isNone(found)) return { _tag: "state" } as ReviewTransitionResult;
        const row = found.value;
        if (row.status === "answered") {
          return sameKeyReplay(
            row.answerIdempotencyKey,
            input.answerIdempotencyKey,
            row.answerPayloadFingerprint,
            input.answerPayloadFingerprint,
          );
        }
        if (row.status !== "open") return { _tag: "state" } as ReviewTransitionResult;
        yield* sql`
            UPDATE architecture_review
            SET status = 'answered',
              answer_disposition = ${input.disposition},
              answer_summary = ${input.summary},
              refs_json = json_patch(
                refs_json,
                json_object(
                  'architectOclRefs',
                  json(${encodeStringArray(input.oclRefs)})
                )
              ),
              answer_idempotency_key = ${input.answerIdempotencyKey},
              answer_payload_fingerprint = ${input.answerPayloadFingerprint},
              answered_at = ${input.answeredAt}
            WHERE review_id = ${input.reviewId} AND status = 'open'
          `;
        return { _tag: "applied" } as ReviewTransitionResult;
      }),
    ).pipe(Effect.mapError(toRepositoryError("answerReview")));

  // Note: architect oclRefs are folded into refs_json under
  // `architectOclRefs` (compact reference events stay on the
  // `architecture.review-answered` activity per §4). The typed request refs
  // (messageIds/checkpoint/oclRefs) are never overwritten by an answer.
  const publishReview: CoordinatorArchitectRepositoryShape["publishReview"] = (
    input: ReviewPublishInput,
  ) =>
    withImmediateTransactionRetry(
      Effect.gen(function* () {
        const found = yield* selectReviewById({ reviewId: input.reviewId });
        if (Option.isNone(found)) return { _tag: "state" } as ReviewTransitionResult;
        const row = found.value;
        if (row.status === "published") {
          return row.publishIdempotencyKey === input.publishIdempotencyKey
            ? ({ _tag: "replay" } as ReviewTransitionResult)
            : ({ _tag: "conflict" } as ReviewTransitionResult);
        }
        if (row.status !== "answered") return { _tag: "state" } as ReviewTransitionResult;
        yield* sql`
            UPDATE architecture_review
            SET status = 'published',
              publish_idempotency_key = ${input.publishIdempotencyKey},
              published_at = ${input.publishedAt}
            WHERE review_id = ${input.reviewId} AND status = 'answered'
          `;
        return { _tag: "applied" } as ReviewTransitionResult;
      }),
    ).pipe(Effect.mapError(toRepositoryError("publishReview")));

  // Additive observability only: proves the coordinator wake fired (success)
  // or records the stable refusal/failure token. Both leave `status`,
  // idempotency keys, and fingerprints untouched.
  const markPublishDelivered: CoordinatorArchitectRepositoryShape["markPublishDelivered"] = (
    input: ReviewPublishDeliveredInput,
  ) =>
    withImmediateTransactionRetry(sql`
      UPDATE architecture_review
      SET publish_delivered_at = ${input.deliveredAt},
        last_publish_failure_reason = NULL,
        last_publish_failure_message = NULL,
        last_publish_failure_at = NULL
      WHERE review_id = ${input.reviewId}
    `).pipe(Effect.mapError(toRepositoryError("markPublishDelivered")));

  const recordPublishFailure: CoordinatorArchitectRepositoryShape["recordPublishFailure"] = (
    input: ReviewPublishFailureInput,
  ) =>
    withImmediateTransactionRetry(sql`
      UPDATE architecture_review
      SET last_publish_failure_reason = ${input.reason},
        last_publish_failure_message = ${input.message},
        last_publish_failure_at = ${input.attemptedAt}
      WHERE review_id = ${input.reviewId}
    `).pipe(Effect.mapError(toRepositoryError("recordPublishFailure")));

  const cancelReview: CoordinatorArchitectRepositoryShape["cancelReview"] = (
    input: ReviewCancelInput,
  ) =>
    withImmediateTransactionRetry(
      Effect.gen(function* () {
        const found = yield* selectReviewById({ reviewId: input.reviewId });
        if (Option.isNone(found)) return { _tag: "state" } as ReviewTransitionResult;
        const row = found.value;
        if (row.status === "cancelled") {
          if (row.cancelIdempotencyKey !== input.cancelIdempotencyKey) {
            return { _tag: "state" } as ReviewTransitionResult;
          }
          return row.cancelPayloadFingerprint === input.cancelPayloadFingerprint
            ? ({ _tag: "replay" } as ReviewTransitionResult)
            : ({ _tag: "conflict" } as ReviewTransitionResult);
        }
        if (row.status !== "open" && row.status !== "answered") {
          return { _tag: "state" } as ReviewTransitionResult;
        }
        yield* sql`
            UPDATE architecture_review
            SET status = 'cancelled',
              cancel_idempotency_key = ${input.cancelIdempotencyKey},
              cancel_payload_fingerprint = ${input.cancelPayloadFingerprint},
              cancelled_at = ${input.cancelledAt},
              cancelled_by = ${input.cancelledBy}
            WHERE review_id = ${input.reviewId} AND status IN ('open', 'answered')
          `;
        return { _tag: "applied" } as ReviewTransitionResult;
      }),
    ).pipe(Effect.mapError(toRepositoryError("cancelReview")));

  const getActiveBindingByCoordinator: CoordinatorArchitectRepositoryShape["getActiveBindingByCoordinator"] =
    (coordinatorThreadId) =>
      selectActiveByCoordinator({ coordinatorThreadId }).pipe(
        Effect.map(Option.match({ onNone: () => null, onSome: toBinding })),
        Effect.mapError(toRepositoryError("getActiveBindingByCoordinator")),
      );

  const getActiveBindingByArchitect: CoordinatorArchitectRepositoryShape["getActiveBindingByArchitect"] =
    (architectThreadId) =>
      selectActiveByArchitect({ architectThreadId }).pipe(
        Effect.map(Option.match({ onNone: () => null, onSome: toBinding })),
        Effect.mapError(toRepositoryError("getActiveBindingByArchitect")),
      );

  const getBindingById: CoordinatorArchitectRepositoryShape["getBindingById"] = (bindingId) =>
    selectBindingById({ bindingId }).pipe(
      Effect.map(Option.match({ onNone: () => null, onSome: toBinding })),
      Effect.mapError(toRepositoryError("getBindingById")),
    );

  const getAnyBindingByArchitect: CoordinatorArchitectRepositoryShape["getAnyBindingByArchitect"] =
    (architectThreadId) =>
      selectAnyByArchitect({ architectThreadId }).pipe(
        Effect.map(Option.match({ onNone: () => null, onSome: toBinding })),
        Effect.mapError(toRepositoryError("getAnyBindingByArchitect")),
      );

  const listActiveBindings: CoordinatorArchitectRepositoryShape["listActiveBindings"] = () =>
    selectActiveBindings().pipe(
      Effect.map((rows) => rows.map(toBinding)),
      Effect.mapError(toRepositoryError("listActiveBindings")),
    );

  const findBindingByCreateKey: CoordinatorArchitectRepositoryShape["findBindingByCreateKey"] = (
    input,
  ) =>
    selectBindingByKey({
      coordinatorThreadId: input.coordinatorThreadId,
      createIdempotencyKey: input.createIdempotencyKey,
    }).pipe(
      Effect.map(Option.match({ onNone: () => null, onSome: toBinding })),
      Effect.mapError(toRepositoryError("findBindingByCreateKey")),
    );

  const findDetachReplay: CoordinatorArchitectRepositoryShape["findDetachReplay"] = (input) =>
    selectBindingsByCoordinator({ coordinatorThreadId: input.coordinatorThreadId }).pipe(
      Effect.flatMap((rows) => {
        const match = rows.find(
          (row) =>
            row.status === "detached" && row.closeIdempotencyKey === input.closeIdempotencyKey,
        );
        if (match === undefined) return Effect.succeed(null);
        if (match.closeRequestFingerprint !== input.closeRequestFingerprint) {
          return Effect.fail(
            new CoordinatorArchitectIdempotencyConflict({
              operation: "findDetachReplay",
              existingId: match.bindingId,
            }),
          );
        }
        return Effect.succeed(toBinding(match));
      }),
      Effect.mapError((cause) =>
        isIdempotencyConflict(cause) ? cause : toRepositoryError("findDetachReplay")(cause),
      ),
    );

  const findReplaceReplay: CoordinatorArchitectRepositoryShape["findReplaceReplay"] = (input) =>
    selectBindingsByCoordinator({ coordinatorThreadId: input.coordinatorThreadId }).pipe(
      Effect.flatMap((rows) => {
        const match = rows.find(
          (row) =>
            row.status === "replaced" && row.closeIdempotencyKey === input.closeIdempotencyKey,
        );
        if (match === undefined) return Effect.succeed(null);
        if (match.closeRequestFingerprint !== input.closeRequestFingerprint) {
          return Effect.fail(
            new CoordinatorArchitectIdempotencyConflict({
              operation: "findReplaceReplay",
              existingId: match.bindingId,
            }),
          );
        }
        return Effect.succeed(toBinding(match));
      }),
      Effect.mapError((cause) =>
        isIdempotencyConflict(cause) ? cause : toRepositoryError("findReplaceReplay")(cause),
      ),
    );

  const insertReview: CoordinatorArchitectRepositoryShape["insertReview"] = (input) =>
    runInsertReview(input).pipe(
      Effect.mapError((cause) =>
        isIdempotencyConflict(cause) ? cause : toRepositoryError("insertReview")(cause),
      ),
    );

  const getReviewById: CoordinatorArchitectRepositoryShape["getReviewById"] = (reviewId) =>
    selectReviewById({ reviewId }).pipe(
      Effect.map(Option.match({ onNone: () => null, onSome: toReview })),
      Effect.mapError(toRepositoryError("getReviewById")),
    );

  const getReviewByRequestKey: CoordinatorArchitectRepositoryShape["getReviewByRequestKey"] = (
    input,
  ) =>
    selectReviewByRequestKey(input).pipe(
      Effect.map(Option.match({ onNone: () => null, onSome: toReview })),
      Effect.mapError(toRepositoryError("getReviewByRequestKey")),
    );

  const listReviewsByCoordinator: CoordinatorArchitectRepositoryShape["listReviewsByCoordinator"] =
    (input) =>
      selectReviewsByCoordinator({
        coordinatorThreadId: input.coordinatorThreadId,
        status: input.status ?? null,
      }).pipe(
        Effect.map((rows) => rows.map(toReview)),
        Effect.mapError(toRepositoryError("listReviewsByCoordinator")),
      );

  return {
    createOrGetBinding,
    getActiveBindingByCoordinator,
    getActiveBindingByArchitect,
    getBindingById,
    getAnyBindingByArchitect,
    listActiveBindings,
    findBindingByCreateKey,
    findDetachReplay,
    findReplaceReplay,
    closeBinding,
    linkReplacementWinner,
    listBindingsByCoordinator,
    insertReview,
    getReviewById,
    getReviewByRequestKey,
    listReviewsByCoordinator,
    answerReview,
    publishReview,
    markPublishDelivered,
    recordPublishFailure,
    cancelReview,
  } satisfies CoordinatorArchitectRepositoryShape;
});

export const CoordinatorArchitectRepositoryLive = Layer.effect(
  CoordinatorArchitectRepository,
  make,
);

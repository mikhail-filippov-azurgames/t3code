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
  answered_at AS "answeredAt", published_at AS "publishedAt", origin,
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

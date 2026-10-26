import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { MAX_SUMMARY_ATTEMPTS, safeSummaryText } from "./DelegatedTaskSummaryText.ts";

export type SummarySource = "model" | "deterministic";
export type SummaryState = "pending" | "ready" | "error";

export interface SummaryRecord {
  readonly childThreadId: string;
  readonly parentEnvironmentId: string;
  readonly parentThreadId: string;
  readonly sourceTurnId: string;
  readonly completedAt: string;
  readonly text: string;
  readonly source: SummarySource;
  readonly sourceTurnIds: ReadonlyArray<string>;
  readonly watermark: number;
  readonly contentFingerprint: string;
  readonly state: SummaryState;
  readonly error: string | null;
  readonly attemptCount: number;
  readonly retryAfter: string | null;
  readonly updatedAt: string;
}

export class DelegatedTaskSummaryRepositoryError extends Schema.TaggedError<DelegatedTaskSummaryRepositoryError>()(
  "DelegatedTaskSummaryRepositoryError",
  { operation: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export interface SummaryHistoryRow {
  readonly childThreadId: string;
  readonly sourceTurnId: string;
  readonly completedAt: string;
  readonly summaryText: string;
  readonly summaryState: SummaryState;
  readonly summaryWatermark: number;
  readonly currentTurnId: string | null;
  readonly currentTurnState: string | null;
  readonly currentWatermark: number;
}

interface SummaryRow {
  readonly childThreadId: string;
  readonly parentEnvironmentId: string;
  readonly parentThreadId: string;
  readonly sourceTurnId: string;
  readonly completedAt: string;
  readonly text: string;
  readonly source: SummarySource;
  readonly sourceTurnIdsJson: string;
  readonly watermark: number;
  readonly contentFingerprint: string;
  readonly state: SummaryState;
  readonly error: string | null;
  readonly attemptCount: number;
  readonly retryAfter: string | null;
  readonly updatedAt: string;
}

const decodeTurnIds = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

const toRecord = (row: SummaryRow): SummaryRecord => ({
  childThreadId: row.childThreadId,
  parentEnvironmentId: row.parentEnvironmentId,
  parentThreadId: row.parentThreadId,
  sourceTurnId: row.sourceTurnId,
  completedAt: row.completedAt,
  text: safeSummaryText(row.text),
  source: row.source,
  sourceTurnIds: Option.getOrElse(
    decodeTurnIds(row.sourceTurnIdsJson),
    () => [] as ReadonlyArray<string>,
  ),
  watermark: row.watermark,
  contentFingerprint: row.contentFingerprint,
  state: row.state,
  error: row.error === null ? null : safeSummaryText(row.error),
  attemptCount: row.attemptCount,
  retryAfter: row.retryAfter,
  updatedAt: row.updatedAt,
});

const mapError =
  (operation: string) =>
  <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, DelegatedTaskSummaryRepositoryError> =>
    effect.pipe(
      Effect.mapError((cause) => new DelegatedTaskSummaryRepositoryError({ operation, cause })),
    );

export class DelegatedTaskSummaryRepository extends Context.Service<
  DelegatedTaskSummaryRepository,
  {
    readonly getByTurn: (input: {
      readonly childThreadId: string;
      readonly sourceTurnId: string;
    }) => Effect.Effect<SummaryRecord | null, DelegatedTaskSummaryRepositoryError>;
    readonly getLatestByChild: (
      childThreadId: string,
    ) => Effect.Effect<SummaryRecord | null, DelegatedTaskSummaryRepositoryError>;
    readonly getLatestBefore: (input: {
      readonly childThreadId: string;
      readonly sourceTurnId: string;
      readonly completedAt: string;
    }) => Effect.Effect<SummaryRecord | null, DelegatedTaskSummaryRepositoryError>;
    readonly listPending: () => Effect.Effect<
      ReadonlyArray<SummaryRecord>,
      DelegatedTaskSummaryRepositoryError
    >;
    readonly currentWatermark: (
      childThreadId: string,
    ) => Effect.Effect<number, DelegatedTaskSummaryRepositoryError>;
    readonly listHistory: (input: {
      readonly parentThreadId: string;
      readonly cursor?: {
        readonly completedAt: string;
        readonly childThreadId: string;
        readonly sourceTurnId: string;
      };
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<SummaryHistoryRow>, DelegatedTaskSummaryRepositoryError>;
    readonly insertPending: (
      row: SummaryRecord,
    ) => Effect.Effect<void, DelegatedTaskSummaryRepositoryError>;
    readonly claimGeneration: (input: {
      readonly childThreadId: string;
      readonly sourceTurnId: string;
      readonly retryAfter: string;
      readonly updatedAt: string;
    }) => Effect.Effect<boolean, DelegatedTaskSummaryRepositoryError>;
    readonly complete: (input: {
      readonly childThreadId: string;
      readonly sourceTurnId: string;
      readonly text: string;
      readonly source: SummarySource;
      readonly sourceTurnIds: ReadonlyArray<string>;
      readonly watermark: number;
      readonly contentFingerprint: string;
      readonly updatedAt: string;
    }) => Effect.Effect<void, DelegatedTaskSummaryRepositoryError>;
    readonly fail: (input: {
      readonly childThreadId: string;
      readonly sourceTurnId: string;
      readonly error: string;
      readonly retryAfter: string | null;
      readonly final: boolean;
      readonly updatedAt: string;
    }) => Effect.Effect<void, DelegatedTaskSummaryRepositoryError>;
  }
>()("@t3tools/ft3-orchestration/DelegatedTaskSummaryRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const one = <E>(query: Effect.Effect<ReadonlyArray<SummaryRow>, E>, operation: string) =>
    query.pipe(
      Effect.mapError((cause) => new DelegatedTaskSummaryRepositoryError({ operation, cause })),
      Effect.map((rows) => (rows[0] === undefined ? null : toRecord(rows[0]))),
    );

  return DelegatedTaskSummaryRepository.of({
    getByTurn: Effect.fn("DelegatedTaskSummaryRepository.getByTurn")(
      ({ childThreadId, sourceTurnId }) =>
        one(
          sql<SummaryRow>`SELECT child_thread_id AS "childThreadId", parent_environment_id AS "parentEnvironmentId", parent_thread_id AS "parentThreadId", source_turn_id AS "sourceTurnId", completed_at AS "completedAt", summary_text AS text, source, source_turn_ids_json AS "sourceTurnIdsJson", watermark, content_fingerprint AS "contentFingerprint", state, error, attempt_count AS "attemptCount", retry_after AS "retryAfter", updated_at AS "updatedAt" FROM ft3_delegated_task_summaries
            WHERE child_thread_id = ${childThreadId} AND source_turn_id = ${sourceTurnId}`,
          "getByTurn",
        ),
    ),
    getLatestByChild: Effect.fn("DelegatedTaskSummaryRepository.getLatestByChild")(
      (childThreadId) =>
        one(
          sql<SummaryRow>`SELECT child_thread_id AS "childThreadId", parent_environment_id AS "parentEnvironmentId", parent_thread_id AS "parentThreadId", source_turn_id AS "sourceTurnId", completed_at AS "completedAt", summary_text AS text, source, source_turn_ids_json AS "sourceTurnIdsJson", watermark, content_fingerprint AS "contentFingerprint", state, error, attempt_count AS "attemptCount", retry_after AS "retryAfter", updated_at AS "updatedAt" FROM ft3_delegated_task_summaries
            WHERE child_thread_id = ${childThreadId}
            ORDER BY completed_at DESC, source_turn_id DESC LIMIT 1`,
          "getLatestByChild",
        ),
    ),
    getLatestBefore: Effect.fn("DelegatedTaskSummaryRepository.getLatestBefore")(
      ({ childThreadId, sourceTurnId, completedAt }) =>
        one(
          sql<SummaryRow>`SELECT child_thread_id AS "childThreadId", parent_environment_id AS "parentEnvironmentId", parent_thread_id AS "parentThreadId", source_turn_id AS "sourceTurnId", completed_at AS "completedAt", summary_text AS text, source, source_turn_ids_json AS "sourceTurnIdsJson", watermark, content_fingerprint AS "contentFingerprint", state, error, attempt_count AS "attemptCount", retry_after AS "retryAfter", updated_at AS "updatedAt" FROM ft3_delegated_task_summaries
            WHERE child_thread_id = ${childThreadId} AND source_turn_id <> ${sourceTurnId}
              AND (completed_at < ${completedAt}
                OR (completed_at = ${completedAt} AND source_turn_id < ${sourceTurnId}))
            ORDER BY completed_at DESC, source_turn_id DESC LIMIT 1`,
          "getLatestBefore",
        ),
    ),
    listPending: Effect.fn("DelegatedTaskSummaryRepository.listPending")(() =>
      mapError("listPending")(
        sql<SummaryRow>`SELECT child_thread_id AS "childThreadId", parent_environment_id AS "parentEnvironmentId", parent_thread_id AS "parentThreadId", source_turn_id AS "sourceTurnId", completed_at AS "completedAt", summary_text AS text, source, source_turn_ids_json AS "sourceTurnIdsJson", watermark, content_fingerprint AS "contentFingerprint", state, error, attempt_count AS "attemptCount", retry_after AS "retryAfter", updated_at AS "updatedAt" FROM ft3_delegated_task_summaries
          WHERE state = 'pending'
          ORDER BY retry_after ASC, updated_at ASC, child_thread_id ASC, source_turn_id ASC
          LIMIT 500`,
      ).pipe(Effect.map((rows) => rows.map(toRecord))),
    ),
    currentWatermark: Effect.fn("DelegatedTaskSummaryRepository.currentWatermark")(
      (childThreadId) =>
        mapError("currentWatermark")(
          sql<{ readonly watermark: number }>`SELECT COALESCE(MAX(sequence), 0) AS watermark
          FROM orchestration_events
          WHERE aggregate_kind = 'thread' AND stream_id = ${childThreadId}`,
        ).pipe(Effect.map((rows) => rows[0]?.watermark ?? 0)),
    ),
    listHistory: Effect.fn("DelegatedTaskSummaryRepository.listHistory")(
      ({ parentThreadId, cursor, limit }) =>
        mapError("listHistory")(
          sql<SummaryHistoryRow>`SELECT
            s.child_thread_id AS "childThreadId",
            s.source_turn_id AS "sourceTurnId",
            s.completed_at AS "completedAt",
            s.summary_text AS "summaryText",
            s.state AS "summaryState",
            s.watermark AS "summaryWatermark",
            (SELECT t.provider_turn_id FROM orchestration_v2_projection_provider_turns t
              WHERE t.thread_id = s.child_thread_id ORDER BY t.ordinal DESC LIMIT 1) AS "currentTurnId",
            (SELECT t.status FROM orchestration_v2_projection_provider_turns t
              WHERE t.thread_id = s.child_thread_id ORDER BY t.ordinal DESC LIMIT 1) AS "currentTurnState",
            COALESCE((SELECT MAX(e.sequence) FROM orchestration_events e
              WHERE e.aggregate_kind = 'thread' AND e.stream_id = s.child_thread_id), 0) AS "currentWatermark"
          FROM ft3_delegated_task_summaries s
          WHERE s.parent_thread_id = ${parentThreadId}
            AND NOT EXISTS (
              SELECT 1 FROM orchestration_v2_projection_threads th
              WHERE th.thread_id = s.child_thread_id AND th.deleted_at IS NOT NULL
            )
            AND (
              ${cursor?.completedAt ?? null} IS NULL
              OR s.completed_at < ${cursor?.completedAt ?? null}
              OR (s.completed_at = ${cursor?.completedAt ?? null}
                AND s.child_thread_id < ${cursor?.childThreadId ?? null})
              OR (s.completed_at = ${cursor?.completedAt ?? null}
                AND s.child_thread_id = ${cursor?.childThreadId ?? null}
                AND s.source_turn_id < ${cursor?.sourceTurnId ?? null})
            )
          ORDER BY s.completed_at DESC, s.child_thread_id DESC, s.source_turn_id DESC
          LIMIT ${limit + 1}`,
        ),
    ),
    insertPending: Effect.fn("DelegatedTaskSummaryRepository.insertPending")((row) =>
      mapError("insertPending")(
        sql`INSERT INTO ft3_delegated_task_summaries (
            child_thread_id, parent_environment_id, parent_thread_id, source_turn_id, completed_at,
            summary_text, source, source_turn_ids_json, watermark, content_fingerprint, state,
            error, attempt_count, retry_after, updated_at
          ) VALUES (
            ${row.childThreadId}, ${row.parentEnvironmentId}, ${row.parentThreadId},
            ${row.sourceTurnId}, ${row.completedAt}, ${safeSummaryText(row.text)}, ${row.source},
            ${JSON.stringify(row.sourceTurnIds)}, ${row.watermark}, ${row.contentFingerprint},
            'pending', NULL, ${row.attemptCount}, ${row.retryAfter}, ${row.updatedAt}
          ) ON CONFLICT(child_thread_id, source_turn_id) DO NOTHING`,
      ).pipe(Effect.asVoid),
    ),
    claimGeneration: Effect.fn("DelegatedTaskSummaryRepository.claimGeneration")(
      ({ childThreadId, sourceTurnId, retryAfter, updatedAt }) =>
        mapError("claimGeneration")(
          sql<{ readonly childThreadId: string }>`
          UPDATE ft3_delegated_task_summaries
          SET attempt_count = attempt_count + 1, retry_after = ${retryAfter}, updated_at = ${updatedAt}
          WHERE child_thread_id = ${childThreadId} AND source_turn_id = ${sourceTurnId}
            AND attempt_count < ${MAX_SUMMARY_ATTEMPTS}
            AND (
              (state = 'pending' AND attempt_count = 0)
              OR (retry_after IS NOT NULL AND retry_after < ${updatedAt})
              OR (state = 'error' AND retry_after IS NULL)
            )
          RETURNING child_thread_id AS "childThreadId"`,
        ).pipe(Effect.map((rows) => rows.length > 0)),
    ),
    complete: Effect.fn("DelegatedTaskSummaryRepository.complete")((input) =>
      mapError("complete")(
        sql`UPDATE ft3_delegated_task_summaries SET
            summary_text = ${safeSummaryText(input.text)}, source = ${input.source},
            source_turn_ids_json = ${JSON.stringify(input.sourceTurnIds)},
            watermark = ${input.watermark}, content_fingerprint = ${input.contentFingerprint},
            state = 'ready', error = NULL, retry_after = NULL, updated_at = ${input.updatedAt}
          WHERE child_thread_id = ${input.childThreadId} AND source_turn_id = ${input.sourceTurnId}`,
      ).pipe(Effect.asVoid),
    ),
    fail: Effect.fn("DelegatedTaskSummaryRepository.fail")((input) =>
      mapError("fail")(
        sql`UPDATE ft3_delegated_task_summaries SET
            state = ${input.final ? "error" : "pending"}, error = ${safeSummaryText(input.error)},
            retry_after = ${input.retryAfter}, updated_at = ${input.updatedAt}
          WHERE child_thread_id = ${input.childThreadId} AND source_turn_id = ${input.sourceTurnId}`,
      ).pipe(Effect.asVoid),
    ),
  });
});

export const layer = Layer.effect(DelegatedTaskSummaryRepository, make);

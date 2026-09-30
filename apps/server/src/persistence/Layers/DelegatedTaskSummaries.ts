import {
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TurnId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Struct from "effect/Struct";

import { scrubDelegatedTaskText } from "../../DelegatedTaskMemoryText.ts";
import {
  DelegatedTaskSummaryRepository,
  DelegatedTaskSummaryRepositoryError,
  type DelegatedTaskSummaryRecord,
  type DelegatedTaskSummaryRepositoryShape,
} from "../Services/DelegatedTaskSummaries.ts";

const TurnLookup = Schema.Struct({ childThreadId: ThreadId, sourceTurnId: TurnId });
const ChildLookup = Schema.Struct({ childThreadId: ThreadId });
const LatestBeforeLookup = Schema.Struct({
  childThreadId: ThreadId,
  sourceTurnId: TurnId,
  completedAt: IsoDateTime,
});
const ParentLookup = Schema.Struct({
  parentEnvironmentId: Schema.String,
  parentThreadId: ThreadId,
});
const SummaryRow = Schema.Struct({
  childThreadId: ThreadId,
  parentEnvironmentId: Schema.String,
  parentThreadId: ThreadId,
  sourceTurnId: TurnId,
  completedAt: IsoDateTime,
  text: Schema.String,
  source: Schema.Literals(["model", "deterministic"]),
  sourceTurnIds: Schema.Array(TurnId),
  watermark: NonNegativeInt,
  contentFingerprint: TrimmedNonEmptyString,
  state: Schema.Literals(["pending", "ready", "error"]),
  error: Schema.NullOr(Schema.String),
  attemptCount: NonNegativeInt,
  retryAfter: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});
const DbSummaryRow = SummaryRow.mapFields(
  Struct.assign({ sourceTurnIds: Schema.fromJsonString(Schema.Array(TurnId)) }),
);
const insertInput = SummaryRow;
const attemptInput = Schema.Struct({
  childThreadId: ThreadId,
  sourceTurnId: TurnId,
  retryAfter: IsoDateTime,
  updatedAt: IsoDateTime,
});
const ClaimedGenerationRow = Schema.Struct({ childThreadId: ThreadId });
const completeInput = Schema.Struct({
  childThreadId: ThreadId,
  sourceTurnId: TurnId,
  text: Schema.String,
  source: Schema.Literals(["model", "deterministic"]),
  sourceTurnIds: Schema.Array(TurnId),
  watermark: NonNegativeInt,
  contentFingerprint: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});
const failInput = Schema.Struct({
  childThreadId: ThreadId,
  sourceTurnId: TurnId,
  error: Schema.String,
  retryAfter: Schema.NullOr(IsoDateTime),
  final: Schema.Boolean,
  updatedAt: IsoDateTime,
});

const toRepositoryError =
  (operation: string) =>
  (cause: unknown): DelegatedTaskSummaryRepositoryError =>
    new DelegatedTaskSummaryRepositoryError({ operation, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const selectByTurn = SqlSchema.findOneOption({
    Request: TurnLookup,
    Result: DbSummaryRow,
    execute: ({ childThreadId, sourceTurnId }) => sql`
      SELECT child_thread_id AS "childThreadId", parent_environment_id AS "parentEnvironmentId",
        parent_thread_id AS "parentThreadId", source_turn_id AS "sourceTurnId", completed_at AS "completedAt",
        summary_text AS text, source, source_turn_ids_json AS "sourceTurnIds", watermark,
        content_fingerprint AS "contentFingerprint", state, error, attempt_count AS "attemptCount",
        retry_after AS "retryAfter", updated_at AS "updatedAt"
      FROM projection_delegated_task_summaries
      WHERE child_thread_id = ${childThreadId} AND source_turn_id = ${sourceTurnId}
    `,
  });
  const selectLatestByChild = SqlSchema.findOneOption({
    Request: ChildLookup,
    Result: DbSummaryRow,
    execute: ({ childThreadId }) => sql`
      SELECT child_thread_id AS "childThreadId", parent_environment_id AS "parentEnvironmentId",
        parent_thread_id AS "parentThreadId", source_turn_id AS "sourceTurnId", completed_at AS "completedAt",
        summary_text AS text, source, source_turn_ids_json AS "sourceTurnIds", watermark,
        content_fingerprint AS "contentFingerprint", state, error, attempt_count AS "attemptCount",
        retry_after AS "retryAfter", updated_at AS "updatedAt"
      FROM projection_delegated_task_summaries
      WHERE child_thread_id = ${childThreadId}
      ORDER BY completed_at DESC, source_turn_id DESC
      LIMIT 1
    `,
  });
  const selectLatestBefore = SqlSchema.findOneOption({
    Request: LatestBeforeLookup,
    Result: DbSummaryRow,
    execute: ({ childThreadId, sourceTurnId, completedAt }) => sql`
      SELECT child_thread_id AS "childThreadId", parent_environment_id AS "parentEnvironmentId",
        parent_thread_id AS "parentThreadId", source_turn_id AS "sourceTurnId", completed_at AS "completedAt",
        summary_text AS text, source, source_turn_ids_json AS "sourceTurnIds", watermark,
        content_fingerprint AS "contentFingerprint", state, error, attempt_count AS "attemptCount",
        retry_after AS "retryAfter", updated_at AS "updatedAt"
      FROM projection_delegated_task_summaries
      WHERE child_thread_id = ${childThreadId} AND source_turn_id <> ${sourceTurnId}
        AND (completed_at < ${completedAt} OR (completed_at = ${completedAt} AND source_turn_id < ${sourceTurnId}))
      ORDER BY completed_at DESC, source_turn_id DESC
      LIMIT 1
    `,
  });
  const selectByParent = SqlSchema.findAll({
    Request: ParentLookup,
    Result: DbSummaryRow,
    execute: ({ parentEnvironmentId, parentThreadId }) => sql`
      SELECT child_thread_id AS "childThreadId", parent_environment_id AS "parentEnvironmentId",
        parent_thread_id AS "parentThreadId", source_turn_id AS "sourceTurnId", completed_at AS "completedAt",
        summary_text AS text, source, source_turn_ids_json AS "sourceTurnIds", watermark,
        content_fingerprint AS "contentFingerprint", state, error, attempt_count AS "attemptCount",
        retry_after AS "retryAfter", updated_at AS "updatedAt"
      FROM projection_delegated_task_summaries
      WHERE parent_environment_id = ${parentEnvironmentId} AND parent_thread_id = ${parentThreadId}
      ORDER BY completed_at DESC, source_turn_id DESC
    `,
  });
  const selectPending = SqlSchema.findAll({
    Request: Schema.Void,
    Result: DbSummaryRow,
    execute: () => sql`
      SELECT child_thread_id AS "childThreadId", parent_environment_id AS "parentEnvironmentId",
        parent_thread_id AS "parentThreadId", source_turn_id AS "sourceTurnId", completed_at AS "completedAt",
        summary_text AS text, source, source_turn_ids_json AS "sourceTurnIds", watermark,
        content_fingerprint AS "contentFingerprint", state, error, attempt_count AS "attemptCount",
        retry_after AS "retryAfter", updated_at AS "updatedAt"
      FROM projection_delegated_task_summaries
      WHERE state = 'pending'
      ORDER BY retry_after ASC, updated_at ASC, child_thread_id ASC, source_turn_id ASC
      LIMIT 500
    `,
  });
  const insertPending = SqlSchema.void({
    Request: insertInput,
    execute: (row) => sql`
      INSERT INTO projection_delegated_task_summaries (
        child_thread_id, parent_environment_id, parent_thread_id, source_turn_id, completed_at,
        summary_text, source, source_turn_ids_json, watermark, content_fingerprint, state,
        error, attempt_count, retry_after, updated_at
      ) VALUES (
        ${row.childThreadId}, ${row.parentEnvironmentId}, ${row.parentThreadId}, ${row.sourceTurnId},
        ${row.completedAt}, ${row.text}, ${row.source}, ${JSON.stringify(row.sourceTurnIds)}, ${row.watermark},
        ${row.contentFingerprint}, 'pending', NULL, ${row.attemptCount}, ${row.retryAfter}, ${row.updatedAt}
      ) ON CONFLICT(child_thread_id, source_turn_id) DO NOTHING
    `,
  });
  const claimGenerationRow = SqlSchema.findOneOption({
    Request: attemptInput,
    Result: ClaimedGenerationRow,
    execute: ({ childThreadId, sourceTurnId, retryAfter, updatedAt }) => sql`
      UPDATE projection_delegated_task_summaries
      SET attempt_count = attempt_count + 1, retry_after = ${retryAfter}, updated_at = ${updatedAt}
      WHERE child_thread_id = ${childThreadId} AND source_turn_id = ${sourceTurnId}
        AND state = 'pending' AND attempt_count = 0
      RETURNING child_thread_id AS "childThreadId"
    `,
  });
  const updateComplete = SqlSchema.void({
    Request: completeInput,
    execute: (row) => sql`
      UPDATE projection_delegated_task_summaries SET
        summary_text = ${row.text}, source = ${row.source}, source_turn_ids_json = ${JSON.stringify(row.sourceTurnIds)},
        watermark = ${row.watermark}, content_fingerprint = ${row.contentFingerprint}, state = 'ready',
        error = NULL, retry_after = NULL, updated_at = ${row.updatedAt}
      WHERE child_thread_id = ${row.childThreadId} AND source_turn_id = ${row.sourceTurnId}
    `,
  });
  const updateFailure = SqlSchema.void({
    Request: failInput,
    execute: (row) => sql`
      UPDATE projection_delegated_task_summaries SET
        state = ${row.final ? "error" : "pending"}, error = ${row.error}, retry_after = ${row.retryAfter},
        updated_at = ${row.updatedAt}
      WHERE child_thread_id = ${row.childThreadId} AND source_turn_id = ${row.sourceTurnId}
    `,
  });

  const mapRead = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError(toRepositoryError(operation)));
  const mapRecord = (row: typeof DbSummaryRow.Type): DelegatedTaskSummaryRecord => ({
    ...row,
    text: scrubDelegatedTaskText(row.text),
    error: row.error === null ? null : scrubDelegatedTaskText(row.error),
  });
  const getByTurn: DelegatedTaskSummaryRepositoryShape["getByTurn"] = (input) =>
    mapRead("getByTurn", selectByTurn(input)).pipe(
      Effect.map(Option.match({ onNone: () => null, onSome: mapRecord })),
    );
  const getLatestByChild: DelegatedTaskSummaryRepositoryShape["getLatestByChild"] = (
    childThreadId,
  ) =>
    mapRead("getLatestByChild", selectLatestByChild({ childThreadId })).pipe(
      Effect.map(Option.match({ onNone: () => null, onSome: mapRecord })),
    );
  const getLatestBefore: DelegatedTaskSummaryRepositoryShape["getLatestBefore"] = (input) =>
    mapRead("getLatestBefore", selectLatestBefore(input)).pipe(
      Effect.map(Option.match({ onNone: () => null, onSome: mapRecord })),
    );
  const listByParent: DelegatedTaskSummaryRepositoryShape["listByParent"] = (input) =>
    mapRead("listByParent", selectByParent(input)).pipe(Effect.map((rows) => rows.map(mapRecord)));
  const listPending: DelegatedTaskSummaryRepositoryShape["listPending"] = () =>
    mapRead("listPending", selectPending()).pipe(Effect.map((rows) => rows.map(mapRecord)));
  const wrap = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.asVoid, Effect.mapError(toRepositoryError(operation)));

  return {
    getByTurn,
    getLatestByChild,
    getLatestBefore,
    listByParent,
    listPending,
    insertPending: (row) =>
      wrap(
        "insertPending",
        insertPending({
          ...row,
          text: scrubDelegatedTaskText(row.text),
          error: row.error === null ? null : scrubDelegatedTaskText(row.error),
        }),
      ),
    claimGeneration: (input) =>
      mapRead("claimGeneration", claimGenerationRow(input)).pipe(Effect.map(Option.isSome)),
    complete: (input) =>
      wrap("complete", updateComplete({ ...input, text: scrubDelegatedTaskText(input.text) })),
    fail: (input) =>
      wrap("fail", updateFailure({ ...input, error: scrubDelegatedTaskText(input.error) })),
  } satisfies DelegatedTaskSummaryRepositoryShape;
});

export const DelegatedTaskSummaryRepositoryLive = Layer.effect(
  DelegatedTaskSummaryRepository,
  make,
);

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  DELEGATION_CREATED_KIND,
  isLiveDatabasePath,
  LiveDatabaseRefusedError,
  LIVE_DATABASE_PATH,
  STAGING_TABLE,
} from "./prepareLegacyDatabase.ts";

export const SUBAGENT_ID_PREFIX = "ft3:";
export const SUBAGENT_NODE_PREFIX = "ft3:node:";
export const SUBAGENT_ORIGIN = "app_owned";
export const SUBAGENT_STATUS = "completed";
export const FALLBACK_PROVIDER_INSTANCE_ID = "legacy";
export const FALLBACK_DRIVER_KIND = "native";

export interface ImportCount {
  readonly source: number;
  readonly target: number;
  readonly skipped: number;
}

export interface ImportResult {
  readonly boardOrchestrators: ImportCount;
  readonly boardCards: ImportCount;
  readonly boardCardEvents: ImportCount;
  readonly boardCardDeletions: ImportCount;
  readonly architectBindings: ImportCount;
  readonly architectReviews: ImportCount;
  readonly taskSummaries: ImportCount;
  readonly scheduledTasks: ImportCount;
  readonly subagents: ImportCount;
  readonly lineageRestored: number;
}

interface StagingRow {
  readonly thread_id: string;
  readonly created_at: string;
  readonly payload_json: string;
}

interface CalendarRow {
  readonly event_id: string;
  readonly project_id: string;
  readonly title: string;
  readonly message: string;
  readonly cron_expression: string;
  readonly next_fire_at: string;
  readonly last_fired_at: string | null;
  readonly thread_id: string | null;
  readonly model_selection_json: string;
  readonly runtime_mode: string;
  readonly interaction_mode: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const JsonCodec = Schema.fromJsonString(Schema.Unknown);

const parseJson = (json: string): Record<string, unknown> | null => {
  const decoded = Schema.decodeOption(JsonCodec)(json);
  const value = Option.getOrNull(decoded);
  return isRecord(value) ? value : null;
};

const encodeJson = (value: unknown): string => Schema.encodeSync(JsonCodec)(value);

const isSlug = (value: string): boolean => /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value);

const validIso = (value: string): boolean => !Number.isNaN(Date.parse(value));

const slugOr = (value: unknown, fallback: string): string =>
  typeof value === "string" && isSlug(value) ? value : fallback;

// Daily fixed-time events only; other cron shapes stay skipped for a human to reconcile.
const fixedTimeOfDay = (cron: string): string | null => {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = fields[0];
  const hour = fields[1];
  const dom = fields[2];
  const month = fields[3];
  const dow = fields[4];
  if (
    minute === undefined ||
    hour === undefined ||
    dom === undefined ||
    month === undefined ||
    dow === undefined
  ) {
    return null;
  }
  if (dom !== "*" || month !== "*" || dow !== "*") return null;
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
};

export const importLegacyDataSql = Effect.fn("importLegacyDataSql")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const count = (table: string) =>
        sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM ${sql(table)}`.pipe(
          Effect.map((rows) => rows[0]?.count ?? 0),
        );

      yield* sql`INSERT OR IGNORE INTO ft3_board_orchestrators (thread_id, created_by, created_at)
        SELECT thread_id, created_by, created_at FROM board_orchestrators`;
      yield* sql`INSERT OR IGNORE INTO ft3_board_cards (
          card_id, orchestrator_thread_id, title, body, status, created_by, assignee_json,
          executor_role, executor_thread_id, outcome, last_error, failure_streak, order_index,
          archived, created_at, updated_at, readiness, readiness_note
        )
        SELECT card_id, orchestrator_thread_id, title, body, status, created_by, assignee_json,
          executor_role, executor_thread_id, outcome, last_error, failure_streak, order_index,
          archived, created_at, updated_at, readiness, readiness_note
        FROM board_cards`;
      yield* sql`INSERT OR IGNORE INTO ft3_board_card_events (
          entry_id, card_id, at, status, executor_role, model, effort, body, source
        )
        SELECT entry_id, card_id, at, status, executor_role, model, effort, body, source
        FROM board_card_events`;
      yield* sql`INSERT OR IGNORE INTO ft3_board_card_deletions (
          card_id, orchestrator_thread_id, deleted_at, reason, history_event_count
        )
        SELECT card_id, orchestrator_thread_id, deleted_at, reason, history_event_count
        FROM board_card_deletions`;
      yield* sql`INSERT OR IGNORE INTO ft3_architect_binding (
          binding_id, coordinator_thread_id, architect_thread_id, project_id,
          architect_task_effort, status, created_at, created_by, replaced_by_binding_id,
          detach_reason, create_idempotency_key, create_request_fingerprint,
          close_idempotency_key, close_request_fingerprint, routing_evidence_json
        )
        SELECT binding_id, coordinator_thread_id, architect_thread_id, project_id,
          architect_task_effort, status, created_at, created_by, replaced_by_binding_id,
          detach_reason, create_idempotency_key, create_request_fingerprint,
          close_idempotency_key, close_request_fingerprint, routing_evidence_json
        FROM coordinator_architect_binding`;
      yield* sql`INSERT OR IGNORE INTO ft3_architect_review (
          review_id, binding_id, coordinator_thread_id, architect_thread_id,
          subject_child_thread_id, reason, question, refs_json, execution_posture,
          answer_disposition, status, answer_summary, request_idempotency_key,
          answer_idempotency_key, answer_payload_fingerprint, request_payload_fingerprint,
          publish_idempotency_key, cancel_idempotency_key, cancel_payload_fingerprint,
          cancelled_at, cancelled_by, created_at, answered_at, published_at,
          publish_delivered_at, last_publish_failure_reason, last_publish_failure_message,
          last_publish_failure_at, origin, published_by
        )
        SELECT review_id, binding_id, coordinator_thread_id, architect_thread_id,
          subject_child_thread_id, reason, question, refs_json, execution_posture,
          answer_disposition, status, answer_summary, request_idempotency_key,
          answer_idempotency_key, answer_payload_fingerprint, request_payload_fingerprint,
          publish_idempotency_key, cancel_idempotency_key, cancel_payload_fingerprint,
          cancelled_at, cancelled_by, created_at, answered_at, published_at,
          publish_delivered_at, last_publish_failure_reason, last_publish_failure_message,
          last_publish_failure_at, origin, published_by
        FROM architecture_review`;
      yield* sql`INSERT OR IGNORE INTO ft3_delegated_task_summaries (
          child_thread_id, parent_environment_id, parent_thread_id, source_turn_id,
          completed_at, summary_text, source, source_turn_ids_json, watermark,
          content_fingerprint, state, error, attempt_count, retry_after, updated_at
        )
        SELECT child_thread_id, parent_environment_id, parent_thread_id, source_turn_id,
          completed_at, summary_text, source, source_turn_ids_json, watermark,
          content_fingerprint, state, error, attempt_count, retry_after, updated_at
        FROM projection_delegated_task_summaries`;

      const calendarRows = yield* sql<CalendarRow>`
        SELECT
          event_id,
          project_id,
          title,
          message,
          cron_expression,
          next_fire_at,
          last_fired_at,
          thread_id,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          created_at,
          updated_at
        FROM calendar_events
        ORDER BY event_id`;
      let scheduledSkipped = 0;
      for (const row of calendarRows) {
        const timeOfDay = fixedTimeOfDay(row.cron_expression);
        if (timeOfDay === null) {
          scheduledSkipped += 1;
          continue;
        }
        const schedule = { type: "fixed_time", timeOfDay };
        const lastRunStatus = row.last_fired_at === null ? "never" : "succeeded";
        yield* sql`
          INSERT INTO scheduled_tasks (
            task_id, title, prompt, enabled, schedule_json, project_id, thread_id,
            workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
            created_by, creation_source, created_at, updated_at, next_run_at, last_run_at,
            last_run_status, last_run_error, run_count
          )
          VALUES (
            ${row.event_id}, ${row.title}, ${row.message}, 1, ${encodeJson(schedule)},
            ${row.project_id}, ${row.thread_id}, ${encodeJson({ type: "root" })},
            ${row.model_selection_json}, ${row.runtime_mode}, ${row.interaction_mode},
            'system', 'server', ${row.created_at}, ${row.updated_at}, ${row.next_fire_at},
            ${row.last_fired_at}, ${lastRunStatus}, NULL, 0
          )
          ON CONFLICT(task_id) DO NOTHING`;
      }

      const stagingRows = yield* sql<StagingRow>`
        SELECT thread_id, created_at, payload_json FROM ${sql(STAGING_TABLE)}`;
      const threadRows = yield* sql<{
        readonly thread_id: string;
        readonly root_thread_id: string | null;
      }>`
        SELECT thread_id,
          json_extract(payload_json, '$.lineage.rootThreadId') AS root_thread_id
        FROM orchestration_v2_projection_threads`;
      const existingThreads = new Set(threadRows.map((row) => row.thread_id));
      const rootThreadIdByThreadId = new Map(
        threadRows.map((row) => [row.thread_id, row.root_thread_id ?? row.thread_id] as const),
      );
      const parentByChildThreadId = new Map<string, string>();
      for (const row of stagingRows) {
        const payload = parseJson(row.payload_json);
        const childThreadId =
          typeof payload?.childThreadId === "string" ? payload.childThreadId : row.thread_id;
        const parentThreadId =
          typeof payload?.parentThreadId === "string" ? payload.parentThreadId : null;
        if (
          parentThreadId !== null &&
          existingThreads.has(childThreadId) &&
          existingThreads.has(parentThreadId)
        ) {
          parentByChildThreadId.set(childThreadId, parentThreadId);
        }
      }
      const familyRootFor = (childThreadId: string, parentThreadId: string): string | null => {
        let current = parentThreadId;
        const seen = new Set([childThreadId]);
        while (true) {
          if (seen.has(current)) return null;
          seen.add(current);
          const parent = parentByChildThreadId.get(current);
          if (parent === undefined) return rootThreadIdByThreadId.get(current) ?? current;
          current = parent;
        }
      };
      let subagentSkipped = 0;
      let lineageRestored = 0;
      for (const row of stagingRows) {
        const payload = parseJson(row.payload_json);
        const childThreadId =
          typeof payload?.childThreadId === "string" ? payload.childThreadId : row.thread_id;
        const parentThreadId =
          typeof payload?.parentThreadId === "string" ? payload.parentThreadId : null;
        if (
          parentThreadId === null ||
          !existingThreads.has(childThreadId) ||
          !existingThreads.has(parentThreadId)
        ) {
          subagentSkipped += 1;
          continue;
        }
        const rootThreadId = familyRootFor(childThreadId, parentThreadId);
        if (rootThreadId === null) {
          subagentSkipped += 1;
          continue;
        }
        const requested = isRecord(payload?.requested) ? payload.requested : {};
        const providerInstanceId = slugOr(
          requested.providerInstanceId,
          FALLBACK_PROVIDER_INSTANCE_ID,
        );
        const driver = slugOr(requested.driverKind, FALLBACK_DRIVER_KIND);
        const model = typeof requested.model === "string" ? requested.model : null;
        const createdAt = validIso(row.created_at) ? row.created_at : "1970-01-01T00:00:00.000Z";
        const subagentId = `${SUBAGENT_ID_PREFIX}${childThreadId}`;
        const subagentPayload = {
          ...(payload ?? {}),
          id: subagentId,
          threadId: parentThreadId,
          runId: null,
          parentNodeId: `${SUBAGENT_NODE_PREFIX}${childThreadId}`,
          origin: SUBAGENT_ORIGIN,
          createdBy: "agent",
          driver,
          providerInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "",
          title: null,
          model,
          status: SUBAGENT_STATUS,
          result: null,
          startedAt: createdAt,
          completedAt: null,
          updatedAt: createdAt,
        };
        yield* sql`
          INSERT INTO orchestration_v2_projection_subagents (
            subagent_id, thread_id, run_id, parent_node_id, provider, driver,
            provider_instance_id, provider_thread_id, child_thread_id, origin, status,
            started_at, completed_at, updated_at, payload_json
          )
          VALUES (
            ${subagentId}, ${parentThreadId}, NULL, ${`${SUBAGENT_NODE_PREFIX}${childThreadId}`},
            ${providerInstanceId}, ${driver}, ${providerInstanceId}, NULL, ${childThreadId},
            ${SUBAGENT_ORIGIN}, ${SUBAGENT_STATUS}, ${createdAt}, NULL, ${createdAt},
            ${encodeJson(subagentPayload)}
          )
          ON CONFLICT(subagent_id) DO NOTHING`;
        yield* sql`
          UPDATE orchestration_v2_projection_threads
          SET payload_json = json_set(
            payload_json,
            '$.lineage.parentThreadId', ${parentThreadId},
            '$.lineage.relationshipToParent', 'subagent',
            '$.lineage.rootThreadId', ${rootThreadId}
          )
          WHERE thread_id = ${childThreadId}`;
        lineageRestored += 1;
      }

      const importedScheduled = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM scheduled_tasks
        WHERE task_id IN (SELECT event_id FROM calendar_events)`;
      const importedSubagents = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_v2_projection_subagents
        WHERE subagent_id LIKE ${SUBAGENT_ID_PREFIX + "%"}`;

      const boardOrchestrators = {
        source: yield* count("board_orchestrators"),
        target: yield* count("ft3_board_orchestrators"),
        skipped: 0,
      };
      const boardCards = {
        source: yield* count("board_cards"),
        target: yield* count("ft3_board_cards"),
        skipped: 0,
      };
      const boardCardEvents = {
        source: yield* count("board_card_events"),
        target: yield* count("ft3_board_card_events"),
        skipped: 0,
      };
      const boardCardDeletions = {
        source: yield* count("board_card_deletions"),
        target: yield* count("ft3_board_card_deletions"),
        skipped: 0,
      };
      const architectBindings = {
        source: yield* count("coordinator_architect_binding"),
        target: yield* count("ft3_architect_binding"),
        skipped: 0,
      };
      const architectReviews = {
        source: yield* count("architecture_review"),
        target: yield* count("ft3_architect_review"),
        skipped: 0,
      };
      const taskSummaries = {
        source: yield* count("projection_delegated_task_summaries"),
        target: yield* count("ft3_delegated_task_summaries"),
        skipped: 0,
      };
      const scheduledTasks = {
        source: yield* count("calendar_events"),
        target: importedScheduled[0]?.count ?? 0,
        skipped: scheduledSkipped,
      };
      const subagents = {
        source: yield* count(STAGING_TABLE),
        target: importedSubagents[0]?.count ?? 0,
        skipped: subagentSkipped,
      };

      return {
        boardOrchestrators,
        boardCards,
        boardCardEvents,
        boardCardDeletions,
        architectBindings,
        architectReviews,
        taskSummaries,
        scheduledTasks,
        subagents,
        lineageRestored,
      } satisfies ImportResult;
    }),
  );
});

export const importLegacyData = Effect.fn("importLegacyData")(function* (filename: string) {
  if (isLiveDatabasePath(filename)) {
    return yield* new LiveDatabaseRefusedError({ path: filename });
  }
  return yield* importLegacyDataSql();
});

export {
  DELEGATION_CREATED_KIND,
  isLiveDatabasePath,
  LiveDatabaseRefusedError,
  LIVE_DATABASE_PATH,
  STAGING_TABLE,
};

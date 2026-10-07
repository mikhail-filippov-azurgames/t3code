import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import Migration0066 from "./066_DelegationFollowUpLookupIndex.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

/**
 * Regression test for the `task_list` slow path: the `followups` probe inside
 * `listDelegatedTaskMemoryRowsQuery` (ProjectionSnapshotQuery) filtered on
 * `kind = 'delegation.follow-up-queued'`, but no partial index covered that
 * kind, so every per-thread probe walked all activity rows of the thread and
 * pulled each full `payload_json` (~97% of the query time on a live database).
 */
layer("066_DelegationFollowUpLookupIndex", (it) => {
  it.effect("covers the follow-up-queued probe without changing its result", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 66 });

      const created = yield* sql<{ readonly name: string; readonly sql: string | null }>`
        SELECT name, sql FROM sqlite_master
        WHERE type = 'index'
          AND name = 'idx_projection_activities_delegation_follow_up_lookup'
      `;
      assert.strictEqual(created.length, 1);
      assert.ok(
        created[0]!.sql?.includes("WHERE kind = 'delegation.follow-up-queued'"),
        `expected a partial index, got: ${created[0]!.sql}`,
      );

      const applied = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM effect_sql_migrations WHERE migration_id = 66
      `;
      assert.equal(applied.length, 1);

      yield* sql`
        INSERT INTO projection_thread_activities
          (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence)
        VALUES
          ('f-created-1', 'child-1', NULL, 'system', 'delegation.created', 'created',
           '{"parentEnvironmentId":"env-1","parentThreadId":"parent-1","childThreadId":"child-1"}',
           '2026-10-01T00:00:00Z', 1),
          ('f-followup-1', 'child-1', NULL, 'system', 'delegation.follow-up-queued', 'follow-up',
           '{"parentEnvironmentId":"env-1","parentThreadId":"parent-1","result":{"messageId":"msg-1"}}',
           '2026-10-01T00:00:01Z', 2),
          ('f-followup-2', 'child-1', NULL, 'system', 'delegation.follow-up-queued', 'follow-up',
           '{"parentEnvironmentId":"env-1","parentThreadId":"parent-1","result":{"messageId":"msg-2"}}',
           '2026-10-01T00:00:02Z', 3),
          ('f-followup-stale-parent', 'child-1', NULL, 'system', 'delegation.follow-up-queued', 'follow-up',
           '{"parentEnvironmentId":"env-9","parentThreadId":"parent-9","result":{"messageId":"msg-stale"}}',
           '2026-10-01T00:00:03Z', 4),
          ('f-followup-other-parent', 'child-2', NULL, 'system', 'delegation.follow-up-queued', 'follow-up',
           '{"parentEnvironmentId":"env-9","parentThreadId":"parent-9","result":{"messageId":"msg-9"}}',
           '2026-10-01T00:00:04Z', 1),
          ('f-noise-1', 'child-1', NULL, 'user', 'message.created', 'noise',
           '{"text":"noise"}',
           '2026-10-01T00:00:05Z', 5)
      `;

      const explainFollowups = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT activity.thread_id,
          json_extract(activity.payload_json, '$.result.messageId') AS message_id
        FROM projection_thread_activities activity
        WHERE activity.activity_id = (
          SELECT latest.activity_id
          FROM projection_thread_activities latest
          WHERE latest.thread_id = activity.thread_id
            AND latest.kind = 'delegation.follow-up-queued'
            AND json_extract(latest.payload_json, '$.parentEnvironmentId') = 'env-1'
            AND json_extract(latest.payload_json, '$.parentThreadId') = 'parent-1'
          ORDER BY latest.sequence DESC, latest.created_at DESC, latest.activity_id DESC
          LIMIT 1
        )
      `;
      const afterDetails = explainFollowups.map((row) => row.detail);
      assert.ok(
        afterDetails.some((detail) =>
          detail.includes("idx_projection_activities_delegation_follow_up_lookup"),
        ),
        `expected the follow-up lookup index in the plan, got:\n${afterDetails.join("\n")}`,
      );
      assert.ok(
        afterDetails.every((detail) => !detail.includes("SCAN latest")),
        `the follow-up probe must not scan the table, got:\n${afterDetails.join("\n")}`,
      );

      const readFollowups = sql<{
        readonly threadId: string;
        readonly messageId: string | null;
      }>`
        SELECT activity.thread_id AS "threadId",
          json_extract(activity.payload_json, '$.result.messageId') AS "messageId"
        FROM projection_thread_activities activity
        WHERE activity.activity_id = (
          SELECT latest.activity_id
          FROM projection_thread_activities latest
          WHERE latest.thread_id = activity.thread_id
            AND latest.kind = 'delegation.follow-up-queued'
            AND json_extract(latest.payload_json, '$.parentEnvironmentId') = 'env-1'
            AND json_extract(latest.payload_json, '$.parentThreadId') = 'parent-1'
          ORDER BY latest.sequence DESC, latest.created_at DESC, latest.activity_id DESC
          LIMIT 1
        )
        ORDER BY activity.thread_id ASC
      `;
      const rowsWithIndex = yield* readFollowups;

      yield* sql`DROP INDEX idx_projection_activities_delegation_follow_up_lookup`;
      const beforePlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT latest.activity_id
        FROM projection_thread_activities latest
        WHERE latest.thread_id = 'child-1'
          AND latest.kind = 'delegation.follow-up-queued'
          AND json_extract(latest.payload_json, '$.parentEnvironmentId') = 'env-1'
          AND json_extract(latest.payload_json, '$.parentThreadId') = 'parent-1'
        ORDER BY latest.sequence DESC, latest.created_at DESC, latest.activity_id DESC
        LIMIT 1
      `;
      assert.ok(
        beforePlan.every(
          (row) => !row.detail.includes("idx_projection_activities_delegation_follow_up_lookup"),
        ),
      );
      const rowsWithoutIndex = yield* readFollowups;
      assert.deepStrictEqual(rowsWithoutIndex, rowsWithIndex);
      assert.deepStrictEqual(rowsWithIndex, [{ threadId: "child-1", messageId: "msg-2" }]);

      yield* Migration0066.pipe(Effect.provideService(SqlClient.SqlClient, sql));
      const restored = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index'
          AND name = 'idx_projection_activities_delegation_follow_up_lookup'
      `;
      assert.deepStrictEqual(
        restored.map((row) => row.name),
        ["idx_projection_activities_delegation_follow_up_lookup"],
      );
    }),
  );
});

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("069_DelegationLineageLookupIndex", (it) => {
  it.effect("seeks the latest delegation.created activity through the partial index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 69 });

      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT latest.activity_id
        FROM projection_thread_activities latest
        WHERE latest.thread_id = 'thread-1'
          AND latest.kind = 'delegation.created'
        ORDER BY latest.sequence DESC, latest.created_at DESC, latest.activity_id DESC
        LIMIT 1
      `;
      assert.isTrue(
        plan.some((row) =>
          row.detail.includes("idx_projection_activities_delegation_created_lookup"),
        ),
        plan.map((row) => row.detail).join("\n"),
      );
      assert.isFalse(plan.some((row) => row.detail.includes("TEMP B-TREE")));
    }),
  );
});

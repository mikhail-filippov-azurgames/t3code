import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrations } from "./migrations.ts";
import { PolicyUsageRecorder, sqlPolicyUsageRecorderLayer } from "./routing.ts";

const run = Migrator.make({});
const loader = Migrator.fromRecord(migrations);

const testLayer = sqlPolicyUsageRecorderLayer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

it.effect("10_PolicyUsage creates the delegation table and reruns empty", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE ft3_board_cards (card_id TEXT PRIMARY KEY)`;

    assert.deepStrictEqual(yield* run({ loader, table: "ft3_migrations" }), [[10, "PolicyUsage"]]);
    assert.deepStrictEqual(yield* run({ loader, table: "ft3_migrations" }), []);

    const columns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info('ft3_policy_delegations') ORDER BY cid
    `;
    assert.deepStrictEqual(
      columns.map((column) => column.name),
      [
        "usage_id",
        "delegation_id",
        "role",
        "level",
        "policy_revision",
        "policy_sha256",
        "outcome",
        "candidate_alias",
        "candidate_model",
        "candidate_level",
        "candidate_provider_instance_id",
        "candidate_provider_driver_kind",
        "recorded_at",
      ],
    );

    const cardColumns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info('ft3_board_cards') ORDER BY cid
    `;
    assert.deepStrictEqual(
      cardColumns.map((column) => column.name),
      ["card_id", "policy_snapshot_json"],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("10_PolicyUsage skips the board-card column when the board table is absent", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    assert.deepStrictEqual(yield* run({ loader, table: "ft3_migrations" }), [[10, "PolicyUsage"]]);
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'ft3_board_cards'`,
      [],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("10_PolicyUsage keeps a board-card table that already has the snapshot column", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE ft3_board_cards (
      card_id TEXT PRIMARY KEY,
      policy_snapshot_json TEXT
    )`;
    yield* sql`INSERT INTO ft3_board_cards VALUES ('card:one', '{"revision":1}')`;

    assert.deepStrictEqual(yield* run({ loader, table: "ft3_migrations" }), [[10, "PolicyUsage"]]);

    const cardColumns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info('ft3_board_cards') ORDER BY cid
    `;
    assert.deepStrictEqual(
      cardColumns.map((column) => column.name),
      ["card_id", "policy_snapshot_json"],
    );
    assert.deepStrictEqual(yield* sql`SELECT * FROM ft3_board_cards`, [
      { card_id: "card:one", policy_snapshot_json: '{"revision":1}' },
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("the SQL recorder persists selected and no-candidate entries", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* run({ loader, table: "ft3_migrations" });
    const recorder = yield* PolicyUsageRecorder;

    yield* recorder.record({
      delegationId: "delegation:selected",
      role: "implementation",
      level: "high",
      policy: { revision: 12, sha256: "a".repeat(64) },
      candidate: {
        alias: "S",
        provider: { instanceId: "inst:one", driverKind: "codex" },
        model: "model-one",
        level: "high",
        options: [],
      },
      outcome: "selected",
    });
    yield* recorder.record({
      delegationId: "delegation:none",
      role: "review",
      level: "low",
      policy: { revision: 13, sha256: null },
      candidate: null,
      outcome: "no_candidate",
    });

    const rows = yield* sql<{
      readonly delegationId: string;
      readonly role: string;
      readonly level: string;
      readonly policyRevision: number;
      readonly policySha256: string | null;
      readonly outcome: string;
      readonly candidateAlias: string | null;
      readonly candidateModel: string | null;
      readonly candidateLevel: string | null;
      readonly candidateInstance: string | null;
      readonly candidateDriver: string | null;
      readonly recordedAt: string;
    }>`SELECT delegation_id AS "delegationId", role, level,
        policy_revision AS "policyRevision", policy_sha256 AS "policySha256", outcome,
        candidate_alias AS "candidateAlias", candidate_model AS "candidateModel",
        candidate_level AS "candidateLevel",
        candidate_provider_instance_id AS "candidateInstance",
        candidate_provider_driver_kind AS "candidateDriver",
        recorded_at AS "recordedAt"
      FROM ft3_policy_delegations ORDER BY usage_id`;

    assert.equal(rows.length, 2);
    assert.deepStrictEqual(rows[0], {
      delegationId: "delegation:selected",
      role: "implementation",
      level: "high",
      policyRevision: 12,
      policySha256: "a".repeat(64),
      outcome: "selected",
      candidateAlias: "S",
      candidateModel: "model-one",
      candidateLevel: "high",
      candidateInstance: "inst:one",
      candidateDriver: "codex",
      recordedAt: rows[0]!.recordedAt,
    });
    assert.deepStrictEqual(rows[1], {
      delegationId: "delegation:none",
      role: "review",
      level: "low",
      policyRevision: 13,
      policySha256: null,
      outcome: "no_candidate",
      candidateAlias: null,
      candidateModel: null,
      candidateLevel: null,
      candidateInstance: null,
      candidateDriver: null,
      recordedAt: rows[1]!.recordedAt,
    });
    assert.isTrue(rows.every((row) => row.recordedAt.length > 0));
  }).pipe(Effect.provide(testLayer)),
);

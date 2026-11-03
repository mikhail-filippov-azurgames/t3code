import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrations } from "./migrations.ts";

const run = Migrator.make({});
const loader = Migrator.fromRecord(migrations);

it.effect("11_Mail creates the mail tables and reruns empty", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    assert.deepStrictEqual(yield* run({ loader, table: "ft3_migrations" }), [[11, "Mail"]]);
    assert.deepStrictEqual(yield* run({ loader, table: "ft3_migrations" }), []);

    const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'ft3_mail_%' ORDER BY name
    `;
    assert.deepStrictEqual(
      tables.map((table) => table.name),
      [
        "ft3_mail_deliveries",
        "ft3_mail_kind_feedback",
        "ft3_mail_letters",
        "ft3_mail_members",
        "ft3_mail_rounds",
        "ft3_mail_tasks",
        "ft3_mail_wakes",
      ],
    );

    const taskColumns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info('ft3_mail_tasks') ORDER BY cid
    `;
    assert.deepStrictEqual(
      taskColumns.map((column) => column.name),
      [
        "task_id",
        "title",
        "brief",
        "level",
        "card_id",
        "isolation",
        "runtime_mode",
        "interaction_mode",
        "response_budget_seconds",
        "status",
        "outcome",
        "summary",
        "created_by_thread_id",
        "client_request_id",
        "request_fingerprint",
        "created_at",
        "updated_at",
        "closed_at",
      ],
    );

    const letterColumns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info('ft3_mail_letters') ORDER BY cid
    `;
    assert.deepStrictEqual(
      letterColumns.map((column) => column.name),
      [
        "letter_id",
        "task_id",
        "sequence",
        "sender_thread_id",
        "recipient",
        "kind",
        "body",
        "reply_to_letter_id",
        "source_letter_id",
        "plan_phase",
        "plan_step",
        "plan_sha256",
        "plan_doc_id",
        "classifier_kind",
        "classifier_confidence",
        "kind_disputed",
        "lead_kind",
        "client_request_id",
        "request_fingerprint",
        "created_at",
      ],
    );

    const deliveryColumns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info('ft3_mail_deliveries') ORDER BY cid
    `;
    assert.deepStrictEqual(
      deliveryColumns.map((column) => column.name),
      [
        "delivery_id",
        "task_id",
        "letter_id",
        "member_id",
        "recipient",
        "participant_thread_id",
        "state",
        "delivered_at",
        "read_at",
        "answered_at",
        "created_at",
        "updated_at",
      ],
    );

    const roundColumns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info('ft3_mail_rounds') ORDER BY cid
    `;
    assert.deepStrictEqual(
      roundColumns.map((column) => column.name),
      ["round_id", "task_id", "round_number", "kind", "opened_at", "closed_at", "outcome"],
    );

    const wakeColumns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info('ft3_mail_wakes') ORDER BY cid
    `;
    assert.deepStrictEqual(
      wakeColumns.map((column) => column.name),
      [
        "wake_id",
        "task_id",
        "target_thread_id",
        "reason",
        "idempotency_key",
        "created_at",
        "delivered_at",
      ],
    );

    const feedbackColumns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info('ft3_mail_kind_feedback') ORDER BY cid
    `;
    assert.deepStrictEqual(
      feedbackColumns.map((column) => column.name),
      [
        "letter_id",
        "sender_kind",
        "classifier_kind",
        "confidence",
        "lead_kind",
        "classifier_version",
        "created_at",
      ],
    );

    const roundFk = yield* sql<{ readonly table: string; readonly on_delete: string }>`
      PRAGMA foreign_key_list(ft3_mail_rounds)
    `;
    assert.equal(roundFk[0]!.table, "ft3_mail_tasks");
    assert.equal(roundFk[0]!.on_delete, "CASCADE");
    const wakeFk = yield* sql<{ readonly table: string; readonly on_delete: string }>`
      PRAGMA foreign_key_list(ft3_mail_wakes)
    `;
    assert.equal(wakeFk[0]!.table, "ft3_mail_tasks");
    assert.equal(wakeFk[0]!.on_delete, "CASCADE");
    const feedbackFk = yield* sql<{ readonly table: string; readonly on_delete: string }>`
      PRAGMA foreign_key_list(ft3_mail_kind_feedback)
    `;
    assert.equal(feedbackFk[0]!.table, "ft3_mail_letters");
    assert.equal(feedbackFk[0]!.on_delete, "CASCADE");

    const memberFk = yield* sql<{ readonly table: string; readonly on_delete: string }>`
      PRAGMA foreign_key_list(ft3_mail_members)
    `;
    assert.equal(memberFk[0]!.table, "ft3_mail_tasks");
    assert.equal(memberFk[0]!.on_delete, "CASCADE");
    const deliveryFks = yield* sql<{ readonly table: string; readonly on_delete: string }>`
      PRAGMA foreign_key_list(ft3_mail_deliveries)
    `;
    assert.deepStrictEqual(deliveryFks.map((fk) => fk.table).sort(), [
      "ft3_mail_letters",
      "ft3_mail_members",
      "ft3_mail_tasks",
    ]);
    assert.isTrue(deliveryFks.every((fk) => fk.on_delete === "CASCADE"));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Mail state in `statev2.sqlite` (design §10.2). Tasks own members, letters and
 * deliveries; a finished task is purged explicitly because SQLite foreign-key
 * cascades are not guaranteed on every connection.
 */

export const FT3_MAIL_TASKS_DDL = `
  CREATE TABLE IF NOT EXISTS ft3_mail_tasks (
    task_id TEXT NOT NULL PRIMARY KEY,
    title TEXT NOT NULL,
    brief TEXT NOT NULL,
    level TEXT NOT NULL,
    card_id TEXT,
    isolation TEXT,
    runtime_mode TEXT,
    interaction_mode TEXT,
    response_budget_seconds INTEGER NOT NULL DEFAULT 1800,
    status TEXT NOT NULL DEFAULT 'open',
    outcome TEXT,
    summary TEXT,
    created_by_thread_id TEXT NOT NULL,
    client_request_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT,
    UNIQUE (created_by_thread_id, client_request_id)
  )
`;

export const FT3_MAIL_MEMBERS_DDL = `
  CREATE TABLE IF NOT EXISTS ft3_mail_members (
    member_id TEXT NOT NULL PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES ft3_mail_tasks(task_id) ON DELETE CASCADE,
    role_id TEXT NOT NULL,
    specialization TEXT,
    level TEXT,
    response_budget_seconds INTEGER,
    documents_write INTEGER NOT NULL DEFAULT 0,
    model_override_json TEXT,
    human_instruction TEXT,
    participant_thread_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

export const FT3_MAIL_LETTERS_DDL = `
  CREATE TABLE IF NOT EXISTS ft3_mail_letters (
    letter_id TEXT NOT NULL PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES ft3_mail_tasks(task_id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    sender_thread_id TEXT NOT NULL,
    recipient TEXT NOT NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    reply_to_letter_id TEXT,
    source_letter_id TEXT,
    plan_phase TEXT,
    plan_step TEXT,
    plan_sha256 TEXT,
    plan_doc_id TEXT,
    classifier_kind TEXT,
    classifier_confidence REAL,
    kind_disputed INTEGER NOT NULL DEFAULT 0,
    lead_kind TEXT,
    client_request_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (task_id, sender_thread_id, client_request_id),
    UNIQUE (task_id, sequence)
  )
`;

export const FT3_MAIL_DELIVERIES_DDL = `
  CREATE TABLE IF NOT EXISTS ft3_mail_deliveries (
    delivery_id TEXT NOT NULL PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES ft3_mail_tasks(task_id) ON DELETE CASCADE,
    letter_id TEXT NOT NULL REFERENCES ft3_mail_letters(letter_id) ON DELETE CASCADE,
    member_id TEXT REFERENCES ft3_mail_members(member_id) ON DELETE CASCADE,
    recipient TEXT NOT NULL,
    participant_thread_id TEXT,
    state TEXT NOT NULL DEFAULT 'pending',
    delivered_at TEXT,
    read_at TEXT,
    answered_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (letter_id, recipient)
  )
`;

const mail = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`${sql.literal(FT3_MAIL_TASKS_DDL)}`;
  yield* sql`${sql.literal(FT3_MAIL_MEMBERS_DDL)}`;
  yield* sql`${sql.literal(FT3_MAIL_LETTERS_DDL)}`;
  yield* sql`${sql.literal(FT3_MAIL_DELIVERIES_DDL)}`;
  yield* sql`CREATE INDEX idx_ft3_mail_tasks_retention ON ft3_mail_tasks(status, closed_at)`;
  yield* sql`CREATE INDEX idx_ft3_mail_members_task ON ft3_mail_members(task_id)`;
  yield* sql`CREATE INDEX idx_ft3_mail_letters_task ON ft3_mail_letters(task_id, sequence)`;
  yield* sql`CREATE INDEX idx_ft3_mail_deliveries_task ON ft3_mail_deliveries(task_id)`;
});

export const migrations = {
  "11_Mail": mail,
};

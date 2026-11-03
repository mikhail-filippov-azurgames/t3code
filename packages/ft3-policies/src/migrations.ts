import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Delegation evidence in `statev2.sqlite` (design §10.1): which policy revision
 * and candidate a delegation actually used. Append-only; a retry is a new row.
 */
export const FT3_POLICY_DELEGATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS ft3_policy_delegations (
    usage_id INTEGER PRIMARY KEY,
    delegation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    level TEXT NOT NULL,
    policy_revision INTEGER NOT NULL,
    policy_sha256 TEXT,
    outcome TEXT NOT NULL,
    candidate_alias TEXT,
    candidate_model TEXT,
    candidate_level TEXT,
    candidate_provider_instance_id TEXT,
    candidate_provider_driver_kind TEXT,
    recorded_at TEXT NOT NULL
  )
`;

const policyUsage = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`${sql.literal(FT3_POLICY_DELEGATIONS_DDL)}`;
  yield* sql`CREATE INDEX idx_ft3_policy_delegations_delegation ON ft3_policy_delegations(delegation_id)`;
});

export const migrations = {
  "10_PolicyUsage": policyUsage,
};

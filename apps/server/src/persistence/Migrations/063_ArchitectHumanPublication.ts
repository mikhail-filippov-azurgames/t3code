import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Track review origin and publication actor; keep one prepared advice per binding. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE architecture_review
    ADD COLUMN origin TEXT NOT NULL DEFAULT 'coordinator-request'
  `;
  yield* sql`
    ALTER TABLE architecture_review
    ADD COLUMN published_by TEXT
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_architecture_review_unpublished_advice
    ON architecture_review(binding_id)
    WHERE origin = 'architect-advice' AND status = 'answered'
  `;
});

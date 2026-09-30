import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Add exact-retry fingerprints to the Phase 1 durable command records. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE coordinator_architect_binding
    ADD COLUMN close_request_fingerprint TEXT
  `;
  yield* sql`
    ALTER TABLE architecture_review
    ADD COLUMN request_payload_fingerprint TEXT
  `;
  yield* sql`
    ALTER TABLE architecture_review
    ADD COLUMN cancel_payload_fingerprint TEXT
  `;
});

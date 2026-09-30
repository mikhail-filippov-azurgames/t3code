import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Additive review delivery observability: proves whether an answer was
 * recorded (`answered_at`) versus delivered to the coordinator
 * (`publish_delivered_at`, set only after the publish wake fires), and keeps
 * the last refused/failed publish attempt with its stable reason token so a
 * coordinator calling `list_architecture_reviews` can tell "never answered"
 * apart from "answered but delivery failed" without reading logs. Existing
 * status and idempotency semantics are untouched.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE architecture_review
    ADD COLUMN publish_delivered_at TEXT
  `;
  yield* sql`
    ALTER TABLE architecture_review
    ADD COLUMN last_publish_failure_reason TEXT
  `;
  yield* sql`
    ALTER TABLE architecture_review
    ADD COLUMN last_publish_failure_message TEXT
  `;
  yield* sql`
    ALTER TABLE architecture_review
    ADD COLUMN last_publish_failure_at TEXT
  `;
});

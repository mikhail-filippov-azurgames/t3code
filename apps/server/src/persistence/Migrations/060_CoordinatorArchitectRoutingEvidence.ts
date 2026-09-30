import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Preserve the accepted policy selection and live eligibility evidence per binding. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE coordinator_architect_binding
    ADD COLUMN routing_evidence_json TEXT
  `;
});

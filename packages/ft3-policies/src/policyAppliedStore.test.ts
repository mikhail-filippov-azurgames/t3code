import { assert, describe, it } from "@effect/vitest";
import { FT3_POLICY_APPLIED_DDL } from "@t3tools/ft3-docs/migrations";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import {
  POLICY_ENVIRONMENT_SCOPE,
  PolicyAppliedStore,
  layer as policyAppliedStoreLayer,
} from "./policyAppliedStore.ts";

const storeLayer = Layer.provideMerge(
  policyAppliedStoreLayer,
  NodeSqliteClient.layer({ filename: ":memory:" }),
);

const createTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`${sql.literal(FT3_POLICY_APPLIED_DDL)}`;
});

const files = [
  {
    file: "",
    sha256: "a".repeat(64),
    content: "---\nrevision: 1\n---\n",
    stableId: null,
  },
  {
    file: "lead.md",
    sha256: "b".repeat(64),
    content: "# Lead\n",
    stableId: "00000000-0000-0000-0000-000000000000",
  },
];

describe("PolicyAppliedStore", () => {
  it.effect("replaces every file of one document and keeps another document intact", () =>
    Effect.gen(function* () {
      yield* createTable;
      const store = yield* PolicyAppliedStore;
      yield* store.save({
        scope: POLICY_ENVIRONMENT_SCOPE,
        key: "roles",
        files,
        appliedAt: "2026-11-03T00:00:00.000Z",
        appliedBy: "human_tab",
      });
      const stored = yield* store.load({ scope: POLICY_ENVIRONMENT_SCOPE, key: "roles" });
      assert.deepStrictEqual(
        stored.map((record) => [record.file, record.sha256, record.appliedBy]),
        [
          ["", "a".repeat(64), "human_tab"],
          ["lead.md", "b".repeat(64), "human_tab"],
        ],
      );
      assert.equal(stored[1]?.stableId, "00000000-0000-0000-0000-000000000000");

      yield* store.save({
        scope: POLICY_ENVIRONMENT_SCOPE,
        key: "roles",
        files: [{ ...files[0]!, sha256: "c".repeat(64), content: "# v2\n" }],
        appliedAt: "2026-11-03T00:01:00.000Z",
        appliedBy: "human_apply",
      });
      const replaced = yield* store.load({ scope: POLICY_ENVIRONMENT_SCOPE, key: "roles" });
      assert.deepStrictEqual(
        replaced.map((record) => [record.file, record.sha256]),
        [["", "c".repeat(64)]],
      );
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("answers an empty list when the table is missing", () =>
    Effect.gen(function* () {
      const store = yield* PolicyAppliedStore;
      const stored = yield* store.load({ scope: "project-1", key: "routingPolicy" });
      assert.deepStrictEqual(stored, []);
    }).pipe(Effect.provide(storeLayer)),
  );
});

import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { BoardCardId } from "./contracts.ts";
import * as BoardRepository from "./BoardRepository.ts";

const testLayer = BoardRepository.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

it.effect("stores a policy snapshot on the named card only", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE ft3_board_cards (card_id TEXT PRIMARY KEY, policy_snapshot_json TEXT)`;
    yield* sql`INSERT INTO ft3_board_cards (card_id) VALUES ('card:one'), ('card:two')`;
    const repository = yield* BoardRepository.BoardRepository;

    yield* repository.setPolicySnapshot({
      cardId: BoardCardId.make("card:one"),
      policySnapshotJson: '{"documents":[]}',
    });

    const rows = yield* sql<{ readonly cardId: string; readonly snapshot: string | null }>`
      SELECT card_id AS "cardId", policy_snapshot_json AS snapshot
      FROM ft3_board_cards ORDER BY card_id`;
    assert.deepStrictEqual(rows, [
      { cardId: "card:one", snapshot: '{"documents":[]}' },
      { cardId: "card:two", snapshot: null },
    ]);
  }).pipe(Effect.provide(testLayer)),
);

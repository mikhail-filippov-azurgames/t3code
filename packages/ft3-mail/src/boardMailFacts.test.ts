import { assert, describe, it } from "@effect/vitest";
import { BoardMailFacts } from "@t3tools/ft3-board/planning";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { boardMailFactsLayer } from "./boardMailFacts.ts";
import { migrateMail } from "./mail.testkit.ts";
import { layer as repositoryLayer } from "./repository.ts";

const NOW = "2026-11-05T00:00:00.000Z";

const sql = NodeSqliteClient.layer({ filename: ":memory:" });
const repo = repositoryLayer.pipe(Layer.provide(sql));
const facts = boardMailFactsLayer.pipe(Layer.provide(repo));
const layer = Layer.mergeAll(sql, repo, facts);

const seedTask = (taskId: string, cardId: string | null, status: "open" | "closed") =>
  Effect.gen(function* () {
    const db = yield* SqlClient.SqlClient;
    yield* db`INSERT INTO ft3_mail_tasks (task_id, title, brief, level, card_id, status,
        created_by_thread_id, client_request_id, request_fingerprint, created_at, updated_at)
      VALUES (${taskId}, 'Title', 'Brief', 'medium', ${cardId}, ${status},
        'thread:lead', ${`key:${taskId}`}, ${`fp:${taskId}`}, ${NOW}, ${NOW})`;
  });

const seedLetter = (letterId: string, taskId: string, planPhase: string | null, sequence = 1) =>
  Effect.gen(function* () {
    const db = yield* SqlClient.SqlClient;
    yield* db`INSERT INTO ft3_mail_letters (letter_id, task_id, sequence, sender_thread_id,
        recipient, kind, body, plan_phase, client_request_id, request_fingerprint, created_at)
      VALUES (${letterId}, ${taskId}, ${sequence}, 'thread:lead', 'role:implementation', 'request',
        'Build it.', ${planPhase}, ${`key:${letterId}`}, ${`fp:${letterId}`}, ${NOW})`;
  });

const seedRound = (roundId: string, taskId: string, closed: boolean) =>
  Effect.gen(function* () {
    const db = yield* SqlClient.SqlClient;
    yield* db`INSERT INTO ft3_mail_rounds (round_id, task_id, round_number, kind, opened_at, closed_at)
      VALUES (${roundId}, ${taskId}, 1, 'review', ${NOW}, ${closed ? NOW : null})`;
  });

const seedDelivery = (deliveryId: string, taskId: string, letterId: string, state: string) =>
  Effect.gen(function* () {
    const db = yield* SqlClient.SqlClient;
    yield* db`INSERT INTO ft3_mail_deliveries (delivery_id, task_id, letter_id, recipient,
        state, created_at, updated_at)
      VALUES (${deliveryId}, ${taskId}, ${letterId}, 'role:implementation',
        ${state}, ${NOW}, ${NOW})`;
  });

describe("BoardMailFacts over the mail repository", () => {
  it.effect("reports cards with an implement letter, bounded by the selected cards", () =>
    Effect.gen(function* () {
      yield* migrateMail;
      const mail = yield* BoardMailFacts;
      yield* seedTask("task:one", "card:one", "open");
      yield* seedLetter("letter:discussion", "task:one", "discussion");
      assert.deepStrictEqual(yield* mail.hasImplementLetter(["card:one"]), new Set());
      yield* seedLetter("letter:implement", "task:one", "implement", 2);
      assert.deepStrictEqual(
        yield* mail.hasImplementLetter(["card:one", "card:other"]),
        new Set(["card:one"]),
      );
      assert.deepStrictEqual(yield* mail.hasImplementLetter([]), new Set());
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reports an open round as open mail work", () =>
    Effect.gen(function* () {
      yield* migrateMail;
      const mail = yield* BoardMailFacts;
      yield* seedTask("task:round", "card:round", "open");
      yield* seedRound("round:open", "task:round", false);
      assert.isTrue(yield* mail.hasOpenMailWork("card:round"));
      assert.isFalse(yield* mail.hasOpenMailWork("card:quiet"));
      yield* seedTask("task:shut", "card:shut", "open");
      yield* seedRound("round:shut", "task:shut", true);
      assert.isFalse(yield* mail.hasOpenMailWork("card:shut"));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reports a live delivery as open mail work", () =>
    Effect.gen(function* () {
      yield* migrateMail;
      const mail = yield* BoardMailFacts;
      yield* seedTask("task:live", "card:live", "open");
      yield* seedLetter("letter:live", "task:live", "implement");
      yield* seedDelivery("delivery:pending", "task:live", "letter:live", "pending");
      assert.isTrue(yield* mail.hasOpenMailWork("card:live"));
      yield* seedTask("task:read", "card:read", "open");
      yield* seedLetter("letter:read", "task:read", "implement");
      yield* seedDelivery("delivery:read", "task:read", "letter:read", "read");
      assert.isTrue(yield* mail.hasOpenMailWork("card:read"));
      yield* seedTask("task:done", "card:done", "open");
      yield* seedLetter("letter:done", "task:done", "implement");
      yield* seedDelivery("delivery:answered", "task:done", "letter:done", "answered");
      assert.isFalse(yield* mail.hasOpenMailWork("card:done"));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("ignores a failed delivery of a closed task", () =>
    Effect.gen(function* () {
      yield* migrateMail;
      const mail = yield* BoardMailFacts;
      yield* seedTask("task:closed", "card:closed", "closed");
      yield* seedLetter("letter:closed", "task:closed", "implement");
      yield* seedDelivery("delivery:failed", "task:closed", "letter:closed", "failed");
      assert.isFalse(yield* mail.hasOpenMailWork("card:closed"));
      assert.deepStrictEqual(
        yield* mail.hasImplementLetter(["card:closed"]),
        new Set(["card:closed"]),
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads no mail activity when the mail tables are absent", () =>
    Effect.gen(function* () {
      const mail = yield* BoardMailFacts;
      assert.deepStrictEqual(yield* mail.hasImplementLetter(["card:one"]), new Set());
      assert.isFalse(yield* mail.hasOpenMailWork("card:one"));
    }).pipe(Effect.provide(layer)),
  );
});

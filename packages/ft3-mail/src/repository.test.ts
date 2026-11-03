import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import {
  type AddMemberInput,
  type AppendLetterInput,
  type CreateTaskInput,
  layer as mailRepositoryLayer,
  MailRepository,
} from "./repository.ts";
import { migrations } from "./migrations.ts";

const run = Migrator.make({});
const loader = Migrator.fromRecord(migrations);

const testLayer = mailRepositoryLayer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const taskInput = (overrides: Partial<CreateTaskInput> = {}): CreateTaskInput => ({
  taskId: "task:one",
  title: "Task one",
  brief: "Do the work.",
  level: "medium",
  cardId: null,
  isolation: null,
  runtimeMode: null,
  interactionMode: null,
  responseBudgetSeconds: 1800,
  createdByThreadId: "thread:lead",
  clientRequestId: "request:create",
  requestFingerprint: "fingerprint:create",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const memberInput = (overrides: Partial<AddMemberInput> = {}): AddMemberInput => ({
  memberId: "member:one",
  taskId: "task:one",
  roleId: "implementation",
  specialization: null,
  level: "medium",
  responseBudgetSeconds: 600,
  documentsWrite: false,
  modelOverrideJson: null,
  humanInstruction: null,
  participantThreadId: null,
  createdAt: "2026-01-01T00:00:01.000Z",
  ...overrides,
});

const letterInput = (overrides: Partial<AppendLetterInput> = {}): AppendLetterInput => ({
  letterId: "letter:one",
  taskId: "task:one",
  senderThreadId: "thread:lead",
  recipient: "role:implementation",
  kind: "request",
  body: "Start.",
  replyToLetterId: null,
  sourceLetterId: null,
  planPhase: null,
  planStep: null,
  planSha256: null,
  planDocId: null,
  classifierKind: null,
  classifierConfidence: null,
  kindDisputed: false,
  leadKind: null,
  clientRequestId: "request:letter-one",
  requestFingerprint: "fingerprint:letter-one",
  createdAt: "2026-01-01T00:00:02.000Z",
  ...overrides,
});

const migrate = run({ loader, table: "ft3_migrations" });

it.effect("round-trips a task, members, letters and delivery state", () =>
  Effect.gen(function* () {
    yield* migrate;
    const repository = yield* MailRepository;

    const task = yield* repository.createTask(taskInput());
    assert.equal(task.taskId, "task:one");
    assert.equal(task.status, "open");
    assert.equal(task.responseBudgetSeconds, 1800);

    const repeatedCreate = yield* repository.createTask(taskInput({ taskId: "task:other" }));
    assert.equal(repeatedCreate.taskId, "task:one");

    const member = yield* repository.addMember(memberInput({ documentsWrite: true }));
    assert.equal(member.memberId, "member:one");
    assert.isTrue(member.documentsWrite);
    assert.equal((yield* repository.listMembers("task:one")).length, 1);

    const first = yield* repository.appendLetter(letterInput());
    assert.isTrue(first.created);
    assert.equal(first.letter.sequence, 1);
    const second = yield* repository.appendLetter(
      letterInput({
        letterId: "letter:two",
        kind: "answer",
        body: "Done.",
        clientRequestId: "request:letter-two",
        requestFingerprint: "fingerprint:letter-two",
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );
    assert.isTrue(second.created);
    assert.equal(second.letter.sequence, 2);

    const delivery = yield* repository.recordDelivery({
      deliveryId: "delivery:one",
      taskId: "task:one",
      letterId: "letter:one",
      memberId: "member:one",
      recipient: "role:implementation",
      participantThreadId: "thread:worker",
      createdAt: "2026-01-01T00:00:04.000Z",
    });
    assert.equal(delivery.state, "pending");
    assert.equal(delivery.participantThreadId, "thread:worker");

    const delivered = yield* repository.markDeliveryDelivered({
      deliveryId: "delivery:one",
      at: "2026-01-01T00:00:05.000Z",
    });
    assert.equal(delivered?.state, "delivered");
    assert.equal(delivered?.deliveredAt, "2026-01-01T00:00:05.000Z");

    const read = yield* repository.markDeliveryRead({
      deliveryId: "delivery:one",
      at: "2026-01-01T00:00:06.000Z",
    });
    assert.equal(read?.state, "read");
    assert.equal(read?.readAt, "2026-01-01T00:00:06.000Z");

    const answered = yield* repository.markDeliveryAnswered({
      deliveryId: "delivery:one",
      at: "2026-01-01T00:00:07.000Z",
    });
    assert.equal(answered?.state, "answered");
    assert.equal(answered?.answeredAt, "2026-01-01T00:00:07.000Z");
    assert.equal(answered?.readAt, "2026-01-01T00:00:06.000Z");

    const timeline = yield* repository.listTimeline({ taskId: "task:one", limit: 10 });
    assert.deepStrictEqual(
      timeline.map((entry) => entry.letter.sequence),
      [2, 1],
    );
    assert.deepStrictEqual(
      timeline[0]!.deliveries.map((item) => item.state),
      [],
    );
    assert.deepStrictEqual(
      timeline[1]!.deliveries.map((item) => item.state),
      ["answered"],
    );

    const closed = yield* repository.closeTask({
      taskId: "task:one",
      outcome: "succeeded",
      summary: "Everything landed.",
      closedAt: "2026-01-01T00:00:08.000Z",
    });
    assert.equal(closed?.status, "closed");
    assert.equal(closed?.outcome, "succeeded");
    assert.equal(closed?.closedAt, "2026-01-01T00:00:08.000Z");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("appends a repeated letter once and rejects a changed payload", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* migrate;
    const repository = yield* MailRepository;
    yield* repository.createTask(taskInput());

    const first = yield* repository.appendLetter(letterInput());
    assert.isTrue(first.created);

    const repeated = yield* repository.appendLetter(letterInput({ letterId: "letter:other" }));
    assert.isFalse(repeated.created);
    assert.equal(repeated.letter.letterId, "letter:one");
    assert.equal(repeated.letter.sequence, 1);
    assert.equal(yield* repository.getLetter("letter:other"), null);

    const conflict = yield* Effect.flip(
      repository.appendLetter(
        letterInput({ requestFingerprint: "fingerprint:changed", body: "Different." }),
      ),
    );
    assert.equal(conflict._tag, "MailIdempotencyConflict");

    const count = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM ft3_mail_letters WHERE task_id = 'task:one'
    `;
    assert.deepStrictEqual(count, [{ count: 1 }]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("records rounds, wakes and kind feedback idempotently", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* migrate;
    const repository = yield* MailRepository;
    yield* repository.createTask(taskInput());
    yield* repository.appendLetter(letterInput());

    const opened = yield* repository.createRound({
      roundId: "round:one",
      taskId: "task:one",
      roundNumber: 1,
      kind: "review",
      openedAt: "2026-01-01T00:00:03.000Z",
    });
    assert.isTrue(opened.created);
    assert.equal(opened.round.kind, "review");
    assert.isNull(opened.round.closedAt);

    const repeatedRound = yield* repository.createRound({
      roundId: "round:other",
      taskId: "task:one",
      roundNumber: 1,
      kind: "review",
      openedAt: "2026-01-01T00:00:04.000Z",
    });
    assert.isFalse(repeatedRound.created);
    assert.equal(repeatedRound.round.roundId, "round:one");

    const closed = yield* repository.closeRound({
      roundId: "round:one",
      outcome: "succeeded",
      closedAt: "2026-01-01T00:00:05.000Z",
    });
    assert.equal(closed?.closedAt, "2026-01-01T00:00:05.000Z");
    assert.equal(closed?.outcome, "succeeded");
    assert.equal((yield* repository.listRounds("task:one")).length, 1);

    const wake = yield* repository.recordWake({
      wakeId: "wake:one",
      taskId: "task:one",
      targetThreadId: "thread:lead",
      reason: "round-opened",
      idempotencyKey: "wake-key:one",
      createdAt: "2026-01-01T00:00:06.000Z",
    });
    assert.isTrue(wake.created);
    assert.isNull(wake.wake.deliveredAt);

    const repeatedWake = yield* repository.recordWake({
      wakeId: "wake:other",
      taskId: "task:one",
      targetThreadId: "thread:lead",
      reason: "round-opened",
      idempotencyKey: "wake-key:one",
      createdAt: "2026-01-01T00:00:07.000Z",
    });
    assert.isFalse(repeatedWake.created);
    assert.equal(repeatedWake.wake.wakeId, "wake:one");

    const feedback = yield* repository.recordKindFeedback({
      letterId: "letter:one",
      senderKind: "request",
      classifierKind: "answer",
      confidence: 0.6,
      leadKind: "request",
      classifierVersion: "v1",
      createdAt: "2026-01-01T00:00:08.000Z",
    });
    assert.equal(feedback.classifierKind, "answer");
    assert.equal(feedback.confidence, 0.6);
    assert.equal(feedback.classifierVersion, "v1");

    const reclassified = yield* repository.recordKindFeedback({
      letterId: "letter:one",
      senderKind: "request",
      classifierKind: "question",
      confidence: 0.4,
      leadKind: null,
      classifierVersion: "v2",
      createdAt: "2026-01-01T00:00:09.000Z",
    });
    assert.equal(reclassified.classifierKind, "question");
    assert.equal(reclassified.classifierVersion, "v2");
    assert.deepStrictEqual(
      yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM ft3_mail_kind_feedback WHERE letter_id = 'letter:one'
      `,
      [{ count: 1 }],
    );

    const classified = yield* repository.setLetterClassifier({
      letterId: "letter:one",
      classifierKind: "changes",
      classifierConfidence: 0.9,
      kindDisputed: true,
      leadKind: "request",
    });
    assert.equal(classified?.kind, "request");
    assert.equal(classified?.classifierKind, "changes");
    assert.equal(classified?.classifierConfidence, 0.9);
    assert.isTrue(classified?.kindDisputed);
    assert.equal(classified?.leadKind, "request");
    assert.equal(
      yield* repository.setLetterClassifier({
        letterId: "letter:missing",
        classifierKind: "info",
        classifierConfidence: null,
        kindDisputed: false,
        leadKind: null,
      }),
      null,
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("purges only closed tasks older than the retention cutoff", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* migrate;
    const repository = yield* MailRepository;

    yield* repository.createTask(taskInput());
    yield* repository.createTask(
      taskInput({
        taskId: "task:recent",
        clientRequestId: "request:create-recent",
        requestFingerprint: "fingerprint:create-recent",
      }),
    );
    yield* repository.addMember(memberInput());
    yield* repository.appendLetter(letterInput());
    yield* repository.recordDelivery({
      deliveryId: "delivery:one",
      taskId: "task:one",
      letterId: "letter:one",
      memberId: "member:one",
      recipient: "role:implementation",
      participantThreadId: "thread:worker",
      createdAt: "2026-01-01T00:00:04.000Z",
    });
    yield* repository.createRound({
      roundId: "round:one",
      taskId: "task:one",
      roundNumber: 1,
      kind: "discussion",
      openedAt: "2026-01-01T00:00:05.000Z",
    });
    yield* repository.recordWake({
      wakeId: "wake:one",
      taskId: "task:one",
      targetThreadId: "thread:lead",
      reason: "round-opened",
      idempotencyKey: "wake-key:one",
      createdAt: "2026-01-01T00:00:06.000Z",
    });
    yield* repository.recordKindFeedback({
      letterId: "letter:one",
      senderKind: "request",
      classifierKind: "request",
      confidence: 0.8,
      leadKind: "request",
      classifierVersion: "v1",
      createdAt: "2026-01-01T00:00:07.000Z",
    });
    yield* repository.closeTask({
      taskId: "task:one",
      outcome: "failed",
      summary: "Old task.",
      closedAt: "2020-01-01T00:00:00.000Z",
    });
    yield* repository.closeTask({
      taskId: "task:recent",
      outcome: "succeeded",
      summary: "Recent task.",
      closedAt: "2026-01-01T00:00:00.000Z",
    });

    const purged = yield* repository.purgeFinishedTasks({
      before: "2025-01-01T00:00:00.000Z",
      limit: 10,
    });
    assert.equal(purged, 1);

    assert.equal(yield* repository.getTask("task:one"), null);
    assert.notEqual(yield* repository.getTask("task:recent"), null);
    const leftovers = yield* sql<{ readonly table: string; readonly count: number }>`
      SELECT 'members' AS "table", COUNT(*) AS count FROM ft3_mail_members
      UNION ALL SELECT 'letters', COUNT(*) FROM ft3_mail_letters
      UNION ALL SELECT 'deliveries', COUNT(*) FROM ft3_mail_deliveries
      UNION ALL SELECT 'rounds', COUNT(*) FROM ft3_mail_rounds
      UNION ALL SELECT 'wakes', COUNT(*) FROM ft3_mail_wakes
      UNION ALL SELECT 'feedback', COUNT(*) FROM ft3_mail_kind_feedback
    `;
    assert.deepStrictEqual(leftovers, [
      { table: "members", count: 0 },
      { table: "letters", count: 0 },
      { table: "deliveries", count: 0 },
      { table: "rounds", count: 0 },
      { table: "wakes", count: 0 },
      { table: "feedback", count: 0 },
    ]);

    assert.equal(
      yield* repository.purgeFinishedTasks({ before: "2025-01-01T00:00:00.000Z", limit: 10 }),
      0,
    );
  }).pipe(Effect.provide(testLayer)),
);

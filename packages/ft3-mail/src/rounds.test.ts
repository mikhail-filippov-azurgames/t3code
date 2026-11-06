import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { mailHarness, migrateMail } from "./mail.testkit.ts";
import { MailRepository } from "./repository.ts";
import { MailService, MailServiceError } from "./service.ts";

const LEAD = "thread:lead";
const WORKER = "thread:worker";
const TESTER = "thread:tester";
const STRANGER = "thread:stranger";

const isMailServiceError = Schema.is(MailServiceError);

const refusal = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(
    Effect.map((error) => (isMailServiceError(error) ? error.code : error._tag)),
  );

const teamOf = (clientRequestId = "request:team") =>
  Effect.gen(function* () {
    const mail = yield* MailService;
    return yield* mail.createTask({
      callerThreadId: LEAD,
      clientRequestId,
      title: "Refactor",
      brief: "Split the module.",
      level: "medium",
      members: [{ role: "implementation" }],
    });
  });

it.effect("opens and closes rounds with sequential numbers, lead-only", () => {
  const harness = mailHarness();
  return Effect.gen(function* () {
    yield* migrateMail;
    const created = yield* teamOf();
    const mail = yield* MailService;

    const first = yield* mail.openRound({
      callerThreadId: LEAD,
      taskId: created.task.taskId,
      kind: "review",
    });
    assert.equal(first.roundNumber, 1);
    assert.isNull(first.closedAt);
    const second = yield* mail.openRound({
      callerThreadId: LEAD,
      taskId: created.task.taskId,
      kind: "discussion",
    });
    assert.equal(second.roundNumber, 2);

    const closed = yield* mail.closeRound({
      callerThreadId: LEAD,
      roundId: first.roundId,
      outcome: "succeeded",
    });
    assert.equal(closed.outcome, "succeeded");
    assert.isNotNull(closed.closedAt);

    assert.equal(
      yield* refusal(
        mail.openRound({ callerThreadId: WORKER, taskId: created.task.taskId, kind: "review" }),
      ),
      "capability_denied",
    );
    assert.equal(
      yield* refusal(
        mail.closeRound({ callerThreadId: WORKER, roundId: second.roundId, outcome: "failed" }),
      ),
      "capability_denied",
    );
    assert.equal(
      yield* refusal(
        mail.closeRound({ callerThreadId: LEAD, roundId: "round:missing", outcome: "failed" }),
      ),
      "invalid_request",
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("reads a letter and marks the caller's own delivered delivery read", () => {
  const harness = mailHarness();
  return Effect.gen(function* () {
    yield* migrateMail;
    const created = yield* teamOf();
    const mail = yield* MailService;
    const sent = yield* mail.sendLetter({
      callerThreadId: LEAD,
      taskId: created.task.taskId,
      to: "role:implementation",
      kind: "request",
      body: "Start.",
      clientRequestId: "request:letter",
    });

    // The launch fake starts a thread per member, so the launched member got
    // the letter in its first prompt and its delivery is already delivered;
    // the lead reads the letter without deliveries of its own.
    const asLead = yield* mail.readLetter({
      callerThreadId: LEAD,
      letterId: sent.letter.letterId,
    });
    assert.equal(asLead.letter.letterId, sent.letter.letterId);
    assert.equal(asLead.effectiveKind, "request");
    assert.deepStrictEqual(
      asLead.deliveries.map((delivery) => delivery.state),
      ["delivered"],
    );
    assert.equal(
      yield* refusal(mail.readLetter({ callerThreadId: STRANGER, letterId: sent.letter.letterId })),
      "capability_denied",
    );
    assert.equal(
      yield* refusal(mail.readLetter({ callerThreadId: LEAD, letterId: "letter:missing" })),
      "letter_not_found",
    );

    // A participant reading its delivered letter marks it read.
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* MailRepository;
    const memberId = created.members[0]!.member.memberId;
    yield* sql`UPDATE ft3_mail_members SET participant_thread_id = ${WORKER} WHERE member_id = ${memberId}`;
    const deliveryId = sent.deliveries[0]!.deliveryId;
    yield* sql`UPDATE ft3_mail_deliveries SET participant_thread_id = ${WORKER} WHERE delivery_id = ${deliveryId}`;
    yield* repository.markDeliveryDelivered({ deliveryId, at: "2026-11-04T01:00:00.000Z" });
    const asParticipant = yield* mail.readLetter({
      callerThreadId: WORKER,
      letterId: sent.letter.letterId,
    });
    assert.deepStrictEqual(
      asParticipant.deliveries.map((delivery) => delivery.state),
      ["read"],
    );
    // A second read keeps the state; the lead reading never marks a participant delivery.
    const reread = yield* mail.readLetter({
      callerThreadId: WORKER,
      letterId: sent.letter.letterId,
    });
    assert.deepStrictEqual(
      reread.deliveries.map((delivery) => delivery.state),
      ["read"],
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("shows a participant only the letters it sent or was addressed", () => {
  const harness = mailHarness();
  return Effect.gen(function* () {
    yield* migrateMail;
    const mail = yield* MailService;
    const created = yield* mail.createTask({
      callerThreadId: LEAD,
      clientRequestId: "request:team",
      title: "Refactor",
      brief: "Split the module.",
      level: "medium",
      members: [{ role: "implementation" }, { role: "test" }],
    });
    const taskId = created.task.taskId;
    const impl = created.members.find((route) => route.member.roleId === "implementation")!.member;
    const tester = created.members.find((route) => route.member.roleId === "test")!.member;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE ft3_mail_members SET participant_thread_id = ${WORKER} WHERE member_id = ${impl.memberId}`;
    yield* sql`UPDATE ft3_mail_members SET participant_thread_id = ${TESTER} WHERE member_id = ${tester.memberId}`;
    const sent = yield* mail.sendLetter({
      callerThreadId: LEAD,
      taskId,
      to: "role:implementation",
      kind: "request",
      body: "Start.",
      clientRequestId: "request:letter",
    });

    // The other participant can neither read the letter nor see it in its view.
    assert.equal(
      yield* refusal(mail.readLetter({ callerThreadId: TESTER, letterId: sent.letter.letterId })),
      "capability_denied",
    );
    const hidden = yield* mail.readTask({ callerThreadId: TESTER, taskId });
    assert.deepStrictEqual(
      hidden.entries.map((entry) => entry.letter.letterId),
      [],
    );
    // The lead and the addressee see it.
    const leadView = yield* mail.readTask({ callerThreadId: LEAD, taskId });
    assert.deepStrictEqual(
      leadView.entries.map((entry) => entry.letter.letterId),
      [sent.letter.letterId],
    );
    const implView = yield* mail.readTask({ callerThreadId: WORKER, taskId });
    assert.deepStrictEqual(
      implView.entries.map((entry) => entry.letter.letterId),
      [sent.letter.letterId],
    );

    // The tester's own answer to the lead stays visible to the tester and the
    // lead, but not to the other participant.
    const answer = yield* mail.sendLetter({
      callerThreadId: TESTER,
      taskId,
      to: "lead",
      kind: "answer",
      body: "Testing.",
      clientRequestId: "request:answer",
    });
    const testerView = yield* mail.readTask({ callerThreadId: TESTER, taskId });
    assert.deepStrictEqual(
      testerView.entries.map((entry) => entry.letter.letterId),
      [answer.letter.letterId],
    );
    const implAfter = yield* mail.readTask({ callerThreadId: WORKER, taskId });
    assert.deepStrictEqual(
      implAfter.entries.map((entry) => entry.letter.letterId),
      [sent.letter.letterId],
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("reads a task with members, rounds and the newest-first timeline", () => {
  const harness = mailHarness();
  return Effect.gen(function* () {
    yield* migrateMail;
    const created = yield* teamOf();
    const mail = yield* MailService;
    yield* mail.openRound({ callerThreadId: LEAD, taskId: created.task.taskId, kind: "review" });
    const first = yield* mail.sendLetter({
      callerThreadId: LEAD,
      taskId: created.task.taskId,
      to: "human",
      kind: "info",
      body: "First.",
      clientRequestId: "request:first",
    });
    const second = yield* mail.sendLetter({
      callerThreadId: LEAD,
      taskId: created.task.taskId,
      to: "human",
      kind: "info",
      body: "Second.",
      clientRequestId: "request:second",
    });

    const read = yield* mail.readTask({ callerThreadId: LEAD, taskId: created.task.taskId });
    assert.equal(read.task.taskId, created.task.taskId);
    assert.equal(read.members.length, 1);
    assert.equal(read.rounds.length, 1);
    assert.deepStrictEqual(
      read.entries.map((entry) => entry.letter.letterId),
      [second.letter.letterId, first.letter.letterId],
    );

    const paged = yield* mail.readTask({
      callerThreadId: LEAD,
      taskId: created.task.taskId,
      beforeLetterId: second.letter.letterId,
      limit: 10,
    });
    assert.deepStrictEqual(
      paged.entries.map((entry) => entry.letter.letterId),
      [first.letter.letterId],
    );

    assert.equal(
      yield* refusal(
        mail.readTask({ callerThreadId: LEAD, taskId: created.task.taskId, limit: 101 }),
      ),
      "invalid_request",
    );
    assert.equal(
      yield* refusal(
        mail.readTask({
          callerThreadId: LEAD,
          taskId: created.task.taskId,
          beforeLetterId: "letter:missing",
        }),
      ),
      "letter_not_found",
    );
    assert.equal(
      yield* refusal(mail.readTask({ callerThreadId: STRANGER, taskId: created.task.taskId })),
      "capability_denied",
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("lists the timeline newest-first with a default limit of fifty", () => {
  const harness = mailHarness();
  return Effect.gen(function* () {
    yield* migrateMail;
    const created = yield* teamOf();
    const mail = yield* MailService;
    for (let index = 0; index < 3; index++) {
      yield* mail.sendLetter({
        callerThreadId: LEAD,
        taskId: created.task.taskId,
        to: "human",
        kind: "info",
        body: `Note ${index}.`,
        clientRequestId: `request:note-${index}`,
      });
    }
    const entries = yield* mail.listTimeline({ callerThreadId: LEAD, taskId: created.task.taskId });
    assert.equal(entries.length, 3);
    assert.deepStrictEqual(
      entries.map((entry) => entry.letter.body),
      ["Note 2.", "Note 1.", "Note 0."],
    );
    const second = yield* mail.listTimeline({
      callerThreadId: LEAD,
      taskId: created.task.taskId,
      beforeSequence: entries[0]!.letter.sequence,
      limit: 1,
    });
    assert.deepStrictEqual(
      second.map((entry) => entry.letter.body),
      ["Note 1."],
    );
  }).pipe(Effect.provide(harness.layer));
});

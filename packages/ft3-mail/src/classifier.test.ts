import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { applyClassification, effectiveLetterKind } from "./classifier.ts";
import type { MailLetterKind } from "./contracts.ts";
import { mailHarness, migrateMail } from "./mail.testkit.ts";
import { MailService, MailServiceError } from "./service.ts";
import { readMailSettings } from "./settings.ts";

const LEAD = "thread:lead";
const WORKER = "thread:worker";

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

const bindParticipant = (memberId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE ft3_mail_members SET participant_thread_id = ${WORKER} WHERE member_id = ${memberId}`;
  });

const answerAs = (taskId: string, kind: MailLetterKind, body: string, clientRequestId: string) =>
  Effect.gen(function* () {
    const mail = yield* MailService;
    return yield* mail.sendLetter({
      callerThreadId: WORKER,
      taskId,
      to: "lead",
      kind,
      body,
      clientRequestId,
    });
  });

const feedbackOf = (letterId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly senderKind: string;
      readonly classifierKind: string | null;
      readonly confidence: number | null;
      readonly leadKind: string | null;
    }>`SELECT sender_kind AS "senderKind", classifier_kind AS "classifierKind",
        confidence, lead_kind AS "leadKind"
      FROM ft3_mail_kind_feedback WHERE letter_id = ${letterId}`;
    return rows[0] ?? null;
  });

it.effect("keeps the sender kind with the no-op classifier and writes no feedback", () => {
  const harness = mailHarness();
  return Effect.gen(function* () {
    yield* migrateMail;
    const created = yield* teamOf();
    yield* bindParticipant(created.members[0]!.member.memberId);
    const sent = yield* answerAs(created.task.taskId, "answer", "Done.", "request:answer");

    assert.isFalse(sent.letter.kindDisputed);
    assert.isNull(sent.letter.classifierKind);
    assert.isNull(sent.letter.leadKind);
    assert.deepStrictEqual(harness.classified, ["Done."]);
    assert.isNull(yield* feedbackOf(sent.letter.letterId));
  }).pipe(Effect.provide(harness.layer));
});

it.effect("does not classify lead letters", () => {
  const harness = mailHarness({
    classify: () => ({ kind: "blocked", confidence: 0.99, version: "test-v1" }),
  });
  return Effect.gen(function* () {
    yield* migrateMail;
    const created = yield* teamOf();
    const mail = yield* MailService;
    const sent = yield* mail.sendLetter({
      callerThreadId: LEAD,
      taskId: created.task.taskId,
      to: "human",
      kind: "info",
      body: "FYI.",
      clientRequestId: "request:human",
    });
    assert.isFalse(sent.letter.kindDisputed);
    assert.isNull(sent.letter.classifierKind);
    assert.deepStrictEqual(harness.classified, []);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("trusts a confident classifier kind for transitions", () => {
  const harness = mailHarness({
    classify: () => ({ kind: "blocked", confidence: 0.95, version: "test-v1" }),
  });
  return Effect.gen(function* () {
    yield* migrateMail;
    const created = yield* teamOf();
    yield* bindParticipant(created.members[0]!.member.memberId);
    const sent = yield* answerAs(created.task.taskId, "answer", "Stuck.", "request:stuck");

    assert.equal(sent.letter.kind, "answer");
    assert.equal(sent.letter.classifierKind, "blocked");
    assert.isFalse(sent.letter.kindDisputed);
    assert.equal(effectiveLetterKind(sent.letter), "blocked");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("marks a low-confidence mismatch disputed and keeps the sender kind", () => {
  const harness = mailHarness({
    classify: () => ({ kind: "blocked", confidence: 0.4, version: "test-v1" }),
  });
  return Effect.gen(function* () {
    yield* migrateMail;
    const created = yield* teamOf();
    yield* bindParticipant(created.members[0]!.member.memberId);
    const sent = yield* answerAs(created.task.taskId, "answer", "Maybe stuck.", "request:maybe");

    assert.isTrue(sent.letter.kindDisputed);
    assert.equal(sent.letter.classifierKind, "blocked");
    assert.equal(effectiveLetterKind(sent.letter), "answer");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("lets the lead decide a disputed kind and records training feedback", () => {
  const harness = mailHarness({
    classify: () => ({ kind: "blocked", confidence: 0.4, version: "test-v1" }),
  });
  return Effect.gen(function* () {
    yield* migrateMail;
    const created = yield* teamOf();
    yield* bindParticipant(created.members[0]!.member.memberId);
    const sent = yield* answerAs(created.task.taskId, "answer", "Maybe stuck.", "request:maybe");

    const mail = yield* MailService;
    const decided = yield* mail.setLetterKind({
      callerThreadId: LEAD,
      letterId: sent.letter.letterId,
      kind: "blocked",
      clientRequestId: "request:decide",
    });
    assert.equal(decided.effectiveKind, "blocked");
    assert.equal(decided.letter.leadKind, "blocked");
    assert.isFalse(decided.letter.kindDisputed);
    assert.equal(effectiveLetterKind(decided.letter), "blocked");

    const feedback = yield* feedbackOf(sent.letter.letterId);
    assert.deepStrictEqual(feedback, {
      senderKind: "answer",
      classifierKind: "blocked",
      confidence: 0.4,
      leadKind: "blocked",
    });
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "refuses a kind decision without a dispute, from a non-lead or for a missing letter",
  () => {
    const harness = mailHarness({
      classify: (body) =>
        body === "Maybe stuck." ? { kind: "blocked", confidence: 0.4, version: "test-v1" } : null,
    });
    return Effect.gen(function* () {
      yield* migrateMail;
      const created = yield* teamOf();
      yield* bindParticipant(created.members[0]!.member.memberId);
      const plain = yield* answerAs(created.task.taskId, "answer", "Done.", "request:plain");
      const mail = yield* MailService;

      const decide = (callerThreadId: string, letterId: string) =>
        mail.setLetterKind({
          callerThreadId,
          letterId,
          kind: "blocked",
          clientRequestId: "request:decide",
        });
      assert.equal(yield* refusal(decide(LEAD, plain.letter.letterId)), "kind_not_disputed");
      assert.equal(yield* refusal(decide(LEAD, "letter:missing")), "letter_not_found");
      assert.equal(yield* refusal(decide(WORKER, plain.letter.letterId)), "capability_denied");
    }).pipe(Effect.provide(harness.layer));
  },
);

it("applies the threshold without a classifier round-trip", () => {
  assert.deepStrictEqual(applyClassification("answer", null, 0.8), {
    classifierKind: null,
    classifierConfidence: null,
    kindDisputed: false,
  });
  assert.deepStrictEqual(
    applyClassification("answer", { kind: "blocked", confidence: 0.8, version: "v" }, 0.8),
    { classifierKind: "blocked", classifierConfidence: 0.8, kindDisputed: false },
  );
  assert.deepStrictEqual(
    applyClassification("answer", { kind: "blocked", confidence: 0.79, version: "v" }, 0.8),
    { classifierKind: "blocked", classifierConfidence: 0.79, kindDisputed: true },
  );
  assert.deepStrictEqual(
    applyClassification("answer", { kind: "answer", confidence: 0.1, version: "v" }, 0.8),
    { classifierKind: "answer", classifierConfidence: 0.1, kindDisputed: false },
  );
});

it("reads the mail settings namespace with safe defaults", () => {
  assert.equal(readMailSettings(undefined).classifierThreshold, 0.8);
  assert.equal(readMailSettings({}).classifierThreshold, 0.8);
  assert.equal(readMailSettings({ mail: { classifierThreshold: 0.5 } }).classifierThreshold, 0.5);
  assert.equal(readMailSettings({ mail: { classifierThreshold: 7 } }).classifierThreshold, 0.8);
  assert.equal(readMailSettings({ mail: null }).classifierThreshold, 0.8);
});

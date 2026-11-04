import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { mailHarness, migrateMail } from "./mail.testkit.ts";
import { MailRepository } from "./repository.ts";
import { MailService, MailServiceError } from "./service.ts";

const LEAD = "thread:lead";

const isMailServiceError = Schema.is(MailServiceError);

const refusal = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(
    Effect.map((error) => (isMailServiceError(error) ? error.code : error._tag)),
  );

// The test clock is fixed at the epoch, so the scan timestamps are epoch-relative.
const afterSeconds = (seconds: number) =>
  `1970-01-01T00:${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.000Z`;

const teamWithBudget = (budget: number, clientRequestId = "request:team") =>
  Effect.gen(function* () {
    const mail = yield* MailService;
    return yield* mail.createTask({
      callerThreadId: LEAD,
      clientRequestId,
      title: "Refactor",
      brief: "Split the module.",
      level: "medium",
      members: [{ role: "implementation", responseBudgetSeconds: budget }],
    });
  });

const sendRequest = (taskId: string, clientRequestId: string) =>
  Effect.gen(function* () {
    const mail = yield* MailService;
    return yield* mail.sendLetter({
      callerThreadId: LEAD,
      taskId,
      to: "role:implementation",
      kind: "request",
      body: "Start.",
      clientRequestId,
    });
  });

it.effect("fails deliveries past the member budget and tells the lead once", () => {
  const harness = mailHarness();
  return Effect.gen(function* () {
    yield* migrateMail;
    const created = yield* teamWithBudget(60);
    const sent = yield* sendRequest(created.task.taskId, "request:letter");
    const mail = yield* MailService;
    const repository = yield* MailRepository;

    const early = yield* mail.timeoutOverdueDeliveries({ now: afterSeconds(30) });
    assert.deepStrictEqual(early.failed, []);
    assert.deepStrictEqual(early.letters, []);

    const late = yield* mail.timeoutOverdueDeliveries({ now: afterSeconds(61) });
    assert.equal(late.failed.length, 1);
    assert.equal(late.failed[0]!.deliveryId, sent.deliveries[0]!.deliveryId);
    assert.include(late.failed[0]!.failureReason ?? "", "60 seconds");
    assert.equal(late.letters.length, 1);
    assert.equal(late.letters[0]!.senderThreadId, "system");
    assert.include(late.letters[0]!.body, "response budget expired");
    assert.include(late.letters[0]!.body, sent.letter.letterId);

    // The member stays active and a rescan finds nothing new.
    assert.equal((yield* repository.listMembers(created.task.taskId))[0]?.status, "active");
    const again = yield* mail.timeoutOverdueDeliveries({ now: afterSeconds(120) });
    assert.deepStrictEqual(again.failed, []);
    assert.deepStrictEqual(again.letters, []);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("falls back to the task default budget", () => {
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
      members: [{ role: "implementation" }],
    });
    yield* sendRequest(created.task.taskId, "request:letter");

    // The member budget defaults to 1800 seconds; just under it nothing fails.
    const early = yield* mail.timeoutOverdueDeliveries({ now: afterSeconds(1799) });
    assert.deepStrictEqual(early.failed, []);
    const late = yield* mail.timeoutOverdueDeliveries({ now: afterSeconds(1801) });
    assert.equal(late.failed.length, 1);
    assert.include(late.failed[0]!.failureReason ?? "", "1800 seconds");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("refuses a scan without a timestamp and stays quiet while mail is off", () => {
  const harness = mailHarness();
  return Effect.gen(function* () {
    yield* migrateMail;
    const created = yield* teamWithBudget(60);
    yield* sendRequest(created.task.taskId, "request:letter");
    const mail = yield* MailService;
    assert.equal(
      yield* refusal(mail.timeoutOverdueDeliveries({ now: "not-a-time" })),
      "invalid_request",
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("stays quiet while mail is off", () => {
  const harness = mailHarness({ enabled: false });
  return Effect.gen(function* () {
    yield* migrateMail;
    const mail = yield* MailService;
    assert.equal(
      yield* refusal(mail.timeoutOverdueDeliveries({ now: afterSeconds(3600) })),
      "mail_disabled",
    );
  }).pipe(Effect.provide(harness.layer));
});

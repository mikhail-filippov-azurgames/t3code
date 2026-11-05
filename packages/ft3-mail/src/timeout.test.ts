import { assert, it } from "@effect/vitest";
import { normalServicePolicyLayer } from "@t3tools/ft3-policies/routing";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";

import {
  classifierFake,
  cryptoLayer,
  gateLayer,
  launcherFake,
  mailHarness,
  migrateMail,
  planGateFake,
  policyEvidenceFake,
  routingFake,
  settingsLayer,
} from "./mail.testkit.ts";
import { layer as mailRepositoryLayer, MailRepository } from "./repository.ts";
import { layer as mailServiceLayer, MailService, MailServiceError } from "./service.ts";

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

interface FaultFlag {
  predicate: ((statement: string) => boolean) | null;
}

/** The same in-memory stack as the harness, but the first matching statement dies. */
const faultHarness = (fault: FaultFlag) => {
  const proxied = (real: SqlClient.SqlClient) =>
    new Proxy(real, {
      apply: (target, thisArg, args) => {
        const first = (args as ReadonlyArray<unknown>)[0];
        const text = Array.isArray(first) ? first.join("") : "";
        if (fault.predicate !== null && fault.predicate(text)) {
          return Effect.die(new Error(`injected storage fault at: ${text.slice(0, 80)}`));
        }
        return (target as (...callArgs: ReadonlyArray<unknown>) => unknown).apply(
          thisArg,
          Array.from(args as ReadonlyArray<unknown>),
        );
      },
      get: (target, property, receiver) => Reflect.get(target as object, property, receiver),
    }) as typeof real;
  const sqlite = NodeSqliteClient.layer({ filename: ":memory:" }).pipe(
    Layer.flatMap((context) =>
      Layer.succeed(SqlClient.SqlClient, proxied(Context.get(context, SqlClient.SqlClient))),
    ),
  );
  const layer = mailServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        routingFake({}).layer,
        gateLayer(true),
        cryptoLayer,
        policyEvidenceFake().layer,
        launcherFake().layer,
        classifierFake().layer,
        normalServicePolicyLayer,
        settingsLayer(),
        planGateFake().layer,
      ),
    ),
    Layer.provideMerge(mailRepositoryLayer.pipe(Layer.provideMerge(sqlite))),
  );
  return { layer };
};

it.effect("restarts the timeout scan from every write boundary", () => {
  const boundaries: ReadonlyArray<{ name: string; match: (text: string) => boolean }> = [
    { name: "fail delivery", match: (text) => text.includes("UPDATE ft3_mail_deliveries") },
    { name: "mark wake", match: (text) => text.includes("UPDATE ft3_mail_wakes") },
    { name: "append notice", match: (text) => text.includes("INSERT INTO ft3_mail_letters") },
    { name: "record delivery", match: (text) => text.includes("INSERT INTO ft3_mail_deliveries") },
    { name: "record wake", match: (text) => text.includes("INSERT INTO ft3_mail_wakes") },
  ];
  return Effect.gen(function* () {
    for (const boundary of boundaries) {
      const fault: FaultFlag = { predicate: null };
      const harness = faultHarness(fault);
      yield* Effect.gen(function* () {
        yield* migrateMail;
        const created = yield* teamWithBudget(60);
        const taskId = created.task.taskId;
        const sent = yield* sendRequest(taskId, "request:letter");
        const mail = yield* MailService;
        const repository = yield* MailRepository;

        fault.predicate = boundary.match;
        const exit = yield* Effect.exit(mail.timeoutOverdueDeliveries({ now: afterSeconds(61) }));
        assert.equal(exit._tag, "Failure", boundary.name);
        fault.predicate = null;

        // The crash left no partial timeout state behind.
        assert.equal(
          (yield* repository.getDelivery(sent.deliveries[0]!.deliveryId))?.state,
          "pending",
        );
        assert.deepStrictEqual(
          (yield* repository.listTimeline({ taskId, limit: 10 })).filter(
            (entry) => entry.letter.senderThreadId === "system",
          ),
          [],
        );

        // A restart heals everything, exactly once.
        const healed = yield* mail.timeoutOverdueDeliveries({ now: afterSeconds(61) });
        assert.equal(healed.failed.length, 1, boundary.name);
        assert.equal(healed.failed[0]!.deliveryId, sent.deliveries[0]!.deliveryId);
        assert.equal(healed.letters.length, 1, boundary.name);
        const wakes = yield* repository.listUndeliveredWakes({ limit: 10 });
        assert.equal(wakes.length, 1, boundary.name);
        assert.equal(wakes[0]!.targetThreadId, LEAD);
        assert.equal(wakes[0]!.reason, "member-timeout");
        const again = yield* mail.timeoutOverdueDeliveries({ now: afterSeconds(120) });
        assert.deepStrictEqual(again.failed, [], boundary.name);
        assert.deepStrictEqual(again.letters, [], boundary.name);
      }).pipe(Effect.provide(harness.layer));
    }
  });
});

const systemEntries = (taskId: string) =>
  Effect.gen(function* () {
    const repository = yield* MailRepository;
    return (yield* repository.listTimeline({ taskId, limit: 10 })).filter(
      (entry) => entry.letter.senderThreadId === "system",
    );
  });

const settleWakes = () =>
  Effect.gen(function* () {
    const repository = yield* MailRepository;
    return (yield* repository.listUndeliveredWakes({ limit: 10 })).filter(
      (wake) => wake.reason === "member-settled",
    );
  });

it.effect("settles a member from every write boundary without partial state", () => {
  const boundaries: ReadonlyArray<{ name: string; match: (text: string) => boolean }> = [
    { name: "close member", match: (text) => text.includes("UPDATE ft3_mail_members") },
    { name: "fail delivery", match: (text) => text.includes("UPDATE ft3_mail_deliveries") },
    { name: "mark wake", match: (text) => text.includes("UPDATE ft3_mail_wakes") },
    { name: "append notice", match: (text) => text.includes("INSERT INTO ft3_mail_letters") },
    { name: "record delivery", match: (text) => text.includes("INSERT INTO ft3_mail_deliveries") },
    { name: "record wake", match: (text) => text.includes("INSERT INTO ft3_mail_wakes") },
  ];
  return Effect.gen(function* () {
    for (const boundary of boundaries) {
      const fault: FaultFlag = { predicate: null };
      const harness = faultHarness(fault);
      yield* Effect.gen(function* () {
        yield* migrateMail;
        const created = yield* teamWithBudget(60);
        const taskId = created.task.taskId;
        const sent = yield* sendRequest(taskId, "request:letter");
        const mail = yield* MailService;
        const repository = yield* MailRepository;
        const memberId = (yield* repository.listMembers(taskId))[0]!.memberId;
        const settle = { memberId, settledAs: "completed", at: afterSeconds(61) };

        fault.predicate = boundary.match;
        const exit = yield* Effect.exit(mail.settleMember(settle));
        assert.equal(exit._tag, "Failure", boundary.name);
        fault.predicate = null;

        // The crash left the member open and its letters untouched.
        assert.equal((yield* repository.getMember(memberId))?.status, "active", boundary.name);
        assert.equal(
          (yield* repository.getDelivery(sent.deliveries[0]!.deliveryId))?.state,
          "pending",
          boundary.name,
        );
        assert.deepStrictEqual(yield* systemEntries(taskId), [], boundary.name);
        assert.deepStrictEqual(yield* settleWakes(), [], boundary.name);

        // A retry heals everything, exactly once.
        const healed = yield* mail.settleMember(settle);
        assert.equal(healed?.member.status, "closed", boundary.name);
        assert.deepStrictEqual(
          healed?.failed.map((delivery) => delivery.deliveryId),
          [sent.deliveries[0]!.deliveryId],
          boundary.name,
        );
        assert.equal(healed?.letter?.senderThreadId, "system", boundary.name);
        const notices = yield* systemEntries(taskId);
        assert.equal(notices.length, 1, boundary.name);
        assert.deepStrictEqual(
          notices[0]!.deliveries.map((delivery) => [delivery.recipient, delivery.state]),
          [["lead", "pending"]],
          boundary.name,
        );
        assert.equal((yield* settleWakes()).length, 1, boundary.name);

        // A further pass is a no-op.
        const again = yield* mail.settleMember(settle);
        assert.deepStrictEqual(again?.failed, [], boundary.name);
        assert.equal(again?.letter, null, boundary.name);
        assert.equal((yield* systemEntries(taskId)).length, 1, boundary.name);
        assert.equal((yield* settleWakes()).length, 1, boundary.name);
      }).pipe(Effect.provide(harness.layer));
    }
  });
});

it.effect("gives a later settle batch its own notice, delivery and wake", () => {
  const fault: FaultFlag = { predicate: null };
  const harness = faultHarness(fault);
  return Effect.gen(function* () {
    yield* migrateMail;
    const created = yield* teamWithBudget(60);
    const taskId = created.task.taskId;
    yield* sendRequest(taskId, "request:first");
    const mail = yield* MailService;
    const repository = yield* MailRepository;
    const sql = yield* SqlClient.SqlClient;
    const memberId = (yield* repository.listMembers(taskId))[0]!.memberId;
    yield* mail.settleMember({ memberId, settledAs: "completed", at: afterSeconds(61) });

    // A member that comes back and strands a newer letter settles into a second notice.
    yield* sql`UPDATE ft3_mail_members SET status = 'active' WHERE member_id = ${memberId}`;
    const second = yield* sendRequest(taskId, "request:second");
    const settled = yield* mail.settleMember({
      memberId,
      settledAs: "completed",
      at: afterSeconds(62),
    });
    assert.deepStrictEqual(
      settled?.failed.map((delivery) => delivery.deliveryId),
      [second.deliveries[0]!.deliveryId],
    );
    const notices = yield* systemEntries(taskId);
    assert.equal(notices.length, 2);
    const leadDeliveryIds = notices.flatMap((entry) =>
      entry.deliveries.filter((d) => d.recipient === "lead").map((d) => d.deliveryId),
    );
    const wakes = yield* settleWakes();
    assert.deepStrictEqual(
      wakes.map((wake) => wake.idempotencyKey).toSorted(),
      leadDeliveryIds.map((id) => `mail:wake:${id}`).toSorted(),
    );
  }).pipe(Effect.provide(harness.layer));
});

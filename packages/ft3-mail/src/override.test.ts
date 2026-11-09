import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { mailHarness, migrateMail } from "./mail.testkit.ts";
import { MailRepository } from "./repository.ts";
import { MailService, MailServiceError, type MailMemberRequest } from "./service.ts";
import type { RoutingRoleId } from "@t3tools/ft3-policies/routingPolicy";

const LEAD = "thread:lead";
const WORKER = "thread:worker";

const isMailServiceError = Schema.is(MailServiceError);

const refusal = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(
    Effect.map((error) => (isMailServiceError(error) ? error.code : error._tag)),
  );

const overrideSelection = (model = "gpt-test") =>
  ({
    instanceId: ProviderInstanceId.make("codex"),
    model,
  }) as { readonly instanceId: ProviderInstanceId; readonly model: string };

const teamOf = (members: ReadonlyArray<MailMemberRequest>, clientRequestId = "request:team") =>
  Effect.gen(function* () {
    const mail = yield* MailService;
    return yield* mail.createTask({
      callerThreadId: LEAD,
      clientRequestId,
      title: "Refactor",
      brief: "Split the module.",
      level: "medium",
      members,
    });
  });

it.effect("stores a compose override with no route and no routing fallback", () => {
  const harness = mailHarness();
  return Effect.gen(function* () {
    yield* migrateMail;
    const created = yield* teamOf([
      {
        role: "implementation",
        modelOverride: {
          modelSelection: overrideSelection(),
          humanInstruction: "Use the fast box.",
        },
      },
    ]);

    const member = created.members[0]!.member;
    assert.isTrue(created.created);
    assert.isNotNull(member.modelOverrideJson);
    assert.equal(member.humanInstruction, "Use the fast box.");
    assert.isNull(member.routeAlias);
    assert.isNull(member.routeModelSelectionJson);
    assert.isNull(created.members[0]!.noCandidate);
    assert.deepStrictEqual(harness.selects, []);

    const decoded = JSON.parse(member.modelOverrideJson!);
    assert.equal(decoded.model, "gpt-test");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("requires a human instruction for a compose override", () => {
  const harness = mailHarness();
  return Effect.gen(function* () {
    yield* migrateMail;
    assert.equal(
      yield* refusal(
        teamOf([
          {
            role: "implementation",
            modelOverride: { modelSelection: overrideSelection(), humanInstruction: "  " },
          },
        ]),
      ),
      "human_instruction_required",
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("refuses an accelerated override model", () => {
  const harness = mailHarness();
  return Effect.gen(function* () {
    yield* migrateMail;
    assert.equal(
      yield* refusal(
        teamOf(
          [
            {
              role: "implementation",
              modelOverride: {
                modelSelection: overrideSelection("gpt-highspeed"),
                humanInstruction: "Go fast.",
              },
            },
          ],
          "request:accelerated",
        ),
      ),
      "model_unavailable",
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("launches an overridden member on its override without a route", () => {
  const harness = mailHarness({ routable: [] });
  return Effect.gen(function* () {
    yield* migrateMail;
    const created = yield* teamOf([
      {
        role: "implementation",
        modelOverride: {
          modelSelection: overrideSelection(),
          humanInstruction: "Use the fast box.",
        },
      },
    ]);
    const taskId = created.task.taskId;

    const mail = yield* MailService;
    const sent = yield* mail.sendLetter({
      callerThreadId: LEAD,
      taskId,
      to: "role:implementation",
      kind: "request",
      body: "Start.",
      clientRequestId: "request:letter",
    });
    assert.equal(sent.launched.length, 1);
    assert.deepStrictEqual(sent.launchFailures, []);
    assert.equal(harness.launches.length, 1);
    assert.equal(JSON.parse(harness.launches[0]!.modelSelectionJson).model, "gpt-test");
    assert.deepStrictEqual(sent.noCandidate, []);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("reroutes a routeless member when the letter is resent after the policy is fixed", () => {
  const routable: Array<RoutingRoleId> = [];
  const harness = mailHarness({ routable });
  return Effect.gen(function* () {
    yield* migrateMail;
    const created = yield* teamOf([{ role: "implementation" }], "request:team");
    const taskId = created.task.taskId;
    assert.isNull(created.members[0]!.member.routeModelSelectionJson);

    const mail = yield* MailService;
    const stuck = yield* mail.sendLetter({
      callerThreadId: LEAD,
      taskId,
      to: "role:implementation",
      kind: "request",
      body: "Start.",
      clientRequestId: "request:first",
    });
    assert.deepStrictEqual(stuck.launched, []);
    assert.equal(stuck.noCandidate.length, 1);

    routable.push("implementation");
    const healed = yield* mail.sendLetter({
      callerThreadId: LEAD,
      taskId,
      to: "role:implementation",
      kind: "request",
      body: "Start again.",
      clientRequestId: "request:second",
    });
    assert.equal(healed.launched.length, 1);
    assert.deepStrictEqual(healed.launchFailures, []);
    assert.deepStrictEqual(healed.noCandidate, []);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("binds the pending delivery to the thread on a same-key resend", () => {
  const routable: Array<RoutingRoleId> = [];
  const harness = mailHarness({ routable });
  return Effect.gen(function* () {
    yield* migrateMail;
    const created = yield* teamOf([{ role: "implementation" }], "request:team");
    const taskId = created.task.taskId;
    const mail = yield* MailService;
    const repository = yield* MailRepository;

    const stuck = yield* mail.sendLetter({
      callerThreadId: LEAD,
      taskId,
      to: "role:implementation",
      kind: "request",
      body: "Start.",
      clientRequestId: "request:letter",
    });
    assert.deepStrictEqual(stuck.launched, []);
    assert.equal(stuck.noCandidate.length, 1);
    assert.isNull(stuck.deliveries[0]!.participantThreadId);
    assert.deepStrictEqual(yield* repository.listUndeliveredWakes({ limit: 10 }), []);

    routable.push("implementation");
    const healed = yield* mail.sendLetter({
      callerThreadId: LEAD,
      taskId,
      to: "role:implementation",
      kind: "request",
      body: "Start.",
      clientRequestId: "request:letter",
    });
    assert.isFalse(healed.created);
    assert.equal(healed.launched.length, 1);
    const thread = healed.launched[0]!.participantThreadId;
    assert.equal(healed.deliveries.length, 1);
    assert.equal(healed.deliveries[0]!.participantThreadId, thread);
    // The launched member carries the letter in its first prompt: the delivery is
    // delivered and no wake is recorded for it.
    const healedDeliveries = yield* repository.listLetterDeliveries(healed.letter.letterId);
    assert.equal(healedDeliveries.length, 1);
    assert.equal(healedDeliveries[0]!.state, "delivered");
    const wakes = yield* repository.listUndeliveredWakes({ limit: 10 });
    assert.equal(wakes.length, 0);
    assert.equal(thread, healed.deliveries[0]!.participantThreadId);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("stores a mid-task override for the lead only", () => {
  const harness = mailHarness();
  return Effect.gen(function* () {
    yield* migrateMail;
    const created = yield* teamOf([{ role: "implementation" }]);
    const memberId = created.members[0]!.member.memberId;
    const mail = yield* MailService;

    const set = (callerThreadId: string, memberIdForCall: string) =>
      mail.setMemberModel({
        callerThreadId,
        taskId: created.task.taskId,
        memberId: memberIdForCall,
        modelSelection: overrideSelection("gpt-other"),
        humanInstruction: "The first model stalls.",
        clientRequestId: "request:override",
      });
    assert.equal(yield* refusal(set(WORKER, memberId)), "capability_denied");
    assert.equal(yield* refusal(set(LEAD, "member:missing")), "invalid_request");

    const updated = yield* set(LEAD, memberId);
    assert.equal(JSON.parse(updated.modelOverrideJson!).model, "gpt-other");
    assert.equal(updated.humanInstruction, "The first model stalls.");
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "refuses a mid-task override without a human instruction or with an accelerated model",
  () => {
    const harness = mailHarness();
    return Effect.gen(function* () {
      yield* migrateMail;
      const created = yield* teamOf([{ role: "implementation" }], "request:team");
      const memberId = created.members[0]!.member.memberId;
      const mail = yield* MailService;

      assert.equal(
        yield* refusal(
          mail.setMemberModel({
            callerThreadId: LEAD,
            taskId: created.task.taskId,
            memberId,
            modelSelection: overrideSelection(),
            humanInstruction: "",
            clientRequestId: "request:empty",
          }),
        ),
        "human_instruction_required",
      );
      assert.equal(
        yield* refusal(
          mail.setMemberModel({
            callerThreadId: LEAD,
            taskId: created.task.taskId,
            memberId,
            modelSelection: overrideSelection("gpt-highspeed"),
            humanInstruction: "Go fast.",
            clientRequestId: "request:fast",
          }),
        ),
        "model_unavailable",
      );
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("keeps the override out of the fingerprint of an unchanged team", () => {
  const harness = mailHarness();
  return Effect.gen(function* () {
    yield* migrateMail;
    const first = yield* teamOf(
      [
        {
          role: "implementation",
          modelOverride: { modelSelection: overrideSelection(), humanInstruction: "A." },
        },
      ],
      "request:same",
    );
    const replay = yield* teamOf(
      [
        {
          role: "implementation",
          modelOverride: { modelSelection: overrideSelection(), humanInstruction: "A." },
        },
      ],
      "request:same",
    );
    assert.isFalse(replay.created);
    assert.equal(replay.task.taskId, first.task.taskId);

    assert.equal(
      yield* refusal(
        teamOf(
          [
            {
              role: "implementation",
              modelOverride: { modelSelection: overrideSelection(), humanInstruction: "B." },
            },
          ],
          "request:same",
        ),
      ),
      "idempotency_conflict",
    );
  }).pipe(Effect.provide(harness.layer));
});

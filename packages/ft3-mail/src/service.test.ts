import { assert, it } from "@effect/vitest";
import { FeatureDisabledError, FeatureGate } from "@t3tools/ft3-policies/server";
import { normalServicePolicyLayer } from "@t3tools/ft3-policies/routing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { MailLetterKind, MailTask } from "./contracts.ts";
import type { CreateMailTaskInput } from "./service.ts";
import { MailRepository } from "./repository.ts";
import {
  ALL_ROUTING_ROLES,
  classifierFake,
  cryptoLayer,
  databaseLayer,
  launcherFake,
  mailHarness,
  migrateMail,
  planGateFake,
  policyEvidenceFake,
  routingFake,
  settingsLayer,
} from "./mail.testkit.ts";
import {
  layer as mailServiceLayer,
  type MailMemberRequest,
  type MailTaskCreated,
  MailService,
  MailServiceError,
  mailKindAllowed,
} from "./service.ts";

const LEAD = "thread:lead";
const WORKER = "thread:worker";
const CONSULTANT = "thread:consultant";

const isMailServiceError = Schema.is(MailServiceError);

const refusal = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(
    Effect.map((error) => (isMailServiceError(error) ? error.code : error._tag)),
  );

const teamOf = (
  members: ReadonlyArray<MailMemberRequest>,
  clientRequestId = "request:team",
  title = "Refactor",
) =>
  Effect.gen(function* () {
    const mail = yield* MailService;
    return yield* mail.createTask({
      callerThreadId: LEAD,
      clientRequestId,
      title,
      brief: "Split the module.",
      level: "medium",
      members,
    });
  });

const sendAs = (
  callerThreadId: string,
  taskId: string,
  to: string,
  kind: MailLetterKind,
  body = "Start.",
  clientRequestId = "request:letter",
) =>
  Effect.gen(function* () {
    const mail = yield* MailService;
    return yield* mail.sendLetter({ callerThreadId, taskId, to, kind, body, clientRequestId });
  });

const idsOf = (created: MailTaskCreated, role: string) =>
  created.members
    .filter((route) => route.member.roleId === role)
    .map((route) => route.member.memberId)
    .toSorted();

const bindParticipant = (memberId: string, threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE ft3_mail_members SET participant_thread_id = ${threadId} WHERE member_id = ${memberId}`;
  });

const finishMember = (memberId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE ft3_mail_members SET status = 'closed' WHERE member_id = ${memberId}`;
  });

const closeAs = (callerThreadId: string, task: MailTask) =>
  Effect.gen(function* () {
    const mail = yield* MailService;
    return yield* mail.closeTask({
      callerThreadId,
      taskId: task.taskId,
      outcome: "succeeded",
      summary: "Done.",
    });
  });

it.effect(
  "routes each member by its role and level and records the choice under the member",
  () => {
    const harness = mailHarness();
    return Effect.gen(function* () {
      yield* migrateMail;
      const created = yield* teamOf([
        { role: "implementation" },
        { role: "test", level: "high", responseBudgetSeconds: 600 },
      ]);

      assert.isTrue(created.created);
      assert.deepStrictEqual(
        created.members.map((route) => route.member.roleId),
        ["implementation", "test"],
      );
      assert.deepStrictEqual(
        created.members.map((route) => route.member.responseBudgetSeconds),
        [1800, 600],
      );
      assert.deepStrictEqual(
        created.members.map((route) => route.noCandidate),
        [null, null],
      );
      assert.deepStrictEqual(
        harness.selects.map((select) => ({
          role: select.role,
          level: select.level,
          delegationId: select.delegationId,
        })),
        [
          {
            role: "implementation",
            level: "medium",
            delegationId: created.members[0]?.member.memberId,
          },
          { role: "test", level: "high", delegationId: created.members[1]?.member.memberId },
        ],
      );
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("keeps a member without a route and reports the cell and the skipped candidates", () => {
  const harness = mailHarness({ routable: ALL_ROUTING_ROLES.filter((role) => role !== "test") });
  return Effect.gen(function* () {
    yield* migrateMail;
    const created = yield* teamOf([{ role: "implementation" }, { role: "test" }]);

    assert.deepStrictEqual(
      created.members.map((route) => route.noCandidate?.role ?? null),
      [null, "test"],
    );
    assert.deepStrictEqual(
      created.members[1]?.noCandidate?.skipped.map((skip) => skip.reason),
      ["unavailable"],
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("replays a repeated create without routing or writing the team again", () => {
  const harness = mailHarness();
  return Effect.gen(function* () {
    yield* migrateMail;
    const first = yield* teamOf([{ role: "implementation" }, { role: "test" }]);
    const replay = yield* teamOf([{ role: "implementation" }, { role: "test" }]);

    assert.isFalse(replay.created);
    assert.equal(replay.task.taskId, first.task.taskId);
    assert.equal(harness.selects.length, 2);
    assert.deepStrictEqual(
      replay.members.map((route) => route.member.memberId).toSorted(),
      first.members.map((route) => route.member.memberId).toSorted(),
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("stores the policy snapshot on the card a task belongs to, once", () => {
  const harness = mailHarness();
  return Effect.gen(function* () {
    yield* migrateMail;
    const mail = yield* MailService;
    const input: CreateMailTaskInput = {
      callerThreadId: LEAD,
      clientRequestId: "request:card",
      title: "Card work",
      brief: "Do it.",
      level: "medium",
      cardId: "card:one",
      members: [{ role: "implementation" }],
    };
    yield* mail.createTask(input);
    yield* mail.createTask(input);
    yield* teamOf([{ role: "test" }], "request:loose");
    assert.deepStrictEqual(harness.cardSnapshots, [
      { cardId: "card:one", snapshotJson: '{"revision":3}' },
    ]);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("refuses a task for an unknown board card and creates nothing", () => {
  const harness = mailHarness();
  return Effect.gen(function* () {
    yield* migrateMail;
    const mail = yield* MailService;
    const repository = yield* MailRepository;
    const input: CreateMailTaskInput = {
      callerThreadId: LEAD,
      clientRequestId: "request:missing-card",
      title: "Card work",
      brief: "Do it.",
      level: "medium",
      cardId: "card:missing",
      members: [{ role: "implementation" }],
    };
    assert.equal(yield* refusal(mail.createTask(input)), "card_not_found");
    assert.isNull(
      yield* repository.getTaskByRequestKey({
        createdByThreadId: LEAD,
        clientRequestId: "request:missing-card",
      }),
    );
    assert.equal(harness.selects.length, 0);
    assert.deepStrictEqual(harness.cardSnapshots, []);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("refuses a repeated create whose payload changed", () => {
  const harness = mailHarness();
  return Effect.gen(function* () {
    yield* migrateMail;
    yield* teamOf([{ role: "implementation" }]);
    assert.equal(
      yield* refusal(teamOf([{ role: "implementation" }], "request:team", "Other title")),
      "idempotency_conflict",
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("grants documents:write only to a general member", () => {
  const harness = mailHarness();
  return Effect.gen(function* () {
    yield* migrateMail;
    assert.equal(
      yield* refusal(teamOf([{ role: "implementation", documentsWrite: true }])),
      "capability_denied",
    );
    const general = yield* teamOf([{ role: "general", documentsWrite: true }], "request:general");
    assert.deepStrictEqual(
      general.members.map((route) => route.member.documentsWrite),
      [true],
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("refuses a lead role, an empty team, a bad budget and a blank title", () => {
  const harness = mailHarness();
  return Effect.gen(function* () {
    yield* migrateMail;
    assert.equal(yield* refusal(teamOf([{ role: "lead" }])), "invalid_role");
    assert.equal(yield* refusal(teamOf([])), "invalid_request");
    assert.equal(
      yield* refusal(teamOf([{ role: "test", responseBudgetSeconds: 30 }])),
      "invalid_request",
    );
    assert.equal(
      yield* refusal(teamOf([{ role: "test" }], "request:blank", "   ")),
      "invalid_request",
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("refuses mail work while the mail feature is off", () => {
  const harness = mailHarness({ enabled: false });
  return Effect.gen(function* () {
    yield* migrateMail;
    assert.equal(yield* refusal(teamOf([{ role: "implementation" }])), "mail_disabled");
    assert.equal(yield* refusal(sendAs(LEAD, "task:none", "human", "info")), "mail_disabled");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("refuses a team while no routing policy is applied", () => {
  const harness = mailHarness({ applied: false });
  return Effect.gen(function* () {
    yield* migrateMail;
    assert.equal(yield* refusal(teamOf([{ role: "implementation" }])), "mail_disabled");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("sends a lead letter to every member of the addressed role", () => {
  const harness = mailHarness();
  return Effect.gen(function* () {
    yield* migrateMail;
    const created = yield* teamOf([
      { role: "implementation" },
      { role: "implementation" },
      { role: "test" },
    ]);
    const sent = yield* sendAs(LEAD, created.task.taskId, "role:implementation", "request");

    assert.isTrue(sent.created);
    assert.equal(sent.letter.recipient, "role:implementation");
    assert.deepStrictEqual(
      sent.deliveries.map((delivery) => delivery.memberId).toSorted(),
      idsOf(created, "implementation"),
    );
    assert.deepStrictEqual(
      sent.deliveries.map((delivery) => delivery.state),
      ["pending", "pending"],
    );
    assert.deepStrictEqual(sent.noCandidate, []);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("keeps a letter to a member without a route pending and reports the route", () => {
  const harness = mailHarness({ routable: ALL_ROUTING_ROLES.filter((role) => role !== "test") });
  return Effect.gen(function* () {
    yield* migrateMail;
    const created = yield* teamOf([{ role: "test" }]);
    const taskId = created.task.taskId;
    const sent = yield* sendAs(LEAD, taskId, "role:test", "request");

    assert.deepStrictEqual(
      sent.noCandidate.map((gap) => [gap.memberId, gap.role]),
      [[idsOf(created, "test")[0], "test"]],
    );
    assert.deepStrictEqual(
      sent.deliveries.map((delivery) => delivery.state),
      ["pending"],
    );

    const replay = yield* sendAs(LEAD, taskId, "role:test", "request");
    assert.isFalse(replay.created);
    assert.equal(replay.letter.letterId, sent.letter.letterId);
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "lets the lead write to the human and to declared roles, with the participant kinds",
  () => {
    const harness = mailHarness();
    return Effect.gen(function* () {
      yield* migrateMail;
      const created = yield* teamOf([{ role: "implementation" }, { role: "test" }]);
      const taskId = created.task.taskId;

      const toHuman = yield* sendAs(LEAD, taskId, "human", "approve", "Ship it?", "request:human");
      assert.deepStrictEqual(
        toHuman.deliveries.map((delivery) => delivery.recipient),
        ["human"],
      );
      assert.equal(
        yield* refusal(sendAs(LEAD, taskId, "role:implementation", "approve", "x", "request:a")),
        "kind_denied",
      );
      assert.equal(
        yield* refusal(sendAs(LEAD, taskId, "role:research", "request", "x", "request:b")),
        "address_denied",
      );
      assert.equal(
        yield* refusal(sendAs(LEAD, taskId, "lead", "info", "x", "request:c")),
        "address_denied",
      );
      assert.equal(
        yield* refusal(sendAs(LEAD, taskId, "role:lead", "request", "x", "request:d")),
        "invalid_role",
      );
      assert.equal(
        yield* refusal(sendAs(LEAD, taskId, "everyone", "info", "x", "request:e")),
        "invalid_request",
      );
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("lets a participant write only to the lead, with its own kinds", () => {
  const harness = mailHarness();
  return Effect.gen(function* () {
    yield* migrateMail;
    const created = yield* teamOf([{ role: "implementation" }]);
    const taskId = created.task.taskId;
    yield* bindParticipant(idsOf(created, "implementation")[0] ?? "", WORKER);

    const answer = yield* sendAs(WORKER, taskId, "lead", "answer", "Done.", "request:answer");
    assert.deepStrictEqual(
      answer.deliveries.map((delivery) => [delivery.recipient, delivery.participantThreadId]),
      [["lead", LEAD]],
    );
    assert.equal(
      yield* refusal(sendAs(WORKER, taskId, "lead", "request", "x", "request:req")),
      "kind_denied",
    );
    assert.equal(
      yield* refusal(sendAs(WORKER, taskId, "role:test", "info", "x", "request:role")),
      "address_denied",
    );
    assert.equal(
      yield* refusal(sendAs(WORKER, taskId, "human", "info", "x", "request:human")),
      "address_denied",
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("lets only an architect answer with approve or changes", () => {
  const harness = mailHarness();
  return Effect.gen(function* () {
    yield* migrateMail;
    const created = yield* teamOf([{ role: "architect" }, { role: "implementation" }]);
    const taskId = created.task.taskId;
    yield* bindParticipant(idsOf(created, "architect")[0] ?? "", CONSULTANT);
    yield* bindParticipant(idsOf(created, "implementation")[0] ?? "", WORKER);

    const approved = yield* sendAs(CONSULTANT, taskId, "lead", "approve", "OK.", "request:ok");
    assert.equal(approved.letter.kind, "approve");
    const changed = yield* sendAs(CONSULTANT, taskId, "lead", "changes", "Quote.", "request:fix");
    assert.equal(changed.letter.kind, "changes");
    assert.equal(
      yield* refusal(sendAs(WORKER, taskId, "lead", "approve", "OK.", "request:worker")),
      "kind_denied",
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("refuses a sender outside the task, an unknown task and an unknown reply target", () => {
  const harness = mailHarness();
  return Effect.gen(function* () {
    yield* migrateMail;
    const created = yield* teamOf([{ role: "implementation" }]);
    const taskId = created.task.taskId;
    assert.equal(
      yield* refusal(sendAs("thread:stranger", taskId, "human", "info")),
      "capability_denied",
    );
    assert.equal(yield* refusal(sendAs(LEAD, "task:missing", "human", "info")), "task_not_found");
    const reply = Effect.gen(function* () {
      const mail = yield* MailService;
      return yield* mail.sendLetter({
        callerThreadId: LEAD,
        taskId,
        to: "human",
        kind: "info",
        body: "x",
        replyToLetterId: "letter:missing",
        clientRequestId: "request:reply",
      });
    });
    assert.equal(yield* refusal(reply), "letter_not_found");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("replays a repeated letter once and refuses a changed payload", () => {
  const harness = mailHarness();
  return Effect.gen(function* () {
    yield* migrateMail;
    const created = yield* teamOf([{ role: "implementation" }]);
    const taskId = created.task.taskId;
    const first = yield* sendAs(
      LEAD,
      taskId,
      "role:implementation",
      "request",
      "Start.",
      "request:go",
    );

    const repeated = yield* sendAs(
      LEAD,
      taskId,
      "role:implementation",
      "request",
      "Start.",
      "request:go",
    );
    assert.isFalse(repeated.created);
    assert.equal(repeated.letter.letterId, first.letter.letterId);
    assert.equal(repeated.deliveries.length, 1);

    assert.equal(
      yield* refusal(
        sendAs(LEAD, taskId, "role:implementation", "request", "Other.", "request:go"),
      ),
      "idempotency_conflict",
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("launches a threadless routed member once and reuses its thread", () => {
  const harness = mailHarness();
  return Effect.gen(function* () {
    yield* migrateMail;
    const created = yield* teamOf([{ role: "implementation" }]);
    const taskId = created.task.taskId;
    const member = idsOf(created, "implementation")[0] ?? "";

    const sent = yield* sendAs(LEAD, taskId, "role:implementation", "request", "Start.");
    assert.deepStrictEqual(sent.launched, [
      { memberId: member, participantThreadId: `thread:participant:${member}` },
    ]);
    assert.deepStrictEqual(sent.launchFailures, []);
    assert.equal(harness.launches.length, 1);
    assert.equal(harness.launches[0]?.letterBody, "Start.");

    // The recorded thread answers as the participant without another launch.
    const answer = yield* sendAs(
      `thread:participant:${member}`,
      taskId,
      "lead",
      "answer",
      "Done.",
      "request:answer",
    );
    assert.isTrue(answer.created);
    const followUp = yield* sendAs(
      LEAD,
      taskId,
      "role:implementation",
      "request",
      "Again.",
      "request:again",
    );
    assert.deepStrictEqual(followUp.launched, []);
    assert.deepStrictEqual(followUp.launchFailures, []);
    assert.equal(harness.launches.length, 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("keeps the delivery pending when the launch is refused and retries it", () => {
  const fail = new Set<string>();
  const harness = mailHarness({ launchFail: fail });
  return Effect.gen(function* () {
    yield* migrateMail;
    const created = yield* teamOf([{ role: "implementation" }]);
    const taskId = created.task.taskId;
    const member = idsOf(created, "implementation")[0] ?? "";
    fail.add(member);

    const refused = yield* sendAs(LEAD, taskId, "role:implementation", "request", "Start.");
    assert.isTrue(refused.created);
    assert.deepStrictEqual(refused.launched, []);
    assert.equal(refused.launchFailures.length, 1);
    assert.equal(refused.launchFailures[0]?.memberId, member);
    assert.deepStrictEqual(
      refused.deliveries.map((delivery) => delivery.state),
      ["pending"],
    );

    // A resend heals the threadless member once the launch succeeds.
    fail.delete(member);
    const retried = yield* sendAs(
      LEAD,
      taskId,
      "role:implementation",
      "request",
      "Start again.",
      "request:retry",
    );
    assert.deepStrictEqual(retried.launched, [
      { memberId: member, participantThreadId: `thread:participant:${member}` },
    ]);
    assert.deepStrictEqual(retried.launchFailures, []);
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "closes a task only for the lead, after its members finish, and then refuses letters",
  () => {
    const harness = mailHarness();
    return Effect.gen(function* () {
      yield* migrateMail;
      const created = yield* teamOf([{ role: "implementation" }]);
      const member = idsOf(created, "implementation")[0] ?? "";
      yield* bindParticipant(member, WORKER);

      const close = (callerThreadId: string) => closeAs(callerThreadId, created.task);
      assert.equal(yield* refusal(close(WORKER)), "capability_denied");
      assert.equal(yield* refusal(close(LEAD)), "members_active");

      yield* finishMember(member);
      const closed = yield* close(LEAD);
      assert.equal(closed.status, "closed");
      assert.equal(closed.outcome, "succeeded");

      assert.equal(yield* refusal(close(LEAD)), "task_closed");
      assert.equal(
        yield* refusal(sendAs(LEAD, created.task.taskId, "human", "info", "x", "request:late")),
        "task_closed",
      );
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("routes plan letters by phase and records the gate calls", () => {
  const harness = mailHarness();
  return Effect.gen(function* () {
    yield* migrateMail;
    const mail = yield* MailService;
    const created = yield* mail.createTask({
      callerThreadId: LEAD,
      clientRequestId: "request:plan-team",
      title: "Plan work",
      brief: "Write the plan.",
      level: "medium",
      cardId: "card:one",
      members: [{ role: "planner" }, { role: "architect" }],
    });
    const taskId = created.task.taskId;
    const draft = (to: string, clientRequestId: string) =>
      mail.sendLetter({
        callerThreadId: LEAD,
        taskId,
        to,
        kind: "request",
        body: "Draft it.",
        clientRequestId,
        plan: { phase: "draft" },
      });
    assert.equal(
      yield* refusal(draft("role:architect", "request:draft-wrong")),
      "plan_phase_invalid",
    );
    assert.equal(
      yield* refusal(
        mail.sendLetter({
          callerThreadId: LEAD,
          taskId,
          to: "role:planner",
          kind: "request",
          body: "Review it.",
          clientRequestId: "request:review-wrong",
          plan: { phase: "review" },
        }),
      ),
      "plan_phase_invalid",
    );
    const sent = yield* draft("role:planner", "request:draft");
    assert.equal(sent.letter.planPhase, "draft");
    assert.deepStrictEqual(harness.planChecks, [{ cardId: "card:one", roleId: "planner" }]);
    assert.deepStrictEqual(harness.planRecords, [{ cardId: "card:one", phase: "draft" }]);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("refuses plan letters without a board card and maps gate refusals", () => {
  const harness = mailHarness({ planRefuse: "plan_not_accepted" });
  return Effect.gen(function* () {
    yield* migrateMail;
    const mail = yield* MailService;
    const unlinked = yield* teamOf([{ role: "implementation" }], "request:unlinked");
    assert.equal(
      yield* refusal(
        mail.sendLetter({
          callerThreadId: LEAD,
          taskId: unlinked.task.taskId,
          to: "role:implementation",
          kind: "request",
          body: "Build it.",
          clientRequestId: "request:implement-unlinked",
          plan: { phase: "implement", step: "P1" },
        }),
      ),
      "invalid_request",
    );
    const linked = yield* mail.createTask({
      callerThreadId: LEAD,
      clientRequestId: "request:plan-team",
      title: "Plan work",
      brief: "Build it.",
      level: "medium",
      cardId: "card:one",
      members: [{ role: "implementation" }],
    });
    assert.equal(
      yield* refusal(
        mail.sendLetter({
          callerThreadId: LEAD,
          taskId: linked.task.taskId,
          to: "role:implementation",
          kind: "request",
          body: "Build it.",
          clientRequestId: "request:implement",
          plan: { phase: "implement", step: "P1" },
        }),
      ),
      "plan_not_accepted",
    );
    assert.deepStrictEqual(harness.planRecords, []);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("checks plain requests to gated roles on card-linked tasks only", () => {
  const harness = mailHarness({ planRefuse: "plan_phase_required" });
  return Effect.gen(function* () {
    yield* migrateMail;
    const mail = yield* MailService;
    const linked = yield* mail.createTask({
      callerThreadId: LEAD,
      clientRequestId: "request:linked-team",
      title: "Build work",
      brief: "Build it.",
      level: "medium",
      cardId: "card:one",
      members: [{ role: "implementation" }],
    });
    assert.equal(
      yield* refusal(
        mail.sendLetter({
          callerThreadId: LEAD,
          taskId: linked.task.taskId,
          to: "role:implementation",
          kind: "request",
          body: "Build it.",
          clientRequestId: "request:plain",
        }),
      ),
      "plan_phase_required",
    );
    assert.deepStrictEqual(harness.planChecks, [{ cardId: "card:one", roleId: "implementation" }]);
    const unlinked = yield* teamOf([{ role: "implementation" }], "request:unlinked-team");
    const sent = yield* mail.sendLetter({
      callerThreadId: LEAD,
      taskId: unlinked.task.taskId,
      to: "role:implementation",
      kind: "request",
      body: "Build it.",
      clientRequestId: "request:plain-unlinked",
    });
    assert.equal(sent.letter.kind, "request");
    assert.lengthOf(harness.planChecks, 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("keeps checking plain requests to gated roles while planning is off", () => {
  const harness = mailHarness({ planRefuse: "plan_phase_required", planning: false });
  return Effect.gen(function* () {
    yield* migrateMail;
    const mail = yield* MailService;
    const linked = yield* mail.createTask({
      callerThreadId: LEAD,
      clientRequestId: "request:linked-team",
      title: "Build work",
      brief: "Build it.",
      level: "medium",
      cardId: "card:one",
      members: [{ role: "test" }],
    });
    assert.equal(
      yield* refusal(
        mail.sendLetter({
          callerThreadId: LEAD,
          taskId: linked.task.taskId,
          to: "role:test",
          kind: "request",
          body: "Test it.",
          clientRequestId: "request:plain-test",
        }),
      ),
      "plan_phase_required",
    );
    assert.deepStrictEqual(harness.planChecks, [{ cardId: "card:one", roleId: "test" }]);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("records the implement letter at send time", () => {
  const harness = mailHarness();
  return Effect.gen(function* () {
    yield* migrateMail;
    const mail = yield* MailService;
    const created = yield* mail.createTask({
      callerThreadId: LEAD,
      clientRequestId: "request:plan-team",
      title: "Plan work",
      brief: "Build it.",
      level: "medium",
      cardId: "card:one",
      members: [{ role: "implementation" }],
    });
    const sent = yield* mail.sendLetter({
      callerThreadId: LEAD,
      taskId: created.task.taskId,
      to: "role:implementation",
      kind: "request",
      body: "Build P1.",
      clientRequestId: "request:implement",
      plan: { phase: "implement", step: "P1" },
    });
    assert.equal(sent.letter.planPhase, "implement");
    assert.deepStrictEqual(harness.planRecords, [{ cardId: "card:one", phase: "implement" }]);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("rolls the letter back when its plan transition fails, and applies it once", () => {
  const harness = mailHarness({ planRecordsFail: true });
  return Effect.gen(function* () {
    yield* migrateMail;
    const mail = yield* MailService;
    const team = yield* mail.createTask({
      callerThreadId: LEAD,
      clientRequestId: "request:review-team",
      title: "Review plan",
      brief: "Review it.",
      level: "medium",
      cardId: "card:one",
      members: [{ role: "architect" }],
    });
    const review = () =>
      mail.sendLetter({
        callerThreadId: LEAD,
        taskId: team.task.taskId,
        to: "role:architect",
        kind: "request",
        body: "Review the plan.",
        clientRequestId: "request:review",
        plan: { phase: "review" },
      });
    const timeline = () =>
      mail.readTask({ taskId: team.task.taskId, callerThreadId: LEAD, limit: 10 });
    const before = (yield* timeline()).entries.length;
    assert.equal(yield* refusal(review()), "plan_transition_invalid");
    assert.equal((yield* timeline()).entries.length, before);
    harness.planFailRecords.current = false;
    const retried = yield* review();
    assert.isTrue(retried.created);
    assert.deepStrictEqual(harness.planRecords, [{ cardId: "card:one", phase: "review" }]);
    const replayed = yield* review();
    assert.isFalse(replayed.created);
    assert.equal(replayed.letter.letterId, retried.letter.letterId);
    assert.lengthOf(harness.planRecords, 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("starts one planner thread per card and reuses it in later tasks", () => {
  const harness = mailHarness();
  return Effect.gen(function* () {
    yield* migrateMail;
    const mail = yield* MailService;
    const first = yield* mail.createTask({
      callerThreadId: LEAD,
      clientRequestId: "request:plan-one",
      title: "Plan work",
      brief: "Write the plan.",
      level: "medium",
      cardId: "card:one",
      members: [{ role: "planner" }],
    });
    const draftOne = yield* mail.sendLetter({
      callerThreadId: LEAD,
      taskId: first.task.taskId,
      to: "role:planner",
      kind: "request",
      body: "Draft it.",
      clientRequestId: "request:draft-one",
      plan: { phase: "draft" },
    });
    const plannerThread = draftOne.launched[0]!.participantThreadId;
    assert.deepStrictEqual(harness.planBinds, [{ cardId: "card:one", threadId: plannerThread }]);
    yield* sendAs(plannerThread, first.task.taskId, "lead", "answer", "Drafted.", "request:answer");
    assert.deepStrictEqual(harness.planAnswers, ["card:one"]);
    const second = yield* mail.createTask({
      callerThreadId: LEAD,
      clientRequestId: "request:plan-two",
      title: "Plan again",
      brief: "Revise the plan.",
      level: "medium",
      cardId: "card:one",
      members: [{ role: "planner" }],
    });
    const draftTwo = yield* mail.sendLetter({
      callerThreadId: LEAD,
      taskId: second.task.taskId,
      to: "role:planner",
      kind: "request",
      body: "Draft again.",
      clientRequestId: "request:draft-two",
      plan: { phase: "draft" },
    });
    assert.lengthOf(harness.launches, 1);
    assert.deepStrictEqual(
      draftTwo.deliveries.map((delivery) => delivery.participantThreadId),
      [plannerThread],
    );
    assert.lengthOf(harness.planBinds, 1);
  }).pipe(Effect.provide(harness.layer));
});

it("matches the kind matrix for the system, the lead and participants", () => {
  assert.isTrue(mailKindAllowed({ kind: "system" }, "lead", "blocked"));
  assert.isFalse(mailKindAllowed({ kind: "system" }, "lead", "request"));
  assert.isFalse(mailKindAllowed({ kind: "system" }, "human", "info"));
  assert.isFalse(mailKindAllowed({ kind: "lead" }, "participant", "approve"));
  assert.isTrue(mailKindAllowed({ kind: "participant", roleId: "architect" }, "lead", "changes"));
  assert.isFalse(
    mailKindAllowed({ kind: "participant", roleId: "implementation" }, "lead", "changes"),
  );
  assert.isFalse(mailKindAllowed({ kind: "participant", roleId: "planner" }, "lead", "request"));
});

const flagGateLayer = (flag: Ref.Ref<boolean>) =>
  Layer.succeed(
    FeatureGate,
    FeatureGate.of({
      states: Effect.die("unused as a value"),
      state: () => Effect.die("unused as a value"),
      isEffective: () => Ref.get(flag),
      require: () =>
        Ref.get(flag).pipe(
          Effect.flatMap((on) =>
            on
              ? Effect.void
              : Effect.fail(
                  new FeatureDisabledError({ feature: "mail", code: "feature_disabled" }),
                ),
          ),
        ),
    }),
  );

it.effect("reads history while the mail feature is off without marking deliveries", () => {
  const flagHarness = (flag: Ref.Ref<boolean>) => {
    const layer = mailServiceLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          routingFake({}).layer,
          flagGateLayer(flag),
          cryptoLayer,
          policyEvidenceFake().layer,
          launcherFake().layer,
          classifierFake().layer,
          normalServicePolicyLayer,
          settingsLayer(),
          planGateFake().layer,
        ),
      ),
      Layer.provideMerge(databaseLayer),
    );
    return { layer };
  };
  return Effect.gen(function* () {
    const flag = yield* Ref.make(true);
    const harness = flagHarness(flag);
    yield* Effect.gen(function* () {
      yield* migrateMail;
      const created = yield* teamOf([{ role: "implementation" }]);
      const taskId = created.task.taskId;
      yield* bindParticipant(idsOf(created, "implementation")[0] ?? "", WORKER);
      const sent = yield* sendAs(LEAD, taskId, "role:implementation", "request", "Start.");
      const delivery = sent.deliveries[0]!;
      const repository = yield* MailRepository;
      yield* repository.markDeliveryDelivered({
        deliveryId: delivery.deliveryId,
        at: "2026-11-04T01:00:00.000Z",
      });
      yield* sendAs(LEAD, taskId, "human", "info", "Hello.", "request:hello");
      yield* Ref.set(flag, false);

      const mail = yield* MailService;
      assert.equal(
        yield* refusal(sendAs(LEAD, taskId, "human", "info", "Blocked.", "request:blocked")),
        "mail_disabled",
      );
      const entries = yield* mail.listTimeline({ taskId, callerThreadId: LEAD, limit: 10 });
      assert.equal(entries.length, 2);
      assert.equal(entries[0]!.letter.body, "Hello.");
      const task = yield* mail.readTask({ taskId, callerThreadId: LEAD, limit: 10 });
      assert.equal(task.entries.length, 2);
      const letter = yield* mail.readLetter({
        letterId: sent.letter.letterId,
        callerThreadId: WORKER,
      });
      assert.equal(letter.letter.body, "Start.");
      assert.equal((yield* repository.getDelivery(delivery.deliveryId))?.state, "delivered");
    }).pipe(Effect.provide(harness.layer));
  });
});

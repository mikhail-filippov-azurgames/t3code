import { assert, it } from "@effect/vitest";
import type { RoutingRoleId } from "@t3tools/ft3-policies/routingPolicy";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ALL_ROUTING_ROLES, mailHarness, migrateMail } from "./mail.testkit.ts";
import {
  type CreateMailTaskInput,
  type MailMemberRequest,
  MailService,
  MailServiceError,
} from "./service.ts";
import { mailMemberLaunch } from "./toolContracts.ts";

const LEAD = "thread:lead";
// A fixed seed keeps every run reproducible; the replay token of a failure pins it further.
const SEED = 20261117;
const options = (runs: number) => ({ arbitrary: { runs, seed: SEED } });

const isMailServiceError = Schema.is(MailServiceError);
const refusal = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(
    Effect.map((error) => (isMailServiceError(error) ? error.code : error._tag)),
  );

const literal = <const A extends ReadonlyArray<string>>(values: A) =>
  Arbitrary.schema(Schema.Literals(values));
const intBetween = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));
const words = (min: number, max: number) =>
  Arbitrary.array(literal(["alpha", "beta", "gamma", "delta", "omega"]), {
    minLength: min,
    maxLength: max,
  }).pipe(Arbitrary.map((parts) => parts.join(" ")));

const roleArb = literal(ALL_ROUTING_ROLES as ReadonlyArray<RoutingRoleId>);
const memberArb = Arbitrary.all({
  role: roleArb,
  specialization: literal(["", "codex", "ui"]),
  level: literal(["", "low", "medium", "high"]),
}).pipe(
  Arbitrary.map(({ role, specialization, level }): MailMemberRequest => ({
    role,
    ...(specialization === "" ? {} : { specialization }),
    ...(level === "" ? {} : { level: level as "low" | "medium" | "high" }),
  })),
);
const taskArb = Arbitrary.all({
  title: words(1, 3),
  brief: words(1, 6),
  level: literal(["low", "medium", "high"]),
  members: Arbitrary.array(memberArb, { minLength: 1, maxLength: 4 }),
});
type TaskPayload = Omit<CreateMailTaskInput, "callerThreadId" | "clientRequestId">;

const createAs = (payload: TaskPayload, clientRequestId = "request:prop") =>
  Effect.gen(function* () {
    const mail = yield* MailService;
    return yield* mail.createTask({ ...payload, callerThreadId: LEAD, clientRequestId });
  });

const countRows = (table: "ft3_mail_tasks" | "ft3_mail_members" | "ft3_mail_letters") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)}`;
    return Number(rows[0]?.n ?? 0);
  });

/** The addresses `next` asks to start and the ones it reports as unroutable, as written. */
const parseNext = (next: string | null) => {
  const pending = next?.match(/Participants (.+?) have not started\./)?.[1]?.split(", ") ?? [];
  const unavailable = [...(next ?? "").matchAll(/(role:\S+) has no route\/model available/g)].map(
    (match) => match[1] ?? "",
  );
  return { pending, unavailable };
};

const sortedNext = (next: string | null) => {
  const { pending, unavailable } = parseNext(next);
  return { pending: pending.toSorted(), unavailable: unavailable.toSorted() };
};

/** One field of a task payload changed so the stored fingerprint no longer matches. */
const mutationArb = literal(["title", "brief", "level", "members"]);
const mutateTask = (payload: TaskPayload, field: string): TaskPayload => {
  switch (field) {
    case "title":
      return { ...payload, title: `${payload.title} changed` };
    case "brief":
      return { ...payload, brief: `${payload.brief}.` };
    case "level":
      return { ...payload, level: payload.level === "low" ? "high" : "low" };
    default:
      return { ...payload, members: [...payload.members, { role: "review" }] };
  }
};

it.effect.prop(
  "replays a repeated mail_task_create with the same key and payload as the first result",
  { task: taskArb, repeats: intBetween(1, 3) },
  ({ task, repeats }) => {
    const harness = mailHarness();
    return Effect.gen(function* () {
      yield* migrateMail;
      const first = yield* createAs(task);
      const ids = first.members.map(({ member }) => member.memberId).toSorted();
      for (let index = 0; index < repeats; index++) {
        const replay = yield* createAs(task);
        assert.isFalse(replay.created);
        assert.equal(replay.task.taskId, first.task.taskId);
        assert.deepStrictEqual(replay.members.map(({ member }) => member.memberId).toSorted(), ids);
        // Replay lists members by (created_at, member_id), so only the address sets must match.
        assert.deepStrictEqual(sortedNext(replay.next), sortedNext(first.next));
      }
      assert.equal(yield* countRows("ft3_mail_tasks"), 1);
      assert.equal(yield* countRows("ft3_mail_members"), task.members.length);
      assert.equal(harness.selects.length, task.members.length);
    }).pipe(Effect.provide(harness.layer));
  },
  options(60),
);

it.effect.prop(
  "refuses mail_task_create when the same key carries a changed payload",
  { task: taskArb, field: mutationArb },
  ({ task, field }) => {
    const harness = mailHarness();
    return Effect.gen(function* () {
      yield* migrateMail;
      yield* createAs(task);
      assert.equal(yield* refusal(createAs(mutateTask(task, field))), "idempotency_conflict");
      assert.equal(yield* countRows("ft3_mail_tasks"), 1);
      assert.equal(yield* countRows("ft3_mail_members"), task.members.length);
    }).pipe(Effect.provide(harness.layer));
  },
  options(60),
);

const sendLead = (taskId: string, body: string, clientRequestId: string) =>
  Effect.gen(function* () {
    const mail = yield* MailService;
    return yield* mail.sendLetter({
      callerThreadId: LEAD,
      taskId,
      to: "role:implementation",
      kind: "request",
      body,
      clientRequestId,
    });
  });

it.effect.prop(
  "replays a repeated mail_send once and refuses the same key with a changed body",
  { body: words(1, 5), other: words(1, 5), repeats: intBetween(1, 3) },
  ({ body, other, repeats }) => {
    const harness = mailHarness();
    return Effect.gen(function* () {
      yield* migrateMail;
      const created = yield* createAs({
        title: "Task",
        brief: "Brief.",
        level: "medium",
        members: [{ role: "implementation" }],
      });
      const taskId = created.task.taskId;
      const first = yield* sendLead(taskId, body, "request:letter");
      for (let index = 0; index < repeats; index++) {
        const replay = yield* sendLead(taskId, body, "request:letter");
        assert.isFalse(replay.created);
        assert.equal(replay.letter.letterId, first.letter.letterId);
        assert.deepStrictEqual(
          replay.deliveries.map((delivery) => delivery.deliveryId),
          first.deliveries.map((delivery) => delivery.deliveryId),
        );
      }
      if (other !== body) {
        assert.equal(
          yield* refusal(sendLead(taskId, other, "request:letter")),
          "idempotency_conflict",
        );
      }
      assert.equal(yield* countRows("ft3_mail_letters"), 1);
      assert.equal(harness.launches.length, 1);
    }).pipe(Effect.provide(harness.layer));
  },
  options(60),
);

it.prop(
  "derives a member launch by D1: closed over started over not_started",
  {
    status: literal(["active", "closed"]),
    participantThreadId: Arbitrary.schema(Schema.NullOr(Schema.String)),
  },
  ({ status, participantThreadId }) => {
    const expected =
      status === "closed" ? "closed" : participantThreadId === null ? "not_started" : "started";
    assert.equal(mailMemberLaunch({ status, participantThreadId }), expected);
  },
  options(100),
);

const addressOf = (member: { readonly roleId: string; readonly specialization: string | null }) =>
  member.specialization === null
    ? `role:${member.roleId}`
    : `role:${member.roleId}/${member.specialization}`;

it.effect.prop(
  "names in next only not_started members, once each, and lists unroutable ones apart",
  {
    members: Arbitrary.array(memberArb, { minLength: 1, maxLength: 5 }),
    routable: Arbitrary.array(roleArb, { maxLength: 7 }),
    states: Arbitrary.array(literal(["not_started", "started", "closed", "closed_started"]), {
      minLength: 5,
      maxLength: 5,
    }),
  },
  ({ members, routable, states }) => {
    const harness = mailHarness({ routable });
    return Effect.gen(function* () {
      yield* migrateMail;
      const payload = { title: "Team", brief: "Brief.", level: "medium" as const, members };
      const created = yield* createAs(payload);
      const sql = yield* SqlClient.SqlClient;
      for (const [index, route] of created.members.entries()) {
        const state = states[index] ?? "not_started";
        const memberId = route.member.memberId;
        if (state === "started" || state === "closed_started") {
          yield* sql`UPDATE ft3_mail_members SET participant_thread_id = ${`thread:${memberId}`} WHERE member_id = ${memberId}`;
        }
        if (state === "closed" || state === "closed_started") {
          yield* sql`UPDATE ft3_mail_members SET status = 'closed' WHERE member_id = ${memberId}`;
        }
      }
      const replay = yield* createAs(payload);

      const expectedPending = new Set<string>();
      const expectedUnavailable = new Set<string>();
      for (const route of replay.members) {
        assert.equal(route.launch, mailMemberLaunch(route.member));
        if (route.launch !== "not_started") continue;
        (route.noCandidate === null ? expectedPending : expectedUnavailable).add(
          addressOf(route.member),
        );
      }
      const { pending, unavailable } = parseNext(replay.next);
      assert.equal(new Set(pending).size, pending.length, "pending addresses repeat");
      assert.equal(new Set(unavailable).size, unavailable.length, "unroutable addresses repeat");
      assert.deepStrictEqual(pending.toSorted(), [...expectedPending].toSorted());
      assert.deepStrictEqual(unavailable.toSorted(), [...expectedUnavailable].toSorted());
      if (expectedPending.size === 0 && expectedUnavailable.size === 0) {
        assert.isNull(replay.next);
      }
    }).pipe(Effect.provide(harness.layer));
  },
  options(60),
);

it.effect.prop(
  "pages the timeline newest first and returns each letter exactly once",
  { letters: intBetween(1, 12), limit: intBetween(1, 5) },
  ({ letters, limit }) => {
    const harness = mailHarness();
    return Effect.gen(function* () {
      yield* migrateMail;
      const mail = yield* MailService;
      const created = yield* createAs({
        title: "Task",
        brief: "Brief.",
        level: "medium",
        members: [{ role: "implementation" }],
      });
      const taskId = created.task.taskId;
      const sent: Array<string> = [];
      for (let index = 0; index < letters; index++) {
        sent.push(
          (yield* sendLead(taskId, `Letter ${index}.`, `request:${index}`)).letter.letterId,
        );
      }

      const seen: Array<{ readonly letterId: string; readonly sequence: number }> = [];
      let before: string | undefined;
      for (let page = 0; page <= letters; page++) {
        const read = yield* mail.readTask({
          taskId,
          callerThreadId: LEAD,
          limit,
          ...(before === undefined ? {} : { beforeLetterId: before }),
        });
        assert.isAtMost(read.entries.length, limit);
        if (read.entries.length === 0) break;
        seen.push(
          ...read.entries.map(({ letter }) => ({
            letterId: letter.letterId,
            sequence: letter.sequence,
          })),
        );
        before = read.entries.at(-1)?.letter.letterId;
      }
      const sequences = seen.map((entry) => entry.sequence);
      assert.deepStrictEqual(
        sequences,
        sequences.toSorted((a, b) => b - a),
      );
      assert.equal(new Set(sequences).size, sequences.length);
      assert.deepStrictEqual(
        seen.map((entry) => entry.letterId),
        sent.toReversed(),
      );
    }).pipe(Effect.provide(harness.layer));
  },
  options(40),
);

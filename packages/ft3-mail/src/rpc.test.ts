import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/sql/Migrator";

import { MailRepository, layer as mailRepositoryLayer } from "./repository.ts";
import type { CreateTaskInput, AppendLetterInput } from "./repository.ts";
import { FT3_MAIL_WS_METHODS, mailRpcHandlers } from "./rpc.ts";
import { MailService } from "./service.ts";
import { migrations } from "./migrations.ts";

const run = Migrator.make({});
const loader = Migrator.fromRecord(migrations);
const migrate = run({ loader, table: "ft3_migrations" });

const testLayer = mailRepositoryLayer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

// mail.timeline asks MailService after the ownership check; the scoping tests
// never reach it, only the service type has to exist.
const unusedMailService = (() => Effect.die("unused mail service method")) as never;
const mailServiceStubLayer = Layer.succeed(
  MailService,
  MailService.of({
    createTask: unusedMailService,
    setMemberModel: unusedMailService,
    sendLetter: unusedMailService,
    setLetterKind: unusedMailService,
    openRound: unusedMailService,
    closeRound: unusedMailService,
    readLetter: unusedMailService,
    readTask: unusedMailService,
    listTimeline: () => Effect.succeed([]),
    timeoutOverdueDeliveries: unusedMailService,
    closeTask: unusedMailService,
    settleMember: unusedMailService,
    purgeFinishedTasks: unusedMailService,
  }),
);

const taskInput = (overrides: Partial<CreateTaskInput> = {}): CreateTaskInput => ({
  taskId: "task:one",
  title: "Task one",
  brief: "Do the work.",
  level: "medium",
  cardId: "card-a",
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

const letterInput = (overrides: Partial<AppendLetterInput> = {}): AppendLetterInput => ({
  letterId: "letter:one",
  taskId: "task:one",
  senderThreadId: "thread:lead",
  recipient: "lead",
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

it.effect("lists board tasks with their recent letters in one call", () =>
  Effect.gen(function* () {
    yield* migrate;
    const repository = yield* MailRepository;
    yield* repository.createTask(taskInput());
    yield* repository.createTask(
      taskInput({
        taskId: "task:two",
        cardId: "card-a",
        clientRequestId: "request:create-two",
        requestFingerprint: "fingerprint:create-two",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    yield* repository.appendLetter(letterInput());
    yield* repository.appendLetter(
      letterInput({
        letterId: "letter:two",
        taskId: "task:two",
        body: "Second task letter.",
        clientRequestId: "request:letter-two",
        requestFingerprint: "fingerprint:letter-two",
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );

    const withoutLetters = yield* mailRpcHandlers[FT3_MAIL_WS_METHODS.mailTasks]({
      cardIds: ["card-a"],
      threadId: "thread:lead",
    });
    assert.deepStrictEqual(
      withoutLetters.tasks.map((task) => task.taskId),
      ["task:two", "task:one"],
    );
    assert.isUndefined(withoutLetters.letters);

    const withLetters = yield* mailRpcHandlers[FT3_MAIL_WS_METHODS.mailTasks]({
      cardIds: ["card-a"],
      lettersPerTask: 10,
      threadId: "thread:lead",
    });
    assert.deepStrictEqual(Object.keys(withLetters.letters ?? {}).toSorted(), [
      "task:one",
      "task:two",
    ]);
    assert.equal(withLetters.letters?.["task:one"]?.[0]?.letter.body, "Start.");
    assert.equal(withLetters.letters?.["task:two"]?.[0]?.letter.body, "Second task letter.");

    const refused = yield* mailRpcHandlers[FT3_MAIL_WS_METHODS.mailTasks]({
      cardIds: ["card-a"],
      lettersPerTask: 0,
      threadId: "thread:lead",
    }).pipe(Effect.flip);
    assert.equal((refused as { code: string }).code, "invalid_request");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("scopes card tasks to the calling lead thread", () =>
  Effect.gen(function* () {
    yield* migrate;
    const repository = yield* MailRepository;
    yield* repository.createTask(taskInput());
    yield* repository.appendLetter(letterInput());
    yield* repository.createTask(
      taskInput({
        taskId: "task:other-card",
        cardId: "card-b",
        createdByThreadId: "thread:other",
        clientRequestId: "request:other-card",
        requestFingerprint: "fingerprint:other-card",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    yield* repository.createTask(
      taskInput({
        taskId: "task:other-same-card",
        cardId: "card-a",
        createdByThreadId: "thread:other",
        clientRequestId: "request:other-same-card",
        requestFingerprint: "fingerprint:other-same-card",
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );

    // The web tab asks with the whole board's card ids; the server must drop
    // the tasks of cards this lead does not own.
    const own = yield* mailRpcHandlers[FT3_MAIL_WS_METHODS.mailTasks]({
      cardIds: ["card-a", "card-b"],
      lettersPerTask: 10,
      threadId: "thread:lead",
    });
    assert.deepStrictEqual(
      own.tasks.map((task) => task.taskId),
      ["task:one"],
    );
    assert.deepStrictEqual(Object.keys(own.letters ?? {}), ["task:one"]);

    const other = yield* mailRpcHandlers[FT3_MAIL_WS_METHODS.mailTasks]({
      cardIds: ["card-a", "card-b"],
      threadId: "thread:other",
    });
    assert.deepStrictEqual(other.tasks.map((task) => task.taskId).toSorted(), [
      "task:other-card",
      "task:other-same-card",
    ]);

    const foreignTimeline = yield* mailRpcHandlers[FT3_MAIL_WS_METHODS.mailTimeline]({
      taskId: "task:one",
      threadId: "thread:other",
    }).pipe(Effect.flip);
    assert.equal((foreignTimeline as { code: string }).code, "capability_denied");
  }).pipe(Effect.provide(Layer.provideMerge(testLayer, mailServiceStubLayer))),
);

it.effect("lists only the calling lead's open card-less tasks when withoutCard is set", () =>
  Effect.gen(function* () {
    yield* migrate;
    const repository = yield* MailRepository;
    yield* repository.createTask(
      taskInput({ taskId: "task:own-open", cardId: null, clientRequestId: "request:own-open" }),
    );
    yield* repository.createTask(
      taskInput({
        taskId: "task:own-closed",
        cardId: null,
        clientRequestId: "request:own-closed",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    yield* repository.closeTask({
      taskId: "task:own-closed",
      outcome: "cancelled",
      summary: "No longer needed.",
      closedAt: "2026-01-01T00:00:02.000Z",
    });
    yield* repository.createTask(
      taskInput({
        taskId: "task:other-lead",
        cardId: null,
        createdByThreadId: "thread:other",
        clientRequestId: "request:other-lead",
        requestFingerprint: "fingerprint:other-lead",
      }),
    );
    yield* repository.createTask(
      taskInput({
        taskId: "task:with-card",
        clientRequestId: "request:with-card",
        requestFingerprint: "fingerprint:with-card",
      }),
    );

    const result = yield* mailRpcHandlers[FT3_MAIL_WS_METHODS.mailTasks]({
      cardIds: [],
      withoutCard: true,
      threadId: "thread:lead",
    });
    assert.deepStrictEqual(
      result.tasks.map((task) => task.taskId),
      ["task:own-open"],
    );

    const withCards = yield* mailRpcHandlers[FT3_MAIL_WS_METHODS.mailTasks]({
      cardIds: ["card-a"],
      withoutCard: true,
      threadId: "thread:lead",
      lettersPerTask: 10,
    });
    assert.deepStrictEqual(
      withCards.tasks.map((task) => task.taskId),
      ["task:with-card", "task:own-open"],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("reads a letter by id only from the lead thread of its task", () =>
  Effect.gen(function* () {
    yield* migrate;
    const repository = yield* MailRepository;
    yield* repository.createTask(taskInput());
    yield* repository.appendLetter(letterInput());

    const read = yield* mailRpcHandlers[FT3_MAIL_WS_METHODS.mailLetter]({
      letterId: "letter:one",
      threadId: "thread:lead",
    });
    assert.equal(read.letter.body, "Start.");
    assert.equal(read.effectiveKind, "request");

    const foreign = yield* mailRpcHandlers[FT3_MAIL_WS_METHODS.mailLetter]({
      letterId: "letter:one",
      threadId: "thread:someone-else",
    }).pipe(Effect.flip);
    assert.equal((foreign as { code: string }).code, "capability_denied");

    const missing = yield* mailRpcHandlers[FT3_MAIL_WS_METHODS.mailLetter]({
      letterId: "letter:missing",
      threadId: "thread:lead",
    }).pipe(Effect.flip);
    assert.equal((missing as { code: string }).code, "letter_not_found");
  }).pipe(Effect.provide(testLayer)),
);

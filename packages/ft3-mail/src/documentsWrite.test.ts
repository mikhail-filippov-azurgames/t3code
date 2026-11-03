import { assert, it } from "@effect/vitest";
import { DocumentsWriteFactsPort } from "@t3tools/ft3-docs/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { databaseLayer, migrateMail } from "./mail.testkit.ts";
import { MailRepository } from "./repository.ts";
import { documentsWriteFactsLayer } from "./documentsWrite.ts";

const LEAD = "thread:lead";

const seedTeam = Effect.gen(function* () {
  yield* migrateMail;
  const repository = yield* MailRepository;
  yield* repository.createTask({
    taskId: "task:one",
    title: "Task one",
    brief: "Do the work.",
    level: "medium",
    cardId: null,
    isolation: null,
    runtimeMode: null,
    interactionMode: null,
    responseBudgetSeconds: 1800,
    createdByThreadId: LEAD,
    clientRequestId: "request:one",
    requestFingerprint: "fingerprint:one",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  yield* repository.addMember({
    memberId: "member:general",
    taskId: "task:one",
    roleId: "general",
    specialization: null,
    level: null,
    responseBudgetSeconds: null,
    documentsWrite: true,
    modelOverrideJson: null,
    humanInstruction: null,
    participantThreadId: "thread:general",
    createdAt: "2026-01-01T00:00:01.000Z",
  });
  yield* repository.addMember({
    memberId: "member:implementation",
    taskId: "task:one",
    roleId: "implementation",
    specialization: null,
    level: null,
    responseBudgetSeconds: null,
    documentsWrite: false,
    modelOverrideJson: null,
    humanInstruction: null,
    participantThreadId: "thread:implementation",
    createdAt: "2026-01-01T00:00:02.000Z",
  });
});

const factsOf = (threadId: string | null) =>
  Effect.gen(function* () {
    const port = yield* DocumentsWriteFactsPort;
    return yield* port.factsOf({ threadId, parentThreadId: LEAD });
  });

it.effect("grants documents:write from the member record while its task is open", () =>
  Effect.gen(function* () {
    yield* seedTeam;
    assert.deepStrictEqual(yield* factsOf("thread:general"), {
      role: "general",
      planStableId: null,
      granted: true,
    });
    assert.deepStrictEqual(yield* factsOf("thread:implementation"), {
      role: "implementation",
      planStableId: null,
      granted: false,
    });
    assert.deepStrictEqual(yield* factsOf("thread:unknown"), {
      role: null,
      planStableId: null,
      granted: false,
    });
    assert.deepStrictEqual(yield* factsOf(null), {
      role: null,
      planStableId: null,
      granted: false,
    });
    const repository = yield* MailRepository;
    yield* repository.closeTask({
      taskId: "task:one",
      outcome: "succeeded",
      summary: "Done.",
      closedAt: "2026-01-01T00:00:03.000Z",
    });
    assert.isFalse((yield* factsOf("thread:general")).granted);
  }).pipe(Effect.provide(documentsWriteFactsLayer.pipe(Layer.provideMerge(databaseLayer)))),
);

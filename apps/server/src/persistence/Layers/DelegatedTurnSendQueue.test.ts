import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import DelegatedTurnSendQueueMigration from "../Migrations/057_DelegatedTurnSendQueue.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

function messageEvent(threadId: ThreadId, id: string): Omit<OrchestrationEvent, "sequence"> {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    type: "thread.message-sent",
    eventId: EventId.make(id),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: now,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId,
      messageId: MessageId.make(id),
      role: "assistant",
      text: id,
      turnId: null,
      streaming: false,
      createdAt: now,
      updatedAt: now,
    },
  };
}

it.effect("tracks queued delegated sends atomically without replaying unrelated events", () =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("queued-store-thread");
    const messageId = MessageId.make("queued-store-message");
    const now = "2026-01-01T00:00:00.000Z";
    const start = (id: string): Omit<OrchestrationEvent, "sequence"> => ({
      type: "thread.turn-start-requested",
      eventId: EventId.make(id),
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: now,
      commandId: CommandId.make(id),
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        threadId,
        messageId,
        runtimeMode: "approval-required",
        interactionMode: "default",
        delegationConfigFingerprint: "frozen-fingerprint",
        followUpBehavior: "queue",
        createdAt: now,
      },
    });
    const marker = (
      id: string,
      kind: "provider.turn.send.claimed" | "provider.turn.send.uncertain",
    ) =>
      ({
        type: "thread.activity-appended",
        eventId: EventId.make(id),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.make(id),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId,
          activity: {
            id: EventId.make(id),
            tone: kind === "provider.turn.send.claimed" ? "info" : "error",
            kind,
            summary: kind,
            payload: { requestId: messageId },
            turnId: null,
            createdAt: now,
          },
        },
      }) as Omit<OrchestrationEvent, "sequence">;

    yield* store.append(messageEvent(threadId, "unrelated-message"));
    yield* store.append(start("queued-start"));
    const pending = () => Stream.runCollect(store.readPendingDelegatedTurnStarts());
    assert.deepEqual(
      (yield* pending()).map((event) => event.eventId),
      ["queued-start"],
    );

    // An unrelated active turn can temporarily inherit this pending message
    // in the projection. It is not evidence that this request was sent.
    yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json
        ) VALUES (${threadId}, 'older-turn', ${messageId}, 'running', ${now}, '[]')
      `;
    assert.deepEqual(
      (yield* pending()).map((event) => event.eventId),
      ["queued-start"],
    );

    yield* store.append(marker("queued-claim", "provider.turn.send.claimed"));
    assert.deepEqual(
      (yield* pending()).map((event) => event.eventId),
      ["queued-start"],
    );
    const attempted = yield* sql<{ readonly state: string }>`
        SELECT state FROM delegated_turn_send_queue
        WHERE thread_id = ${threadId} AND message_id = ${messageId}
      `;
    assert.equal(attempted[0]?.state, "attempted");

    yield* store.append(marker("queued-uncertain", "provider.turn.send.uncertain"));
    assert.equal((yield* pending()).length, 0);
    yield* store.append(start("queued-start-replayed"));
    assert.equal((yield* pending()).length, 0);

    // The migration is idempotent for an existing event history. A completed
    // request must stay closed when the same migration runs again.
    yield* DelegatedTurnSendQueueMigration;
    assert.equal((yield* pending()).length, 0);
  }).pipe(
    Effect.provide(OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
  ),
);

it.effect("backfills legacy claims and closes them only after a linked turn", () =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("legacy-queue-thread");
    const messageId = MessageId.make("legacy-queue-message");
    const now = "2026-01-01T00:00:00.000Z";
    const claimPayloadJson = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      requestId: messageId,
    });
    yield* store.append({
      type: "thread.turn-start-requested",
      eventId: EventId.make("legacy-queue-request"),
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: now,
      commandId: CommandId.make("legacy-queue-request"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        threadId,
        messageId,
        runtimeMode: "approval-required",
        interactionMode: "default",
        delegationConfigFingerprint: "legacy-fingerprint",
        followUpBehavior: "queue",
        createdAt: now,
      },
    });
    yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
        ) VALUES (
          'legacy-claim', ${threadId}, NULL, 'info', 'provider.turn.send.claimed',
          'Provider turn send claimed', ${claimPayloadJson}, ${now}
        )
      `;
    yield* sql`DELETE FROM delegated_turn_send_queue`;
    yield* DelegatedTurnSendQueueMigration;
    const state = () => sql<{ readonly state: string }>`
        SELECT state FROM delegated_turn_send_queue
        WHERE thread_id = ${threadId} AND message_id = ${messageId}
      `;
    assert.equal((yield* state())[0]?.state, "attempted");
    assert.equal((yield* Stream.runCollect(store.readPendingDelegatedTurnStarts())).length, 1);

    yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json
        ) VALUES (${threadId}, 'legacy-turn', ${messageId}, 'running', ${now}, '[]')
      `;
    assert.equal((yield* state())[0]?.state, "done");
    assert.equal((yield* Stream.runCollect(store.readPendingDelegatedTurnStarts())).length, 0);
  }).pipe(
    Effect.provide(OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
  ),
);

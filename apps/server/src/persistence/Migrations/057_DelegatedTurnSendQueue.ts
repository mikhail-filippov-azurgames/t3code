import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Materialized inbox for delegated queued sends. Event append and inbox updates are atomic. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS delegated_turn_send_queue (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      request_sequence INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'attempted', 'done')),
      PRIMARY KEY (thread_id, message_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_delegated_turn_send_queue_pending
    ON delegated_turn_send_queue(state, request_sequence)
  `;

  // Existing databases need one bounded migration pass. Later boots read only
  // pending rows. The original event and activity history remains authoritative.
  yield* sql`
    INSERT INTO delegated_turn_send_queue (thread_id, message_id, request_sequence, state)
    SELECT json_extract(payload_json, '$.threadId'),
           json_extract(payload_json, '$.messageId'), sequence, 'pending'
    FROM orchestration_events
    WHERE event_type = 'thread.turn-start-requested'
      AND json_valid(payload_json)
      AND json_extract(payload_json, '$.followUpBehavior') = 'queue'
      AND json_extract(payload_json, '$.delegationConfigFingerprint') IS NOT NULL
    ORDER BY sequence
    ON CONFLICT(thread_id, message_id) DO UPDATE SET
      request_sequence = excluded.request_sequence
  `;
  yield* sql`
    UPDATE delegated_turn_send_queue AS queue
    SET state = 'attempted'
    WHERE EXISTS (
      SELECT 1 FROM projection_thread_activities AS activity
      WHERE activity.thread_id = queue.thread_id
        AND json_valid(activity.payload_json)
        AND activity.kind IN (
          'provider.turn.send.claimed',
          'delegation.provider-bound'
        )
        AND COALESCE(
          json_extract(activity.payload_json, '$.requestId'),
          json_extract(activity.payload_json, '$.delegatedMessageId')
        ) = queue.message_id
    )
  `;
  yield* sql`
    UPDATE delegated_turn_send_queue AS queue
    SET state = 'done'
    WHERE EXISTS (
      SELECT 1 FROM projection_thread_activities AS activity
      WHERE activity.thread_id = queue.thread_id
        AND json_valid(activity.payload_json)
        AND activity.kind IN ('provider.turn.start.failed', 'provider.turn.send.uncertain')
        AND json_extract(activity.payload_json, '$.requestId') = queue.message_id
    ) OR (queue.state = 'attempted' AND EXISTS (
      SELECT 1 FROM projection_turns AS turn
      WHERE turn.thread_id = queue.thread_id
        AND turn.pending_message_id = queue.message_id
        AND turn.turn_id IS NOT NULL
    ))
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_delegated_turn_send_queue_request
    AFTER INSERT ON orchestration_events
    WHEN NEW.event_type = 'thread.turn-start-requested'
      AND json_valid(NEW.payload_json)
      AND json_extract(NEW.payload_json, '$.followUpBehavior') = 'queue'
      AND json_extract(NEW.payload_json, '$.delegationConfigFingerprint') IS NOT NULL
    BEGIN
      INSERT INTO delegated_turn_send_queue (thread_id, message_id, request_sequence, state)
      VALUES (
        json_extract(NEW.payload_json, '$.threadId'),
        json_extract(NEW.payload_json, '$.messageId'),
        NEW.sequence,
        'pending'
      )
      ON CONFLICT(thread_id, message_id) DO UPDATE SET
        request_sequence = excluded.request_sequence;
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_delegated_turn_send_queue_marker
    AFTER INSERT ON orchestration_events
    WHEN NEW.event_type = 'thread.activity-appended'
      AND json_valid(NEW.payload_json)
      AND json_extract(NEW.payload_json, '$.activity.kind') IN (
        'provider.turn.start.failed',
        'provider.turn.send.uncertain',
        'provider.turn.send.claimed',
        'delegation.provider-bound'
      )
    BEGIN
      UPDATE delegated_turn_send_queue
      SET state = CASE
        WHEN json_extract(NEW.payload_json, '$.activity.kind') IN (
          'provider.turn.start.failed', 'provider.turn.send.uncertain'
        ) THEN 'done'
        WHEN state = 'pending' THEN 'attempted'
        ELSE state
      END
      WHERE thread_id = json_extract(NEW.payload_json, '$.threadId')
        AND message_id = COALESCE(
          json_extract(NEW.payload_json, '$.activity.payload.requestId'),
          json_extract(NEW.payload_json, '$.activity.payload.delegatedMessageId')
        );
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_delegated_turn_send_queue_turn_insert
    AFTER INSERT ON projection_turns
    WHEN NEW.turn_id IS NOT NULL AND NEW.pending_message_id IS NOT NULL
    BEGIN
      UPDATE delegated_turn_send_queue SET state = 'done'
      WHERE thread_id = NEW.thread_id AND message_id = NEW.pending_message_id
        AND state = 'attempted';
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_delegated_turn_send_queue_turn_update
    AFTER UPDATE OF turn_id, pending_message_id ON projection_turns
    WHEN NEW.turn_id IS NOT NULL AND NEW.pending_message_id IS NOT NULL
    BEGIN
      UPDATE delegated_turn_send_queue SET state = 'done'
      WHERE thread_id = NEW.thread_id AND message_id = NEW.pending_message_id
        AND state = 'attempted';
    END
  `;
});

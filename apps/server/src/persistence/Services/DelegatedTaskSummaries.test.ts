import { ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { DelegatedTaskSummaryRepositoryLive } from "../Layers/DelegatedTaskSummaries.ts";
import { SqlitePersistenceMemory } from "../Layers/Sqlite.ts";
import {
  DelegatedTaskSummaryRepository,
  type DelegatedTaskSummaryRecord,
} from "./DelegatedTaskSummaries.ts";

const repositoryLayer = it.layer(
  DelegatedTaskSummaryRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const childThreadId = ThreadId.make("summary-child");
const firstTurnId = TurnId.make("summary-turn-1");
const secondTurnId = TurnId.make("summary-turn-2");
const crashTurnId = TurnId.make("summary-turn-crash-window");
const crashChildThreadId = ThreadId.make("summary-child-crash-window");
const firstAt = "2026-09-01T10:00:00.000Z";
const secondAt = "2026-09-01T10:01:00.000Z";

function pendingRow(
  overrides: Partial<DelegatedTaskSummaryRecord> = {},
): DelegatedTaskSummaryRecord {
  return {
    childThreadId,
    parentEnvironmentId: "environment-one",
    parentThreadId: ThreadId.make("summary-parent"),
    sourceTurnId: firstTurnId,
    completedAt: firstAt,
    text: "Outcome: deterministic fallback.",
    source: "deterministic",
    sourceTurnIds: [firstTurnId],
    watermark: 12,
    contentFingerprint: "fingerprint-1",
    state: "pending",
    error: null,
    attemptCount: 0,
    retryAfter: null,
    updatedAt: firstAt,
    ...overrides,
  };
}

repositoryLayer("DelegatedTaskSummaryRepository", (it) => {
  it.effect("persists one summary per child turn and records generation watermark/retries", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at
        ) VALUES (
          ${childThreadId}, 'summary-project', 'Child', '{"instanceId":"codex","model":"gpt-5"}',
          'full-access', ${firstAt}, ${firstAt}
        )
      `;
      const repository = yield* DelegatedTaskSummaryRepository;
      yield* repository.insertPending(pendingRow());
      yield* repository.insertPending(
        pendingRow({ text: "duplicate callback must not replace this" }),
      );

      const initial = yield* repository.getByTurn({ childThreadId, sourceTurnId: firstTurnId });
      assert.deepEqual(initial?.text, "Outcome: deterministic fallback.");
      assert.deepEqual(initial?.state, "pending");

      assert.isTrue(
        yield* repository.claimGeneration({
          childThreadId,
          sourceTurnId: firstTurnId,
          retryAfter: secondAt,
          updatedAt: firstAt,
        }),
      );
      assert.isFalse(
        yield* repository.claimGeneration({
          childThreadId,
          sourceTurnId: firstTurnId,
          retryAfter: secondAt,
          updatedAt: secondAt,
        }),
      );
      const attempted = yield* repository.getByTurn({ childThreadId, sourceTurnId: firstTurnId });
      assert.deepEqual(attempted?.attemptCount, 1);
      assert.deepEqual(attempted?.retryAfter, secondAt);

      yield* repository.complete({
        childThreadId,
        sourceTurnId: firstTurnId,
        text: "Outcome: implemented; Details: focused tests passed.",
        source: "model",
        sourceTurnIds: [firstTurnId],
        watermark: 25,
        contentFingerprint: "fingerprint-1",
        updatedAt: secondAt,
      });
      const ready = yield* repository.getByTurn({ childThreadId, sourceTurnId: firstTurnId });
      assert.deepEqual(ready, {
        ...pendingRow(),
        text: "Outcome: implemented; Details: focused tests passed.",
        source: "model",
        watermark: 25,
        state: "ready",
        attemptCount: 1,
        retryAfter: null,
        updatedAt: secondAt,
      });

      yield* repository.insertPending(
        pendingRow({
          sourceTurnId: secondTurnId,
          completedAt: secondAt,
          sourceTurnIds: [firstTurnId, secondTurnId],
        }),
      );
      const previous = yield* repository.getLatestBefore({
        childThreadId,
        sourceTurnId: secondTurnId,
        completedAt: secondAt,
      });
      assert.deepEqual(previous?.sourceTurnId, firstTurnId);

      yield* repository.fail({
        childThreadId,
        sourceTurnId: secondTurnId,
        error: "temporary generator error",
        retryAfter: secondAt,
        final: false,
        updatedAt: secondAt,
      });
      const retriable = yield* repository.getByTurn({ childThreadId, sourceTurnId: secondTurnId });
      assert.deepEqual(retriable?.state, "pending");
      assert.deepEqual(retriable?.text, "Outcome: deterministic fallback.");

      yield* repository.fail({
        childThreadId,
        sourceTurnId: secondTurnId,
        error: "generator unavailable",
        retryAfter: null,
        final: true,
        updatedAt: secondAt,
      });
      const failed = yield* repository.getByTurn({ childThreadId, sourceTurnId: secondTurnId });
      assert.deepEqual(failed?.state, "error");
      assert.deepEqual(failed?.source, "deterministic");
      assert.deepEqual(failed?.error, "generator unavailable");

      const scoped = yield* repository.listByParent({
        parentEnvironmentId: "environment-one",
        parentThreadId: ThreadId.make("summary-parent"),
      });
      assert.deepEqual(
        scoped.map((row) => row.sourceTurnId),
        [secondTurnId, firstTurnId],
      );
      assert.deepEqual(
        yield* repository.listByParent({
          parentEnvironmentId: "different-environment",
          parentThreadId: ThreadId.make("summary-parent"),
        }),
        [],
      );
    }),
  );

  it.effect("never reclaims a paid generation after a crash before summary completion", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at
        ) VALUES (
          ${crashChildThreadId}, 'summary-project', 'Crash Child', '{"instanceId":"codex","model":"gpt-5"}',
          'full-access', ${firstAt}, ${firstAt}
        )
      `;
      const repository = yield* DelegatedTaskSummaryRepository;
      const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
      yield* repository.insertPending(
        pendingRow({
          childThreadId: crashChildThreadId,
          sourceTurnId: crashTurnId,
          text: `Outcome: token=${secret}`,
          sourceTurnIds: [crashTurnId],
        }),
      );

      // This represents a provider call succeeding after the durable claim;
      // the process dies before complete() can persist its result.
      let paidGenerationCalls = 0;
      const firstClaim = yield* repository.claimGeneration({
        childThreadId: crashChildThreadId,
        sourceTurnId: crashTurnId,
        retryAfter: secondAt,
        updatedAt: firstAt,
      });
      if (firstClaim) paidGenerationCalls++;
      assert.isTrue(firstClaim);

      const persisted = yield* repository.getByTurn({
        childThreadId: crashChildThreadId,
        sourceTurnId: crashTurnId,
      });
      assert.equal(persisted?.attemptCount, 1);
      assert.notInclude(persisted?.text ?? "", secret);
      assert.include(persisted?.text ?? "", "[REDACTED]");
      const stored = yield* sql<{ readonly summary_text: string }>`
        SELECT summary_text FROM projection_delegated_task_summaries
        WHERE child_thread_id = ${crashChildThreadId} AND source_turn_id = ${crashTurnId}
      `;
      assert.notInclude(stored[0]?.summary_text ?? "", secret);

      // Simulate lease expiry/recovery: the persisted claim prevents another
      // paid provider call and recovery marks the deterministic row uncertain.
      assert.isFalse(
        yield* repository.claimGeneration({
          childThreadId: crashChildThreadId,
          sourceTurnId: crashTurnId,
          retryAfter: secondAt,
          updatedAt: secondAt,
        }),
      );
      assert.equal(paidGenerationCalls, 1);
      yield* repository.fail({
        childThreadId: crashChildThreadId,
        sourceTurnId: crashTurnId,
        error: "Summary generation outcome is uncertain; deterministic summary retained.",
        retryAfter: null,
        final: true,
        updatedAt: secondAt,
      });
      const recovered = yield* repository.getByTurn({
        childThreadId: crashChildThreadId,
        sourceTurnId: crashTurnId,
      });
      assert.equal(recovered?.state, "error");
      assert.equal(recovered?.source, "deterministic");
      assert.equal(recovered?.attemptCount, 1);
    }),
  );
});

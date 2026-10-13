import { assert, it as effectIt } from "@effect/vitest";
import { ThreadId, TurnId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";
import {
  ProjectionSnapshotQuery,
  type DelegatedTaskSummaryRecoveryCandidate,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import * as ThreadSettlementReactor from "../ThreadSettlementReactor.ts";
import * as PullRequestSyncReactor from "../PullRequestSyncReactor.ts";
import * as ThreadPullRequestReactor from "../ThreadPullRequestReactor.ts";
import { OrchestrationReactor } from "../Services/OrchestrationReactor.ts";
import { makeOrchestrationReactor } from "./OrchestrationReactor.ts";
import * as AgentAwarenessRelay from "../../relay/AgentAwarenessRelay.ts";
import { CalendarReactor } from "../../background/CalendarReactor.ts";
import * as BoardReactor from "../BoardReactor.ts";
import * as BoardRetentionReactor from "../BoardRetentionReactor.ts";
import * as CoordinatorBoardNudgeReactor from "../CoordinatorBoardNudgeReactor.ts";
import * as DelegatedTaskSummaryReactor from "../DelegatedTaskSummaryReactor.ts";

const emptyRecoveryPage: ProjectionSnapshotQueryShape["listDelegatedTaskSummaryRecoveryCandidates"] =
  () => Effect.succeed({ rows: [], hasMore: false });

function makeReactorLayer(options: {
  readonly started?: string[];
  readonly listRecoveryCandidates?: ProjectionSnapshotQueryShape["listDelegatedTaskSummaryRecoveryCandidates"];
  readonly recoverDelegationCompletions?: ProviderRuntimeIngestionShape["recoverDelegationCompletions"];
  readonly recoverSummaries?: DelegatedTaskSummaryReactor.DelegatedTaskSummaryReactor["Service"]["recover"];
}) {
  const record = (name: string) => () => {
    options.started?.push(name);
    return Effect.void;
  };
  return Layer.effect(OrchestrationReactor, makeOrchestrationReactor).pipe(
    Layer.provideMerge(
      Layer.mock(ProjectionSnapshotQuery)({
        listDelegatedTaskSummaryRecoveryCandidates:
          options.listRecoveryCandidates ?? emptyRecoveryPage,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ProviderRuntimeIngestionService, {
        start: record("provider-runtime-ingestion"),
        recoverDelegationCompletions: options.recoverDelegationCompletions ?? (() => Effect.void),
        drain: Effect.void,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ProviderCommandReactor, {
        start: record("provider-command-reactor"),
        drain: Effect.void,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(CheckpointReactor, {
        start: record("checkpoint-reactor"),
        drain: Effect.void,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ThreadDeletionReactor, {
        start: record("thread-deletion-reactor"),
        drainThrough: () => Effect.void,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ThreadPullRequestReactor.ThreadPullRequestReactor, {
        start: record("thread-pull-request-reactor"),
        drain: Effect.void,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ThreadSettlementReactor.ThreadSettlementReactor, {
        start: record("thread-settlement-reactor"),
        drain: Effect.void,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(PullRequestSyncReactor.PullRequestSyncReactor, {
        start: record("pull-request-sync-reactor"),
        drain: Effect.void,
        requestSync: () => Effect.void,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(AgentAwarenessRelay.AgentAwarenessRelay, {
        publishThread: () => Effect.void,
        start: record("agent-awareness-relay"),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(CalendarReactor, {
        start: () => Effect.void,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(BoardReactor.BoardReactor, {
        start: record("board-reactor"),
        drain: Effect.void,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(BoardRetentionReactor.BoardRetentionReactor, {
        start: record("board-retention-reactor"),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(CoordinatorBoardNudgeReactor.CoordinatorBoardNudgeReactor, {
        start: record("coordinator-board-nudge-reactor"),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(DelegatedTaskSummaryReactor.DelegatedTaskSummaryReactor, {
        start: record("delegated-task-summary-reactor"),
        recover: options.recoverSummaries ?? (() => Effect.void),
        drain: Effect.void,
      }),
    ),
  );
}

describe("OrchestrationReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<OrchestrationReactor, never> | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  it("starts every orchestration reactor", async () => {
    const started: string[] = [];

    runtime = ManagedRuntime.make(makeReactorLayer({ started }));

    const reactor = await runtime!.runPromise(Effect.service(OrchestrationReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));

    expect(started).toEqual([
      "provider-runtime-ingestion",
      "provider-command-reactor",
      "checkpoint-reactor",
      "thread-deletion-reactor",
      "thread-pull-request-reactor",
      "thread-settlement-reactor",
      "pull-request-sync-reactor",
      "agent-awareness-relay",
      "board-reactor",
      "board-retention-reactor",
      "coordinator-board-nudge-reactor",
      "delegated-task-summary-reactor",
    ]);

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});

const candidate = (childThreadId: string): DelegatedTaskSummaryRecoveryCandidate => ({
  parentThreadId: ThreadId.make("recovery-parent"),
  childThreadId: ThreadId.make(childThreadId),
  sourceTurnId: TurnId.make(`${childThreadId}-turn`),
  status: "completed",
  outputStatus: "available",
  completedAt: "2026-10-13T06:00:00.000Z",
  resultExcerpt: null,
  terminalError: null,
});

effectIt.effect(
  "reads each delegation recovery page once for callbacks and summaries, and retries a failed read",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstPageCursor = {
          completedAt: "2026-10-13T06:00:00.000Z" as const,
          childThreadId: ThreadId.make("child-a"),
          sourceTurnId: TurnId.make("child-a-turn"),
        };
        const reads: Array<string> = [];
        const handled: Array<string> = [];
        const readFailed = yield* Deferred.make<void>();
        const sweeps = yield* Queue.unbounded<void>();

        const layer = makeReactorLayer({
          listRecoveryCandidates: ({ after, limit }) =>
            Effect.gen(function* () {
              assert.equal(limit, 100);
              reads.push(after === undefined ? "head" : after.childThreadId);
              if (reads.length === 1) {
                return { rows: [candidate("child-a")], hasMore: true, nextCursor: firstPageCursor };
              }
              if (reads.length === 2) {
                yield* Deferred.succeed(readFailed, undefined);
                return yield* new PersistenceSqlError({
                  operation: "test.recovery",
                  detail: "temporary SQLite read failure",
                });
              }
              return { rows: [candidate("child-b")], hasMore: false, nextCursor: null };
            }),
          recoverDelegationCompletions: (rows) =>
            Effect.sync(() => {
              for (const row of rows) handled.push(`callback:${row.childThreadId}`);
            }),
          recoverSummaries: (rows) =>
            Effect.sync(() => {
              for (const row of rows) handled.push(`summary:${row.childThreadId}`);
            }).pipe(Effect.andThen(Queue.offer(sweeps, undefined))),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* OrchestrationReactor;
          yield* reactor.start();

          yield* Queue.take(sweeps);
          assert.deepStrictEqual(reads, ["head"]);
          assert.deepStrictEqual(handled, ["callback:child-a", "summary:child-a"]);

          yield* TestClock.adjust("1 minute");
          yield* Deferred.await(readFailed);
          assert.deepStrictEqual(handled, ["callback:child-a", "summary:child-a"]);

          yield* TestClock.adjust("1 minute");
          yield* Queue.take(sweeps);
          assert.deepStrictEqual(reads, ["head", "child-a", "child-a"]);
          assert.deepStrictEqual(handled, [
            "callback:child-a",
            "summary:child-a",
            "callback:child-b",
            "summary:child-b",
          ]);

          yield* TestClock.adjust("1 minute");
          yield* Queue.take(sweeps);
          assert.deepStrictEqual(reads, ["head", "child-a", "child-a", "head"]);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

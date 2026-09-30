import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  ProjectId,
  TextGenerationError,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  buildDelegatedSummaryGenerationInput,
  deterministicDelegatedSummary,
  formatDelegatedSummary,
  DelegatedTaskSummaryReactor,
  layer as delegatedTaskSummaryReactorLayer,
} from "./DelegatedTaskSummaryReactor.ts";
import { scrubDelegatedTaskText } from "../DelegatedTaskMemoryText.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  DelegatedTaskSummaryRepository,
  type DelegatedTaskSummaryRecord,
} from "../persistence/Services/DelegatedTaskSummaries.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";

it("bounds delegated summary inputs and preserves the configured text generation selection", () => {
  const input = buildDelegatedSummaryGenerationInput({
    cwd: "/workspace/child",
    branch: "feature/delegated-summary",
    status: "completed",
    previousSummary: "previous summary ".repeat(100),
    sourceTurnId: TurnId.make("child-turn-1"),
    report: "final report ".repeat(1_000),
    events: "checkpoint event\n".repeat(500),
    modelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
  });

  assert.equal(input.modelSelection, DEFAULT_SERVER_SETTINGS.textGenerationModelSelection);
  assert.isAtMost(input.stagedSummary.length, 1_000);
  assert.isAtMost(input.stagedPatch.length, 5_000 + 1_800 + 256);
  assert.include(input.stagedSummary, "Previous summary:");
  assert.include(input.stagedPatch, "Child final report (child-turn-1):");
});

it("formats short structured output and a bounded deterministic fallback", () => {
  const generated = formatDelegatedSummary({
    subject: "Outcome ".repeat(100),
    body: "- Changed projection.\n- Added focused tests.\n".repeat(100),
  });
  const fallback = deterministicDelegatedSummary(
    "failed",
    "final report ".repeat(200),
    "checkpoint.created: recorded durable evidence",
  );

  assert.isAtMost(generated.length, 600);
  assert.match(generated, /^Outcome: .+\nDetails:\n- /);
  assert.isAtMost(fallback.length, 600);
  assert.include(fallback, "Outcome: failed");
  assert.include(fallback, "Report:");
});

it("scrubs common dummy credentials before generation, fallback, and indexing text", () => {
  const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
  const input = buildDelegatedSummaryGenerationInput({
    cwd: "/workspace/child",
    branch: "feature/scrub",
    status: "completed",
    previousSummary: `token=${secret}`,
    sourceTurnId: TurnId.make("child-turn-secret"),
    report: `Authorization: Bearer ${secret}; api_key: "${secret}"`,
    events: `remote https://user:${secret}@example.test/repo`,
    modelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
  });
  const fallback = deterministicDelegatedSummary(
    "failed",
    `failed with token=${secret}`,
    `authorization: Bearer ${secret}`,
  );
  const indexedText = scrubDelegatedTaskText(`title contains ${secret}`);

  for (const value of [input.stagedSummary, input.stagedPatch, fallback, indexedText]) {
    assert.notInclude(value, secret);
    assert.include(value, "[REDACTED]");
  }
});

it.effect(
  "summarizes live callbacks, backfills missing callbacks, and never replays a paid claim",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const eventQueue = yield* Queue.unbounded<OrchestrationEvent>();
        const generationRequests =
          yield* Queue.unbounded<
            Parameters<TextGeneration.TextGeneration["Service"]["generateCommitMessage"]>[0]
          >();
        const records = yield* Ref.make(new Map<string, DelegatedTaskSummaryRecord>());
        const childSnapshots = new Map<
          string,
          ProjectionSnapshotQuery.DelegatedTaskSummaryInputSnapshot
        >();
        const childA = ThreadId.make("summary-pipeline-a");
        const childB = ThreadId.make("summary-pipeline-b");
        const childC = ThreadId.make("summary-pipeline-crash-recovery");
        const parentThreadId = ThreadId.make("summary-pipeline-parent");
        const projectId = ProjectId.make("summary-pipeline-project");
        const projectTextGenerationSelection = {
          ...DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
          model: "project-summary-model",
        };
        const turnA = TurnId.make("summary-pipeline-turn-a");
        const turnB = TurnId.make("summary-pipeline-turn-b");
        const turnC = TurnId.make("summary-pipeline-turn-crash-window");
        const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
        const parentEnvironmentId = "summary-pipeline-environment";
        const keyOf = (childThreadId: ThreadId, sourceTurnId: TurnId) =>
          `${childThreadId}\u0000${sourceTurnId}`;

        for (const childThreadId of [childA, childB, childC]) {
          childSnapshots.set(childThreadId, {
            projectId,
            parentEnvironmentId,
            parentThreadId,
            branch: "feature/task-memory",
            worktreePath: `/workspace/${childThreadId}`,
            assistantText: `Final report Authorization: Bearer ${secret}`,
            activities: [{ kind: "tool.completed", summary: `api_key=${secret}` }],
            threadWatermark: 42,
          });
        }
        yield* Ref.set(
          records,
          new Map([
            [
              keyOf(childC, turnC),
              {
                childThreadId: childC,
                parentEnvironmentId,
                parentThreadId,
                sourceTurnId: turnC,
                completedAt: "2026-09-20T10:00:00.000Z" as const,
                text: "Outcome: deterministic crash-window fallback.",
                source: "deterministic" as const,
                sourceTurnIds: [turnC],
                watermark: 42,
                contentFingerprint: "preexisting-paid-generation-claim",
                state: "pending" as const,
                error: null,
                attemptCount: 1,
                retryAfter: null,
                updatedAt: "2026-09-20T10:00:00.000Z" as const,
              },
            ],
          ]),
        );

        const repository = Layer.mock(DelegatedTaskSummaryRepository)({
          getByTurn: ({ childThreadId, sourceTurnId }) =>
            Ref.get(records).pipe(
              Effect.map((rows) => rows.get(keyOf(childThreadId, sourceTurnId)) ?? null),
            ),
          getLatestBefore: () => Effect.succeed(null),
          insertPending: (row) =>
            Ref.update(records, (rows) => {
              const next = new Map(rows);
              const key = keyOf(row.childThreadId, row.sourceTurnId);
              if (!next.has(key)) next.set(key, row);
              return next;
            }),
          claimGeneration: ({ childThreadId, sourceTurnId, retryAfter, updatedAt }) =>
            Ref.modify(records, (rows) => {
              const key = keyOf(childThreadId, sourceTurnId);
              const current = rows.get(key);
              if (
                current === undefined ||
                current.state !== "pending" ||
                current.attemptCount !== 0
              ) {
                return [false, rows];
              }
              const next = new Map(rows);
              next.set(key, { ...current, attemptCount: 1, retryAfter, updatedAt });
              return [true, next];
            }),
          complete: (input) =>
            Ref.update(records, (rows) => {
              const next = new Map(rows);
              const key = keyOf(input.childThreadId, input.sourceTurnId);
              const current = next.get(key);
              if (current !== undefined) {
                next.set(key, {
                  ...current,
                  ...input,
                  state: "ready",
                  error: null,
                  retryAfter: null,
                });
              }
              return next;
            }),
          fail: (input) =>
            Ref.update(records, (rows) => {
              const next = new Map(rows);
              const key = keyOf(input.childThreadId, input.sourceTurnId);
              const current = next.get(key);
              if (current !== undefined) {
                next.set(key, {
                  ...current,
                  state: input.final ? "error" : "pending",
                  error: scrubDelegatedTaskText(input.error),
                  retryAfter: input.retryAfter,
                  updatedAt: input.updatedAt,
                });
              }
              return next;
            }),
        });
        const engine = Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
          subscribeDomainEvents: Effect.succeed(Stream.fromQueue(eventQueue)),
        });
        const snapshots = Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getProjectShellById: () => Effect.succeedNone,
          getDelegatedTaskSummaryInput: ({ childThreadId }) =>
            Effect.succeed(Option.fromNullishOr(childSnapshots.get(childThreadId))),
          listDelegatedTaskSummaryRecoveryCandidates: ({ afterChildThreadId }) =>
            Effect.succeed(
              afterChildThreadId === undefined
                ? {
                    rows: [
                      {
                        parentThreadId,
                        childThreadId: childA,
                        sourceTurnId: turnA,
                        status: "completed" as const,
                        outputStatus: "available" as const,
                        completedAt: "2026-09-20T10:00:00.000Z" as const,
                        resultExcerpt: null,
                        terminalError: null,
                      },
                      {
                        parentThreadId,
                        childThreadId: childC,
                        sourceTurnId: turnC,
                        status: "completed" as const,
                        outputStatus: "available" as const,
                        completedAt: "2026-09-20T10:00:00.000Z" as const,
                        resultExcerpt: null,
                        terminalError: null,
                      },
                    ],
                    hasMore: false,
                  }
                : { rows: [], hasMore: false },
            ),
        });
        let generatorCalls = 0;
        const generator = Layer.mock(TextGeneration.TextGeneration)({
          generateCommitMessage: (input) =>
            Effect.gen(function* () {
              generatorCalls++;
              yield* Queue.offer(generationRequests, input);
              if (input.cwd.endsWith(childA)) {
                return {
                  subject: `Implemented with token=${secret}`,
                  body: "- Focused validation passed.",
                };
              }
              return yield* new TextGenerationError({
                operation: "generateCommitMessage",
                detail: `provider unavailable api_key=${secret}`,
              });
            }),
        });
        const dependencies = Layer.mergeAll(
          repository,
          engine,
          snapshots,
          generator,
          ServerSettings.ServerSettingsService.layerTest({
            projectSettingsOverrides: {
              [projectId]: {
                textGenerationModelSelection: projectTextGenerationSelection,
              },
            },
          }),
        );
        const layer = delegatedTaskSummaryReactorLayer.pipe(Layer.provideMerge(dependencies));

        yield* Effect.gen(function* () {
          const reactor = yield* DelegatedTaskSummaryReactor;
          yield* reactor.start();

          const eventFor = (childThreadId: ThreadId, delegatedTurnId: TurnId, suffix: string) =>
            ({
              sequence: suffix === "a" ? 1 : 2,
              eventId: EventId.make(`summary-pipeline-event-${suffix}`),
              aggregateKind: "thread" as const,
              aggregateId: parentThreadId,
              occurredAt: "2026-09-20T10:00:00.000Z",
              commandId: null,
              causationEventId: null,
              correlationId: null,
              metadata: {},
              type: "thread.activity-appended" as const,
              payload: {
                threadId: parentThreadId,
                activity: {
                  id: EventId.make(`summary-pipeline-completion-${suffix}`),
                  tone: "info" as const,
                  kind: "delegation.completed",
                  summary: "Delegated child completed",
                  payload: {
                    version: 1 as const,
                    childThreadId,
                    delegatedTurnId,
                    status: suffix === "a" ? ("completed" as const) : ("failed" as const),
                    completedAt: "2026-09-20T10:00:00.000Z",
                    ...(suffix === "b" ? { terminalError: `failed api_key=${secret}` } : {}),
                  },
                  turnId: null,
                  createdAt: "2026-09-20T10:00:00.000Z",
                },
              },
            }) satisfies OrchestrationEvent;

          const firstEvent = eventFor(childB, turnB, "b");
          yield* Queue.offer(eventQueue, firstEvent);
          yield* Queue.offer(eventQueue, firstEvent);
          const firstInput = yield* Queue.take(generationRequests);
          const secondInput = yield* Queue.take(generationRequests);
          yield* reactor.drain;

          assert.equal(generatorCalls, 2);
          assert.deepEqual(
            [firstInput.cwd, secondInput.cwd].toSorted(),
            [`/workspace/${childA}`, `/workspace/${childB}`].toSorted(),
          );
          const generatedInput = firstInput.cwd.endsWith(childA) ? firstInput : secondInput;
          const failedInput = firstInput.cwd.endsWith(childB) ? firstInput : secondInput;
          assert.deepEqual(generatedInput.modelSelection, projectTextGenerationSelection);
          assert.notInclude(generatedInput.stagedPatch, secret);
          assert.notInclude(failedInput.stagedPatch, secret);
          const rows = yield* Ref.get(records);
          const generated = rows.get(keyOf(childA, turnA));
          const fallback = rows.get(keyOf(childB, turnB));
          assert.equal(generated?.state, "ready");
          assert.equal(generated?.source, "model");
          assert.notInclude(generated?.text ?? "", secret);
          assert.include(generated?.text ?? "", "[REDACTED]");
          assert.equal(generated?.watermark, 42);
          assert.deepEqual(generated?.sourceTurnIds, [turnA]);
          assert.equal(fallback?.state, "error");
          assert.equal(fallback?.source, "deterministic");
          assert.notInclude(fallback?.text ?? "", secret);
          assert.notInclude(fallback?.error ?? "", secret);
          const uncertain = rows.get(keyOf(childC, turnC));
          assert.equal(uncertain?.state, "error");
          assert.equal(uncertain?.attemptCount, 1);
          assert.equal(uncertain?.source, "deterministic");
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("retries delegated summary recovery after a transient query failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const firstAttempt = yield* Deferred.make<void>();
      const secondAttempt = yield* Deferred.make<void>();
      const repository = Layer.mock(DelegatedTaskSummaryRepository)({});
      const engine = Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
        subscribeDomainEvents: Effect.succeed(Stream.empty),
      });
      const snapshots = Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        listDelegatedTaskSummaryRecoveryCandidates: () =>
          Effect.gen(function* () {
            const attempt = yield* Ref.modify(attempts, (count) => [count, count + 1] as const);
            if (attempt === 0) {
              yield* Deferred.succeed(firstAttempt, undefined);
              return yield* Effect.fail(
                new PersistenceSqlError({
                  operation: "test.recovery",
                  detail: "temporary SQLite read failure",
                }),
              );
            }
            yield* Deferred.succeed(secondAttempt, undefined);
            return { rows: [], hasMore: false };
          }),
      });
      const generator = Layer.mock(TextGeneration.TextGeneration)({
        generateCommitMessage: () => Effect.die(new Error("No generation expected")),
      });
      const layer = delegatedTaskSummaryReactorLayer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            repository,
            engine,
            snapshots,
            generator,
            ServerSettings.ServerSettingsService.layerTest(),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const reactor = yield* DelegatedTaskSummaryReactor;
        yield* reactor.start();
        yield* Deferred.await(firstAttempt);
        yield* TestClock.adjust("1 minute");
        yield* Deferred.await(secondAttempt);
        assert.equal(yield* Ref.get(attempts), 2);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

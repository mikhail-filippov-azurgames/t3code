import {
  type BoardOrchestrator,
  CommandId,
  type CoordinatorArchitectBinding,
  CorrelationId,
  EventId,
  type OrchestrationClientOrigin,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { BoardRepository } from "../../persistence/Services/Board.ts";
import {
  CoordinatorArchitectRepository,
  type BindingCloseInput,
} from "../../persistence/Services/CoordinatorArchitect.ts";
import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import {
  COORDINATOR_DELETED_DETACH_REASON,
  coordinatorArchitectDeleteCommandId,
  directDelegatedChildIds,
  subtreeDeleteCommandId,
  ThreadDeletionReactorLive,
} from "./ThreadDeletionReactor.ts";

const NOW = "2026-10-07T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-cascade");

function makeShell(input: {
  readonly id: ThreadId;
  readonly parent?: ThreadId | null;
  readonly archived?: boolean;
}): OrchestrationThreadShell {
  return {
    id: input.id,
    projectId: PROJECT_ID,
    title: `Thread ${input.id}`,
    modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5"),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: input.archived === true ? NOW : null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...(input.parent == null
      ? {}
      : {
          delegationParent: {
            parentThreadId: input.parent,
            parentEnvironmentId: "env-1",
            role: "implementation",
          },
        }),
  };
}

function makeBinding(input: {
  readonly coordinatorThreadId: ThreadId;
  readonly architectThreadId: ThreadId;
}): CoordinatorArchitectBinding {
  return {
    bindingId: `binding:${input.coordinatorThreadId}`,
    coordinatorThreadId: input.coordinatorThreadId,
    architectThreadId: input.architectThreadId,
    projectId: PROJECT_ID,
    architectTaskEffort: "medium",
    routingEvidence: null,
    status: "active",
    createdAt: NOW,
    createdBy: input.coordinatorThreadId,
    replacedByBindingId: null,
    detachReason: null,
    createIdempotencyKey: `create:${input.coordinatorThreadId}`,
  };
}

function threadDeletedEvent(input: {
  readonly threadId: ThreadId;
  readonly sequence: number;
  readonly origin: OrchestrationClientOrigin | undefined;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`evt-deleted-${input.sequence}`),
    aggregateKind: "thread",
    aggregateId: input.threadId,
    type: "thread.deleted",
    occurredAt: NOW,
    commandId: CommandId.make(`cmd-deleted-${input.sequence}`),
    causationEventId: null,
    correlationId: CorrelationId.make(`cmd-deleted-${input.sequence}`),
    metadata: input.origin === undefined ? {} : { origin: input.origin },
    payload: { threadId: input.threadId, deletedAt: NOW },
  };
}

interface HarnessSeed {
  readonly shells: ReadonlyArray<OrchestrationThreadShell>;
  readonly orchestrators?: ReadonlyArray<ThreadId>;
  readonly bindings?: ReadonlyArray<CoordinatorArchitectBinding>;
}

function makeHarness(seed: HarnessSeed) {
  return Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    // One offer per fake interaction. Every reactor processing performs at
    // least the two snapshot reads plus the orchestrator check, and every
    // dispatch offers too, so taking the exact expected offer count proves
    // quiescence without any clock: takes block until the work happened.
    const activity = yield* Queue.unbounded<void>();
    const note = Queue.offer(activity, undefined).pipe(Effect.asVoid);
    // Live (non-deleted) thread ids. Both projection snapshots derive from
    // this set, exactly like the real projection excludes deleted threads
    // from the active and the archived snapshot.
    const live = yield* Ref.make(new Set<ThreadId>(seed.shells.map((shell) => shell.id)));
    const shellsById = new Map<ThreadId, OrchestrationThreadShell>(
      seed.shells.map((shell) => [shell.id, shell]),
    );
    const receipts = yield* Ref.make(
      new Map<string, { readonly aggregateId: string; readonly sequence: number }>(),
    );
    const nextSequence = yield* Ref.make(0);
    const dispatched = yield* Ref.make<
      ReadonlyArray<{
        readonly command: OrchestrationCommand;
        readonly origin: OrchestrationClientOrigin | undefined;
      }>
    >([]);
    const emitted = yield* Ref.make<ReadonlyArray<OrchestrationEvent>>([]);
    const stops = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const terminalCloses = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const orchestrators = yield* Ref.make<ReadonlyArray<BoardOrchestrator>>(
      (seed.orchestrators ?? []).map((threadId) => ({
        threadId,
        createdBy: "human",
        createdAt: NOW,
      })),
    );
    const removedOrchestrators = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const bindings = yield* Ref.make(
      new Map<ThreadId, CoordinatorArchitectBinding>(
        (seed.bindings ?? []).map((binding) => [binding.coordinatorThreadId, binding]),
      ),
    );
    const closeKeys = yield* Ref.make(
      new Map<string, { readonly idempotencyKey: string; readonly fingerprint: string }>(),
    );
    const closedBindings = yield* Ref.make<ReadonlyArray<BindingCloseInput>>([]);

    const snapshotFor = (archived: boolean): Effect.Effect<OrchestrationShellSnapshot> =>
      Ref.get(live).pipe(
        Effect.map((ids) => ({
          snapshotSequence: 0,
          projects: [],
          threads: seed.shells.filter(
            (shell) => ids.has(shell.id) && (shell.archivedAt !== null) === archived,
          ),
          updatedAt: NOW,
        })),
        Effect.tap(() => note),
      );

    const engine = {
      latestSequence: Ref.get(nextSequence),
      streamDomainEvents: Stream.fromSubscription(yield* PubSub.subscribe(events)),
      dispatch: (
        command: OrchestrationCommand,
        options?: { readonly origin?: OrchestrationClientOrigin },
      ) =>
        Effect.gen(function* () {
          yield* note;
          yield* Ref.update(dispatched, (all) => [...all, { command, origin: options?.origin }]);
          const key = String(command.commandId);
          const aggregateId =
            "threadId" in command ? String(command.threadId) : String(command.projectId);
          const existing = (yield* Ref.get(receipts)).get(key);
          // The engine receipt path: the same deterministic command id for
          // the same aggregate replays its sequence without emitting again.
          if (existing !== undefined && existing.aggregateId === aggregateId) {
            return { sequence: existing.sequence };
          }
          const sequence = (yield* Ref.get(nextSequence)) + 1;
          yield* Ref.set(nextSequence, sequence);
          yield* Ref.update(receipts, (all) => new Map(all).set(key, { aggregateId, sequence }));
          if (command.type === "thread.delete") {
            yield* Ref.update(live, (all) => {
              const next = new Set(all);
              next.delete(command.threadId);
              return next;
            });
            const event = threadDeletedEvent({
              threadId: command.threadId,
              sequence,
              origin: options?.origin,
            });
            yield* Ref.update(emitted, (all) => [...all, event]);
            yield* PubSub.publish(events, event);
          }
          return { sequence };
        }),
    } as unknown as OrchestrationEngineShape;

    const providerService = {
      stopSession: ({ threadId }: { readonly threadId: ThreadId }) =>
        Ref.update(stops, (all) => [...all, threadId]).pipe(Effect.asVoid),
    } as unknown as ProviderServiceShape;

    const terminalManager = {
      close: ({ threadId }: { readonly threadId: ThreadId }) =>
        Ref.update(terminalCloses, (all) => [...all, threadId]).pipe(Effect.asVoid),
    } as unknown as TerminalManager.TerminalManager["Service"];

    const snapshot = Layer.mock(ProjectionSnapshotQuery)({
      getShellSnapshot: () => snapshotFor(false),
      getArchivedShellSnapshot: () => snapshotFor(true),
      getThreadShellById: (threadId: ThreadId) =>
        Ref.get(live).pipe(
          Effect.map((ids) => {
            const shell = shellsById.get(threadId);
            if (shell === undefined || !ids.has(threadId) || shell.archivedAt !== null) {
              return Option.none();
            }
            return Option.some(shell);
          }),
          Effect.tap(() => note),
        ),
      getThreadDetailByIdIncludingArchived: (threadId: ThreadId) =>
        Ref.get(live).pipe(
          Effect.map((ids) =>
            ids.has(threadId)
              ? Option.some({ id: threadId } as unknown as OrchestrationThread)
              : Option.none(),
          ),
          Effect.tap(() => note),
        ),
    });

    const board = Layer.mock(BoardRepository)({
      listOrchestrators: () => Ref.get(orchestrators).pipe(Effect.tap(() => note)),
      removeOrchestrator: (threadId: ThreadId) =>
        Ref.update(removedOrchestrators, (all) => [...all, threadId]).pipe(
          Effect.tap(() => note),
          Effect.asVoid,
        ),
    });

    const architectStore = Layer.mock(CoordinatorArchitectRepository)({
      getActiveBindingByCoordinator: (coordinatorThreadId) =>
        Ref.get(bindings).pipe(
          Effect.map((all) => {
            const row = all.get(coordinatorThreadId as ThreadId);
            return row !== undefined && row.status === "active" ? row : null;
          }),
          Effect.tap(() => note),
        ),
      findDetachReplay: (input: {
        readonly coordinatorThreadId: string;
        readonly closeIdempotencyKey: string;
        readonly closeRequestFingerprint: string;
      }) =>
        Effect.gen(function* () {
          const all = yield* Ref.get(bindings);
          const keys = yield* Ref.get(closeKeys);
          const row = all.get(input.coordinatorThreadId as ThreadId);
          if (row === undefined || row.status === "active") return null;
          const stored = keys.get(row.bindingId);
          return stored !== undefined &&
            stored.idempotencyKey === input.closeIdempotencyKey &&
            stored.fingerprint === input.closeRequestFingerprint
            ? row
            : null;
        }).pipe(Effect.tap(() => note)),
      closeBinding: (input: BindingCloseInput) =>
        Effect.gen(function* () {
          const all = yield* Ref.get(bindings);
          const entry = [...all.values()].find((row) => row.bindingId === input.bindingId);
          if (entry === undefined) return null;
          if (entry.status !== "active") {
            const keys = yield* Ref.get(closeKeys);
            const stored = keys.get(entry.bindingId);
            if (
              stored?.idempotencyKey === input.idempotencyKey &&
              stored?.fingerprint === input.closeRequestFingerprint
            ) {
              return entry;
            }
            return null;
          }
          const closed: CoordinatorArchitectBinding = {
            ...entry,
            status: input.status,
            replacedByBindingId: input.replacedByBindingId,
            detachReason: input.detachReason,
          };
          yield* Ref.set(bindings, new Map(all).set(closed.coordinatorThreadId, closed));
          yield* Ref.update(closeKeys, (keys) =>
            new Map(keys).set(closed.bindingId, {
              idempotencyKey: input.idempotencyKey,
              fingerprint: input.closeRequestFingerprint,
            }),
          );
          yield* Ref.update(closedBindings, (rows) => [...rows, input]);
          return closed;
        }).pipe(Effect.tap(() => note)),
    });

    const layer = ThreadDeletionReactorLive.pipe(
      Layer.provide(Layer.succeed(ProviderService, providerService)),
      Layer.provide(Layer.succeed(TerminalManager.TerminalManager, terminalManager)),
      Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
      Layer.provide(snapshot),
      Layer.provide(board),
      Layer.provide(architectStore),
    );

    return {
      engine,
      activity,
      live,
      dispatched,
      emitted,
      stops,
      terminalCloses,
      removedOrchestrators,
      closedBindings,
      publish: (event: OrchestrationEvent) =>
        Effect.gen(function* () {
          const sequence = (yield* Ref.get(nextSequence)) + 1;
          yield* Ref.set(nextSequence, sequence);
          // A committed thread.deleted means the projection already excludes
          // the thread from both snapshots.
          if (event.type === "thread.deleted") {
            yield* Ref.update(live, (all) => {
              const next = new Set(all);
              next.delete(event.payload.threadId);
              return next;
            });
          }
          yield* PubSub.publish(events, { ...event, sequence });
          return sequence;
        }),
      layer,
    };
  });
}

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

/** Take exactly `count` activity offers; completion proves the work happened. */
const takeActivity = (fixture: Harness, count: number): Effect.Effect<void> =>
  Effect.forEach(Array.from({ length: count }), () => Queue.take(fixture.activity), {
    discard: true,
  });

const runWithReactor = (
  seed: HarnessSeed,
  body: (
    fixture: Harness,
  ) => Effect.Effect<void, OrchestrationDispatchError, ThreadDeletionReactor>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeHarness(seed);
      return yield* Effect.gen(function* () {
        const reactor = yield* ThreadDeletionReactor;
        yield* reactor.start();
        return yield* body(fixture);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

const threadIdsOf = (commands: ReadonlyArray<{ readonly command: OrchestrationCommand }>) =>
  commands
    .map(({ command }) => (command.type === "thread.delete" ? String(command.threadId) : null))
    .filter((id) => id !== null);

describe("ThreadDeletionReactor subtree cascade", () => {
  it.effect("deletes three levels including an archived child, one event per thread", () =>
    runWithReactor(
      {
        shells: [
          makeShell({ id: ThreadId.make("thread-root") }),
          makeShell({
            id: ThreadId.make("thread-a"),
            parent: ThreadId.make("thread-root"),
            archived: true,
          }),
          makeShell({ id: ThreadId.make("thread-b"), parent: ThreadId.make("thread-root") }),
          makeShell({ id: ThreadId.make("thread-c"), parent: ThreadId.make("thread-b") }),
          makeShell({ id: ThreadId.make("thread-d"), parent: ThreadId.make("thread-c") }),
        ],
      },
      (fixture) =>
        Effect.gen(function* () {
          yield* fixture.publish(
            threadDeletedEvent({
              threadId: ThreadId.make("thread-root"),
              sequence: 0,
              origin: undefined,
            }),
          );
          // Five events (root plus one per cascade delete) with three
          // offered reads each, plus four child dispatches: the closed world
          // proves quiescence, so the counts below are exact.
          yield* takeActivity(fixture, 5 * 3 + 4);

          const commands = yield* Ref.get(fixture.dispatched);
          assert.equal(commands.length, 4);
          assert.deepEqual(threadIdsOf(commands).sort(), [
            "thread-a",
            "thread-b",
            "thread-c",
            "thread-d",
          ]);
          const byChild = new Map(
            commands.map(({ command }) => [
              command.type === "thread.delete" ? String(command.threadId) : "",
              String(command.commandId),
            ]),
          );
          assert.equal(byChild.get("thread-a"), "thread-subtree-delete:thread-root:thread-a");
          assert.equal(byChild.get("thread-b"), "thread-subtree-delete:thread-root:thread-b");
          assert.equal(byChild.get("thread-c"), "thread-subtree-delete:thread-b:thread-c");
          assert.equal(byChild.get("thread-d"), "thread-subtree-delete:thread-c:thread-d");

          // One thread.deleted per thread: the root was published by the test,
          // one per cascade delete was emitted by the fake engine.
          const emitted = yield* Ref.get(fixture.emitted);
          assert.equal(emitted.length, 4);
          const perThread = new Map<string, number>();
          for (const event of emitted) {
            if (event.type !== "thread.deleted") continue;
            const id = String(event.payload.threadId);
            perThread.set(id, (perThread.get(id) ?? 0) + 1);
          }
          assert.deepEqual([...perThread.entries()].sort(), [
            ["thread-a", 1],
            ["thread-b", 1],
            ["thread-c", 1],
            ["thread-d", 1],
          ]);

          // The archived child was deleted too, and every deleted thread got
          // the usual session/terminal cleanup exactly once.
          const stops = yield* Ref.get(fixture.stops);
          assert.deepEqual([...stops].sort(), [
            "thread-a",
            "thread-b",
            "thread-c",
            "thread-d",
            "thread-root",
          ]);
          assert.deepEqual([...(yield* Ref.get(fixture.terminalCloses))].sort(), [...stops].sort());
        }),
    ),
  );

  it.effect("replaying the root event reuses the same command ids and deletes nothing twice", () =>
    runWithReactor(
      {
        shells: [
          makeShell({ id: ThreadId.make("thread-root") }),
          makeShell({ id: ThreadId.make("thread-child"), parent: ThreadId.make("thread-root") }),
        ],
      },
      (fixture) =>
        Effect.gen(function* () {
          yield* fixture.publish(
            threadDeletedEvent({
              threadId: ThreadId.make("thread-root"),
              sequence: 0,
              origin: undefined,
            }),
          );
          yield* takeActivity(fixture, 2 * 3 + 1);
          assert.equal((yield* Ref.get(fixture.emitted)).length, 1);

          // Repeat the root deletion event while the projection still shows
          // the child as live (a redelivered event racing the projector): the
          // same deterministic command id replays the engine receipt, so no
          // second delete is emitted.
          yield* Ref.update(fixture.live, (all) => new Set(all).add(ThreadId.make("thread-child")));
          yield* fixture.publish(
            threadDeletedEvent({
              threadId: ThreadId.make("thread-root"),
              sequence: 0,
              origin: undefined,
            }),
          );
          yield* takeActivity(fixture, 1 * 3 + 1);

          const commands = yield* Ref.get(fixture.dispatched);
          assert.equal(commands.length, 2);
          assert.equal(
            String(commands[0]?.command.commandId),
            String(commands[1]?.command.commandId),
          );
          assert.equal(
            String(commands[0]?.command.commandId),
            "thread-subtree-delete:thread-root:thread-child",
          );
          assert.equal((yield* Ref.get(fixture.emitted)).length, 1);
          assert.deepEqual(threadIdsOf(yield* Ref.get(fixture.dispatched)), [
            "thread-child",
            "thread-child",
          ]);
        }),
    ),
  );

  it.effect("deleting a coordinator detaches its architect binding and its architect thread", () =>
    runWithReactor(
      {
        shells: [
          makeShell({ id: ThreadId.make("coordinator-1") }),
          makeShell({ id: ThreadId.make("arch:1") }),
        ],
        orchestrators: [ThreadId.make("coordinator-1")],
        bindings: [
          makeBinding({
            coordinatorThreadId: ThreadId.make("coordinator-1"),
            architectThreadId: ThreadId.make("arch:1"),
          }),
        ],
      },
      (fixture) =>
        Effect.gen(function* () {
          yield* fixture.publish(
            threadDeletedEvent({
              threadId: ThreadId.make("coordinator-1"),
              sequence: 0,
              origin: undefined,
            }),
          );
          // Root: two snapshot reads, the orchestrator check, the binding
          // read, the architect shell read, one dispatch, one close. The
          // architect event: the same three reads as any other deletion.
          yield* takeActivity(fixture, 7 + 3);

          // The board row itself stays the BoardReactor's job.
          assert.deepEqual(yield* Ref.get(fixture.removedOrchestrators), []);

          const commands = yield* Ref.get(fixture.dispatched);
          assert.equal(commands.length, 1);
          assert.equal(commands[0]?.command.type, "thread.delete");
          if (commands[0]?.command.type === "thread.delete") {
            assert.equal(String(commands[0].command.threadId), "arch:1");
            assert.equal(
              String(commands[0].command.commandId),
              String(coordinatorArchitectDeleteCommandId(ThreadId.make("arch:1"))),
            );
          }

          const closed = yield* Ref.get(fixture.closedBindings);
          assert.equal(closed.length, 1);
          assert.equal(closed[0]?.status, "detached");
          assert.equal(closed[0]?.detachReason, COORDINATOR_DELETED_DETACH_REASON);
          assert.equal(closed[0]?.replacedByBindingId, null);
        }),
    ),
  );

  it.effect("deleting a childless non-coordinator thread changes nothing else", () =>
    runWithReactor(
      {
        shells: [makeShell({ id: ThreadId.make("thread-leaf") })],
      },
      (fixture) =>
        Effect.gen(function* () {
          yield* fixture.publish(
            threadDeletedEvent({
              threadId: ThreadId.make("thread-leaf"),
              sequence: 0,
              origin: undefined,
            }),
          );
          yield* takeActivity(fixture, 3);

          assert.deepEqual(yield* Ref.get(fixture.dispatched), []);
          assert.deepEqual(yield* Ref.get(fixture.emitted), []);
          assert.deepEqual(yield* Ref.get(fixture.removedOrchestrators), []);
          assert.deepEqual(yield* Ref.get(fixture.closedBindings), []);
          assert.deepEqual(yield* Ref.get(fixture.stops), [ThreadId.make("thread-leaf")]);
          assert.deepEqual(yield* Ref.get(fixture.terminalCloses), [ThreadId.make("thread-leaf")]);
        }),
    ),
  );

  it.effect("mobile and server-originated deletions cascade the same way", () =>
    runWithReactor(
      {
        shells: [
          makeShell({ id: ThreadId.make("mobile-root") }),
          makeShell({ id: ThreadId.make("mobile-child"), parent: ThreadId.make("mobile-root") }),
          makeShell({ id: ThreadId.make("server-root") }),
          makeShell({ id: ThreadId.make("server-child"), parent: ThreadId.make("server-root") }),
        ],
      },
      (fixture) =>
        Effect.gen(function* () {
          // Both surfaces funnel through the same thread.delete command: the
          // mobile client stamps its origin, server/MCP paths dispatch
          // without one. The cascade keys off the committed event either way.
          yield* fixture.engine.dispatch(
            {
              type: "thread.delete",
              commandId: CommandId.make("cmd-mobile-delete"),
              threadId: ThreadId.make("mobile-root"),
            },
            {
              origin: {
                surface: "mobile",
                appVersion: "0.0.40",
              } satisfies OrchestrationClientOrigin,
            },
          );
          yield* fixture.engine.dispatch({
            type: "thread.delete",
            commandId: CommandId.make("cmd-server-delete"),
            threadId: ThreadId.make("server-root"),
          });
          // Two direct dispatches, two root processings with three reads
          // each, two cascade dispatches, two child processings.
          yield* takeActivity(fixture, 2 + 2 * 3 + 2 + 2 * 3);

          const commands = yield* Ref.get(fixture.dispatched);
          assert.deepEqual(threadIdsOf(commands).sort(), [
            "mobile-child",
            "mobile-root",
            "server-child",
            "server-root",
          ]);
          const emitted = yield* Ref.get(fixture.emitted);
          assert.equal(emitted.length, 4);
          const origins = commands.map(({ origin }) => origin?.surface ?? null);
          assert.deepEqual(origins, ["mobile", null, null, null]);
        }),
    ),
  );
});

describe("directDelegatedChildIds", () => {
  const snapshot = (
    threads: ReadonlyArray<OrchestrationThreadShell>,
  ): OrchestrationShellSnapshot => ({
    snapshotSequence: 0,
    projects: [],
    threads,
    updatedAt: NOW,
  });

  it("finds direct children only, grandchildren stay out", () => {
    const root = ThreadId.make("root");
    const child = ThreadId.make("child");
    const children = directDelegatedChildIds(
      [
        snapshot([
          makeShell({ id: root }),
          makeShell({ id: child, parent: root }),
          makeShell({ id: ThreadId.make("grandchild"), parent: child }),
          makeShell({ id: ThreadId.make("archived-child"), parent: root, archived: true }),
          makeShell({ id: ThreadId.make("unrelated") }),
        ]),
        snapshot([]),
      ],
      root,
    );
    assert.deepEqual(children, [ThreadId.make("archived-child"), ThreadId.make("child")]);
  });

  it("builds deterministic command ids per subtree edge", () => {
    assert.equal(
      String(subtreeDeleteCommandId(ThreadId.make("root"), ThreadId.make("child"))),
      "thread-subtree-delete:root:child",
    );
  });
});

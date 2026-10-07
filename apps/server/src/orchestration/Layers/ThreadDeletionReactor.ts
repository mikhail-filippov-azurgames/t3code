import {
  CommandId,
  type CoordinatorArchitectBinding,
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as NodeCrypto from "node:crypto";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { BoardRepository } from "../../persistence/Services/Board.ts";
import {
  CoordinatorArchitectRepository,
  type CoordinatorArchitectRepositoryError,
} from "../../persistence/Services/CoordinatorArchitect.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";
import { forkParked } from "../../serverActivation.ts";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

/**
 * Deterministic command id for one subtree edge: deleting `childId` because
 * its direct delegation parent `parentId` was deleted. A repeated
 * `thread.deleted` for the parent replays the same command id, so the engine
 * receipt dedupes it instead of deleting twice.
 */
export const subtreeDeleteCommandId = (parentId: ThreadId, childId: ThreadId): CommandId =>
  CommandId.make(`thread-subtree-delete:${parentId}:${childId}`);

/** Command id for the architect-thread soft delete on coordinator deletion. */
export const coordinatorArchitectDeleteCommandId = (architectThreadId: ThreadId): CommandId =>
  CommandId.make(`architect-delete:${architectThreadId}`);

/** Detach reason recorded when a coordinator deletion takes its architect binding down. */
export const COORDINATOR_DELETED_DETACH_REASON = "coordinator-deleted";

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
};

/** Same stable fingerprint the MCP detach path stores for its close request. */
const stableHash = (value: unknown): string =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");

const coordinatorDeletedIdempotencyKey = (coordinatorThreadId: ThreadId): string =>
  `coordinator-deleted:${coordinatorThreadId}`;

const coordinatorDeletedCloseFingerprint = (): string =>
  stableHash({ operation: "detach", reason: COORDINATOR_DELETED_DETACH_REASON });

/**
 * Direct delegated children of `parentId` across the given snapshots, sorted
 * for deterministic dispatch order. Archived children are included: the
 * projection snapshots exclude deleted threads, so an already-deleted child
 * never appears here and is never dispatched twice.
 */
export const directDelegatedChildIds = (
  snapshots: ReadonlyArray<OrchestrationShellSnapshot>,
  parentId: ThreadId,
): ReadonlyArray<ThreadId> => {
  const seen = new Set<string>();
  const children: Array<ThreadId> = [];
  for (const snapshot of snapshots) {
    for (const thread of snapshot.threads) {
      if (thread.id === parentId) continue;
      if (thread.delegationParent?.parentThreadId !== parentId) continue;
      if (seen.has(thread.id)) continue;
      seen.add(thread.id);
      children.push(thread.id);
    }
  }
  return children.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
};

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const snapshots = yield* ProjectionSnapshotQuery;
  const board = yield* BoardRepository;
  const architectStore = yield* CoordinatorArchitectRepository;

  const stopProviderSession = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: providerService.stopSession({ threadId }),
      message: "thread deletion cleanup skipped provider session stop",
      threadId,
    });

  const closeThreadTerminals = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: terminalManager.close({ threadId, deleteHistory: true }),
      message: "thread deletion cleanup skipped terminal close",
      threadId,
    });

  const dispatchThreadDeleteBestEffort = (
    commandId: CommandId,
    threadId: ThreadDeletedEvent["payload"]["threadId"],
  ) =>
    logCleanupCauseUnlessInterrupted({
      effect: orchestrationEngine
        .dispatch({ type: "thread.delete", commandId, threadId })
        .pipe(Effect.asVoid),
      message: "thread deletion cascade skipped a child delete",
      threadId,
    });

  /**
   * One level of the subtree cascade: delete every direct delegated child of
   * the deleted thread, including archived ones. Each child delete emits its
   * own `thread.deleted`, which cascades to the next level on its own event —
   * the reactor never walks more than one level per event.
   */
  const cascadeSubtreeDelete = Effect.fn("cascadeSubtreeDelete")(function* (
    threadId: ThreadDeletedEvent["payload"]["threadId"],
  ) {
    const [active, archived] = yield* Effect.all(
      [snapshots.getShellSnapshot(), snapshots.getArchivedShellSnapshot()],
      { concurrency: 2 },
    );
    const children = directDelegatedChildIds([active, archived], threadId);
    yield* Effect.forEach(
      children,
      (childId) =>
        dispatchThreadDeleteBestEffort(subtreeDeleteCommandId(threadId, childId), childId),
      { discard: true },
    );
  });

  const readCoordinatorArchitectBinding = (
    coordinatorThreadId: ThreadDeletedEvent["payload"]["threadId"],
  ): Effect.Effect<CoordinatorArchitectBinding | null, CoordinatorArchitectRepositoryError> =>
    Effect.gen(function* () {
      const active = yield* architectStore.getActiveBindingByCoordinator(coordinatorThreadId);
      if (active !== null) return active;
      // Exact-retry replay of our own earlier close; a terminal binding
      // closed by another path returns null here and needs no architect work.
      return yield* architectStore
        .findDetachReplay({
          coordinatorThreadId,
          closeIdempotencyKey: coordinatorDeletedIdempotencyKey(coordinatorThreadId),
          closeRequestFingerprint: coordinatorDeletedCloseFingerprint(),
        })
        .pipe(
          Effect.catchTags({
            CoordinatorArchitectIdempotencyConflict: () => Effect.succeed(null),
          }),
        );
    });

  const architectThreadIsPresent = (
    architectThreadId: ThreadId,
  ): Effect.Effect<boolean, ProjectionRepositoryError> =>
    Effect.gen(function* () {
      const shell = yield* snapshots.getThreadShellById(architectThreadId);
      if (Option.isSome(shell)) return true;
      const detail = yield* snapshots.getThreadDetailByIdIncludingArchived(architectThreadId);
      return Option.isSome(detail);
    });

  /**
   * Coordinator branch of `thread.deleted`: the board row itself is removed
   * by the BoardReactor; here the architect binding goes `detached` with
   * `coordinator-deleted` and the architect thread is soft-deleted with the
   * same deterministic command id the MCP detach path uses, so a repeated
   * event replays the engine receipt instead of deleting twice.
   */
  const detachCoordinatorArchitect = Effect.fn("detachCoordinatorArchitect")(function* (
    threadId: ThreadDeletedEvent["payload"]["threadId"],
  ) {
    const orchestrators = yield* board.listOrchestrators();
    if (!orchestrators.some((orchestrator) => orchestrator.threadId === threadId)) return;
    const binding = yield* readCoordinatorArchitectBinding(threadId);
    if (binding === null) return;
    if (yield* architectThreadIsPresent(binding.architectThreadId)) {
      yield* dispatchThreadDeleteBestEffort(
        coordinatorArchitectDeleteCommandId(binding.architectThreadId),
        binding.architectThreadId,
      );
    }
    const closed = yield* architectStore.closeBinding({
      bindingId: binding.bindingId,
      status: "detached",
      replacedByBindingId: null,
      detachReason: COORDINATOR_DELETED_DETACH_REASON,
      idempotencyKey: coordinatorDeletedIdempotencyKey(threadId),
      closeRequestFingerprint: coordinatorDeletedCloseFingerprint(),
    });
    if (closed === null) {
      yield* Effect.logWarning(
        "coordinator deletion left the architect binding to a concurrent close",
        { threadId, bindingId: binding.bindingId },
      );
    }
  });

  const processThreadDeleted = Effect.fn("processThreadDeleted")(function* (
    event: ThreadDeletedEvent,
  ) {
    const { threadId } = event.payload;
    yield* stopProviderSession(threadId);
    yield* closeThreadTerminals(threadId);
    yield* cascadeSubtreeDelete(threadId);
    yield* detachCoordinatorArchitect(threadId);
  });

  const processThreadDeletedSafely = (event: ThreadDeletedEvent) =>
    processThreadDeleted(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread deletion reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadDeletedSafely);

  // Highest event sequence the subscriber has handed to the worker. Waiting
  // through a successful thread.created sequence covers every deletion that
  // was ahead of that create in the engine queue; the worker drain then covers
  // the in-flight cleanup.
  const seenSequence = yield* SubscriptionRef.make(0);
  const noteSeen = (sequence: number) =>
    SubscriptionRef.update(seenSequence, (seen) => Math.max(seen, sequence));

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(
        orchestrationEngine.streamDomainEvents.pipe(
          // Events that landed before the subscription are not replayed, so
          // start the watermark at the current head instead of zero.
          Stream.onStart(orchestrationEngine.latestSequence.pipe(Effect.flatMap(noteSeen))),
        ),
        (event) =>
          (event.type === "thread.deleted" ? worker.enqueue(event) : Effect.void).pipe(
            Effect.andThen(noteSeen(event.sequence)),
          ),
      ),
    );
  });

  const drainThrough: ThreadDeletionReactorShape["drainThrough"] = Effect.fn(
    "ThreadDeletionReactor.drainThrough",
  )(function* (target) {
    yield* SubscriptionRef.changes(seenSequence).pipe(
      Stream.filter((seen) => seen >= target),
      Stream.runHead,
    );
    yield* worker.drain;
  });

  return {
    start,
    drainThrough,
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make);

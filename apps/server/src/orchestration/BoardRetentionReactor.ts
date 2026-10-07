/**
 * Periodically archives and deletes done board cards past their retention.
 *
 * A card whose `updatedAt` is older than `boardArchiveAfterDays` is archived
 * once it is `done`; an archived `done` card older than
 * `boardDeleteArchivedAfterDays` is deleted together with its history, leaving
 * only a minimal deletion record. `backlog` and unfinished cards are never
 * touched, and manually archived unfinished cards are never deleted by age.
 * The pass wakes nobody: it only writes board rows, never dispatches turns.
 *
 * @module BoardRetentionReactor
 */
import type { BoardCard } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

import { ServerSettingsService } from "../serverSettings.ts";
import { BoardRepository, buildBoardCardEvent } from "../persistence/Services/Board.ts";

export const RETENTION_BATCH_LIMIT = 500;
const RETENTION_INTERVAL = Duration.hours(1);

export class BoardRetentionReactor extends Context.Service<
  BoardRetentionReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/orchestration/BoardRetentionReactor") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const board = yield* BoardRepository;
  const settingsService = yield* ServerSettingsService;

  const logReason = (reason: string, details: Record<string, unknown> = {}) =>
    Effect.logInfo("board retention", { reason, ...details });

  const cutoffFor = (now: DateTime.DateTime, days: number): string =>
    DateTime.formatIso(DateTime.subtract(now, { days }));

  const archiveBatch = Effect.fn("BoardRetentionReactor.archiveBatch")(function* (
    archiveAfterDays: number,
  ) {
    const cutoff = cutoffFor(yield* DateTime.now, archiveAfterDays);
    const candidates = yield* board.listArchiveCandidates({
      cutoff,
      limit: RETENTION_BATCH_LIMIT,
    });
    let archived = 0;
    for (const candidate of candidates) {
      const current = Option.getOrNull(yield* board.getCard(candidate.cardId));
      if (current === null || current.status !== "done" || current.archived) {
        yield* logReason("archive-skip", { cardId: candidate.cardId });
        continue;
      }
      const at = DateTime.formatIso(yield* DateTime.now);
      const next: BoardCard = { ...current, archived: true, updatedAt: at };
      yield* board.updateCardWithEvent(
        next,
        buildBoardCardEvent(next, { at, body: "archived by retention" }),
      );
      archived += 1;
      yield* logReason("archived", { cardId: next.cardId });
    }
    return archived;
  });

  const deleteBatch = Effect.fn("BoardRetentionReactor.deleteBatch")(function* (
    deleteArchivedAfterDays: number,
  ) {
    const cutoff = cutoffFor(yield* DateTime.now, deleteArchivedAfterDays);
    const candidates = yield* board.listDeleteCandidates({
      cutoff,
      limit: RETENTION_BATCH_LIMIT,
    });
    let deleted = 0;
    for (const candidate of candidates) {
      const current = Option.getOrNull(yield* board.getCard(candidate.cardId));
      if (current === null || current.status !== "done" || !current.archived) {
        yield* logReason("delete-skip", { cardId: candidate.cardId });
        continue;
      }
      const events = yield* board.listEventsForCard({ cardId: current.cardId });
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* board.deleteCardWithRecord({
        cardId: current.cardId,
        orchestratorThreadId: current.orchestratorThreadId,
        deletedAt: at,
        historyEventCount: events.length,
      });
      deleted += 1;
      yield* logReason("deleted", { cardId: current.cardId });
    }
    return deleted;
  });

  const sweep = Effect.fn("BoardRetentionReactor.sweep")(function* () {
    const archiveSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    const archived = yield* archiveBatch(archiveSettings.boardArchiveAfterDays);
    const deleteSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    const deleted = yield* deleteBatch(deleteSettings.boardDeleteArchivedAfterDays);
    yield* logReason("sweep", { archived, deleted });
  });

  const runSweepSafely = sweep().pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("board retention sweep failed", {
            cause: Cause.pretty(cause),
          }),
    ),
  );

  const start: BoardRetentionReactor["Service"]["start"] = Effect.fn("BoardRetentionReactor.start")(
    function* () {
      const loopReady = yield* Deferred.make<void>();
      let signalledReady = false;
      const loop = Effect.fn("BoardRetentionReactor.loop")(function* () {
        while (true) {
          yield* runSweepSafely;
          if (!signalledReady) {
            signalledReady = true;
            yield* Deferred.succeed(loopReady, undefined);
          }
          yield* Effect.sleep(RETENTION_INTERVAL);
        }
      });

      yield* loop().pipe(Effect.forkScoped);
      yield* Deferred.await(loopReady);
    },
  );

  return { start } satisfies BoardRetentionReactor["Service"];
});

export const layer = Layer.effect(BoardRetentionReactor, make);

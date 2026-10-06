/**
 * Periodically nudges idle board coordinators toward their next eligible card.
 *
 * @module CoordinatorBoardNudgeReactor
 */
import {
  BoardCardEventId,
  CommandId,
  MessageId,
  type BoardCard,
  type BoardOrchestrator,
  type OrchestrationThreadShell,
  type ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import { compareDateTimeStrings } from "@t3tools/shared/dateTime";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";

import { ServerSettingsService } from "../serverSettings.ts";
import { BoardRepository, buildBoardCardEvent } from "../persistence/Services/Board.ts";
import { projectDerivedText } from "../security/SecretTextPolicy.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

export const NUDGES_PER_SWEEP_LIMIT = 3;

const CANDIDATE_STATUSES = ["todo", "review", "orchestrator"] as const;
type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

function isCandidateStatus(status: BoardCard["status"]): status is CandidateStatus {
  return CANDIDATE_STATUSES.includes(status as CandidateStatus);
}

function statusPriority(status: CandidateStatus): number {
  switch (status) {
    case "todo":
      return 0;
    case "review":
      return 1;
    case "orchestrator":
      return 2;
  }
}

function compareIdentifiers(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareCandidateCards(left: BoardCard, right: BoardCard): number {
  const byStatus =
    statusPriority(left.status as CandidateStatus) -
    statusPriority(right.status as CandidateStatus);
  if (byStatus !== 0) return byStatus;
  const byAge = compareDateTimeStrings(left.createdAt, right.createdAt);
  if (byAge !== 0) return byAge;
  return compareIdentifiers(String(left.cardId), String(right.cardId));
}

function compareOrchestrators(left: BoardOrchestrator, right: BoardOrchestrator): number {
  const byAge = compareDateTimeStrings(left.createdAt, right.createdAt);
  if (byAge !== 0) return byAge;
  return compareIdentifiers(String(left.threadId), String(right.threadId));
}

function hasLiveSessionWork(thread: OrchestrationThreadShell): boolean {
  const session = thread.session;
  return (
    (session !== null &&
      (session.status === "starting" ||
        session.status === "running" ||
        session.activeTurnId !== null)) ||
    thread.backgroundLiveness === "working" ||
    thread.backgroundLiveness === "monitoring"
  );
}

function formatLastError(error: string): string {
  const safe = projectDerivedText("summary", error).trim().replace(/\s+/g, " ");
  return safe.length > 200 ? `${safe.slice(0, 197)}...` : safe;
}

/** @internal Exported for focused prompt tests. */
export function formatCoordinatorBoardNudgeMessage(
  card: BoardCard,
  activeChildCount: number,
  threshold: number,
): string {
  const stateInstruction =
    card.status === "review"
      ? "Review the work and either finish this card or return it for changes."
      : card.status === "todo"
        ? "Plan this task and delegate it to an executor."
        : "Plan this task, then move it to Plan (todo) before delegating.";
  return [
    `This is an automatic board check, not a message from a person. The coordinator has ${activeChildCount} active child task(s); the nudge threshold is ${threshold}.`,
    `Card: ${projectDerivedText("summary", card.title)}`,
    `Card id: ${card.cardId}`,
    `State: ${card.status}`,
    `Executor role: ${card.executorRole}`,
    ...(card.lastError === null ? [] : [`Last error: ${formatLastError(card.lastError)}`]),
    "",
    stateInstruction,
    "If this card is waiting for a human decision, move it to Backlog or explain the decision needed and end this turn.",
  ].join("\n");
}

/** The card's updatedAt is its persisted version for one attempt per state. */
export function coordinatorBoardNudgeAttemptId(
  coordinatorThreadId: ThreadId,
  card: BoardCard,
): string {
  return `board:idle-nudge:${coordinatorThreadId}:${card.cardId}:${card.status}:${card.updatedAt}`;
}

export class CoordinatorBoardNudgeReactor extends Context.Service<
  CoordinatorBoardNudgeReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/orchestration/CoordinatorBoardNudgeReactor") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const board = yield* BoardRepository;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettingsService;

  const logReason = (reason: string, details: Record<string, unknown> = {}) =>
    Effect.logInfo("coordinator board nudge", { reason, ...details });

  const sweep = Effect.fn("CoordinatorBoardNudgeReactor.sweep")(function* (
    settings: ServerSettings,
  ) {
    const intervalMinutes = settings.coordinatorBoardNudgeIntervalMinutes;
    if (intervalMinutes === null) {
      yield* logReason("disabled");
      return;
    }
    const threshold = settings.coordinatorBoardNudgeActiveChildThreshold;
    const observedAtMillis = DateTime.toEpochMillis(yield* DateTime.now);
    const orchestrators = [...(yield* board.listOrchestrators())].sort(compareOrchestrators);
    const cards = yield* board.listCards();
    const orchestratorIds = new Set(orchestrators.map((orchestrator) => orchestrator.threadId));
    const candidatesByCoordinator = new Map<ThreadId, Array<BoardCard>>();

    for (const card of cards) {
      if (card.archived || !isCandidateStatus(card.status)) continue;
      if (!orchestratorIds.has(card.orchestratorThreadId)) continue;
      if (card.failureStreak >= 3) {
        yield* logReason("card-limit", {
          coordinatorId: card.orchestratorThreadId,
          cardId: card.cardId,
          failureStreak: card.failureStreak,
        });
        continue;
      }
      const coordinatorCards = candidatesByCoordinator.get(card.orchestratorThreadId) ?? [];
      coordinatorCards.push(card);
      candidatesByCoordinator.set(card.orchestratorThreadId, coordinatorCards);
    }

    const coordinatorsWithCandidates = orchestrators.filter(
      (orchestrator) => (candidatesByCoordinator.get(orchestrator.threadId)?.length ?? 0) > 0,
    );
    if (coordinatorsWithCandidates.length === 0) {
      yield* logReason("no-candidates");
      return;
    }

    for (const coordinator of orchestrators) {
      if (!candidatesByCoordinator.has(coordinator.threadId)) {
        yield* logReason("no-candidates", { coordinatorId: coordinator.threadId });
      }
    }

    const snapshot = yield* snapshots.getShellSnapshot();
    const shellsById = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
    let sentCount = 0;

    for (const coordinator of coordinatorsWithCandidates) {
      if (sentCount >= NUDGES_PER_SWEEP_LIMIT) {
        yield* logReason("sweep-limit", { sentCount });
        return;
      }

      const coordinatorId = coordinator.threadId;
      const coordinatorCards = candidatesByCoordinator.get(coordinatorId) ?? [];
      coordinatorCards.sort(compareCandidateCards);
      const shell = shellsById.get(coordinatorId);
      if (shell === undefined || shell.archivedAt !== null) {
        yield* logReason("no-candidates", { coordinatorId });
        continue;
      }
      if (
        shell.snoozedUntil !== undefined &&
        shell.snoozedUntil !== null &&
        DateTime.toEpochMillis(DateTime.makeUnsafe(shell.snoozedUntil)) > observedAtMillis
      ) {
        yield* logReason("deferred", {
          coordinatorId,
          snoozedUntil: shell.snoozedUntil,
        });
        continue;
      }
      if (shell.hasPendingApprovals || shell.hasPendingUserInput) {
        yield* logReason("waiting-human", {
          coordinatorId,
          hasPendingApprovals: shell.hasPendingApprovals,
          hasPendingUserInput: shell.hasPendingUserInput,
        });
        continue;
      }
      if (hasLiveSessionWork(shell)) {
        yield* logReason("busy", { coordinatorId });
        continue;
      }
      if (
        shell.latestUserMessageAt !== null &&
        observedAtMillis - DateTime.toEpochMillis(DateTime.makeUnsafe(shell.latestUserMessageAt)) <
          intervalMinutes * 60_000
      ) {
        yield* logReason("quiet-period", {
          coordinatorId,
          latestUserMessageAt: shell.latestUserMessageAt,
          intervalMinutes,
        });
        continue;
      }

      const activeChildCount = snapshot.threads.filter(
        (thread) =>
          thread.delegationParent?.parentThreadId === coordinatorId && hasLiveSessionWork(thread),
      ).length;
      if (activeChildCount >= threshold) {
        yield* logReason("threshold", {
          coordinatorId,
          activeChildCount,
          threshold,
        });
        continue;
      }

      for (const card of coordinatorCards) {
        const currentCard = Option.getOrNull(yield* board.getCard(card.cardId));
        if (
          currentCard === null ||
          currentCard.archived ||
          !isCandidateStatus(currentCard.status) ||
          currentCard.failureStreak >= 3 ||
          currentCard.status !== card.status ||
          currentCard.updatedAt !== card.updatedAt
        ) {
          yield* logReason("no-candidates", {
            coordinatorId,
            cardId: card.cardId,
          });
          continue;
        }

        const attemptId = coordinatorBoardNudgeAttemptId(coordinatorId, currentCard);
        const cardEvents = yield* board.listEventsForCard({ cardId: currentCard.cardId });
        if (cardEvents.some((event) => event.entryId === attemptId)) {
          yield* logReason("already-sent", {
            coordinatorId,
            cardId: currentCard.cardId,
            status: currentCard.status,
            version: currentCard.updatedAt,
          });
          continue;
        }

        const latestSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
        const latestInterval = latestSettings.coordinatorBoardNudgeIntervalMinutes;
        if (latestInterval === null) {
          yield* logReason("disabled", { coordinatorId });
          return;
        }
        const latestThreshold = latestSettings.coordinatorBoardNudgeActiveChildThreshold;
        if (activeChildCount >= latestThreshold) {
          yield* logReason("threshold", {
            coordinatorId,
            activeChildCount,
            threshold: latestThreshold,
          });
          break;
        }

        const sentAt = DateTime.formatIso(yield* DateTime.now);
        yield* engine.dispatch({
          type: "thread.turn.start",
          runOrigin: { _tag: "board-idle-nudge" },
          commandId: CommandId.make(attemptId),
          threadId: coordinatorId,
          message: {
            messageId: MessageId.make(attemptId),
            role: "user",
            text: formatCoordinatorBoardNudgeMessage(
              currentCard,
              activeChildCount,
              latestThreshold,
            ),
            attachments: [],
          },
          runtimeMode: shell.runtimeMode,
          interactionMode: shell.interactionMode,
          createdAt: sentAt,
        });
        sentCount += 1;
        const historyEntry = buildBoardCardEvent(currentCard, {
          at: sentAt,
          body: "Coordinator was automatically nudged to take this card.",
        });
        yield* board.appendEvent({
          ...historyEntry,
          entryId: BoardCardEventId.make(attemptId),
        });
        yield* logReason("sent", {
          coordinatorId,
          cardId: currentCard.cardId,
          activeChildCount,
          threshold: latestThreshold,
        });
        break;
      }
    }
  });

  const runSweepSafely = (settings: ServerSettings) =>
    sweep(settings).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("coordinator board nudge sweep failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const start: CoordinatorBoardNudgeReactor["Service"]["start"] = Effect.fn(
    "CoordinatorBoardNudgeReactor.start",
  )(function* () {
    const settingsChanges = yield* settingsService.subscribeChanges;
    const settingsQueue = yield* Queue.sliding<ServerSettings>(1);
    yield* Stream.runForEach(settingsChanges, (settings) =>
      Queue.offer(settingsQueue, settings).pipe(Effect.asVoid),
    ).pipe(Effect.forkScoped);

    const initialSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    const startedAt = DateTime.toEpochMillis(yield* DateTime.now);
    const loopReady = yield* Deferred.make<void>();
    const loop = Effect.fn("CoordinatorBoardNudgeReactor.loop")(function* () {
      let currentSettings = initialSettings;
      let intervalMinutes = currentSettings.coordinatorBoardNudgeIntervalMinutes;
      let nextSweepAt = intervalMinutes === null ? null : startedAt + intervalMinutes * 60_000;
      let loggedNotTime = false;
      let signalledReady = false;

      const signalReady = Effect.gen(function* () {
        if (signalledReady) return;
        signalledReady = true;
        yield* Deferred.succeed(loopReady, undefined);
      });

      if (intervalMinutes === null) {
        yield* logReason("disabled");
        yield* signalReady;
      }

      while (true) {
        if (nextSweepAt === null) {
          const changed = yield* Queue.take(settingsQueue);
          const changedInterval = changed.coordinatorBoardNudgeIntervalMinutes;
          currentSettings = changed;
          if (changedInterval === null) continue;
          intervalMinutes = changedInterval;
          nextSweepAt = DateTime.toEpochMillis(yield* DateTime.now) + intervalMinutes * 60_000;
          loggedNotTime = false;
          continue;
        }

        if (!loggedNotTime) {
          yield* logReason("not-time", { intervalMinutes, nextSweepAt });
          loggedNotTime = true;
        }
        yield* signalReady;

        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const remaining = nextSweepAt - now;
        if (remaining > 0) {
          const wake = yield* Effect.raceFirst(
            Effect.sleep(Duration.millis(remaining)).pipe(Effect.as({ _tag: "due" as const })),
            Queue.take(settingsQueue).pipe(
              Effect.map((settings) => ({ _tag: "settings" as const, settings })),
            ),
          );
          if (wake._tag === "settings") {
            const previousInterval = intervalMinutes;
            currentSettings = wake.settings;
            intervalMinutes = currentSettings.coordinatorBoardNudgeIntervalMinutes;
            if (intervalMinutes === null) {
              nextSweepAt = null;
              loggedNotTime = false;
              yield* logReason("disabled");
            } else if (intervalMinutes !== previousInterval) {
              nextSweepAt = DateTime.toEpochMillis(yield* DateTime.now) + intervalMinutes * 60_000;
              loggedNotTime = false;
            }
            continue;
          }
        }

        const latestSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
        const latestInterval = latestSettings.coordinatorBoardNudgeIntervalMinutes;
        currentSettings = latestSettings;
        if (latestInterval === null) {
          intervalMinutes = null;
          nextSweepAt = null;
          loggedNotTime = false;
          yield* logReason("disabled");
          continue;
        }
        if (latestInterval !== intervalMinutes) {
          intervalMinutes = latestInterval;
          nextSweepAt = DateTime.toEpochMillis(yield* DateTime.now) + intervalMinutes * 60_000;
          loggedNotTime = false;
          continue;
        }

        yield* runSweepSafely(currentSettings);

        const afterSweepSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
        currentSettings = afterSweepSettings;
        intervalMinutes = currentSettings.coordinatorBoardNudgeIntervalMinutes;
        if (intervalMinutes === null) {
          nextSweepAt = null;
          loggedNotTime = false;
          yield* logReason("disabled");
        } else {
          nextSweepAt = DateTime.toEpochMillis(yield* DateTime.now) + intervalMinutes * 60_000;
          loggedNotTime = false;
        }
      }
    });

    yield* loop().pipe(Effect.forkScoped);
    yield* Deferred.await(loopReady);
  });

  return { start } satisfies CoordinatorBoardNudgeReactor["Service"];
});

export const layer = Layer.effect(CoordinatorBoardNudgeReactor, make);

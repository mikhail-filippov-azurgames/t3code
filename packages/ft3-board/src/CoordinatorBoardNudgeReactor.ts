/**
 * Periodically nudges idle board coordinators toward their next eligible card.
 *
 * @module CoordinatorBoardNudgeReactor
 */
import {
  CommandId,
  MessageId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ServerSettings,
} from "@t3tools/contracts";
import { projectDerivedText } from "@t3tools/ft3-delegation/server";
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
import * as SqlClient from "effect/sql/SqlClient";

import { ServerSettingsService } from "../../../apps/server/src/serverSettings.ts";
import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import * as BoardRepository from "./BoardRepository.ts";
import { readBoardAutomationSettings } from "./settings.ts";
import * as Contracts from "./contracts.ts";

const nudgeIntervalMinutes = (settings: ServerSettings) =>
  readBoardAutomationSettings(settings.ft3).coordinatorBoardNudgeIntervalMinutes;
const nudgeActiveChildThreshold = (settings: ServerSettings) =>
  readBoardAutomationSettings(settings.ft3).coordinatorBoardNudgeActiveChildThreshold;

export const NUDGES_PER_SWEEP_LIMIT = 3;

const CANDIDATE_STATUSES = ["orchestrator", "review", "todo"] as const;
type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

function isCandidateStatus(status: Contracts.BoardCard["status"]): status is CandidateStatus {
  return CANDIDATE_STATUSES.includes(status as CandidateStatus);
}

function isBlockedCandidateStatus(status: Contracts.BoardCard["status"]): boolean {
  return status !== "backlog" && status !== "done";
}

function isWorkingReadyCard(card: Contracts.BoardCard, coordinatorId: ThreadId): boolean {
  return (
    card.orchestratorThreadId === coordinatorId &&
    !card.archived &&
    card.readiness === "ready" &&
    ["todo", "orchestrator", "in_progress", "review"].includes(card.status)
  );
}

function statusPriority(status: CandidateStatus): number {
  switch (status) {
    case "orchestrator":
      return 0;
    case "review":
      return 1;
    case "todo":
      return 2;
  }
}

function compareIdentifiers(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareCandidateCards(left: Contracts.BoardCard, right: Contracts.BoardCard): number {
  const byStatus =
    statusPriority(left.status as CandidateStatus) -
    statusPriority(right.status as CandidateStatus);
  if (byStatus !== 0) return byStatus;
  const byAge = compareIdentifiers(left.createdAt, right.createdAt);
  if (byAge !== 0) return byAge;
  return compareIdentifiers(String(left.cardId), String(right.cardId));
}

function compareCardAge(left: Contracts.BoardCard, right: Contracts.BoardCard): number {
  const byAge = compareIdentifiers(left.createdAt, right.createdAt);
  return byAge !== 0 ? byAge : compareIdentifiers(String(left.cardId), String(right.cardId));
}

function compareOrchestrators(
  left: Contracts.BoardOrchestrator,
  right: Contracts.BoardOrchestrator,
): number {
  const byAge = compareIdentifiers(left.createdAt, right.createdAt);
  if (byAge !== 0) return byAge;
  return compareIdentifiers(String(left.threadId), String(right.threadId));
}

const LIVE_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "preparing",
  "starting",
  "running",
  "waiting",
]);

function hasLiveSessionWork(thread: OrchestrationV2ThreadShell): boolean {
  return (
    (thread.activityRunStatus ?? null) !== null ||
    LIVE_STATUSES.has(thread.status) ||
    thread.activeRunId !== null ||
    thread.pendingRuntimeRequest !== null ||
    (thread.pendingBackgroundTasks?.length ?? 0) > 0
  );
}

function formatLastError(error: string): string {
  const safe = projectDerivedText("summary", error).trim().replace(/\s+/g, " ");
  return safe.length > 200 ? `${safe.slice(0, 197)}...` : safe;
}

/** @internal Exported for focused prompt tests. */
export function formatCoordinatorBoardNudgeMessage(
  card: Contracts.BoardCard,
  activeChildCount: number,
  threshold: number,
): string {
  const stateInstruction =
    card.readiness === "blocked"
      ? `This card is blocked and no other card can move: ${projectDerivedText("summary", card.readinessNote ?? "")}. Either fix the blocker now and set readiness to ready, or set needs_human with the exact question for the human, or, if the awaited work is still running, keep it blocked and end this turn.`
      : card.status === "review"
        ? "Review the work and either finish this card or return it for changes."
        : card.status === "todo"
          ? "Plan this task and delegate it to an executor."
          : "Plan this task, then move it to Plan (todo) before delegating.";
  return [
    `This is an automatic board check, not a message from a person. The coordinator has ${activeChildCount} active child task(s); the nudge threshold is ${threshold}.`,
    `Card: ${projectDerivedText("summary", card.title)}`,
    `Card id: ${card.cardId}`,
    `State: ${card.status}`,
    `Readiness: ${card.readiness}`,
    `Executor role: ${card.executorRole}`,
    ...(card.lastError === null ? [] : [`Last error: ${formatLastError(card.lastError)}`]),
    "",
    stateInstruction,
    "If the work is no longer needed, close the card as done with outcome cancelled. Preserve its existing body and append `Closure reason: <why>` so the reason is visible when the card is read, then end this turn.",
    ...(card.readiness === "blocked"
      ? []
      : [
          "If this card needs a human answer or decision, set readiness to needs_human with a readinessNote stating the exact question, tell the human, and end this turn. If it is blocked by an external cause, either fix it now and set ready, or set blocked with the cause and what it waits for, and end this turn. Do not move it to Backlog for this.",
        ]),
  ].join("\n");
}

/** The card's updatedAt is its persisted version for one attempt per state. */
export function coordinatorBoardNudgeAttemptId(
  coordinatorThreadId: ThreadId,
  card: Contracts.BoardCard,
): string {
  return `board:idle-nudge:${coordinatorThreadId}:${card.cardId}:${card.status}:${card.updatedAt}`;
}

export class CoordinatorBoardNudgeReactor extends Context.Service<
  CoordinatorBoardNudgeReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/ft3-board/CoordinatorBoardNudgeReactor") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const board = yield* BoardRepository.BoardRepository;
  const engine = yield* ThreadManagement.ThreadManagementService;
  const settingsService = yield* ServerSettingsService;
  const sql = yield* SqlClient.SqlClient;

  const logReason = (reason: string, details: Record<string, unknown> = {}) =>
    Effect.logInfo("coordinator board nudge", { reason, ...details });

  const blockedByOpenReview = Effect.fn("CoordinatorBoardNudgeReactor.blockedByOpenReview")(
    function* (coordinatorId: ThreadId) {
      const result = yield* sql<{ readonly present: number }>`
        SELECT 1 AS "present" FROM ft3_architect_review
        WHERE coordinator_thread_id = ${coordinatorId} AND status = 'open' LIMIT 1
      `.pipe(
        Effect.map((rows) => ({ _tag: "success" as const, open: rows.length > 0 })),
        Effect.catch((error) => Effect.succeed({ _tag: "failure" as const, error })),
      );
      if (result._tag === "failure") {
        yield* logReason("blocked-while-review-open", {
          coordinatorId,
          error: String(result.error),
        });
        return true;
      }
      if (result.open) {
        yield* logReason("blocked-while-review-open", { coordinatorId, openReviewCount: 1 });
        return true;
      }
      return false;
    },
  );

  const sweep = Effect.fn("CoordinatorBoardNudgeReactor.sweep")(function* (
    settings: ServerSettings,
  ) {
    const intervalMinutes = nudgeIntervalMinutes(settings);
    if (intervalMinutes === null) {
      yield* logReason("disabled");
      return;
    }
    const threshold = nudgeActiveChildThreshold(settings);
    const observedAtMillis = DateTime.toEpochMillis(yield* DateTime.now);

    const orchestrators = [...(yield* board.listOrchestrators())].sort(compareOrchestrators);
    if (orchestrators.length === 0) {
      yield* logReason("no-candidates");
      return;
    }

    // Sweep candidates only: rows this pass can never act on (archived,
    // backlog, done) stay in SQL instead of hydrating the whole table.
    const cards = yield* board.listNudgeCandidateCards();
    const orchestratorIds = new Set(orchestrators.map((orchestrator) => orchestrator.threadId));
    const readyCandidatesByCoordinator = new Map<ThreadId, Array<Contracts.BoardCard>>();
    const blockedCandidatesByCoordinator = new Map<ThreadId, Array<Contracts.BoardCard>>();

    for (const card of cards) {
      if (card.archived) continue;
      if (!orchestratorIds.has(card.orchestratorThreadId)) continue;
      if (card.readiness === "needs_human") {
        yield* logReason("card-needs-human", {
          coordinatorId: card.orchestratorThreadId,
          cardId: card.cardId,
        });
        continue;
      }
      if (card.failureStreak >= 3) {
        yield* logReason("card-limit", {
          coordinatorId: card.orchestratorThreadId,
          cardId: card.cardId,
          failureStreak: card.failureStreak,
        });
        continue;
      }
      if (card.readiness === "blocked") {
        if (!isBlockedCandidateStatus(card.status)) continue;
        const coordinatorCards =
          blockedCandidatesByCoordinator.get(card.orchestratorThreadId) ?? [];
        coordinatorCards.push(card);
        blockedCandidatesByCoordinator.set(card.orchestratorThreadId, coordinatorCards);
        continue;
      }
      if (!isCandidateStatus(card.status)) continue;
      const coordinatorCards = readyCandidatesByCoordinator.get(card.orchestratorThreadId) ?? [];
      coordinatorCards.push(card);
      readyCandidatesByCoordinator.set(card.orchestratorThreadId, coordinatorCards);
    }

    const coordinatorsWithCandidates = orchestrators.filter(
      (orchestrator) =>
        (readyCandidatesByCoordinator.get(orchestrator.threadId)?.length ?? 0) > 0 ||
        (blockedCandidatesByCoordinator.get(orchestrator.threadId)?.length ?? 0) > 0,
    );
    if (coordinatorsWithCandidates.length === 0) {
      yield* logReason("no-candidates");
      return;
    }

    const snapshot = yield* engine.getShellSnapshot();
    const shellsById = new Map(
      [...snapshot.threads, ...snapshot.archivedThreads].map((thread) => [thread.id, thread]),
    );
    let sentCount = 0;

    for (const coordinator of coordinatorsWithCandidates) {
      if (sentCount >= NUDGES_PER_SWEEP_LIMIT) {
        yield* logReason("sweep-limit", { sentCount });
        return;
      }

      const coordinatorId = coordinator.threadId;
      const readyCards = [...(readyCandidatesByCoordinator.get(coordinatorId) ?? [])].sort(
        compareCandidateCards,
      );
      const blockedCards = [...(blockedCandidatesByCoordinator.get(coordinatorId) ?? [])].sort(
        compareCardAge,
      );
      const shell = shellsById.get(coordinatorId);
      if (shell === undefined || shell.deletedAt !== null || shell.archivedAt !== null) {
        yield* logReason("no-candidates", { coordinatorId });
        continue;
      }
      if (
        shell.snoozedUntil !== undefined &&
        shell.snoozedUntil !== null &&
        DateTime.toEpochMillis(shell.snoozedUntil) > observedAtMillis
      ) {
        yield* logReason("deferred", { coordinatorId, snoozedUntil: shell.snoozedUntil });
        continue;
      }
      if (shell.pendingRuntimeRequest !== null) {
        yield* logReason("waiting-human", { coordinatorId });
        continue;
      }
      if (hasLiveSessionWork(shell)) {
        yield* logReason("busy", { coordinatorId });
        continue;
      }
      if (
        shell.latestUserMessageAt !== null &&
        observedAtMillis - DateTime.toEpochMillis(shell.latestUserMessageAt) <
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
          thread.lineage.relationshipToParent === "subagent" &&
          thread.lineage.parentThreadId === coordinatorId &&
          hasLiveSessionWork(thread),
      ).length;
      let coordinatorCards: Array<Contracts.BoardCard>;
      const blockedNudge = readyCards.length === 0;
      if (!blockedNudge) {
        if (activeChildCount >= threshold) {
          yield* logReason("threshold", { coordinatorId, activeChildCount, threshold });
          continue;
        }
        coordinatorCards = readyCards;
      } else {
        if (blockedCards.length === 0) continue;
        if (cards.some((card) => isWorkingReadyCard(card, coordinatorId))) {
          yield* logReason("blocked-while-work-ready", { coordinatorId });
          continue;
        }
        if (activeChildCount > 0) {
          yield* logReason("blocked-while-children-live", { coordinatorId, activeChildCount });
          continue;
        }
        if (yield* blockedByOpenReview(coordinatorId)) continue;
        coordinatorCards = blockedCards;
      }

      for (const card of coordinatorCards) {
        const currentCard = yield* board.getCard(card.cardId);
        const currentStatusEligible =
          currentCard !== null &&
          (blockedNudge
            ? isBlockedCandidateStatus(currentCard.status)
            : isCandidateStatus(currentCard.status));
        if (
          currentCard === null ||
          currentCard.archived ||
          currentCard.orchestratorThreadId !== coordinatorId ||
          !currentStatusEligible ||
          currentCard.readiness !== (blockedNudge ? "blocked" : "ready") ||
          currentCard.failureStreak >= 3 ||
          currentCard.status !== card.status ||
          currentCard.updatedAt !== card.updatedAt
        ) {
          yield* logReason("no-candidates", { coordinatorId, cardId: card.cardId });
          continue;
        }

        if (blockedNudge) {
          const latestCard = yield* board.getCard(currentCard.cardId);
          if (
            latestCard === null ||
            latestCard.archived ||
            latestCard.readiness !== "blocked" ||
            latestCard.status !== currentCard.status ||
            latestCard.updatedAt !== currentCard.updatedAt
          ) {
            yield* logReason("no-candidates", { coordinatorId, cardId: card.cardId });
            continue;
          }
          if (yield* board.hasWorkingReadyCard(coordinatorId)) {
            yield* logReason("blocked-while-work-ready", { coordinatorId });
            continue;
          }
          const latestSnapshot = yield* engine.getShellSnapshot();
          const latestActiveChildCount = latestSnapshot.threads.filter(
            (thread) =>
              thread.lineage.relationshipToParent === "subagent" &&
              thread.lineage.parentThreadId === coordinatorId &&
              hasLiveSessionWork(thread),
          ).length;
          if (latestActiveChildCount > 0) {
            yield* logReason("blocked-while-children-live", {
              coordinatorId,
              activeChildCount: latestActiveChildCount,
            });
            continue;
          }
          if (yield* blockedByOpenReview(coordinatorId)) continue;
        }

        const attemptId = coordinatorBoardNudgeAttemptId(coordinatorId, currentCard);
        if (yield* board.hasCardEvent(Contracts.BoardCardEventId.make(attemptId))) {
          yield* logReason("already-sent", {
            coordinatorId,
            cardId: currentCard.cardId,
            status: currentCard.status,
            version: currentCard.updatedAt,
          });
          continue;
        }

        const latestSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
        const latestInterval = nudgeIntervalMinutes(latestSettings);
        if (latestInterval === null) {
          yield* logReason("disabled", { coordinatorId });
          return;
        }
        const latestThreshold = nudgeActiveChildThreshold(latestSettings);
        if (!blockedNudge && activeChildCount >= latestThreshold) {
          yield* logReason("threshold", {
            coordinatorId,
            activeChildCount,
            threshold: latestThreshold,
          });
          break;
        }

        const sentAt = DateTime.formatIso(yield* DateTime.now);
        yield* engine
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(attemptId),
            threadId: coordinatorId,
            messageId: MessageId.make(attemptId),
            text: formatCoordinatorBoardNudgeMessage(
              currentCard,
              activeChildCount,
              latestThreshold,
            ),
            attachments: [],
            createdBy: "agent",
            creationSource: "server",
            dispatchMode: { type: "start_immediately" },
          })
          .pipe(
            Effect.catch((error) =>
              logReason("dispatch-failed", {
                coordinatorId,
                cardId: currentCard.cardId,
                error: String(error),
              }),
            ),
          );
        sentCount += 1;
        const historyEntry = BoardRepository.buildBoardCardEvent(currentCard, {
          at: sentAt,
          body: "Coordinator was automatically nudged to take this card.",
          entryId: Contracts.BoardCardEventId.make(attemptId),
        });
        yield* board.updateCard(currentCard, [historyEntry]);
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
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("coordinator board nudge sweep failed", {
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
      let intervalMinutes = nudgeIntervalMinutes(currentSettings);
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
          const changedInterval = nudgeIntervalMinutes(changed);
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
            intervalMinutes = nudgeIntervalMinutes(currentSettings);
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
        const latestInterval = nudgeIntervalMinutes(latestSettings);
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
        intervalMinutes = nudgeIntervalMinutes(currentSettings);
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

  return CoordinatorBoardNudgeReactor.of({ start });
});

export const layer = Layer.effect(CoordinatorBoardNudgeReactor, make);

export const layerWorker = () =>
  Layer.effectDiscard(
    Effect.flatMap(CoordinatorBoardNudgeReactor, (reactor) => reactor.start()),
  ).pipe(Layer.provide(layer), Layer.provide(BoardRepository.layer));

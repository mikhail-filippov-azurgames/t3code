import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import {
  ProjectionSnapshotQuery,
  type DelegatedTaskSummaryRecoveryCursor,
} from "../Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../../serverActivation.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import * as ThreadSettlementReactor from "../ThreadSettlementReactor.ts";
import * as PullRequestSyncReactor from "../PullRequestSyncReactor.ts";
import * as ThreadPullRequestReactor from "../ThreadPullRequestReactor.ts";
import * as AgentAwarenessRelay from "../../relay/AgentAwarenessRelay.ts";
import { CalendarReactor } from "../../background/CalendarReactor.ts";
import * as BoardReactor from "../BoardReactor.ts";
import * as BoardRetentionReactor from "../BoardRetentionReactor.ts";
import * as CoordinatorBoardNudgeReactor from "../CoordinatorBoardNudgeReactor.ts";
import * as DelegatedTaskSummaryReactor from "../DelegatedTaskSummaryReactor.ts";

const DELEGATION_RECOVERY_PAGE_SIZE = 100;

export const makeOrchestrationReactor = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const threadSettlementReactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
  const pullRequestSyncReactor = yield* PullRequestSyncReactor.PullRequestSyncReactor;
  const threadPullRequestReactor = yield* ThreadPullRequestReactor.ThreadPullRequestReactor;
  const agentAwarenessRelay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
  const calendarReactor = yield* CalendarReactor;
  const boardReactor = yield* BoardReactor.BoardReactor;
  const boardRetentionReactor = yield* BoardRetentionReactor.BoardRetentionReactor;
  const coordinatorBoardNudgeReactor =
    yield* CoordinatorBoardNudgeReactor.CoordinatorBoardNudgeReactor;
  const delegatedTaskSummaryReactor =
    yield* DelegatedTaskSummaryReactor.DelegatedTaskSummaryReactor;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  // One read per page feeds both recoveries; a failed read retries the same page next tick.
  let delegationRecoveryCursor: DelegatedTaskSummaryRecoveryCursor | undefined;
  const recoverDelegations = Effect.fn("OrchestrationReactor.recoverDelegations")(function* () {
    const page = yield* projectionSnapshotQuery.listDelegatedTaskSummaryRecoveryCandidates({
      ...(delegationRecoveryCursor === undefined ? {} : { after: delegationRecoveryCursor }),
      limit: DELEGATION_RECOVERY_PAGE_SIZE,
    });
    yield* providerRuntimeIngestion.recoverDelegationCompletions(page.rows);
    yield* delegatedTaskSummaryReactor.recover(page.rows);
    delegationRecoveryCursor = page.hasMore ? (page.nextCursor ?? undefined) : undefined;
  });
  const recoverDelegationsSafely = recoverDelegations().pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("delegation recovery sweep failed; it will retry", {
            cause: Cause.pretty(cause),
          }),
    ),
  );

  const start: OrchestrationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* providerRuntimeIngestion.start();
    yield* providerCommandReactor.start();
    yield* checkpointReactor.start();
    yield* threadDeletionReactor.start();
    yield* threadPullRequestReactor.start();
    yield* threadSettlementReactor.start();
    yield* pullRequestSyncReactor.start();
    yield* agentAwarenessRelay.start();
    yield* calendarReactor.start();
    yield* boardReactor.start();
    yield* boardRetentionReactor.start();
    yield* coordinatorBoardNudgeReactor.start();
    yield* delegatedTaskSummaryReactor.start();
    yield* forkParked(
      recoverDelegationsSafely.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
  });

  return {
    start,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);

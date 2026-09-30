/**
 * ProjectionSnapshotQuery - Read-model snapshot query service interface.
 *
 * Exposes the current orchestration projection snapshot for read-only API
 * access.
 *
 * @module ProjectionSnapshotQuery
 */
import type {
  AgentSessionImportSource,
  ApprovalRequestId,
  CheckpointRef,
  IsoDateTime,
  MessageId,
  DelegationCompletedActivityPayload,
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationProject,
  OrchestrationProjectShell,
  OrchestrationReadModel,
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadDetailWindow,
  OrchestrationThreadShell,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Option from "effect/Option";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { ProjectionTurnState } from "../../persistence/Services/ProjectionTurns.ts";
import type {
  DelegatedSummarySource,
  DelegatedSummaryState,
} from "../../persistence/Services/DelegatedTaskSummaries.ts";

export interface DelegatedTaskMemoryRow {
  readonly taskId: ThreadId;
  readonly projectId: ProjectId;
  readonly role: string;
  readonly title: string;
  readonly updatedAt: IsoDateTime;
  readonly worktreePath: string | null;
  readonly latestTurnId: TurnId | null;
  readonly latestTurnState: ProjectionTurnState | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly hasPendingFollowUp: boolean;
  readonly threadWatermark: number;
  readonly summary: null | {
    readonly sourceTurnId: TurnId;
    readonly text: string;
    readonly source: DelegatedSummarySource;
    readonly sourceTurnIds: ReadonlyArray<TurnId>;
    readonly watermark: number;
    readonly state: DelegatedSummaryState;
    readonly error: string | null;
  };
}

export interface DelegatedTaskSummaryInputSnapshot {
  readonly projectId: ProjectId;
  readonly parentEnvironmentId: string;
  readonly parentThreadId: ThreadId;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly assistantText: string | null;
  readonly activities: ReadonlyArray<{ readonly kind: string; readonly summary: string }>;
  readonly threadWatermark: number;
}

export interface DelegatedTaskSummaryRecoveryCandidate {
  readonly parentThreadId: ThreadId;
  readonly childThreadId: ThreadId;
  readonly sourceTurnId: TurnId;
  readonly status: DelegationCompletedActivityPayload["status"];
  readonly outputStatus: DelegationCompletedActivityPayload["outputStatus"] | null;
  readonly completedAt: IsoDateTime;
  readonly resultExcerpt: string | null;
  readonly terminalError: string | null;
}

export interface ProjectionSnapshotCounts {
  readonly projectCount: number;
  readonly threadCount: number;
}

export interface ProjectionSnapshotSequence {
  readonly snapshotSequence: number;
}

export interface ProjectionEventReplayStats {
  readonly eventCount: number;
  readonly payloadBytes: number;
}

export interface ProjectionThreadCheckpointContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
}

export interface ProjectionFullThreadDiffContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly latestCheckpointTurnCount: number;
  readonly toCheckpointRef: CheckpointRef | null;
}

export interface ProjectionThreadDetailQuery {
  /**
   * Filter activities before SQLite returns and decodes their payloads.
   * Filtered reads keep the generic recent-activity window unless an internal
   * durable-protocol caller explicitly requests complete history.
   * Any explicit filter omits pinned-request reads. An empty list also skips
   * the activity query. Omit this option to preserve the full detail response.
   */
  readonly activityKinds?: ReadonlyArray<string>;
  /** Internal durable-protocol reads can explicitly bypass the recent 500-activity window. */
  readonly activityHistory?: "recent" | "complete";
}

/**
 * ProjectionSnapshotQueryShape - Service API for read-model snapshots.
 */
export interface ProjectionSnapshotQueryShape {
  /** Keyset-paged direct child index, with bounded summary and latest-follow-up projection. */
  readonly listDelegatedTaskMemoryRows: (input: {
    readonly parentEnvironmentId: string;
    readonly parentThreadId: ThreadId;
    readonly afterTaskId?: ThreadId;
    readonly taskId?: ThreadId;
    readonly limit: number;
  }) => Effect.Effect<
    { readonly rows: ReadonlyArray<DelegatedTaskMemoryRow>; readonly hasMore: boolean },
    ProjectionRepositoryError
  >;

  /** Small turn-scoped input for summary generation; never hydrates a full transcript. */
  readonly getDelegatedTaskSummaryInput: (input: {
    readonly childThreadId: ThreadId;
    readonly sourceTurnId: TurnId;
  }) => Effect.Effect<Option.Option<DelegatedTaskSummaryInputSnapshot>, ProjectionRepositoryError>;

  /** Bounded keyset scan of terminal delegated child turns needing a summary or parent notification recovery. */
  readonly listDelegatedTaskSummaryRecoveryCandidates: (input: {
    readonly afterChildThreadId?: ThreadId;
    readonly afterSourceTurnId?: TurnId;
    readonly limit: number;
  }) => Effect.Effect<
    {
      readonly rows: ReadonlyArray<DelegatedTaskSummaryRecoveryCandidate>;
      readonly hasMore: boolean;
    },
    ProjectionRepositoryError
  >;

  /** Read the latest request or resolution without loading the thread history. */
  readonly getUserInputActivity: (input: {
    readonly threadId: ThreadId;
    readonly requestId: ApprovalRequestId;
  }) => Effect.Effect<Option.Option<OrchestrationThreadActivity>, ProjectionRepositoryError>;

  /**
   * Read every activity of one kind across active (not deleted, not archived)
   * threads, without hydrating the threads. Used at startup to find state a
   * crashed process left behind.
   */
  readonly listActivitiesByKind: (
    kind: string,
  ) => Effect.Effect<ReadonlyArray<OrchestrationThreadActivity>, ProjectionRepositoryError>;

  /** Same durable activity read, including archived but not deleted threads. */
  readonly listActivitiesByKindIncludingArchived: (
    kind: string,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly threadId: ThreadId; readonly activity: OrchestrationThreadActivity }>,
    ProjectionRepositoryError
  >;

  /**
   * Read the lightweight command snapshot used to bootstrap the in-memory
   * orchestration engine without hydrating message/activity/checkpoint bodies.
   */
  readonly getCommandReadModel: () => Effect.Effect<
    OrchestrationReadModel,
    ProjectionRepositoryError
  >;

  /**
   * Read the latest orchestration projection snapshot.
   *
   * Rehydrates from projection tables and derives snapshot sequence from
   * projector cursor state.
   */
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;

  /**
   * Read the latest orchestration shell snapshot.
   *
   * Returns only projects and thread shell summaries so clients can bootstrap
   * lightweight navigation state without hydrating every thread body.
   */
  readonly getShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Read archived thread shell summaries for the archive page.
   *
   * This query is separate from the main shell snapshot so archived threads
   * are never bootstrapped into normal navigation state.
   */
  readonly getArchivedShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Search active thread navigation metadata, user messages, and canonical
   * assistant outputs without hydrating thread detail snapshots.
   */
  readonly searchThreads: (
    input: OrchestrationSearchThreadsInput,
  ) => Effect.Effect<OrchestrationSearchThreadsResult, ProjectionRepositoryError>;

  /**
   * Read the latest projection snapshot sequence without hydrating read-model
   * entities.
   */
  readonly getSnapshotSequence: () => Effect.Effect<
    ProjectionSnapshotSequence,
    ProjectionRepositoryError
  >;

  /**
   * Read aggregate projection counts without hydrating the full read model.
   */
  readonly getCounts: () => Effect.Effect<ProjectionSnapshotCounts, ProjectionRepositoryError>;

  /**
   * Measure a persisted event range without decoding its payload bodies.
   */
  readonly getEventReplayStats: (input: {
    readonly fromSequenceExclusive: number;
    readonly toSequenceInclusive: number;
  }) => Effect.Effect<ProjectionEventReplayStats, ProjectionRepositoryError>;

  /**
   * Read the active project for an exact workspace root match.
   */
  readonly getActiveProjectByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<Option.Option<OrchestrationProject>, ProjectionRepositoryError>;

  /**
   * Read a single active project shell row by id.
   */
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectionRepositoryError>;

  readonly getProjectShells: (
    projectIds?: ReadonlyArray<ProjectId>,
  ) => Effect.Effect<ReadonlyArray<OrchestrationProjectShell>, ProjectionRepositoryError>;

  /**
   * Read the earliest active thread for a project.
   */
  readonly getFirstActiveThreadIdByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<ThreadId>, ProjectionRepositoryError>;

  /** Read completed import sources without loading thread history. */
  readonly getImportedAgentSessionSources: (projectId: ProjectId) => Effect.Effect<
    ReadonlyArray<{
      readonly threadId: ThreadId;
      readonly source: AgentSessionImportSource;
    }>,
    ProjectionRepositoryError
  >;

  /**
   * Read the checkpoint context needed to resolve a single thread diff.
   */
  readonly getThreadCheckpointContext: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadCheckpointContext>, ProjectionRepositoryError>;

  /**
   * Read only the narrow context needed to compute a full-thread diff from
   * checkpoint 0 to a specific turn count.
   */
  readonly getFullThreadDiffContext: (
    threadId: ThreadId,
    toTurnCount: number,
  ) => Effect.Effect<Option.Option<ProjectionFullThreadDiffContext>, ProjectionRepositoryError>;

  /**
   * Read a single active thread shell row by id.
   */
  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ProjectionRepositoryError>;

  /** Read the active thread and session facts used to ingest provider events. */
  readonly getThreadRuntimeContext: (
    threadId: ThreadId,
  ) => Effect.Effect<
    Option.Option<
      Pick<OrchestrationThreadShell, "id" | "projectId" | "title" | "titleState" | "session">
    >,
    ProjectionRepositoryError
  >;

  /**
   * Read one requested message and whether another non-compaction user message exists.
   * Newer queued messages count too, preserving first-turn title eligibility.
   */
  readonly getTurnStartMessage: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) => Effect.Effect<
    Option.Option<{
      readonly message: OrchestrationMessage;
      readonly hasOtherUserMessages: boolean;
    }>,
    ProjectionRepositoryError
  >;

  /**
   * Read the concrete turn recorded for one request message, if any. Links a
   * request to the turn that consumed it via the persisted pending message id,
   * so startup recovery can tell a sent turn from a claimed-but-lost send.
   */
  readonly getTurnByPendingMessageId: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) => Effect.Effect<
    Option.Option<{
      readonly turnId: TurnId;
      readonly state: ProjectionTurnState;
    }>,
    ProjectionRepositoryError
  >;

  /**
   * Read a single active thread detail snapshot by id.
   */
  readonly getThreadDetailById: (
    threadId: ThreadId,
    query?: ProjectionThreadDetailQuery,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionRepositoryError>;

  /** Internal durable-memory read; includes archived, non-deleted threads. */
  readonly getThreadDetailByIdIncludingArchived: (
    threadId: ThreadId,
    query?: ProjectionThreadDetailQuery,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail together with the projection snapshot
   * sequence in one consistent transaction, so the returned `snapshotSequence`
   * exactly matches the state reflected in `thread` (no interleaving projector
   * update between the two reads).
   *
   * When `window` is provided, the thread's messages, activities, proposed
   * plans, and checkpoints are bounded to a page of recent turns and the
   * response carries `page` metadata (see `OrchestrationThreadDetailWindow`).
   * Without a window the full thread is returned with no `page` field —
   * pagination is strictly opt-in.
   *
   * Activity payloads are projected for clients as they are read in small
   * sequential batches. Callers still apply the full snapshot projector for
   * collection-level activity pruning.
   */
  readonly getThreadDetailSnapshot: (
    threadId: ThreadId,
    window?: OrchestrationThreadDetailWindow,
  ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>, ProjectionRepositoryError>;

  /** Paginated transcript read that includes archived, non-deleted threads. */
  readonly getThreadDetailSnapshotIncludingArchived: (
    threadId: ThreadId,
    window?: OrchestrationThreadDetailWindow,
  ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>, ProjectionRepositoryError>;
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends Context.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("t3/orchestration/Services/ProjectionSnapshotQuery") {}

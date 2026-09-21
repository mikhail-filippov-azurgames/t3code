/**
 * Orchestrator kanban board.
 *
 * A board orchestrator is an ordinary non-child thread a human has marked.
 * Cards belong to exactly one orchestrator (cascade delete with the thread),
 * move through five statuses, and carry a role plus a nullable executor model
 * selection. Progress history is an append-only stream written by the server
 * without an LLM call.
 *
 * @module board
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";
import {
  BoardCard,
  BoardCardEvent,
  BoardCardEventId,
  BoardCardEventSource,
  BoardCardId,
  BoardCardOutcome,
  BoardCardStatus,
  BoardCreatedBy,
  ExecutorRole,
} from "./boardShared.ts";

export {
  BoardCard,
  BoardCardEvent,
  BoardCardEventId,
  BoardCardEventSource,
  BoardCardId,
  BoardCardOutcome,
  BoardCardStatus,
  BoardCreatedBy,
};

/**
 * Executor role vocabulary is shared with the delegation policy; alias keeps
 * the two from drifting apart.
 */
export const BoardExecutorRole = ExecutorRole;
export type BoardExecutorRole = typeof BoardExecutorRole.Type;

/** A thread a human has marked as an orchestrator. */
export const BoardOrchestrator = Schema.Struct({
  threadId: ThreadId,
  createdBy: BoardCreatedBy,
  createdAt: IsoDateTime,
});
export type BoardOrchestrator = typeof BoardOrchestrator.Type;

export const BoardOrchestratorsListInput = Schema.Struct({});
export type BoardOrchestratorsListInput = typeof BoardOrchestratorsListInput.Type;

export const BoardOrchestratorsListResult = Schema.Struct({
  orchestrators: Schema.Array(BoardOrchestrator),
});
export type BoardOrchestratorsListResult = typeof BoardOrchestratorsListResult.Type;

/** Marks an existing non-child thread as an orchestrator. */
export const BoardOrchestratorAddInput = Schema.Struct({
  threadId: ThreadId,
});
export type BoardOrchestratorAddInput = typeof BoardOrchestratorAddInput.Type;

export const BoardOrchestratorAddResult = BoardOrchestrator;
export type BoardOrchestratorAddResult = typeof BoardOrchestratorAddResult.Type;

/** Unmarks the orchestrator; its cards and executor child threads cascade. */
export const BoardOrchestratorRemoveInput = Schema.Struct({
  threadId: ThreadId,
});
export type BoardOrchestratorRemoveInput = typeof BoardOrchestratorRemoveInput.Type;

export const BoardOrchestratorRemoveResult = Schema.Struct({});
export type BoardOrchestratorRemoveResult = typeof BoardOrchestratorRemoveResult.Type;

export const BoardListInput = Schema.Struct({});
export type BoardListInput = typeof BoardListInput.Type;

export const BoardListResult = Schema.Struct({
  cards: Schema.Array(BoardCard),
  /** Append-only progress history for the listed cards, read by the board UI. */
  events: Schema.Array(BoardCardEvent),
});
export type BoardListResult = typeof BoardListResult.Type;

/** Human card creation lands in `todo`; the server stamps `createdBy: human`. */
export const BoardCreateInput = Schema.Struct({
  orchestratorThreadId: ThreadId,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  executorRole: BoardExecutorRole,
  assignee: Schema.optional(Schema.NullOr(ModelSelection)),
});
export type BoardCreateInput = typeof BoardCreateInput.Type;

export const BoardCreateResult = BoardCard;
export type BoardCreateResult = typeof BoardCreateResult.Type;

/** Start moves `todo → orchestrator` and wakes the orchestrator thread. */
export const BoardStartInput = Schema.Struct({
  cardId: BoardCardId,
});
export type BoardStartInput = typeof BoardStartInput.Type;

export const BoardStartResult = BoardCard;
export type BoardStartResult = typeof BoardStartResult.Type;

/** Partial update used by the orchestrator-owned fields. */
export const BoardUpdateInput = Schema.Struct({
  cardId: BoardCardId,
  title: Schema.optional(TrimmedNonEmptyString),
  body: Schema.optional(Schema.String),
  status: Schema.optional(BoardCardStatus),
  executorRole: Schema.optional(BoardExecutorRole),
  assignee: Schema.optional(Schema.NullOr(ModelSelection)),
  executorThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  outcome: Schema.optional(Schema.NullOr(BoardCardOutcome)),
  lastError: Schema.optional(Schema.NullOr(Schema.String)),
  failureStreak: Schema.optional(NonNegativeInt),
  order: Schema.optional(NonNegativeInt),
  archived: Schema.optional(Schema.Boolean),
});
export type BoardUpdateInput = typeof BoardUpdateInput.Type;

export const BoardUpdateResult = BoardCard;
export type BoardUpdateResult = typeof BoardUpdateResult.Type;

export const BoardDeleteInput = Schema.Struct({
  cardId: BoardCardId,
});
export type BoardDeleteInput = typeof BoardDeleteInput.Type;

export const BoardDeleteResult = Schema.Struct({});
export type BoardDeleteResult = typeof BoardDeleteResult.Type;

export class BoardError extends Schema.TaggedError<BoardError>()("BoardError", {
  operation: Schema.String,
  detail: Schema.String,
}) {}

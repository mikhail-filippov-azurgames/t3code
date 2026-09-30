/**
 * Board vocabulary and shapes shared by the canonical board contract
 * (`board.ts`) and the orchestrator MCP board tools (`orchestratorMcp.ts`).
 *
 * The two used to each declare their own card, event, and enum schemas because
 * the executor-role vocabulary lived in `orchestratorMcp.ts`: had the MCP
 * toolkit imported the board schemas back, module init would have hit a value
 * cycle. Keeping the shared shapes here, with no dependency on either consumer,
 * lets both reuse one definition.
 *
 * @module boardShared
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";

export const BoardCardId = TrimmedNonEmptyString.pipe(Schema.brand("BoardCardId"));
export type BoardCardId = typeof BoardCardId.Type;

export const BoardCardEventId = TrimmedNonEmptyString.pipe(Schema.brand("BoardCardEventId"));
export type BoardCardEventId = typeof BoardCardEventId.Type;

export const BoardCardStatus = Schema.Literals([
  "todo",
  "orchestrator",
  "in_progress",
  "review",
  "done",
]);
export type BoardCardStatus = typeof BoardCardStatus.Type;

/** Who created the orchestrator mark or the card. */
export const BoardCreatedBy = Schema.Literals(["human", "orchestrator"]);
export type BoardCreatedBy = typeof BoardCreatedBy.Type;

/** Executor role vocabulary shared by board cards and delegation policy. */
export const EXECUTOR_ROLES = [
  "architecture",
  "implementation",
  "review",
  "test",
  "research",
  "general",
] as const;
export const ExecutorRole = Schema.Literals(EXECUTOR_ROLES);
export type ExecutorRole = typeof ExecutorRole.Type;

export const BoardCardOutcome = Schema.Literals(["succeeded", "failed", "cancelled"]);
export type BoardCardOutcome = typeof BoardCardOutcome.Type;

/** Source of a progress-history entry. Phase 1 only emits system entries. */
export const BoardCardEventSource = Schema.Literal("system");
export type BoardCardEventSource = typeof BoardCardEventSource.Type;

export const BoardCard = Schema.Struct({
  cardId: BoardCardId,
  orchestratorThreadId: ThreadId,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  status: BoardCardStatus,
  createdBy: BoardCreatedBy,
  assignee: Schema.NullOr(ModelSelection),
  executorRole: ExecutorRole,
  executorThreadId: Schema.NullOr(ThreadId),
  outcome: Schema.NullOr(BoardCardOutcome),
  lastError: Schema.NullOr(Schema.String),
  failureStreak: NonNegativeInt,
  order: NonNegativeInt,
  archived: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BoardCard = typeof BoardCard.Type;

/**
 * Append-only progress entry. `model` and `effort` are null until an executor
 * is assigned; `body` carries the short system fact for the event.
 */
export const BoardCardEvent = Schema.Struct({
  entryId: BoardCardEventId,
  cardId: BoardCardId,
  at: IsoDateTime,
  status: BoardCardStatus,
  executorRole: ExecutorRole,
  model: Schema.NullOr(TrimmedNonEmptyString),
  effort: Schema.NullOr(TrimmedNonEmptyString),
  body: Schema.optional(TrimmedNonEmptyString),
  source: BoardCardEventSource,
});
export type BoardCardEvent = typeof BoardCardEvent.Type;

import {
  IsoDateTime,
  ModelSelection,
  NonNegativeInt,
  OrchestratorMcpFailure,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const BoardCardId = TrimmedNonEmptyString.pipe(Schema.brand("BoardCardId"));
export type BoardCardId = typeof BoardCardId.Type;
export const BoardCardEventId = TrimmedNonEmptyString.pipe(Schema.brand("BoardCardEventId"));
export type BoardCardEventId = typeof BoardCardEventId.Type;
export const BoardCardStatus = Schema.Literals([
  "backlog",
  "todo",
  "orchestrator",
  "in_progress",
  "review",
  "done",
]);
export const BoardCardReadiness = Schema.Literals(["ready", "needs_human", "blocked"]);
export const BoardCreatedBy = Schema.Literals(["human", "orchestrator"]);
export const ExecutorRole = Schema.Literals([
  "architecture",
  "implementation",
  "review",
  "test",
  "research",
  "general",
]);
export const BoardCardOutcome = Schema.Literals(["succeeded", "failed", "cancelled"]);

export const BoardOrchestrator = Schema.Struct({
  threadId: ThreadId,
  createdBy: BoardCreatedBy,
  createdAt: IsoDateTime,
});
export type BoardOrchestrator = typeof BoardOrchestrator.Type;
export const BoardCard = Schema.Struct({
  cardId: BoardCardId,
  orchestratorThreadId: ThreadId,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  status: BoardCardStatus,
  readiness: BoardCardReadiness,
  readinessNote: Schema.NullOr(Schema.String),
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
export const BoardCardEvent = Schema.Struct({
  entryId: BoardCardEventId,
  cardId: BoardCardId,
  at: IsoDateTime,
  status: BoardCardStatus,
  executorRole: ExecutorRole,
  model: Schema.NullOr(TrimmedNonEmptyString),
  effort: Schema.NullOr(TrimmedNonEmptyString),
  body: Schema.optional(TrimmedNonEmptyString),
  source: Schema.Literal("system"),
});
export type BoardCardEvent = typeof BoardCardEvent.Type;
export const BoardCardDeletionRecord = Schema.Struct({
  cardId: BoardCardId,
  orchestratorThreadId: ThreadId,
  deletedAt: IsoDateTime,
  reason: Schema.Literals(["retention", "executor-thread-deleted"]),
  historyEventCount: NonNegativeInt,
});
export type BoardCardDeletionRecord = typeof BoardCardDeletionRecord.Type;

const BoundedTitle = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(512),
  Schema.makeFilter((value) => value.trim().length > 0 || "Text must not be blank."),
);
const BoundedId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export const BoardCreateCardInput = Schema.Struct({
  title: BoundedTitle,
  body: Schema.String,
  executorRole: ExecutorRole,
  assignee: Schema.optional(Schema.NullOr(ModelSelection)),
  status: Schema.optional(Schema.Literals(["backlog", "todo", "orchestrator"])),
});
export type BoardCreateCardInput = typeof BoardCreateCardInput.Type;
export const BoardUpdateCardInput = Schema.Struct({
  cardId: BoundedId,
  title: Schema.optional(BoundedTitle),
  body: Schema.optional(Schema.String),
  status: Schema.optional(BoardCardStatus),
  readiness: Schema.optional(BoardCardReadiness),
  readinessNote: Schema.optional(Schema.String),
  executorRole: Schema.optional(ExecutorRole),
  assignee: Schema.optional(Schema.NullOr(ModelSelection)),
  executorThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  outcome: Schema.optional(Schema.NullOr(BoardCardOutcome)),
  lastError: Schema.optional(Schema.NullOr(Schema.String)),
  failureStreak: Schema.optional(NonNegativeInt),
  order: Schema.optional(NonNegativeInt),
  archived: Schema.optional(Schema.Boolean),
});
export type BoardUpdateCardInput = typeof BoardUpdateCardInput.Type;
export const BoardDeleteCardInput = Schema.Struct({ cardId: BoundedId });
export type BoardDeleteCardInput = typeof BoardDeleteCardInput.Type;
export const BoardListCardsInput = Schema.Struct({
  includeArchived: Schema.optional(Schema.Boolean),
  cardIds: Schema.optional(Schema.Array(BoundedId).check(Schema.isMaxLength(10))),
});
export type BoardListCardsInput = typeof BoardListCardsInput.Type;
export const BOARD_LIST_BUDGET_BYTES = 64 * 1024;
const { body: _body, ...summaryFields } = BoardCard.fields;
export const BoardCardSummary = Schema.Struct({ ...summaryFields, bodyChars: NonNegativeInt });
export type BoardCardSummary = typeof BoardCardSummary.Type;
export const BoardListCardsResult = Schema.Struct({
  cards: Schema.Array(Schema.Union([BoardCardSummary, BoardCard])),
  truncated: Schema.Boolean,
  omittedCount: NonNegativeInt,
  notFound: Schema.Array(BoardCardId),
});
export type BoardListCardsResult = typeof BoardListCardsResult.Type;

export const BoardOrchestratorsListInput = Schema.Struct({});
export type BoardOrchestratorsListInput = typeof BoardOrchestratorsListInput.Type;
export const BoardOrchestratorsListResult = Schema.Struct({
  orchestrators: Schema.Array(BoardOrchestrator),
});
export type BoardOrchestratorsListResult = typeof BoardOrchestratorsListResult.Type;

export const BoardOrchestratorAddInput = Schema.Struct({ threadId: ThreadId });
export type BoardOrchestratorAddInput = typeof BoardOrchestratorAddInput.Type;
export const BoardOrchestratorAddResult = BoardOrchestrator;
export type BoardOrchestratorAddResult = typeof BoardOrchestratorAddResult.Type;

export const BoardOrchestratorRemoveInput = Schema.Struct({ threadId: ThreadId });
export type BoardOrchestratorRemoveInput = typeof BoardOrchestratorRemoveInput.Type;
export const BoardOrchestratorRemoveResult = Schema.Struct({});
export type BoardOrchestratorRemoveResult = typeof BoardOrchestratorRemoveResult.Type;

export const BoardOrchestratorResendBriefInput = Schema.Struct({ threadId: ThreadId });
export type BoardOrchestratorResendBriefInput = typeof BoardOrchestratorResendBriefInput.Type;
export const BoardOrchestratorResendBriefResult = Schema.Struct({});
export type BoardOrchestratorResendBriefResult = typeof BoardOrchestratorResendBriefResult.Type;

export const BoardListInput = Schema.Struct({
  includeArchived: Schema.optional(Schema.Boolean),
});
export type BoardListInput = typeof BoardListInput.Type;
export const BoardArchivedCount = Schema.Struct({
  orchestratorThreadId: ThreadId,
  status: BoardCardStatus,
  count: NonNegativeInt,
});
export type BoardArchivedCount = typeof BoardArchivedCount.Type;
export const BoardListResult = Schema.Struct({
  cards: Schema.Array(BoardCard),
  events: Schema.Array(BoardCardEvent),
  archivedCounts: Schema.optional(Schema.Array(BoardArchivedCount)),
});
export type BoardListResult = typeof BoardListResult.Type;

export const BoardCardLookupToken = Schema.String.check(
  Schema.isPattern(
    /^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  ),
).pipe(Schema.brand("BoardCardLookupToken"));
export type BoardCardLookupToken = typeof BoardCardLookupToken.Type;
export const BoardCardResolveInput = Schema.Struct({
  tokens: Schema.Array(BoardCardLookupToken).check(Schema.isMaxLength(100)),
  cardIds: Schema.Array(BoardCardId).check(Schema.isMaxLength(20)),
});
export type BoardCardResolveInput = typeof BoardCardResolveInput.Type;
export const BoardCardLookupMatch = Schema.Struct({
  token: BoardCardLookupToken,
  card: BoardCard,
  orchestratorThreadTitle: Schema.NullOr(TrimmedNonEmptyString),
  recentEvents: Schema.Array(BoardCardEvent),
});
export type BoardCardLookupMatch = typeof BoardCardLookupMatch.Type;
export const BoardCardLookupDetail = Schema.Struct({
  card: BoardCard,
  orchestratorThreadTitle: Schema.NullOr(TrimmedNonEmptyString),
  events: Schema.Array(BoardCardEvent),
});
export type BoardCardLookupDetail = typeof BoardCardLookupDetail.Type;
export const BoardCardResolveResult = Schema.Struct({
  matches: Schema.Array(BoardCardLookupMatch),
  details: Schema.Array(BoardCardLookupDetail),
});
export type BoardCardResolveResult = typeof BoardCardResolveResult.Type;

export const BoardCreateInput = Schema.Struct({
  orchestratorThreadId: ThreadId,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  executorRole: ExecutorRole,
  assignee: Schema.optional(Schema.NullOr(ModelSelection)),
});
export type BoardCreateInput = typeof BoardCreateInput.Type;
export const BoardCreateResult = BoardCard;
export type BoardCreateResult = typeof BoardCreateResult.Type;

export const BoardStartInput = Schema.Struct({ cardId: BoardCardId });
export type BoardStartInput = typeof BoardStartInput.Type;
export const BoardStartResult = BoardCard;
export type BoardStartResult = typeof BoardStartResult.Type;

export const BoardUpdateInput = Schema.Struct({
  cardId: BoardCardId,
  title: Schema.optional(TrimmedNonEmptyString),
  body: Schema.optional(Schema.String),
  status: Schema.optional(BoardCardStatus),
  executorRole: Schema.optional(ExecutorRole),
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

export const BoardDeleteInput = Schema.Struct({ cardId: BoardCardId });
export type BoardDeleteInput = typeof BoardDeleteInput.Type;
export const BoardDeleteResult = Schema.Struct({});
export type BoardDeleteResult = typeof BoardDeleteResult.Type;

export class BoardMcpFailure extends Schema.TaggedError<BoardMcpFailure>()(
  "OrchestratorMcpFailure",
  {
    code: Schema.Union([
      OrchestratorMcpFailure.fields.code,
      Schema.Literals([
        "archive_requires_done",
        "readiness_not_ready",
        "readiness_note_required",
        "executor_required",
        "architect_denied",
        "delegated_executor_denied",
        "author_text_rejected",
      ]),
    ]),
    message: Schema.String,
  },
) {}

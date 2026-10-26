import {
  ChatAttachment,
  EventId,
  IsoDateTime,
  MessageId,
  NodeId,
  NonNegativeInt,
  OrchestrationMessageContext,
  PositiveInt,
  ProviderTurnId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const PageLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(100));
const SearchQuery = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const TaskStatus = Schema.Literals([
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export const TaskListInput = Schema.Struct({
  limit: Schema.optional(PageLimit),
  afterTaskId: Schema.optional(NodeId),
});
export type TaskListInput = typeof TaskListInput.Type;

export const TaskSearchInput = Schema.Struct({
  query: SearchQuery,
  limit: Schema.optional(PageLimit),
  afterTaskId: Schema.optional(NodeId),
});
export type TaskSearchInput = typeof TaskSearchInput.Type;

export const TaskReadInput = Schema.Struct({
  taskId: NodeId,
  turnLimit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(20))),
  beforeCursor: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2_048))),
});
export type TaskReadInput = typeof TaskReadInput.Type;

const boundedHandoffText = (maximum: number) =>
  Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(maximum),
    Schema.makeFilter((value) => value.trim().length > 0 || "Text must not be blank."),
  );

export const OclDocumentRef = TrimmedNonEmptyString.check(
  Schema.isMaxLength(45),
  Schema.isPattern(
    /^oc:\/\/doc\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  ),
);
export type OclDocumentRef = typeof OclDocumentRef.Type;

export const TaskHandoff = Schema.Struct({
  contractRef: OclDocumentRef,
  requiredRevision: PositiveInt,
  implementsRevision: PositiveInt,
  stage: boundedHandoffText(256),
  owns: Schema.Array(boundedHandoffText(2_000)).check(Schema.isMaxLength(100)),
  reads: Schema.Array(boundedHandoffText(2_000)).check(Schema.isMaxLength(100)),
  forbidden: Schema.Array(boundedHandoffText(2_000)).check(Schema.isMaxLength(100)),
  acceptance: Schema.Array(boundedHandoffText(2_000)).check(Schema.isMaxLength(100)),
  outputs: Schema.Array(boundedHandoffText(2_000)).check(Schema.isMaxLength(100)),
  evidence: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(4_096))).check(
    Schema.isMaxLength(100),
  ),
  predecessorRefs: Schema.Array(OclDocumentRef).check(Schema.isMaxLength(100)),
}).check(
  Schema.makeFilter(
    (handoff) =>
      handoff.requiredRevision === handoff.implementsRevision ||
      "requiredRevision must equal implementsRevision.",
  ),
);
export type TaskHandoff = typeof TaskHandoff.Type;

export const TaskAttachHandoffInput = Schema.Struct({
  taskId: NodeId,
  handoff: TaskHandoff,
});
export type TaskAttachHandoffInput = typeof TaskAttachHandoffInput.Type;

export const TaskAttachHandoffResult = Schema.Struct({
  taskId: NodeId,
  handoff: TaskHandoff,
  created: Schema.Boolean,
});
export type TaskAttachHandoffResult = typeof TaskAttachHandoffResult.Type;

const SUMMARY_SOURCE_TURN_IDS_MAX = 32;

export const TaskSummary = Schema.Struct({
  text: Schema.String,
  source: Schema.Literals(["model", "deterministic"]),
  sourceTurnIds: Schema.Array(TurnId).check(Schema.isMaxLength(SUMMARY_SOURCE_TURN_IDS_MAX)),
  watermark: NonNegativeInt,
  stale: Schema.Boolean,
  state: Schema.Literals(["pending", "ready", "error"]),
  error: Schema.NullOr(Schema.String),
});
export type TaskSummary = typeof TaskSummary.Type;

const TaskMemoryEntry = Schema.Struct({
  taskId: NodeId,
  childThreadId: ThreadId,
  role: Schema.NullOr(Schema.String),
  title: Schema.String,
  latestStatus: TaskStatus,
  latestTurnId: Schema.NullOr(ProviderTurnId),
  updatedAt: IsoDateTime,
  worktreePath: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(TaskSummary),
  handoff: Schema.NullOr(TaskHandoff),
});
export type TaskMemoryEntry = typeof TaskMemoryEntry.Type;

export const TaskListResult = Schema.Struct({
  tasks: Schema.Array(TaskMemoryEntry).check(Schema.isMaxLength(100)),
  nextCursor: Schema.NullOr(NodeId),
});
export type TaskListResult = typeof TaskListResult.Type;

export const TaskSearchResult = Schema.Struct({
  query: SearchQuery,
  ...TaskListResult.fields,
});
export type TaskSearchResult = typeof TaskSearchResult.Type;

export const TaskSummaryHistoryCursor = Schema.Struct({
  completedAt: IsoDateTime,
  childThreadId: ThreadId,
  sourceTurnId: TurnId,
});
export type TaskSummaryHistoryCursor = typeof TaskSummaryHistoryCursor.Type;

export const TaskSummaryHistoryInput = Schema.Struct({
  limit: Schema.optional(PageLimit),
  cursor: Schema.optional(TaskSummaryHistoryCursor),
});
export type TaskSummaryHistoryInput = typeof TaskSummaryHistoryInput.Type;

const TaskSummaryHistoryRecord = Schema.Struct({
  childThreadId: ThreadId,
  sourceTurnId: TurnId,
  completedAt: IsoDateTime,
  summaryText: Schema.String,
  summaryState: Schema.Literals(["pending", "ready", "error"]),
  summaryWatermark: NonNegativeInt,
  currentTurnId: Schema.NullOr(ProviderTurnId),
  currentTurnState: Schema.NullOr(
    Schema.Literals(["pending", "running", "interrupted", "completed", "error"]),
  ),
  currentWatermark: NonNegativeInt,
  executorRole: Schema.String,
  stale: Schema.Boolean,
});

export const TaskSummaryHistoryResult = Schema.Struct({
  records: Schema.Array(TaskSummaryHistoryRecord).check(Schema.isMaxLength(100)),
  nextCursor: Schema.NullOr(TaskSummaryHistoryCursor),
});
export type TaskSummaryHistoryResult = typeof TaskSummaryHistoryResult.Type;

const TranscriptMessage = Schema.Struct({
  id: MessageId,
  role: Schema.Literals(["user", "assistant", "system"]),
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  context: Schema.optional(OrchestrationMessageContext),
  turnId: Schema.NullOr(ProviderTurnId),
  streaming: Schema.Boolean,
  createdAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});

const TranscriptActivity = Schema.Struct({
  id: EventId,
  tone: Schema.Literals(["info", "tool", "approval", "error"]),
  kind: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  payload: Schema.Unknown,
  turnId: Schema.NullOr(ProviderTurnId),
  createdAt: Schema.NullOr(IsoDateTime),
});

export const TaskReadResult = Schema.Struct({
  taskId: NodeId,
  title: Schema.String,
  handoff: Schema.NullOr(TaskHandoff),
  summary: Schema.NullOr(TaskSummary),
  messages: Schema.Array(TranscriptMessage).check(Schema.isMaxLength(10_000)),
  activities: Schema.Array(TranscriptActivity).check(Schema.isMaxLength(10_000)),
  page: Schema.Struct({
    beforeCursor: Schema.NullOr(TrimmedNonEmptyString),
    hasMore: Schema.Boolean,
    snapshotSequence: NonNegativeInt,
    threadSequence: Schema.optional(NonNegativeInt),
  }),
});
export type TaskReadResult = typeof TaskReadResult.Type;

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

const TaskMemoryEntry = Schema.Struct({
  taskId: NodeId,
  childThreadId: ThreadId,
  role: Schema.NullOr(Schema.String),
  title: Schema.String,
  latestStatus: TaskStatus,
  latestTurnId: Schema.NullOr(ProviderTurnId),
  updatedAt: IsoDateTime,
  worktreePath: Schema.NullOr(Schema.String),
  summary: Schema.Null,
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

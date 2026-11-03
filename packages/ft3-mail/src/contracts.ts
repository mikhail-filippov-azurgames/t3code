/** Browser-safe mail contracts; storage and delivery logic live in `./repository` and the service. */
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const MailTaskId = TrimmedNonEmptyString;
export type MailTaskId = typeof MailTaskId.Type;

export const MailMemberId = TrimmedNonEmptyString;
export type MailMemberId = typeof MailMemberId.Type;

export const MailLetterId = TrimmedNonEmptyString;
export type MailLetterId = typeof MailLetterId.Type;

export const MailDeliveryId = TrimmedNonEmptyString;
export type MailDeliveryId = typeof MailDeliveryId.Type;

/** A thread or the literal `system` sender. */
export const MailSenderId = TrimmedNonEmptyString;
export type MailSenderId = typeof MailSenderId.Type;

/** The routing level a task or member asks for. */
export const MailLevel = Schema.Literals(["low", "medium", "high", "very-high"]);
export type MailLevel = typeof MailLevel.Type;

export const MailIsolation = Schema.Literals(["none", "worktree"]);
export type MailIsolation = typeof MailIsolation.Type;

export const MailTaskStatus = Schema.Literals(["open", "closed"]);
export type MailTaskStatus = typeof MailTaskStatus.Type;

export const MailOutcome = Schema.Literals(["succeeded", "failed", "cancelled"]);
export type MailOutcome = typeof MailOutcome.Type;

export const MailLetterKind = Schema.Literals([
  "request",
  "approve",
  "changes",
  "question",
  "answer",
  "blocked",
  "info",
]);
export type MailLetterKind = typeof MailLetterKind.Type;

export const MailPlanPhase = Schema.Literals(["draft", "review", "prototype", "implement"]);
export type MailPlanPhase = typeof MailPlanPhase.Type;

export const MailDeliveryState = Schema.Literals(["pending", "delivered", "read", "answered"]);
export type MailDeliveryState = typeof MailDeliveryState.Type;

export const MailMemberStatus = Schema.Literals(["active", "closed"]);
export type MailMemberStatus = typeof MailMemberStatus.Type;

export const MailTask = Schema.Struct({
  taskId: MailTaskId,
  title: TrimmedNonEmptyString,
  brief: Schema.String,
  level: MailLevel,
  cardId: Schema.NullOr(TrimmedNonEmptyString),
  isolation: Schema.NullOr(MailIsolation),
  runtimeMode: Schema.NullOr(Schema.String),
  interactionMode: Schema.NullOr(Schema.String),
  responseBudgetSeconds: Schema.Int.check(Schema.isGreaterThan(0)),
  status: MailTaskStatus,
  outcome: Schema.NullOr(MailOutcome),
  summary: Schema.NullOr(Schema.String),
  createdByThreadId: MailSenderId,
  clientRequestId: Schema.String,
  requestFingerprint: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  closedAt: Schema.NullOr(Schema.String),
});
export type MailTask = typeof MailTask.Type;

export const MailMember = Schema.Struct({
  memberId: MailMemberId,
  taskId: MailTaskId,
  roleId: TrimmedNonEmptyString,
  specialization: Schema.NullOr(TrimmedNonEmptyString),
  level: Schema.NullOr(MailLevel),
  responseBudgetSeconds: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  documentsWrite: Schema.Boolean,
  modelOverrideJson: Schema.NullOr(Schema.String),
  humanInstruction: Schema.NullOr(Schema.String),
  participantThreadId: Schema.NullOr(MailSenderId),
  status: MailMemberStatus,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type MailMember = typeof MailMember.Type;

export const MailLetter = Schema.Struct({
  letterId: MailLetterId,
  taskId: MailTaskId,
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  senderThreadId: MailSenderId,
  recipient: TrimmedNonEmptyString,
  kind: MailLetterKind,
  body: Schema.String,
  replyToLetterId: Schema.NullOr(MailLetterId),
  sourceLetterId: Schema.NullOr(MailLetterId),
  planPhase: Schema.NullOr(MailPlanPhase),
  planStep: Schema.NullOr(TrimmedNonEmptyString),
  planSha256: Schema.NullOr(Schema.String),
  planDocId: Schema.NullOr(TrimmedNonEmptyString),
  classifierKind: Schema.NullOr(MailLetterKind),
  classifierConfidence: Schema.NullOr(Schema.Number),
  kindDisputed: Schema.Boolean,
  leadKind: Schema.NullOr(MailLetterKind),
  clientRequestId: Schema.String,
  requestFingerprint: Schema.String,
  createdAt: Schema.String,
});
export type MailLetter = typeof MailLetter.Type;

export const MailDelivery = Schema.Struct({
  deliveryId: MailDeliveryId,
  taskId: MailTaskId,
  letterId: MailLetterId,
  memberId: Schema.NullOr(MailMemberId),
  recipient: TrimmedNonEmptyString,
  participantThreadId: Schema.NullOr(MailSenderId),
  state: MailDeliveryState,
  deliveredAt: Schema.NullOr(Schema.String),
  readAt: Schema.NullOr(Schema.String),
  answeredAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type MailDelivery = typeof MailDelivery.Type;

/** A letter with the delivery state of every recipient the service recorded. */
export const MailTimelineEntry = Schema.Struct({
  letter: MailLetter,
  deliveries: Schema.Array(MailDelivery),
});
export type MailTimelineEntry = typeof MailTimelineEntry.Type;

/** The upstream role name a member is launched as. */
export const MailRole = Schema.Struct({
  roleId: TrimmedNonEmptyString,
  specialization: Schema.NullOr(TrimmedNonEmptyString),
});
export type MailRole = typeof MailRole.Type;

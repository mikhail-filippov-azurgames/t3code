import { ModelSelection, OrchestratorMcpFailure, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import * as PlanningContracts from "@t3tools/ft3-board/planning-contracts";

import {
  MailDelivery,
  MailIsolation,
  MailLetter,
  MailLetterKind,
  MailLevel,
  MailMember,
  MailOutcome,
  MailRound,
  MailTask,
  MailTimelineEntry,
} from "./contracts.ts";

/**
 * MCP surface for mail (design §9.1): seven thread-scoped tools. The calling
 * thread is the caller; reads list state, mutations act as the caller. The
 * tag matches the shared MCP failure so the access wrappers typecheck.
 */
export const MailSpecificMcpFailureCode = Schema.Literals([
  "mail_disabled",
  "task_not_found",
  "card_not_found",
  "task_closed",
  "member_closed",
  "letter_not_found",
  "address_denied",
  "kind_denied",
  "kind_not_disputed",
  "invalid_role",
  "capability_denied",
  "human_instruction_required",
  "model_unavailable",
  "idempotency_conflict",
  "invalid_request",
  "plan_not_found",
  "plan_transition_invalid",
  "plan_review_rounds_exhausted",
  "plan_not_accepted",
  "plan_changed",
  "plan_phase_required",
  "plan_phase_invalid",
  "plan_step_unknown",
  "planning_disabled",
  "mail_disabled_notice",
  "thread_credential_required",
  "internal",
]);
export type MailSpecificMcpFailureCode = typeof MailSpecificMcpFailureCode.Type;

/** A mail tool failure: the shared MCP codes plus the mail-specific ones. */
export class MailMcpFailure extends Schema.TaggedError<MailMcpFailure>()("OrchestratorMcpFailure", {
  code: Schema.Union([OrchestratorMcpFailure.fields.code, MailSpecificMcpFailureCode]),
  message: Schema.String,
}) {}

export const MailTitle = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
export const MailBody = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120000));
export const MailClientRequestId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
);
export const MailHumanInstruction = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4096),
);

export const MailModelOverrideInput = Schema.Struct({
  modelSelection: ModelSelection,
  humanInstruction: MailHumanInstruction,
});
export type MailModelOverrideInput = typeof MailModelOverrideInput.Type;

export const MailMemberRequestInput = Schema.Struct({
  role: Schema.String.check(Schema.isMinLength(1)),
  specialization: Schema.optional(Schema.String),
  level: Schema.optional(MailLevel),
  responseBudgetSeconds: Schema.optional(Schema.Number),
  documentsWrite: Schema.optional(Schema.Boolean),
  modelOverride: Schema.optional(MailModelOverrideInput),
});
export type MailMemberRequestInput = typeof MailMemberRequestInput.Type;

export const MailTaskCreateInput = Schema.Struct({
  title: MailTitle,
  brief: MailBody,
  level: MailLevel,
  responseBudgetSeconds: Schema.optional(Schema.Number),
  members: Schema.Array(MailMemberRequestInput).check(Schema.isMinLength(1)),
  clientRequestId: MailClientRequestId,
  cardId: Schema.optional(TrimmedNonEmptyString),
  isolation: Schema.optional(MailIsolation),
  runtimeMode: Schema.optional(Schema.String),
  interactionMode: Schema.optional(Schema.String),
});
export type MailTaskCreateInput = typeof MailTaskCreateInput.Type;

export const MailSkippedCandidate = Schema.Struct({
  alias: Schema.String,
  model: Schema.NullOr(Schema.String),
  reason: Schema.Literals(["alias_unknown", "accelerated_model", "unavailable"]),
});

export const MailNoCandidate = Schema.Struct({
  role: Schema.String,
  level: Schema.String,
  skipped: Schema.Array(MailSkippedCandidate),
});
export type MailNoCandidate = typeof MailNoCandidate.Type;

export const MailMemberLaunch = Schema.Literals(["not_started", "started", "closed"]);
export type MailMemberLaunch = typeof MailMemberLaunch.Type;

export const mailMemberLaunch = (
  member: Pick<MailMember, "status" | "participantThreadId">,
): MailMemberLaunch => {
  if (member.status === "closed") return "closed";
  return member.participantThreadId === null ? "not_started" : "started";
};

export const MailTaskCreateResult = Schema.Struct({
  created: Schema.Boolean,
  task: MailTask,
  members: Schema.Array(
    Schema.Struct({
      member: MailMember,
      launch: MailMemberLaunch,
      noCandidate: Schema.NullOr(MailNoCandidate),
    }),
  ),
  next: Schema.NullOr(Schema.String),
});
export type MailTaskCreateResult = typeof MailTaskCreateResult.Type;

/**
 * The plan payload of a letter (design §9.1): the phase it belongs to, the
 * step it executes, and the cited plan version. Absent on plain letters.
 */
export const MailSendPlan = Schema.Struct({
  phase: PlanningContracts.PlanPhase,
  step: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  citation: Schema.optional(PlanningContracts.PlanCitation),
});
export type MailSendPlan = typeof MailSendPlan.Type;

export const MailSendInput = Schema.Struct({
  taskId: Schema.String.check(Schema.isMinLength(1)),
  to: Schema.String.check(Schema.isMinLength(1)),
  kind: MailLetterKind,
  body: MailBody,
  replyToLetterId: Schema.optional(Schema.String),
  clientRequestId: MailClientRequestId,
  plan: Schema.optional(MailSendPlan),
  /** Lead only: steer an active participant instead of waiting for its turn to end. */
  urgent: Schema.optional(Schema.Boolean),
});
export type MailSendInput = typeof MailSendInput.Type;

export const MailSendResult = Schema.Struct({
  created: Schema.Boolean,
  letter: MailLetter,
  deliveries: Schema.Array(MailDelivery),
  launched: Schema.Array(
    Schema.Struct({ memberId: Schema.String, participantThreadId: Schema.String }),
  ),
  launchFailures: Schema.Array(Schema.Struct({ memberId: Schema.String, reason: Schema.String })),
  noCandidate: Schema.Array(
    Schema.Struct({
      memberId: Schema.String,
      role: Schema.String,
      level: Schema.String,
      skipped: Schema.Array(MailSkippedCandidate),
    }),
  ),
});
export type MailSendResult = typeof MailSendResult.Type;

export const MailReadInput = Schema.Struct({
  letterId: Schema.String.check(Schema.isMinLength(1)),
});
export type MailReadInput = typeof MailReadInput.Type;

export const MailReadResult = Schema.Struct({
  letter: MailLetter,
  deliveries: Schema.Array(MailDelivery),
  effectiveKind: MailLetterKind,
});
export type MailReadResult = typeof MailReadResult.Type;

export const MailTaskReadInput = Schema.Struct({
  taskId: Schema.String.check(Schema.isMinLength(1)),
  beforeLetterId: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
});
export type MailTaskReadInput = typeof MailTaskReadInput.Type;

export const MailTaskReadResult = Schema.Struct({
  task: MailTask,
  members: Schema.Array(MailMember),
  rounds: Schema.Array(MailRound),
  entries: Schema.Array(MailTimelineEntry),
});
export type MailTaskReadResult = typeof MailTaskReadResult.Type;

export const MailMemberSetModelInput = Schema.Struct({
  taskId: Schema.String.check(Schema.isMinLength(1)),
  memberId: Schema.String.check(Schema.isMinLength(1)),
  modelSelection: ModelSelection,
  humanInstruction: MailHumanInstruction,
  clientRequestId: MailClientRequestId,
});
export type MailMemberSetModelInput = typeof MailMemberSetModelInput.Type;

export const MailLetterSetKindInput = Schema.Struct({
  letterId: Schema.String.check(Schema.isMinLength(1)),
  kind: MailLetterKind,
  clientRequestId: MailClientRequestId,
});
export type MailLetterSetKindInput = typeof MailLetterSetKindInput.Type;

export const MailLetterSetKindResult = Schema.Struct({
  letter: MailLetter,
  effectiveKind: MailLetterKind,
});
export type MailLetterSetKindResult = typeof MailLetterSetKindResult.Type;

export const MailTaskCloseInput = Schema.Struct({
  taskId: Schema.String.check(Schema.isMinLength(1)),
  outcome: MailOutcome,
  summary: Schema.String.check(Schema.isMinLength(1)),
});
export type MailTaskCloseInput = typeof MailTaskCloseInput.Type;

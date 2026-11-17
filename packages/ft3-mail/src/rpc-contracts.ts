import { AuthOrchestrationReadScope, EnvironmentAuthorizationError } from "@t3tools/contracts";
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  MailLetter,
  MailLetterKind,
  MailMember,
  MailTask,
  MailTimelineEntry,
} from "./contracts.ts";
import { MailMcpFailure, MailMemberLaunch } from "./toolContracts.ts";

export const FT3_MAIL_WS_METHODS = {
  mailTimeline: "mail.timeline",
  mailTasks: "mail.tasks",
  mailLetter: "mail.letter",
} as const;

export const MailLetterRpcInput = Schema.Struct({
  letterId: Schema.String.check(Schema.isMinLength(1)),
  /** The lead thread the letter is shown in; only that task's lead may read it here. */
  threadId: Schema.String.check(Schema.isMinLength(1)),
});
export type MailLetterRpcInput = typeof MailLetterRpcInput.Type;

export const MailLetterRpcSuccess = Schema.Struct({
  letter: MailLetter,
  effectiveKind: MailLetterKind,
});
export type MailLetterRpcSuccess = typeof MailLetterRpcSuccess.Type;

export const MailTimelineRpcInput = Schema.Struct({
  taskId: Schema.String.check(Schema.isMinLength(1)),
  beforeSequence: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
  /**
   * The lead thread reading the timeline; when set, only a task created by
   * that thread is returned, like mail.letter enforces for a single letter.
   */
  threadId: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
});
export type MailTimelineRpcInput = typeof MailTimelineRpcInput.Type;

export const MailTimelineRpcSuccess = Schema.Struct({
  task: MailTask,
  entries: Schema.Array(MailTimelineEntry),
});
export type MailTimelineRpcSuccess = typeof MailTimelineRpcSuccess.Type;

export const MailTasksRpcInput = Schema.Struct({
  cardIds: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  limit: Schema.optional(Schema.Number),
  /**
   * When set, each returned task comes with its most recent letters (newest
   * first, bounded by this number), so the board Mail tab needs one request
   * for the whole page instead of one timeline request per task.
   */
  lettersPerTask: Schema.optional(Schema.Number),
  /**
   * Also return the calling lead's open tasks that have no card.
   */
  withoutCard: Schema.optional(Schema.Boolean),
  /**
   * The calling lead thread. Only tasks created by this thread are returned —
   * card tasks and cardless tasks alike — so one lead never sees another
   * lead's mail. Mirrors the mail.letter ownership check.
   */
  threadId: Schema.String.check(Schema.isMinLength(1)),
});
export type MailTasksRpcInput = typeof MailTasksRpcInput.Type;

export const MailTasksRpcSuccess = Schema.Struct({
  tasks: Schema.Array(MailTask),
  letters: Schema.optional(Schema.Record(Schema.String, Schema.Array(MailTimelineEntry))),
  members: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Array(
        Schema.Struct({
          roleId: MailMember.fields.roleId,
          specialization: MailMember.fields.specialization,
          status: MailMember.fields.status,
          launch: MailMemberLaunch,
        }),
      ),
    ),
  ),
});
export type MailTasksRpcSuccess = typeof MailTasksRpcSuccess.Type;

export const MailRpcError = Schema.Union([MailMcpFailure, EnvironmentAuthorizationError]);

export const mailRpcs = [
  Rpc.make(FT3_MAIL_WS_METHODS.mailTimeline, {
    payload: MailTimelineRpcInput,
    success: MailTimelineRpcSuccess,
    error: MailRpcError,
  }),
  Rpc.make(FT3_MAIL_WS_METHODS.mailTasks, {
    payload: MailTasksRpcInput,
    success: MailTasksRpcSuccess,
    error: MailRpcError,
  }),
  Rpc.make(FT3_MAIL_WS_METHODS.mailLetter, {
    payload: MailLetterRpcInput,
    success: MailLetterRpcSuccess,
    error: MailRpcError,
  }),
];

export const mailRpcScopes = {
  [FT3_MAIL_WS_METHODS.mailTimeline]: AuthOrchestrationReadScope,
  [FT3_MAIL_WS_METHODS.mailTasks]: AuthOrchestrationReadScope,
  [FT3_MAIL_WS_METHODS.mailLetter]: AuthOrchestrationReadScope,
} as const;

import { AuthOrchestrationReadScope, EnvironmentAuthorizationError } from "@t3tools/contracts";
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { MailTask, MailTimelineEntry } from "./contracts.ts";
import { MailMcpFailure } from "./toolContracts.ts";

export const FT3_MAIL_WS_METHODS = {
  mailTimeline: "mail.timeline",
  mailTasks: "mail.tasks",
} as const;

export const MailTimelineRpcInput = Schema.Struct({
  taskId: Schema.String.check(Schema.isMinLength(1)),
  beforeSequence: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
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
});
export type MailTasksRpcInput = typeof MailTasksRpcInput.Type;

export const MailTasksRpcSuccess = Schema.Struct({
  tasks: Schema.Array(MailTask),
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
];

export const mailRpcScopes = {
  [FT3_MAIL_WS_METHODS.mailTimeline]: AuthOrchestrationReadScope,
  [FT3_MAIL_WS_METHODS.mailTasks]: AuthOrchestrationReadScope,
} as const;

import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../../apps/server/src/mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import { MailMember, MailTask } from "./contracts.ts";
import { MailService } from "./service.ts";
import * as Contracts from "./toolContracts.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  MailService,
  ThreadManagement.ThreadManagementService,
];

const offNotice = " Refused with mail_disabled_notice while the mail feature is off.";

const mailTaskCreate = Tool.make("mail_task_create", {
  description: `Start a mail task: the calling thread becomes the lead, and each member is routed to a participant thread.${offNotice}`,
  parameters: Contracts.MailTaskCreateInput,
  success: Contracts.MailTaskCreateResult,
  failure: Contracts.MailMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create mail task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const mailSend = Tool.make("mail_send", {
  description: `Send a letter in a mail task. The lead starts threadless members on resend; a participant answers the lead. A plan letter carries plan.phase (draft, review, prototype, implement) with the step it executes and the cited plan version; draft goes to the planner, review opens a review round with architect members, prototype runs on cards whose executor role is gated, implement runs only an accepted step whose live document matches the accepted digest.${offNotice}`,
  parameters: Contracts.MailSendInput,
  success: Contracts.MailSendResult,
  failure: Contracts.MailMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Send mail letter")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const mailRead = Tool.make("mail_read", {
  description: `Read one full letter. An agent recipient reading marks its delivered delivery read.${offNotice}`,
  parameters: Contracts.MailReadInput,
  success: Contracts.MailReadResult,
  failure: Contracts.MailMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read mail letter")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const mailTaskRead = Tool.make("mail_task_read", {
  description: `Read a mail task with its members, rounds and the newest-first letter timeline.${offNotice}`,
  parameters: Contracts.MailTaskReadInput,
  success: Contracts.MailTaskReadResult,
  failure: Contracts.MailMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read mail task")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const mailMemberSetModel = Tool.make("mail_member_set_model", {
  description: `Mid-task model override for one member on the same thread; lead-only, needs a human instruction, and the next dispatch runs on the new model.${offNotice}`,
  parameters: Contracts.MailMemberSetModelInput,
  success: MailMember,
  failure: Contracts.MailMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Set mail member model")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const mailLetterSetKind = Tool.make("mail_letter_set_kind", {
  description: `Lead-only decision on a disputed letter kind; transitions are recalculated and training feedback is recorded.${offNotice}`,
  parameters: Contracts.MailLetterSetKindInput,
  success: Contracts.MailLetterSetKindResult,
  failure: Contracts.MailMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Set mail letter kind")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const mailTaskClose = Tool.make("mail_task_close", {
  description: `Close a mail task when every member is closed; lead-only.${offNotice}`,
  parameters: Contracts.MailTaskCloseInput,
  success: MailTask,
  failure: Contracts.MailMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Close mail task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const toolkit = Toolkit.make(
  mailTaskCreate,
  mailSend,
  mailRead,
  mailTaskRead,
  mailMemberSetModel,
  mailLetterSetKind,
  mailTaskClose,
);

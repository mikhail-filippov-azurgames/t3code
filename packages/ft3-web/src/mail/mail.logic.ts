import type {
  MailDeliveryState,
  MailLetter,
  MailPlanPhase,
  MailTask,
  MailTimelineEntry,
} from "@t3tools/ft3-mail/contracts";

/** One board mail task with its letters, oldest first for reading. */
export interface MailTaskGroup {
  readonly task: MailTask;
  readonly entries: ReadonlyArray<MailTimelineEntry>;
}

/**
 * Groups one `mail.tasks` row with its `mail.timeline` page: the timeline
 * arrives newest-first and flips to chronological so a task reads like a
 * conversation. Tasks keep the server's newest-first order in the tab list.
 */
export function mailTaskGroup(
  task: MailTask,
  entries: ReadonlyArray<MailTimelineEntry>,
): MailTaskGroup {
  return { task, entries: [...entries].reverse() };
}

/** Letters older than a full page stay reachable on the server; the tab caps at this many. */
export const MAIL_TIMELINE_PAGE_LIMIT = 50;

export function mailLetterSenderLabel(letter: MailLetter, task: MailTask): string {
  if (letter.senderThreadId === task.createdByThreadId) return "lead";
  if (letter.senderThreadId === "system") return "system";
  return "participant";
}

/** `member:<id>` says nothing to a human; the role form is the readable one. */
export function mailRecipientLabel(recipient: string): string {
  if (recipient === "lead" || recipient === "human") return recipient;
  if (recipient.startsWith("role:")) return recipient.slice("role:".length);
  if (recipient.startsWith("member:")) return "member";
  return recipient;
}

export function mailPlanPhaseLabel(phase: MailPlanPhase, step: string | null): string {
  return step === null ? phase : `${phase} ${step}`;
}

export type MailDeliveryBadgeVariant = "secondary" | "outline" | "info" | "success" | "error";

export function mailDeliveryBadgeVariant(state: MailDeliveryState): MailDeliveryBadgeVariant {
  switch (state) {
    case "pending":
      return "secondary";
    case "delivered":
      return "outline";
    case "read":
      return "info";
    case "answered":
      return "success";
    case "failed":
      return "error";
  }
}

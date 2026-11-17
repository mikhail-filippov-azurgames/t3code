import type {
  MailDeliveryState,
  MailLetter,
  MailPlanPhase,
  MailTask,
  MailTimelineEntry,
} from "@t3tools/ft3-mail/contracts";
import type { MailTasksRpcSuccess } from "@t3tools/ft3-mail/rpc-contracts";

type MailTaskMember = NonNullable<MailTasksRpcSuccess["members"]>[string][number];

/** One board mail task with its letters, oldest first for reading. */
export interface MailTaskGroup {
  readonly task: MailTask;
  readonly entries: ReadonlyArray<MailTimelineEntry>;
  readonly members: ReadonlyArray<MailTaskMember>;
}

/**
 * Groups the batched `mail.tasks` page for the tab: tasks stay in the
 * server's newest-first order, and each task's letters flip from the
 * timeline's newest-first to chronological so a task reads like a
 * conversation. Tasks without a letters entry render an empty thread.
 */
export function mailTaskGroups(
  tasks: ReadonlyArray<MailTask>,
  letters: Readonly<Record<string, ReadonlyArray<MailTimelineEntry>>>,
  members?: Readonly<Record<string, ReadonlyArray<MailTaskMember>>>,
): ReadonlyArray<MailTaskGroup> {
  return tasks.map((task) => {
    const entries = letters[task.taskId];
    return {
      task,
      entries: entries === undefined ? [] : [...entries].reverse(),
      members: members?.[task.taskId] ?? [],
    };
  });
}

export function mailMemberLaunchLabel(launch: MailTaskMember["launch"]): string {
  switch (launch) {
    case "not_started":
      return "не запущен";
    case "started":
      return "запущен";
    case "closed":
      return "закрыт";
  }
}

/** Letters older than a full page stay reachable on the server; the tab caps at this many. */
export const MAIL_TIMELINE_PAGE_LIMIT = 50;

/** The tab asks for at most this many tasks; hitting the cap shows a note. */
export const MAIL_TASKS_PAGE_LIMIT = 50;

/**
 * An old server without the mail.tasks method dies with an unknown-request-tag
 * defect, which surfaces as a formatted error with no typed failure. Real
 * server errors keep their typed failure, so the two stay distinguishable.
 */
export function mailTasksUnsupported(error: string | null, failure: unknown): boolean {
  return failure === null && error !== null && error.startsWith("Unknown request tag");
}

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

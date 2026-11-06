/** Board wake, brief, nudge and mail prompts are identified by their server-issued message id. */
import type { MailLetterKind } from "@t3tools/ft3-mail/contracts";

export type BoardWakeNoticeKind = "wake" | "brief" | "nudge" | "mail";

export interface BoardWakeNoticeMessage {
  readonly id: string;
  readonly text: string;
}

/** The parsed header of a `mail:wake:` message; the body expands on click. */
export interface MailWakeDetail {
  readonly kind: MailLetterKind;
  /** Lead, system, or the participant role the reactor resolved. */
  readonly sender: string | null;
  readonly task: string;
  readonly body: string;
}

export interface BoardWakeNotice {
  readonly kind: BoardWakeNoticeKind;
  /** The full prompt body shown when the notice is expanded. */
  readonly text: string;
  /** First event line, when the kind has one. */
  readonly detail: string | null;
  /** Present only for a parsed mail wake. */
  readonly mail?: MailWakeDetail;
}

const WAKE_MESSAGE_ID_PREFIXES = [
  "ft3:board:wake:",
  "ft3:board:mark:",
  "ft3:board:start:",
  "ft3:board:orphan:",
] as const;
const BRIEF_MESSAGE_ID_PREFIX = "ft3:board:brief:";
const NUDGE_MESSAGE_ID_PREFIX = "board:idle-nudge:";
const MAIL_WAKE_MESSAGE_ID_PREFIX = "mail:wake:";

const CARD_CONTEXT_MARKER = "Current card context:";
const NUDGE_CARD_LINE = /^Card:\s*(.+)$/m;

/** The reactor writes `New <kind> letter[ from <sender>] in mail task "<title>":\n\n<body>`. */
const MAIL_WAKE_TEXT_PATTERN =
  /^New (\S+) letter(?: from (.+?))? in mail task "([^"]+)":\n\n([\s\S]*)$/;
const MAIL_WAKE_KINDS = new Set([
  "request",
  "approve",
  "changes",
  "question",
  "answer",
  "blocked",
  "info",
]);

export function boardWakeNoticeKind(id: string): BoardWakeNoticeKind | null {
  if (id.startsWith(MAIL_WAKE_MESSAGE_ID_PREFIX)) return "mail";
  if (id.startsWith(NUDGE_MESSAGE_ID_PREFIX)) return "nudge";
  if (id.startsWith(BRIEF_MESSAGE_ID_PREFIX)) return "brief";
  return WAKE_MESSAGE_ID_PREFIXES.some((prefix) => id.startsWith(prefix)) ? "wake" : null;
}

function firstNonEmptyLine(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line !== "") return line;
  }
  return null;
}

/** The wake text carries the event that triggered it after the card-context header. */
function firstEventLine(text: string): string | null {
  const markerIndex = text.indexOf(CARD_CONTEXT_MARKER);
  const source = markerIndex === -1 ? text : text.slice(markerIndex + CARD_CONTEXT_MARKER.length);
  return firstNonEmptyLine(source);
}

function nudgeCardLine(text: string): string | null {
  const match = NUDGE_CARD_LINE.exec(text);
  const line = match?.[1]?.trim();
  return line === undefined || line === "" ? null : line;
}

function mailWakeNotice(text: string): BoardWakeNotice {
  const match = MAIL_WAKE_TEXT_PATTERN.exec(text);
  if (match !== null && MAIL_WAKE_KINDS.has(match[1]!)) {
    const mail: MailWakeDetail = {
      kind: match[1] as MailLetterKind,
      sender: match[2] ?? null,
      task: match[3]!,
      body: mailLetterBody(match[4]!),
    };
    return { kind: "mail", text, detail: mailWakeNoticeDetail(mail), mail };
  }
  return { kind: "mail", text, detail: firstNonEmptyLine(text) };
}

function mailLetterBody(body: string): string {
  const replyInstruction = body.lastIndexOf("\n\nReply with mail_send: taskId ");
  return replyInstruction === -1 ? body : body.slice(0, replyInstruction);
}

function mailWakeNoticeDetail(mail: Pick<MailWakeDetail, "kind" | "sender" | "task">): string {
  return `${mail.kind} letter from ${mail.sender ?? "unknown sender"}: ${mail.task}`;
}

/** Parses the matching notification summary so the display row can share the wake chip label. */
export function mailWakeNotificationHeader(
  summary: string,
): Pick<MailWakeDetail, "kind" | "sender" | "task"> | null {
  const match = /^Mail (\S+) letter(?: from (.+?))? in "([\s\S]*)"$/.exec(summary);
  if (match === null || !MAIL_WAKE_KINDS.has(match[1]!)) return null;
  return {
    kind: match[1] as MailLetterKind,
    sender: match[2] ?? null,
    task: match[3]!,
  };
}

/** Tests whether a mail wake and its separate timeline notification describe the same letter. */
export function mailWakeMatchesNotification(
  mail: Pick<MailWakeDetail, "kind" | "sender" | "task">,
  summary: string,
): boolean {
  const header = mailWakeNotificationHeader(summary);
  return (
    header !== null &&
    header.kind === mail.kind &&
    header.sender === mail.sender &&
    header.task === mail.task
  );
}

/** Returns the notice for a server force-work message, or null for every other message. */
export function boardWakeNoticeOf(message: BoardWakeNoticeMessage): BoardWakeNotice | null {
  const kind = boardWakeNoticeKind(message.id);
  if (kind === null) return null;
  if (kind === "mail") return mailWakeNotice(message.text);
  const detail =
    kind === "brief"
      ? null
      : kind === "nudge"
        ? (nudgeCardLine(message.text) ?? firstNonEmptyLine(message.text))
        : firstEventLine(message.text);
  return { kind, text: message.text, detail };
}

export function boardWakeNoticeLabel(kind: BoardWakeNoticeKind): string {
  switch (kind) {
    case "wake":
      return "Lead woken";
    case "brief":
      return "Lead brief";
    case "nudge":
      return "Lead nudged";
    case "mail":
      return "Mail";
  }
}

/** The single collapsed line, e.g. `⚙ Lead woken: Executor finished its turn.` */
export function boardWakeNoticeLine(notice: BoardWakeNotice): string {
  if (notice.kind === "mail" && notice.mail !== undefined) {
    return `✉ Mail ${mailWakeNoticeDetail(notice.mail)}`;
  }
  const label = `⚙ ${boardWakeNoticeLabel(notice.kind)}`;
  return notice.detail === null ? label : `${label}: ${notice.detail}`;
}

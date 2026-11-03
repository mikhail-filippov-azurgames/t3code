/** Board wake, brief and nudge prompts are identified by their server-issued message id. */

export type BoardWakeNoticeKind = "wake" | "brief" | "nudge";

export interface BoardWakeNoticeMessage {
  readonly id: string;
  readonly text: string;
}

export interface BoardWakeNotice {
  readonly kind: BoardWakeNoticeKind;
  /** The full prompt body shown when the notice is expanded. */
  readonly text: string;
  /** First event line, when the kind has one. */
  readonly detail: string | null;
}

const WAKE_MESSAGE_ID_PREFIXES = [
  "ft3:board:wake:",
  "ft3:board:mark:",
  "ft3:board:start:",
  "ft3:board:orphan:",
] as const;
const BRIEF_MESSAGE_ID_PREFIX = "ft3:board:brief:";
const NUDGE_MESSAGE_ID_PREFIX = "board:idle-nudge:";

const CARD_CONTEXT_MARKER = "Current card context:";
const NUDGE_CARD_LINE = /^Card:\s*(.+)$/m;

export function boardWakeNoticeKind(id: string): BoardWakeNoticeKind | null {
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

/** Returns the notice for a board wake message, or null for every other message. */
export function boardWakeNoticeOf(message: BoardWakeNoticeMessage): BoardWakeNotice | null {
  const kind = boardWakeNoticeKind(message.id);
  if (kind === null) return null;
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
  }
}

/** The single collapsed line, e.g. `⚙ Lead woken: Executor finished its turn.` */
export function boardWakeNoticeLine(notice: BoardWakeNotice): string {
  const label = `⚙ ${boardWakeNoticeLabel(notice.kind)}`;
  return notice.detail === null ? label : `${label}: ${notice.detail}`;
}

const IDENTITY =
  "You are the lead for this board thread. You own the board and its end-to-end execution flow.";

const WORKFLOW = [
  "The wake message already carries the affected card's context, including its status and latest change; start from that context instead of re-reading the whole board. Reach for board_list_cards only when you need the full board, for example after a restart and before a decision. The list is a pointer, not the content: it carries no bodies, only a bodyChars size hint per card. Before delegating work, before deciding a card already covers the work, and before accepting a review, read the bodies of the relevant cards through board_list_cards with cardIds. Manage cards through the board tools. Plan before acting and create precise cards with board_create_card before starting additional tracked work; reuse a card when it already represents the work.",
  "Keep statuses truthful: todo -> orchestrator -> in_progress -> review -> done. backlog sits outside that chain: it marks a card the human deliberately deferred, neither ready nor in work. Put a card in backlog only when the human asks; do not start, delegate, or move a backlog card on your own. It leaves backlog when the human starts it or asks you to. Communicate with the human and executors, route work with delegate_task using orchestrator_capabilities and the active routing policy (role and effort), and honor explicit human assignments. After delegation, use board_update_card to set assignee to the selected route and executorThreadId to the returned childThreadId before moving the card to in_progress.",
  "Supervise delegated work and review each completed executor result. Accept it with done or return it to in_progress/todo. On failure or needs human, retry, reassign, or escalate. Use board_update_card for changes and board_delete_card only to remove a mistaken card. History is automatic and append-only; never rewrite it. Keep the human informed and ask when a human decision is needed.",
  "Use readiness separately from status. Keep ready while work can move. Set needs_human with the exact question when a human answer or decision is required; set readiness back to ready and clear the note after the answer. Set blocked with the external cause and what work it waits for. For blocked, either fix the cause now and set ready, pass it to the human as needs_human, or keep it blocked while the named work is still running. On any wake, re-check blocked cards whose note names the finished work.",
  "Do not report a cause as a fact until it is shown by an observable fact. Separate what was observed from what was inferred, and label an inference as an inference.",
];

export function buildBoardWakePrompt(context: string, roleLine = "", documentsBrief = ""): string {
  return [
    ...(roleLine.trim() === "" ? [] : [roleLine]),
    IDENTITY,
    ...(documentsBrief.trim() === "" ? [] : [documentsBrief]),
    "Architects (`architect`, `architect-*`) are consultants you may call for one concrete question via `delegate_task`; for a card that needs a plan, ask the `planner` role and follow its role file.",
    ...WORKFLOW,
    `Current card context:\n${context}`,
  ].join("\n\n");
}

/** The card fields a wake line needs; kept structural so the text stays testable. */
export interface WakeCard {
  readonly cardId: string;
  readonly title: string;
  readonly status: string;
  readonly readiness: string;
}

const RULES_REFERENCE = "Rules: see your lead brief";

/** Names the applied lead brief, so a short wake never restates the whole brief. */
export function boardWakeRulesLine(): string {
  return `${RULES_REFERENCE}.`;
}

/** Every wake after the first one: the event lines plus where the rules live. */
export function buildBoardWakeShortMessage(context: string): string {
  const body = context.trim();
  const rules = boardWakeRulesLine();
  return body === "" ? rules : `${body}\n\n${rules}`;
}

/**
 * A short, readable handle. Delegated thread ids can be URL-encoded, so the tail
 * segment is decoded and truncated instead of printed as an opaque token.
 */
export function shortBoardId(id: string): string {
  const trimmed = id.trim().replace(/^thread:/i, "");
  let decoded = trimmed;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    decoded = trimmed;
  }
  const parts = decoded.split(/[:/\\]/).filter((part) => part.trim() !== "");
  const tail = parts[parts.length - 1] ?? decoded;
  return tail.slice(0, 8);
}

/** `"Title" (79789b9c)`, or only the handle when the title adds nothing. */
export function wakeActorLabel(title: string | null | undefined, id: string): string {
  const name = (title ?? "").trim();
  const short = shortBoardId(id);
  return name === "" || name === id.trim() ? short : `"${name}" (${short})`;
}

const OUTCOME_WORDS: Record<string, string> = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "interrupted",
  rolled_back: "rolled back",
};

export function outcomeWords(status: string | null): string {
  if (status === null) return "";
  return OUTCOME_WORDS[status] ?? status.replace(/_/g, " ");
}

const ordinal = (value: number): string => {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
};

export function failureWords(streak: number): string {
  if (streak <= 0) return "";
  if (streak === 1) return "first failure in a row";
  return `${ordinal(streak)} failure in a row`;
}

export function cardStateWords(card: WakeCard): string {
  return `${card.status}, ${card.readiness}`;
}

export function boardCardStateLine(card: WakeCard): string {
  return `Card ${wakeActorLabel(card.title, card.cardId)}: ${cardStateWords(card)}.`;
}

/** Full ids stay available because the board tools require them. */
export function boardCardIdLine(cards: ReadonlyArray<WakeCard>): string {
  if (cards.length === 0) return "";
  const entries = cards.map((card) => {
    const title = card.title.trim();
    return title === "" ? card.cardId : `${card.cardId} (${title})`;
  });
  return `Card ids for board tools: ${entries.join("; ")}`;
}

export function executorFinishedLine(input: {
  readonly title: string | null;
  readonly threadId: string;
  readonly status: string | null;
  readonly failureStreak: number;
  readonly lostAtRestart?: boolean;
}): string {
  const actor = wakeActorLabel(input.title, input.threadId);
  const subject =
    input.lostAtRestart === true
      ? `Executor ${actor} lost its session when the server restarted`
      : `Executor finished ${actor}`;
  const detail = [outcomeWords(input.status), failureWords(input.failureStreak)]
    .filter((part) => part !== "")
    .join(", ");
  return detail === "" ? `${subject}.` : `${subject}: ${detail}.`;
}

export function executorInputLine(title: string | null, threadId: string): string {
  return `Executor ${wakeActorLabel(title, threadId)} is waiting for a human answer.`;
}

export function executorBackgroundLine(title: string | null, threadId: string): string {
  return `Executor ${wakeActorLabel(title, threadId)} finished background work.`;
}

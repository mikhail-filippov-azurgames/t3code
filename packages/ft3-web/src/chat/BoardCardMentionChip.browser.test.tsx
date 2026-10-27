import { ThreadId } from "@t3tools/contracts";
import {
  BoardCardId,
  BoardCardLookupToken,
  type BoardCard,
  type BoardCardLookupMatch,
} from "@t3tools/ft3-board/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../../apps/web/test/render";
import { BoardCardMentionButton } from "./BoardCardMentionChip";

const createdAt = "2026-01-01T00:00:00.000Z";
const card: BoardCard = {
  cardId: BoardCardId.make("b71111aa-0000-4000-8000-000000000001"),
  orchestratorThreadId: ThreadId.make("owner-thread"),
  title: "Fix the board",
  body: "",
  status: "todo",
  readiness: "needs_human",
  readinessNote:
    "Which migration order should the executor use?\nContext: the review names three steps.\nQuestion: may it start with step two?",
  createdBy: "human",
  assignee: null,
  executorRole: "implementation",
  executorThreadId: null,
  outcome: null,
  lastError: null,
  failureStreak: 0,
  order: 0,
  archived: false,
  createdAt,
  updatedAt: createdAt,
};

const match: BoardCardLookupMatch = {
  token: BoardCardLookupToken.make("b71111aa"),
  card,
  orchestratorThreadTitle: "Owner chat",
  recentEvents: [],
};

describe("BoardCardMentionButton", () => {
  it("pins the card from its chip", async () => {
    const onPin = vi.fn();
    await using screen = await render(<BoardCardMentionButton match={match} onPin={onPin} />, {
      router: false,
    });

    const button = screen.getByRole("button", { name: "Preview board card Fix the board" });
    expect((button.element() as HTMLElement).dataset.boardCardMention).toBe(String(card.cardId));

    await userEvent.click(button);
    expect(onPin).toHaveBeenCalledWith(String(card.cardId));

    expect(screen.container.textContent).toContain("b71111aa");
  });
});

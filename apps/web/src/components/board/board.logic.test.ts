import {
  BoardCardId,
  BoardCardEventId,
  ThreadId,
  type BoardCard,
  type BoardCardEvent,
  type BoardCardStatus,
  type BoardExecutorRole,
} from "@t3tools/contracts";
import { describe, it } from "vite-plus/test";
import { assert } from "vite-plus/test";

import {
  BOARD_COLUMNS,
  boardEventsForCard,
  DEFAULT_BOARD_FILTERS,
  boardStatusLabel,
  filterBoardCards,
  filterChatCandidates,
  groupBoardCardsByStatus,
  isCardHumanEditable,
  isCardStartable,
} from "./board.logic";

const ORCHESTRATOR = ThreadId.make("thread-orchestrator");

describe("Phase 1 board status compatibility", () => {
  it("keeps the orchestrator status value while presenting it as Coordinator", () => {
    assert.deepEqual(
      BOARD_COLUMNS.map(({ status }) => status),
      ["todo", "orchestrator", "in_progress", "review", "done"],
    );
    assert.strictEqual(
      BOARD_COLUMNS.find(({ status }) => status === "orchestrator")?.label,
      "Coordinator",
    );
    assert.strictEqual(boardStatusLabel("orchestrator"), "Coordinator");
  });
});

function makeCard(input: {
  readonly id: string;
  readonly title?: string;
  readonly body?: string;
  readonly status?: BoardCardStatus;
  readonly role?: BoardExecutorRole;
  readonly archived?: boolean;
  readonly order?: number;
  readonly createdAt?: string;
}): BoardCard {
  return {
    cardId: BoardCardId.make(input.id),
    orchestratorThreadId: ORCHESTRATOR,
    title: input.title ?? `Card ${input.id}`,
    body: input.body ?? "",
    status: input.status ?? "todo",
    createdBy: "human",
    assignee: null,
    executorRole: input.role ?? "implementation",
    executorThreadId: null,
    outcome: null,
    lastError: null,
    failureStreak: 0,
    order: input.order ?? 0,
    archived: input.archived ?? false,
    createdAt: input.createdAt ?? "2026-01-05T08:00:00.000Z",
    updatedAt: "2026-01-05T08:00:00.000Z",
  };
}

describe("filterBoardCards", () => {
  it("hides archived cards unless asked for them", () => {
    const cards = [makeCard({ id: "a" }), makeCard({ id: "b", archived: true })];
    const hidden = filterBoardCards(cards, DEFAULT_BOARD_FILTERS);
    assert.deepEqual(
      hidden.map((card) => card.cardId as string),
      ["a"],
    );
    const shown = filterBoardCards(cards, { ...DEFAULT_BOARD_FILTERS, showArchived: true });
    assert.deepEqual(
      shown.map((card) => card.cardId as string),
      ["a", "b"],
    );
  });

  it("filters by executor role", () => {
    const cards = [
      makeCard({ id: "a", role: "implementation" }),
      makeCard({ id: "b", role: "review" }),
    ];
    const filtered = filterBoardCards(cards, { ...DEFAULT_BOARD_FILTERS, role: "review" });
    assert.deepEqual(
      filtered.map((card) => card.cardId as string),
      ["b"],
    );
  });

  it("matches the search text against title and body, case-insensitively", () => {
    const cards = [
      makeCard({ id: "a", title: "Wire board contracts" }),
      makeCard({ id: "b", title: "Other", body: "mentions BOARD in the body" }),
      makeCard({ id: "c", title: "Unrelated", body: "nothing here" }),
    ];
    const filtered = filterBoardCards(cards, { ...DEFAULT_BOARD_FILTERS, search: "board" });
    assert.deepEqual(
      filtered.map((card) => card.cardId as string),
      ["a", "b"],
    );
  });
});

describe("filterChatCandidates", () => {
  it("keeps chats whose title contains the query, case-insensitively", () => {
    const chats = [{ title: "Board planner" }, { title: "Unity work" }];
    assert.deepEqual(filterChatCandidates(chats, "PLAN"), [{ title: "Board planner" }]);
    assert.deepEqual(filterChatCandidates(chats, "  "), chats);
  });
});

describe("groupBoardCardsByStatus", () => {
  it("places every card in its column and sorts by order then creation", () => {
    const cards = [
      makeCard({ id: "late", status: "todo", order: 2 }),
      makeCard({ id: "first", status: "todo", order: 0 }),
      makeCard({ id: "review", status: "review" }),
    ];
    const grouped = groupBoardCardsByStatus(cards);
    assert.deepEqual(
      grouped.get("todo")?.map((card) => card.cardId as string),
      ["first", "late"],
    );
    assert.deepEqual(
      grouped.get("review")?.map((card) => card.cardId as string),
      ["review"],
    );
    assert.deepEqual(grouped.get("done"), []);
  });
});

describe("card human permissions", () => {
  it("only allows human edits while the card is still todo", () => {
    assert.isTrue(isCardHumanEditable(makeCard({ id: "a", status: "todo" })));
    assert.isFalse(isCardHumanEditable(makeCard({ id: "b", status: "orchestrator" })));
    assert.isFalse(isCardHumanEditable(makeCard({ id: "c", status: "in_progress" })));
    assert.isFalse(isCardHumanEditable(makeCard({ id: "d", status: "review" })));
    assert.isFalse(isCardHumanEditable(makeCard({ id: "e", status: "done" })));
  });

  it("does not let an archived card be started", () => {
    assert.isTrue(isCardStartable(makeCard({ id: "a", status: "todo" })));
    assert.isFalse(isCardStartable(makeCard({ id: "b", status: "todo", archived: true })));
    assert.isFalse(isCardStartable(makeCard({ id: "c", status: "review" })));
  });
});

describe("boardEventsForCard", () => {
  it("keeps only the card's entries, oldest first", () => {
    const makeEvent = (entryId: string, cardId: string, at: string): BoardCardEvent => ({
      entryId: BoardCardEventId.make(entryId),
      cardId: BoardCardId.make(cardId),
      at,
      status: "todo",
      executorRole: "implementation",
      model: null,
      effort: null,
      source: "system",
    });
    const events = [
      makeEvent("second", "a", "2026-01-05T09:00:00.000Z"),
      makeEvent("other", "b", "2026-01-05T08:00:00.000Z"),
      makeEvent("first", "a", "2026-01-05T08:30:00.000Z"),
    ];
    assert.deepEqual(
      boardEventsForCard(events, BoardCardId.make("a")).map((event) => event.entryId as string),
      ["first", "second"],
    );
  });
});

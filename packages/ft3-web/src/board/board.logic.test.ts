import { ThreadId } from "@t3tools/contracts";
import {
  BoardCardId,
  BoardCardEventId,
  BoardCardStatus,
  BoardDelegationStatus,
  type BoardCard,
  type BoardCardReadiness,
  type BoardCardEvent,
  type ExecutorRole as BoardExecutorRole,
} from "@t3tools/ft3-board/contracts";
import { describe, it } from "vite-plus/test";
import { assert } from "vite-plus/test";

import {
  addBoardStatusCounts,
  BOARD_COLUMNS,
  boardDelegationStatusLabel,
  boardDelegationSummaryText,
  boardEventsForCard,
  DEFAULT_BOARD_FILTERS,
  boardStatusLabel,
  boardReadinessLabel,
  countArchivedBoardCardsByStatus,
  countBoardCardsByStatus,
  countNeedsHumanCards,
  countOmittedArchivedByStatus,
  filterBoardCards,
  filterChatCandidates,
  groupBoardCardsByStatus,
  isCardHumanEditable,
  isCardStartable,
  shouldShowBoardReadiness,
  sumBoardStatusCounts,
} from "./board.logic";

const ORCHESTRATOR = ThreadId.make("thread-orchestrator");

describe("Phase 1 board status compatibility", () => {
  it("keeps the orchestrator status value while presenting it as Coordinator", () => {
    assert.deepEqual(
      BOARD_COLUMNS.map(({ status }) => status),
      ["backlog", "todo", "orchestrator", "in_progress", "review", "done"],
    );
    assert.strictEqual(
      BOARD_COLUMNS.find(({ status }) => status === "orchestrator")?.label,
      "Coordinator",
    );
    assert.strictEqual(boardStatusLabel("orchestrator"), "Coordinator");
    assert.strictEqual(boardStatusLabel("backlog"), "Backlog");
  });

  it("has a column and a label for every status the contract defines", () => {
    const columns = BOARD_COLUMNS.map(({ status }) => status);
    for (const status of BoardCardStatus.literals) {
      assert.include(columns, status);
      assert.isString(boardStatusLabel(status));
    }
  });
});

function makeCard(input: {
  readonly id: string;
  readonly coordinator?: ThreadId;
  readonly title?: string;
  readonly body?: string;
  readonly status?: BoardCardStatus;
  readonly readiness?: BoardCardReadiness;
  readonly readinessNote?: string | null;
  readonly role?: BoardExecutorRole;
  readonly archived?: boolean;
  readonly order?: number;
  readonly createdAt?: string;
}): BoardCard {
  return {
    cardId: BoardCardId.make(input.id),
    orchestratorThreadId: input.coordinator ?? ORCHESTRATOR,
    title: input.title ?? `Card ${input.id}`,
    body: input.body ?? "",
    status: input.status ?? "todo",
    readiness: input.readiness ?? "ready",
    readinessNote: input.readinessNote ?? null,
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

  it("filters by readiness and counts only unarchived needs-human cards", () => {
    const otherCoordinator = ThreadId.make("thread-other-coordinator");
    const cards = [
      makeCard({ id: "human", readiness: "needs_human" }),
      makeCard({ id: "other-human", coordinator: otherCoordinator, readiness: "needs_human" }),
      makeCard({ id: "blocked", readiness: "blocked" }),
      makeCard({ id: "ready" }),
      makeCard({ id: "archived-human", readiness: "needs_human", archived: true }),
    ];

    assert.deepEqual(
      filterBoardCards(cards, { ...DEFAULT_BOARD_FILTERS, readiness: "needs_human" }).map(
        (card) => card.cardId as string,
      ),
      ["human", "other-human"],
    );
    assert.deepEqual(
      filterBoardCards(cards, { ...DEFAULT_BOARD_FILTERS, readiness: "blocked" }).map(
        (card) => card.cardId as string,
      ),
      ["blocked"],
    );
    assert.strictEqual(countNeedsHumanCards(cards), 2);
    assert.strictEqual(
      countNeedsHumanCards(cards.filter((card) => card.orchestratorThreadId === ORCHESTRATOR)),
      1,
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

describe("readiness labels", () => {
  it("labels all values and hides the ready marker", () => {
    assert.strictEqual(boardReadinessLabel("ready"), "Ready");
    assert.strictEqual(boardReadinessLabel("needs_human"), "Needs human");
    assert.strictEqual(boardReadinessLabel("blocked"), "Blocked");
    assert.isFalse(shouldShowBoardReadiness("ready"));
    assert.isTrue(shouldShowBoardReadiness("needs_human"));
    assert.isTrue(shouldShowBoardReadiness("blocked"));
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

  it("never drops a card: every status lands in a column", () => {
    const cards = BoardCardStatus.literals.map((status) => makeCard({ id: status, status }));
    const grouped = groupBoardCardsByStatus(cards);
    const placed = [...grouped.values()].flat().map((card) => card.cardId as string);
    assert.sameMembers(
      placed,
      cards.map((card) => card.cardId as string),
    );
    assert.deepEqual(
      grouped.get("backlog")?.map((card) => card.cardId as string),
      ["backlog"],
    );
  });
});

describe("board status counters", () => {
  it("matches every per-status headline with its column list length", () => {
    const cards: BoardCard[] = [];
    for (const status of BoardCardStatus.literals) {
      cards.push(makeCard({ id: `active-${status}`, status }));
      cards.push(makeCard({ id: `active-2-${status}`, status }));
    }
    cards.push(makeCard({ id: "archived-backlog", status: "backlog", archived: true }));
    cards.push(makeCard({ id: "archived-todo", status: "todo", archived: true }));
    cards.push(makeCard({ id: "archived-review", status: "review", archived: true }));
    cards.push(makeCard({ id: "archived-done", status: "done", archived: true }));

    for (const showArchived of [false, true] as const) {
      const visible = filterBoardCards(cards, { ...DEFAULT_BOARD_FILTERS, showArchived });
      const counts = countBoardCardsByStatus(visible);
      const grouped = groupBoardCardsByStatus(visible);
      for (const status of BoardCardStatus.literals) {
        assert.strictEqual(
          counts[status],
          grouped.get(status)?.length ?? 0,
          `status ${status} with showArchived=${showArchived}`,
        );
      }
    }
  });

  it("keeps the reported Done shape: 32 visible plus 12 archived", () => {
    const cards: BoardCard[] = [];
    for (let index = 0; index < 32; index += 1) {
      cards.push(makeCard({ id: `done-${index}`, status: "done" }));
    }
    for (let index = 0; index < 12; index += 1) {
      cards.push(makeCard({ id: `done-archived-${index}`, status: "done", archived: true }));
    }

    const visible = filterBoardCards(cards, DEFAULT_BOARD_FILTERS);
    const counts = countBoardCardsByStatus(visible);
    assert.strictEqual(counts.done, 32);
    assert.strictEqual(groupedLength(visible, "done"), 32);

    const withArchive = filterBoardCards(cards, { ...DEFAULT_BOARD_FILTERS, showArchived: true });
    assert.strictEqual(countBoardCardsByStatus(withArchive).done, 44);
    assert.strictEqual(countArchivedBoardCardsByStatus(withArchive).done, 12);
  });

  it("breaks the archive out per status with no double counting", () => {
    const cards = [
      makeCard({ id: "todo-active", status: "todo" }),
      makeCard({ id: "todo-archived", status: "todo", archived: true }),
      makeCard({ id: "done-active", status: "done" }),
      makeCard({ id: "done-archived-a", status: "done", archived: true }),
      makeCard({ id: "done-archived-b", status: "done", archived: true }),
    ];
    const withArchive = filterBoardCards(cards, { ...DEFAULT_BOARD_FILTERS, showArchived: true });
    const totals = countBoardCardsByStatus(withArchive);
    const archived = countArchivedBoardCardsByStatus(withArchive);
    const hidden = countBoardCardsByStatus(filterBoardCards(cards, DEFAULT_BOARD_FILTERS));
    for (const status of BoardCardStatus.literals) {
      assert.strictEqual(totals[status], hidden[status] + archived[status], `status ${status}`);
    }
    assert.deepEqual(archived, {
      backlog: 0,
      todo: 1,
      orchestrator: 0,
      in_progress: 0,
      review: 0,
      done: 2,
    });
    const archivedOnly = groupBoardCardsByStatus(withArchive.filter((card) => card.archived));
    for (const status of BoardCardStatus.literals) {
      assert.strictEqual(archived[status], archivedOnly.get(status)?.length ?? 0);
    }
  });

  it("adds the archive the server counted to the archive that arrived as rows, once", () => {
    const other = ThreadId.make("thread-other");
    const omitted = {
      cards: [],
      events: [],
      archivedCounts: [
        { orchestratorThreadId: ORCHESTRATOR, status: "done" as const, count: 4 },
        { orchestratorThreadId: ORCHESTRATOR, status: "todo" as const, count: 1 },
        { orchestratorThreadId: other, status: "done" as const, count: 2 },
      ],
    };
    assert.strictEqual(countOmittedArchivedByStatus(omitted, null).done, 6);
    assert.strictEqual(countOmittedArchivedByStatus(omitted, ORCHESTRATOR).done, 4);
    assert.strictEqual(sumBoardStatusCounts(countOmittedArchivedByStatus(omitted, other)), 2);
    assert.strictEqual(sumBoardStatusCounts(countOmittedArchivedByStatus(null, null)), 0);
    const rows = [makeCard({ id: "a", status: "done", archived: true })];
    const full = { cards: rows, events: [] };
    const total = addBoardStatusCounts(
      countArchivedBoardCardsByStatus(rows),
      countOmittedArchivedByStatus(full, null),
    );
    assert.strictEqual(total.done, 1);
    assert.strictEqual(sumBoardStatusCounts(total), 1);
  });

  it("reports zero for statuses with no cards", () => {
    const counts = countBoardCardsByStatus([]);
    const archived = countArchivedBoardCardsByStatus([]);
    const grouped = groupBoardCardsByStatus([]);
    for (const status of BoardCardStatus.literals) {
      assert.strictEqual(counts[status], 0);
      assert.strictEqual(archived[status], 0);
      assert.deepEqual(grouped.get(status), []);
    }
  });

  function groupedLength(cards: ReadonlyArray<BoardCard>, status: BoardCardStatus): number {
    return groupBoardCardsByStatus(cards).get(status)?.length ?? 0;
  }
});

describe("card human permissions", () => {
  it("only allows human edits while the card is still todo", () => {
    assert.isTrue(isCardHumanEditable(makeCard({ id: "a", status: "todo" })));
    assert.isFalse(isCardHumanEditable(makeCard({ id: "b", status: "orchestrator" })));
    assert.isFalse(isCardHumanEditable(makeCard({ id: "c", status: "in_progress" })));
    assert.isFalse(isCardHumanEditable(makeCard({ id: "d", status: "review" })));
    assert.isFalse(isCardHumanEditable(makeCard({ id: "e", status: "done" })));
    assert.isFalse(isCardHumanEditable(makeCard({ id: "f", status: "backlog" })));
  });

  it("does not let an archived card be started", () => {
    assert.isTrue(isCardStartable(makeCard({ id: "a", status: "todo" })));
    assert.isFalse(isCardStartable(makeCard({ id: "b", status: "todo", archived: true })));
    assert.isFalse(isCardStartable(makeCard({ id: "c", status: "review" })));
  });

  it("lets the human pull a deferred card into work, but not an archived one", () => {
    assert.isTrue(isCardStartable(makeCard({ id: "a", status: "backlog" })));
    assert.isFalse(isCardStartable(makeCard({ id: "b", status: "backlog", archived: true })));
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

describe("board delegation presentation", () => {
  it("labels every status and hides a missing or blank summary", () => {
    for (const status of BoardDelegationStatus.literals) {
      assert.isString(boardDelegationStatusLabel(status));
    }
    assert.isNull(boardDelegationSummaryText(null));
    assert.isNull(boardDelegationSummaryText("   "));
    assert.strictEqual(boardDelegationSummaryText(" Probe passed. "), "Probe passed.");
  });
});

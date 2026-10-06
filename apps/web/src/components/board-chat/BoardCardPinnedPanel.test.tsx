import {
  BoardCardEventId,
  BoardCardId,
  EnvironmentId,
  ThreadId,
  type BoardCard,
  type BoardCardLookupDetail,
} from "@t3tools/contracts";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { CoordinatorSummaryHistoryEntry } from "./BoardCardPinnedPanel";

const mocks = vi.hoisted(() => ({
  cardId: "d4dcdf1c-e971-4c17-8823-60c0a0715722",
  pins: ["d4dcdf1c-e971-4c17-8823-60c0a0715722"],
  resolveCards: vi.fn(),
  command: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("effect/unstable/reactivity", () => ({
  AsyncResult: { isSuccess: (result: { _tag?: string }) => result._tag === "Success" },
}));
vi.mock("../../state/board", () => ({
  boardEnvironment: { resolve: {}, start: {}, update: {}, requestOrchestrator: {} },
}));
vi.mock("../../state/entities", () => ({ readThreadShell: () => undefined }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.command }));
vi.mock("../../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => mocks.resolveCards,
}));
vi.mock("@t3tools/client-runtime/board-card-mentions", () => ({
  clearBoardCardMentionCache: () => {},
}));
vi.mock("../board/board.logic", () => ({
  boardFailureText: () => "Board action failed",
  boardExecutorRoleLabel: () => "Исполнитель",
  boardStatusLabel: () => "В работе",
  isCardStartable: () => true,
}));
vi.mock("./boardCardPins", () => ({
  boardCardPinsKey: () => "board-card-pins",
  readBoardCardPins: () => mocks.pins,
  removeBoardCardPin: () => {},
  subscribeBoardCardPins: () => () => {},
}));

import { BoardCardPinnedPanel } from "./BoardCardPinnedPanel";

const environmentId = EnvironmentId.make("environment-local");
const threadId = ThreadId.make("thread-1");
const cardId = BoardCardId.make(mocks.cardId);
const activeTabStorageKey = `t3code:chat-side-panel-tab:${environmentId}:${threadId}`;
const createdAt = "2026-10-06T00:00:00.000Z";
const card: BoardCard = {
  cardId,
  orchestratorThreadId: ThreadId.make("orchestrator-thread"),
  title: "Проверить запуск клиента",
  body: "Подробное описание карточки",
  status: "in_progress",
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
const detail: BoardCardLookupDetail = {
  card,
  orchestratorThreadTitle: "Чат оркестратора",
  events: [
    {
      entryId: BoardCardEventId.make("event-1"),
      cardId,
      at: createdAt,
      status: "in_progress",
      executorRole: "implementation",
      model: null,
      effort: null,
      body: "Записана история карточки",
      source: "system",
    },
  ],
};

function textContent(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textContent(child)))
    .join("");
}

async function mountPanel(
  options: {
    readonly onOpenChange?: (open: boolean) => void;
    readonly loadHistory?: (
      threadId: ThreadId,
    ) => Promise<ReadonlyArray<CoordinatorSummaryHistoryEntry>>;
  } = {},
): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <BoardCardPinnedPanel
        environmentId={environmentId}
        threadId={threadId}
        {...(options.onOpenChange ? { onOpenChange: options.onOpenChange } : {})}
        {...(options.loadHistory ? { loadHistory: options.loadHistory } : {})}
      />,
    );
    await Promise.resolve();
  });
  return renderer;
}

describe("BoardCardPinnedPanel", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const store = new Map<string, string>();
    const storage = {
      clear: () => store.clear(),
      getItem: (key: string) => store.get(key) ?? null,
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
      },
      removeItem: (key: string) => store.delete(key),
      setItem: (key: string, value: string) => store.set(key, value),
    };
    vi.stubGlobal("window", Object.assign(new EventTarget(), { localStorage: storage }));
    mocks.pins = [mocks.cardId];
    mocks.resolveCards.mockResolvedValue({ _tag: "Success", value: { details: [detail] } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("collapses a card to its title and close control, then expands it from the title", async () => {
    const renderer = await mountPanel();
    try {
      let article = renderer.root.findByProps({ "data-board-card-id": mocks.cardId });
      const collapseButton = article.find(
        (node) => node.type === "button" && node.props["aria-expanded"] === true,
      );
      act(() => collapseButton.props.onClick());

      article = renderer.root.findByProps({ "data-board-card-id": mocks.cardId });
      expect(article.findAllByType("button")).toHaveLength(2);
      expect(textContent(article)).toContain(card.title);
      expect(textContent(article)).not.toContain(card.body);
      expect(textContent(article)).not.toContain("Чат оркестратора");
      expect(textContent(article)).not.toContain("История");
      expect(article.findAllByType("textarea")).toHaveLength(0);
      expect(article.findByProps({ "aria-label": `Снять карточку ${mocks.cardId}` })).toBeDefined();

      const expandButton = article.find(
        (node) => node.type === "button" && node.props["aria-expanded"] === false,
      );
      act(() => expandButton.props.onClick());

      article = renderer.root.findByProps({ "data-board-card-id": mocks.cardId });
      expect(textContent(article)).toContain(card.body);
      expect(textContent(article)).toContain("Просьба оркестратору");
      expect(textContent(article)).toContain("История");
    } finally {
      act(() => renderer.unmount());
    }
  });

  it("switches between cards and history inside one shared panel", async () => {
    const renderer = await mountPanel();
    try {
      expect(renderer.root.findAllByProps({ "data-chat-side-panel": "true" })).toHaveLength(1);
      expect(renderer.root.findAllByProps({ "data-board-card-id": mocks.cardId })).toHaveLength(1);

      const historyTab = renderer.root.find(
        (node) => node.props.role === "tab" && textContent(node) === "История",
      );
      act(() => historyTab.props.onClick());

      expect(historyTab.props["aria-selected"]).toBe(true);
      expect(renderer.root.findAllByProps({ "data-board-card-id": mocks.cardId })).toHaveLength(0);
      expect(textContent(renderer.root)).toContain("Выжимок пока нет");

      const cardsTab = renderer.root.find(
        (node) => node.props.role === "tab" && textContent(node) === "Карточки",
      );
      act(() => cardsTab.props.onClick());

      expect(cardsTab.props["aria-selected"]).toBe(true);
      expect(historyTab.props["aria-selected"]).toBe(false);
      expect(renderer.root.findAllByProps({ "data-board-card-id": mocks.cardId })).toHaveLength(1);
      expect(textContent(renderer.root)).not.toContain("Выжимок пока нет");
    } finally {
      act(() => renderer.unmount());
    }
  });

  it("renders full, stale-aware history records with separate current and summary states", async () => {
    mocks.pins = [];
    const summaryText = "x".repeat(600);
    const entry: CoordinatorSummaryHistoryEntry = {
      id: "summary-1",
      summaryText,
      child: "Ребёнок A",
      turn: "7",
      completedAt: createdAt,
      currentStatus: "working",
      summaryStatus: "superseded",
      executorRole: "implementation",
      stale: true,
    };
    const loadHistory = vi.fn(async (requestedThreadId: ThreadId) => {
      expect(requestedThreadId).toBe(threadId);
      return [entry];
    });
    const renderer = await mountPanel({ loadHistory });
    try {
      const summary = renderer.root.find(
        (node) => node.type === "p" && textContent(node) === summaryText,
      );
      expect(textContent(summary)).toHaveLength(600);
      expect(textContent(renderer.root)).toContain("Ребёнок A · ход 7");
      expect(textContent(renderer.root)).toContain("Текущее состояние:working");
      expect(textContent(renderer.root)).toContain("Состояние выжимки:superseded");
      expect(textContent(renderer.root)).toContain("Роль исполнителя:implementation");
      expect(textContent(renderer.root)).toContain("Устарела");
      expect(renderer.root.findByType("time").props.dateTime).toBe(createdAt);
      expect(loadHistory).toHaveBeenCalledOnce();
      expect(renderer.root.findAllByProps({ "data-board-card-id": mocks.cardId })).toHaveLength(0);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it("persists the selected tab across a remount", async () => {
    const firstRenderer = await mountPanel();
    const historyTab = firstRenderer.root.find(
      (node) => node.props.role === "tab" && textContent(node) === "История",
    );
    act(() => historyTab.props.onClick());
    expect(window.localStorage.getItem(activeTabStorageKey)).toBe(JSON.stringify("history"));
    act(() => firstRenderer.unmount());

    const reloadedRenderer = await mountPanel();
    try {
      const reloadedHistoryTab = reloadedRenderer.root.find(
        (node) => node.props.role === "tab" && textContent(node) === "История",
      );
      expect(reloadedHistoryTab.props["aria-selected"]).toBe(true);
      expect(textContent(reloadedRenderer.root)).toContain("Выжимок пока нет");
    } finally {
      act(() => reloadedRenderer.unmount());
    }
  });

  it("reports the whole panel as closed when collapsed and open when restored", async () => {
    const onOpenChange = vi.fn();
    const renderer = await mountPanel({ onOpenChange });
    try {
      expect(onOpenChange).toHaveBeenLastCalledWith(true);

      const collapsePanelButton = renderer.root.findByProps({
        "aria-label": "Свернуть закреплённые карточки",
      });
      act(() => collapsePanelButton.props.onClick());
      expect(onOpenChange).toHaveBeenLastCalledWith(false);

      const expandPanelButton = renderer.root.find(
        (node) =>
          node.type === "button" &&
          node.props["aria-label"] === "Развернуть закреплённые карточки: 1",
      );
      act(() => expandPanelButton.props.onClick());
      expect(onOpenChange).toHaveBeenLastCalledWith(true);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it("reports closed and renders nothing when no cards are pinned", async () => {
    mocks.pins = [];
    const onOpenChange = vi.fn();
    const renderer = await mountPanel({ onOpenChange });
    try {
      expect(renderer.root.findAllByProps({ "data-board-card-panel": "true" })).toHaveLength(0);
      expect(onOpenChange).toHaveBeenLastCalledWith(false);
    } finally {
      act(() => renderer.unmount());
    }
  });
});

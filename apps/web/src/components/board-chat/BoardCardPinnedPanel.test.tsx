import {
  BoardCardEventId,
  BoardCardId,
  EnvironmentId,
  ThreadId,
  TurnId,
  type BoardCard,
  type BoardCardLookupDetail,
} from "@t3tools/contracts";
import { useEffect } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  CoordinatorSummaryHistoryEntry,
  CoordinatorSummaryHistoryLoader,
} from "./coordinatorSummaryHistory";

const mocks = vi.hoisted(() => ({
  cardId: "d4dcdf1c-e971-4c17-8823-60c0a0715722",
  pins: ["d4dcdf1c-e971-4c17-8823-60c0a0715722"],
  resolveCards: vi.fn(),
  command: vi.fn(),
  navigate: vi.fn(),
  commitsGraph: vi.fn(),
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
  boardReadinessLabel: () => "Требует внимания человека",
  boardStatusLabel: () => "В работе",
  isCardStartable: () => true,
  shouldShowBoardReadiness: (readiness: string) => readiness !== "ready",
}));
vi.mock("./boardCardPins", () => ({
  boardCardPinsKey: () => "board-card-pins",
  readBoardCardPins: () => mocks.pins,
  removeBoardCardPin: () => {},
  subscribeBoardCardPins: () => () => {},
}));
vi.mock("../commits/CommitsGraph", () => ({
  CommitsGraph: (props: { cwd: string }) => {
    mocks.commitsGraph(props);
    return <div data-commits-graph="true" />;
  },
}));
vi.mock("../DiffPanel", () => ({
  default: (props: { mode: string }) => <div data-commit-diff={props.mode} />,
}));

import { useExpandCoordinatorHistoryByDefault } from "../board/boardPreferences";
import { useDiffPanelStore } from "../../diffPanelStore";
import { BoardCardPinnedPanel } from "./BoardCardPinnedPanel";

class TestIntersectionObserver {
  static instances: TestIntersectionObserver[] = [];
  readonly callback: IntersectionObserverCallback;
  readonly options: IntersectionObserverInit | undefined;
  readonly observe = vi.fn();
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn();

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.options = options;
    TestIntersectionObserver.instances.push(this);
  }

  report(isIntersecting: boolean) {
    this.callback(
      [{ target: {}, isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

function liveHistoryObservers() {
  return TestIntersectionObserver.instances.filter(
    (observer) => observer.disconnect.mock.calls.length === 0,
  );
}

const environmentId = EnvironmentId.make("environment-local");
const threadId = ThreadId.make("thread-1");
const otherThreadId = ThreadId.make("thread-2");
const cardId = BoardCardId.make(mocks.cardId);
const activeTabStorageKey = `t3code:chat-side-panel-tab:${environmentId}:${threadId}`;
const panelCollapsedStorageKey = `t3code:chat-side-panel-collapsed:${environmentId}:${threadId}`;
const historyOverridesStorageKey = `t3code:chat-side-panel-history-entry-overrides:${environmentId}:${threadId}`;
const expandHistoryStorageKey = "t3code:board:expand-coordinator-history-by-default";
const createdAt = "2026-10-06T00:00:00.000Z";
const card: BoardCard = {
  cardId,
  orchestratorThreadId: ThreadId.make("orchestrator-thread"),
  title: "Проверить запуск клиента",
  body: "Подробное описание карточки",
  status: "in_progress",
  readiness: "needs_human",
  readinessNote: "Какой формат клиента проверить?",
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

type MountPanelOptions = {
  readonly threadId?: ThreadId;
  readonly onOpenChange?: (open: boolean) => void;
  readonly loadHistory?: CoordinatorSummaryHistoryLoader;
  readonly hasGitRepository?: boolean;
  readonly cwd?: string;
};

function panelElement(options: MountPanelOptions = {}) {
  return (
    <BoardCardPinnedPanel
      environmentId={environmentId}
      threadId={options.threadId ?? threadId}
      {...(options.onOpenChange ? { onOpenChange: options.onOpenChange } : {})}
      {...(options.loadHistory ? { loadHistory: options.loadHistory } : {})}
      hasGitRepository={options.hasGitRepository ?? false}
      cwd={options.cwd ?? "/repo"}
    />
  );
}

async function mountPanel(options: MountPanelOptions = {}): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(panelElement(options), {
      // Host refs resolve to null without this, so the sentinel ref would
      // never arm the observer under test.
      createNodeMock: (element) =>
        (element.props as Record<string, unknown>)["data-chat-side-panel-resize"]
          ? {
              parentElement: { getBoundingClientRect: () => ({ width: 352, height: 672 }) },
              setPointerCapture: vi.fn(),
            }
          : {},
    });
    await Promise.resolve();
  });
  return renderer;
}

async function updatePanel(renderer: ReactTestRenderer, options: MountPanelOptions = {}) {
  await act(async () => {
    renderer.update(panelElement(options));
    await Promise.resolve();
  });
}

function historyEntry(id: string, overrides: Partial<CoordinatorSummaryHistoryEntry> = {}) {
  return {
    id,
    summaryText: `Выжимка ${id}`,
    child: `Ребёнок ${id}`,
    turn: id,
    completedAt: createdAt,
    currentStatus: "завершено",
    summaryStatus: "готова",
    executorRole: "implementation",
    stale: false,
    ...overrides,
  } satisfies CoordinatorSummaryHistoryEntry;
}

function cursorAfter(id: string) {
  return {
    completedAt: createdAt,
    childThreadId: ThreadId.make(id),
    sourceTurnId: TurnId.make(id),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function fireHistorySentinel(isIntersecting = true) {
  const observers = liveHistoryObservers();
  const observer = observers[observers.length - 1];
  expect(observer).toBeDefined();
  await act(async () => {
    observer!.report(isIntersecting);
    await Promise.resolve();
  });
}

function historyRows(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType("li").map((row) => textContent(row));
}

function historyToggles(renderer: ReactTestRenderer) {
  return renderer.root.findAll(
    (node) => node.type === "button" && typeof node.props["aria-expanded"] === "boolean",
  );
}

describe("BoardCardPinnedPanel", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    TestIntersectionObserver.instances = [];
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
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
    mocks.commitsGraph.mockClear();
    useDiffPanelStore.setState({ byThreadKey: {}, branchBaseRefByThreadKey: {} });
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
      expect(textContent(article)).toContain("Требует внимания человека");
      expect(textContent(article)).toContain(card.readinessNote!);
      expect(article.findAll((node) => node.type === "svg").length).toBeGreaterThan(0);
      expect(textContent(article)).toContain("Просьба оркестратору");
      expect(textContent(article)).toContain("История");
    } finally {
      act(() => renderer.unmount());
    }
  });

  it("renders the readiness note whole with preserved line breaks", async () => {
    const renderer = await mountPanel();
    try {
      const article = renderer.root.findByProps({ "data-board-card-id": mocks.cardId });
      const notes = article.findAll(
        (node) => node.type === "p" && textContent(node) === card.readinessNote,
      );
      expect(notes).toHaveLength(1);
      expect(String(notes[0]!.props.className)).toContain("whitespace-pre-wrap");
      expect(String(notes[0]!.props.className)).toContain("break-words");
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

  it("opens a commits tab for a git thread without cards and mounts its graph only on demand", async () => {
    mocks.pins = [];
    window.localStorage.setItem(activeTabStorageKey, JSON.stringify("history"));
    const loadHistory = vi.fn<CoordinatorSummaryHistoryLoader>(async () => ({
      entries: [],
      nextCursor: null,
    }));
    const renderer = await mountPanel({ hasGitRepository: true, loadHistory });
    try {
      expect(renderer.root.findAllByProps({ "data-chat-side-panel": "true" })).toHaveLength(1);
      expect(renderer.root.findAllByProps({ "data-commits-graph": "true" })).toHaveLength(0);
      expect(mocks.commitsGraph).not.toHaveBeenCalled();

      const commitsTab = renderer.root.find(
        (node) => node.props.role === "tab" && textContent(node) === "Коммиты",
      );
      act(() => commitsTab.props.onClick());

      expect(commitsTab.props["aria-selected"]).toBe(true);
      expect(renderer.root.findByProps({ "data-commits-graph": "true" })).toBeDefined();
      expect(mocks.commitsGraph).toHaveBeenCalledOnce();
      expect(mocks.commitsGraph.mock.calls[0]?.[0]).toMatchObject({
        environmentId,
        cwd: "/repo",
        className: "h-full min-h-0 flex-1",
        columns: ["commit", "author", "date"],
        dateFormat: "datetime",
        focusCommitId: null,
      });
    } finally {
      act(() => renderer.unmount());
    }
  });

  it("shows the selected commit diff directly from the commits tab and returns to the graph", async () => {
    mocks.pins = [];
    window.localStorage.setItem(activeTabStorageKey, JSON.stringify("commits"));
    const renderer = await mountPanel({ hasGitRepository: true });
    try {
      const graph = mocks.commitsGraph.mock.calls.at(-1)?.[0] as {
        onCommitSelect: (commitId: string) => void;
      };
      act(() => graph.onCommitSelect("15978a076b"));
      await act(async () => Promise.resolve());

      expect(renderer.root.findByProps({ "data-commit-diff": "embedded" })).toBeDefined();
      expect(renderer.root.findAllByProps({ "data-commits-graph": "true" })).toHaveLength(0);
      expect(renderer.root.findByProps({ "aria-label": "Панель чата" }).props.style).toMatchObject({
        width: 352,
        height: 672,
      });

      const backButton = renderer.root.findByProps({ "aria-label": "Вернуться к графу коммитов" });
      await act(async () => {
        backButton!.props.onClick();
        await Promise.resolve();
      });
      expect(renderer.root.findByProps({ "data-commits-graph": "true" })).toBeDefined();
      expect(renderer.root.findAllByProps({ "data-commit-diff": "embedded" })).toHaveLength(0);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it("resizes the panel by dragging its corner handle", async () => {
    const renderer = await mountPanel();
    try {
      const handle = renderer.root.findByProps({ "data-chat-side-panel-resize": "true" });
      const event = {
        currentTarget: handle.instance,
        clientX: 100,
        clientY: 100,
        pointerId: 1,
        preventDefault: vi.fn(),
      };
      act(() => handle.props.onPointerDown(event));
      act(() => handle.props.onPointerMove({ ...event, clientX: 180, clientY: 220 }));

      expect(
        renderer.root.findByProps({ "data-chat-side-panel": "true" }).props.style,
      ).toMatchObject({
        width: 432,
        height: 704,
      });
      act(() => handle.props.onPointerUp(event));
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
    const loadHistory = vi.fn<CoordinatorSummaryHistoryLoader>(async (input) => {
      expect(input).toEqual({ threadId });
      return { entries: [entry], nextCursor: null };
    });
    window.localStorage.setItem(expandHistoryStorageKey, "true");
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

  it("persists history entry overrides per thread while unseen entries follow the default", async () => {
    mocks.pins = [];
    window.localStorage.setItem(expandHistoryStorageKey, "true");
    const loadHistory = vi.fn<CoordinatorSummaryHistoryLoader>(async () => ({
      entries: [historyEntry("shared-entry")],
      nextCursor: null,
    }));

    const renderer = await mountPanel({ loadHistory });
    try {
      expect(historyToggles(renderer)[0]!.props["aria-expanded"]).toBe(true);
      act(() => historyToggles(renderer)[0]!.props.onClick());
      expect(historyToggles(renderer)[0]!.props["aria-expanded"]).toBe(false);
      expect(window.localStorage.getItem(historyOverridesStorageKey)).toBe(
        JSON.stringify({ "shared-entry": false }),
      );

      await updatePanel(renderer, { threadId: otherThreadId, loadHistory });
      expect(historyToggles(renderer)[0]!.props["aria-expanded"]).toBe(true);
      expect(
        window.localStorage.getItem(
          `t3code:chat-side-panel-history-entry-overrides:${environmentId}:${otherThreadId}`,
        ),
      ).toBeNull();

      await updatePanel(renderer, { loadHistory });
      expect(historyToggles(renderer)[0]!.props["aria-expanded"]).toBe(false);
      act(() => historyToggles(renderer)[0]!.props.onClick());
      expect(historyToggles(renderer)[0]!.props["aria-expanded"]).toBe(true);

      await updatePanel(renderer, { threadId: otherThreadId, loadHistory });
      expect(historyToggles(renderer)[0]!.props["aria-expanded"]).toBe(true);
      await updatePanel(renderer, { loadHistory });
      expect(historyToggles(renderer)[0]!.props["aria-expanded"]).toBe(true);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it("persists the panel collapsed state per thread", async () => {
    const renderer = await mountPanel();
    const historyTab = renderer.root.find(
      (node) => node.props.role === "tab" && textContent(node) === "История",
    );
    act(() => historyTab.props.onClick());
    act(() => renderer.root.findByProps({ "aria-label": "Свернуть панель чата" }).props.onClick());
    expect(window.localStorage.getItem(panelCollapsedStorageKey)).toBe("true");
    try {
      await updatePanel(renderer, { threadId: otherThreadId });
      expect(renderer.root.findAllByProps({ "data-chat-side-panel": "true" })).toHaveLength(1);
      expect(
        renderer.root.find((node) => node.props.role === "tab" && node.props["aria-selected"]).props
          .id,
      ).toBe("chat-side-panel-tab-cards");
      expect(
        window.localStorage.getItem(
          `t3code:chat-side-panel-collapsed:${environmentId}:${otherThreadId}`,
        ),
      ).toBeNull();

      await updatePanel(renderer);
      expect(renderer.root.findAllByProps({ "data-chat-side-panel": "true" })).toHaveLength(0);
      act(() =>
        renderer.root.findByProps({ "aria-label": "Развернуть панель чата" }).props.onClick(),
      );
      expect(renderer.root.findAllByProps({ "data-chat-side-panel": "true" })).toHaveLength(1);
      expect(
        renderer.root.find((node) => node.props.role === "tab" && node.props["aria-selected"]).props
          .id,
      ).toBe("chat-side-panel-tab-history");
    } finally {
      act(() => renderer.unmount());
    }
  });

  it("names the collapsed panel neutrally whichever tab is active", async () => {
    const loadHistory = vi.fn<CoordinatorSummaryHistoryLoader>(async () => ({
      entries: [historyEntry("a")],
      nextCursor: null,
    }));
    const renderer = await mountPanel({ loadHistory });
    try {
      for (const tabLabel of ["Карточки", "История"]) {
        const tab = renderer.root.find(
          (node) => node.props.role === "tab" && textContent(node) === tabLabel,
        );
        act(() => tab.props.onClick());
        act(() =>
          renderer.root.findByProps({ "aria-label": "Свернуть панель чата" }).props.onClick(),
        );

        expect(renderer.root.findAllByProps({ "data-chat-side-panel": "true" })).toHaveLength(0);
        const expandButton = renderer.root.findByType("button");
        expect(textContent(expandButton)).toBe("Панель чата");
        expect(expandButton.props["aria-label"]).toBe("Развернуть панель чата");
        expect(textContent(renderer.root)).not.toMatch(/Карточки|История|\d/);

        act(() => expandButton.props.onClick());
        expect(renderer.root.findAllByProps({ "data-chat-side-panel": "true" })).toHaveLength(1);
        expect(
          renderer.root.find((node) => node.props.role === "tab" && textContent(node) === tabLabel)
            .props["aria-selected"],
        ).toBe(true);
      }
    } finally {
      act(() => renderer.unmount());
    }
  });

  it("starts history entries collapsed and toggles each one independently", async () => {
    mocks.pins = [];
    const loadHistory = vi.fn<CoordinatorSummaryHistoryLoader>(async () => ({
      entries: [historyEntry("a", { stale: true }), historyEntry("b")],
      nextCursor: null,
    }));
    const renderer = await mountPanel({ loadHistory });
    try {
      const [rowA, rowB] = renderer.root.findAllByType("li");
      expect(historyToggles(renderer).map((toggle) => toggle.props["aria-expanded"])).toEqual([
        false,
        false,
      ]);
      expect(textContent(rowA!)).toContain("Ребёнок a · ход a");
      expect(textContent(rowA!)).toContain("Устарела");
      expect(rowA!.findByType("time").props.dateTime).toBe(createdAt);
      expect(textContent(renderer.root)).not.toContain("Выжимка a");
      expect(textContent(renderer.root)).not.toContain("Текущее состояние");

      act(() => historyToggles(renderer)[0]!.props.onClick());
      expect(historyToggles(renderer).map((toggle) => toggle.props["aria-expanded"])).toEqual([
        true,
        false,
      ]);
      expect(textContent(rowA!)).toContain("Выжимка a");
      expect(textContent(rowA!)).toContain("Текущее состояние:завершено");
      expect(textContent(rowB!)).not.toContain("Выжимка b");

      act(() => historyToggles(renderer)[0]!.props.onClick());
      expect(historyToggles(renderer)[0]!.props["aria-expanded"]).toBe(false);
      expect(textContent(renderer.root)).not.toContain("Выжимка a");
    } finally {
      act(() => renderer.unmount());
    }
  });

  it("expands entries by default when the setting is on and still lets each be collapsed", async () => {
    mocks.pins = [];
    window.localStorage.setItem(expandHistoryStorageKey, "true");
    const loadHistory = vi.fn<CoordinatorSummaryHistoryLoader>(async () => ({
      entries: [historyEntry("a"), historyEntry("b")],
      nextCursor: null,
    }));
    const renderer = await mountPanel({ loadHistory });
    try {
      expect(textContent(renderer.root)).toContain("Выжимка a");
      expect(textContent(renderer.root)).toContain("Выжимка b");

      act(() => historyToggles(renderer)[0]!.props.onClick());
      expect(textContent(renderer.root)).not.toContain("Выжимка a");
      expect(textContent(renderer.root)).toContain("Выжимка b");
    } finally {
      act(() => renderer.unmount());
    }
  });

  it("saves the default and applies it live to entries the user has not toggled", async () => {
    mocks.pins = [];
    const setting: { set: (value: boolean) => void } = { set: () => {} };
    const setExpandByDefault = (value: boolean) => setting.set(value);
    function SettingHarness() {
      const [, setValue] = useExpandCoordinatorHistoryByDefault();
      useEffect(() => {
        setting.set = setValue;
      }, [setValue]);
      return null;
    }
    const loadHistory = vi.fn<CoordinatorSummaryHistoryLoader>(async () => ({
      entries: [historyEntry("a"), historyEntry("b")],
      nextCursor: null,
    }));
    const renderer = await mountPanel({ loadHistory });
    let harness!: ReactTestRenderer;
    act(() => {
      harness = create(<SettingHarness />);
    });
    try {
      expect(window.localStorage.getItem(expandHistoryStorageKey)).toBeNull();
      act(() => historyToggles(renderer)[1]!.props.onClick());
      expect(textContent(renderer.root)).toContain("Выжимка b");

      act(() => setExpandByDefault(true));
      expect(window.localStorage.getItem(expandHistoryStorageKey)).toBe("true");
      expect(textContent(renderer.root)).toContain("Выжимка a");

      act(() => setExpandByDefault(false));
      expect(window.localStorage.getItem(expandHistoryStorageKey)).toBe("false");
      expect(textContent(renderer.root)).not.toContain("Выжимка a");
      expect(textContent(renderer.root)).toContain("Выжимка b");

      act(() => setExpandByDefault(true));
    } finally {
      act(() => harness.unmount());
      act(() => renderer.unmount());
    }

    const reloaded = await mountPanel({ loadHistory });
    try {
      expect(historyToggles(reloaded).map((toggle) => toggle.props["aria-expanded"])).toEqual([
        true,
        true,
      ]);
    } finally {
      act(() => reloaded.unmount());
    }
  });

  it("reports the whole panel as closed when collapsed and open when restored", async () => {
    const onOpenChange = vi.fn();
    const renderer = await mountPanel({ onOpenChange });
    try {
      expect(onOpenChange).toHaveBeenLastCalledWith(true);

      const collapsePanelButton = renderer.root.findByProps({
        "aria-label": "Свернуть панель чата",
      });
      act(() => collapsePanelButton.props.onClick());
      expect(onOpenChange).toHaveBeenLastCalledWith(false);

      const expandPanelButton = renderer.root.find(
        (node) => node.type === "button" && node.props["aria-label"] === "Развернуть панель чата",
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

  it("loads the next page through the sentinel without any scrolling", async () => {
    mocks.pins = [];
    const loadHistory = vi.fn<CoordinatorSummaryHistoryLoader>(async ({ cursor }) => {
      if (cursor === undefined) {
        return { entries: [historyEntry("a"), historyEntry("b")], nextCursor: cursorAfter("b") };
      }
      if (loadHistory.mock.calls.length === 2) {
        return { entries: [historyEntry("c")], nextCursor: cursorAfter("c") };
      }
      return { entries: [historyEntry("d")], nextCursor: null };
    });
    const renderer = await mountPanel({ loadHistory });
    try {
      expect(historyRows(renderer)).toHaveLength(2);
      // The short first page leaves nothing to scroll, so the sentinel is the
      // only load trigger and arms with a prefetch margin.
      const observers = liveHistoryObservers();
      expect(observers).toHaveLength(1);
      expect(observers[0]!.options).toEqual({ rootMargin: "240px" });
      expect(
        renderer.root.findAll((node) => typeof node.props.onScroll === "function"),
      ).toHaveLength(0);

      await fireHistorySentinel(false);
      expect(loadHistory).toHaveBeenCalledOnce();

      // No scroll happens here: the observer firing is the whole trigger.
      await fireHistorySentinel();
      expect(loadHistory).toHaveBeenCalledTimes(2);
      expect(loadHistory).toHaveBeenLastCalledWith({ threadId, cursor: cursorAfter("b") });
      expect(historyRows(renderer)).toHaveLength(3);
      expect(historyRows(renderer)[2]).toContain("Ребёнок c");

      // The observer re-arms after the loaded page and drives the next one.
      expect(liveHistoryObservers()).toHaveLength(1);
      expect(TestIntersectionObserver.instances).toHaveLength(2);
      await fireHistorySentinel();
      expect(loadHistory).toHaveBeenCalledTimes(3);
      expect(loadHistory).toHaveBeenLastCalledWith({ threadId, cursor: cursorAfter("c") });
      expect(historyRows(renderer)).toHaveLength(4);

      expect(
        renderer.root.findAllByProps({ "data-history-load-more-sentinel": "true" }),
      ).toHaveLength(0);
      expect(liveHistoryObservers()).toHaveLength(0);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it("does not repeat the load while a request is in flight and stops when pages run out", async () => {
    mocks.pins = [];
    const secondPage = deferred<{
      entries: CoordinatorSummaryHistoryEntry[];
      nextCursor: null;
    }>();
    const loadHistory = vi.fn<CoordinatorSummaryHistoryLoader>(async ({ cursor }) =>
      cursor === undefined
        ? { entries: [historyEntry("a"), historyEntry("b")], nextCursor: cursorAfter("b") }
        : secondPage.promise,
    );
    const renderer = await mountPanel({ loadHistory });
    try {
      const observers = liveHistoryObservers();
      expect(observers).toHaveLength(1);
      const sentinel = observers[0]!;

      await act(async () => {
        sentinel.report(true);
        await Promise.resolve();
      });
      expect(loadHistory).toHaveBeenCalledTimes(2);
      expect(textContent(renderer.root)).toContain("Загрузка выжимок…");

      // The in-flight request unarms the sentinel, but a repeated signal from
      // the detached observer must still not start a second request.
      await act(async () => {
        sentinel.report(true);
        await Promise.resolve();
      });
      expect(loadHistory).toHaveBeenCalledTimes(2);

      await act(async () => {
        secondPage.resolve({ entries: [historyEntry("c")], nextCursor: null });
        await Promise.resolve();
      });
      expect(historyRows(renderer)).toHaveLength(3);

      // No pages left: the sentinel is gone and nothing observes anymore.
      expect(
        renderer.root.findAllByProps({ "data-history-load-more-sentinel": "true" }),
      ).toHaveLength(0);
      expect(liveHistoryObservers()).toHaveLength(0);
      await act(async () => {
        await Promise.resolve();
      });
      expect(loadHistory).toHaveBeenCalledTimes(2);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it("keeps loaded rows when a later page fails and retries the same cursor", async () => {
    mocks.pins = [];
    let failNext = true;
    const loadHistory = vi.fn<CoordinatorSummaryHistoryLoader>(async ({ cursor }) => {
      if (cursor === undefined) {
        return { entries: [historyEntry("a")], nextCursor: cursorAfter("a") };
      }
      if (failNext) throw new Error("offline");
      return { entries: [historyEntry("b")], nextCursor: null };
    });
    const renderer = await mountPanel({ loadHistory });
    try {
      await fireHistorySentinel();
      expect(historyRows(renderer)).toHaveLength(1);
      expect(textContent(renderer.root)).toContain("Не удалось загрузить следующие выжимки.");

      // A failed page must not be asked for again on its own.
      expect(liveHistoryObservers()).toHaveLength(0);
      expect(loadHistory).toHaveBeenCalledTimes(2);

      failNext = false;
      const retry = renderer.root.find(
        (node) => node.type === "button" && textContent(node) === "Повторить",
      );
      await act(async () => {
        retry.props.onClick();
        await Promise.resolve();
      });
      expect(loadHistory).toHaveBeenCalledTimes(3);
      expect(loadHistory).toHaveBeenLastCalledWith({ threadId, cursor: cursorAfter("a") });
      expect(historyRows(renderer)).toHaveLength(2);
      expect(textContent(renderer.root)).not.toContain("Не удалось загрузить следующие выжимки.");
    } finally {
      act(() => renderer.unmount());
    }
  });

  it("drops a pending next page when the history is refreshed", async () => {
    mocks.pins = [];
    const stalePage = deferred<{ entries: CoordinatorSummaryHistoryEntry[]; nextCursor: null }>();
    let firstLoads = 0;
    const loadHistory = vi.fn<CoordinatorSummaryHistoryLoader>(async ({ cursor }) => {
      if (cursor !== undefined) return stalePage.promise;
      firstLoads += 1;
      return { entries: [historyEntry(`fresh-${firstLoads}`)], nextCursor: cursorAfter("x") };
    });
    const renderer = await mountPanel({ loadHistory });
    try {
      await fireHistorySentinel();
      const refresh = renderer.root.findByProps({ "aria-label": "Обновить историю" });
      await act(async () => {
        refresh.props.onClick();
        await Promise.resolve();
      });
      await act(async () => {
        stalePage.resolve({ entries: [historyEntry("late")], nextCursor: null });
        await Promise.resolve();
      });
      expect(historyRows(renderer)).toHaveLength(1);
      expect(historyRows(renderer)[0]).toContain("Ребёнок fresh-2");
    } finally {
      act(() => renderer.unmount());
    }
  });

  it("marks only stale records as stale", async () => {
    mocks.pins = [];
    const loadHistory = vi.fn<CoordinatorSummaryHistoryLoader>(async () => ({
      entries: [historyEntry("fresh"), historyEntry("old", { stale: true })],
      nextCursor: null,
    }));
    const renderer = await mountPanel({ loadHistory });
    try {
      const [fresh, old] = renderer.root.findAllByType("li");
      expect(textContent(fresh!)).not.toContain("Устарела");
      expect(textContent(old!)).toContain("Устарела");
    } finally {
      act(() => renderer.unmount());
    }
  });

  it("does not open the panel for an empty history and shows the empty state beside cards", async () => {
    mocks.pins = [];
    const onOpenChange = vi.fn();
    const loadHistory = vi.fn<CoordinatorSummaryHistoryLoader>(async () => ({
      entries: [],
      nextCursor: null,
    }));
    const renderer = await mountPanel({ onOpenChange, loadHistory });
    try {
      expect(loadHistory).toHaveBeenCalledOnce();
      expect(renderer.root.findAllByProps({ "data-chat-side-panel": "true" })).toHaveLength(0);
      expect(onOpenChange).toHaveBeenLastCalledWith(false);
    } finally {
      act(() => renderer.unmount());
    }

    mocks.pins = [mocks.cardId];
    const withCards = await mountPanel({ loadHistory });
    try {
      const historyTab = withCards.root.find(
        (node) => node.props.role === "tab" && textContent(node) === "История",
      );
      expect(historyTab.props["aria-selected"]).toBe(false);
      act(() => historyTab.props.onClick());
      expect(textContent(withCards.root)).toContain("Выжимок пока нет");
    } finally {
      act(() => withCards.unmount());
    }
  });

  it("opens the panel when a git repository has no cards or coordinator history", async () => {
    mocks.pins = [];
    window.localStorage.setItem(activeTabStorageKey, JSON.stringify("history"));
    const onOpenChange = vi.fn();
    const loadHistory = vi.fn<CoordinatorSummaryHistoryLoader>(async () => ({
      entries: [],
      nextCursor: null,
    }));
    const renderer = await mountPanel({ onOpenChange, loadHistory, hasGitRepository: true });
    try {
      expect(renderer.root.findAllByProps({ "data-chat-side-panel": "true" })).toHaveLength(1);
      expect(onOpenChange).toHaveBeenLastCalledWith(true);
      expect(renderer.root.findAllByProps({ "data-commits-graph": "true" })).toHaveLength(0);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it("reports a failed first page inside the history tab without touching cards", async () => {
    const loadHistory = vi.fn<CoordinatorSummaryHistoryLoader>(async () => {
      throw new Error("offline");
    });
    const renderer = await mountPanel({ loadHistory });
    try {
      expect(renderer.root.findAllByProps({ "data-board-card-id": mocks.cardId })).toHaveLength(1);
      const historyTab = renderer.root.find(
        (node) => node.props.role === "tab" && textContent(node) === "История",
      );
      act(() => historyTab.props.onClick());
      expect(textContent(renderer.root)).toContain("Не удалось загрузить историю выжимок.");
    } finally {
      act(() => renderer.unmount());
    }
  });

  it("keeps the panel and the History tab visible without pins when the history fails to load", async () => {
    mocks.pins = [];
    const onOpenChange = vi.fn();
    const loadHistory = vi.fn<CoordinatorSummaryHistoryLoader>(async () => {
      throw new Error("offline");
    });
    const renderer = await mountPanel({ onOpenChange, loadHistory });
    try {
      const historyTab = renderer.root.find(
        (node) => node.props.role === "tab" && textContent(node) === "История",
      );
      expect(historyTab.props["aria-selected"]).toBe(true);
      expect(textContent(renderer.root)).toContain("Не удалось загрузить историю выжимок.");
      expect(onOpenChange).toHaveBeenLastCalledWith(true);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it("states that an empty history is not an error", async () => {
    const loadHistory = vi.fn<CoordinatorSummaryHistoryLoader>(async () => ({
      entries: [],
      nextCursor: null,
    }));
    const renderer = await mountPanel({ loadHistory });
    try {
      const historyTab = renderer.root.find(
        (node) => node.props.role === "tab" && textContent(node) === "История",
      );
      act(() => historyTab.props.onClick());
      expect(textContent(renderer.root)).toContain("Это не ошибка.");
      expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
    } finally {
      act(() => renderer.unmount());
    }
  });
});

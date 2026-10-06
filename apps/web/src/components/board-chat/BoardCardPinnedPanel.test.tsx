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

async function mountPanel(onOpenChange?: (open: boolean) => void): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <BoardCardPinnedPanel
        environmentId={environmentId}
        threadId={threadId}
        onOpenChange={onOpenChange}
      />,
    );
    await Promise.resolve();
  });
  return renderer;
}

describe("BoardCardPinnedPanel", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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

  it("reports the whole panel as closed when collapsed and open when restored", async () => {
    const onOpenChange = vi.fn();
    const renderer = await mountPanel(onOpenChange);
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
    const renderer = await mountPanel(onOpenChange);
    try {
      expect(renderer.root.findAllByProps({ "data-board-card-panel": "true" })).toHaveLength(0);
      expect(onOpenChange).toHaveBeenLastCalledWith(false);
    } finally {
      act(() => renderer.unmount());
    }
  });
});

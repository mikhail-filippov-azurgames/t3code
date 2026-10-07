import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { clearBoardCardMentionCache } from "@t3tools/client-runtime/board-card-mentions";
import {
  BoardCardId,
  type BoardCard,
  type BoardCardLookupDetail,
  type EnvironmentId,
  type OrchestrationDelegatedTaskSummaryHistoryCursor,
  type ThreadId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CircleAlertIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  MessageCircleIcon,
  OctagonAlertIcon,
  PanelLeftOpenIcon,
  PlayIcon,
  RotateCwIcon,
  SendIcon,
  XIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";

import {
  boardFailureText,
  boardExecutorRoleLabel,
  boardReadinessLabel,
  boardStatusLabel,
  isCardStartable,
  shouldShowBoardReadiness,
} from "../board/board.logic";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { boardEnvironment } from "../../state/board";
import { readThreadShell } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useExpandCoordinatorHistoryByDefault } from "../board/boardPreferences";
import {
  boardCardPinsKey,
  readBoardCardPins,
  removeBoardCardPin,
  subscribeBoardCardPins,
} from "./boardCardPins";
import type {
  CoordinatorSummaryHistoryEntry,
  CoordinatorSummaryHistoryLoader,
} from "./coordinatorSummaryHistory";

interface BoardCardPinnedPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Reports whether the full panel (not the collapsed pill) is on screen. */
  readonly onOpenChange?: (open: boolean) => void;
  readonly loadHistory?: CoordinatorSummaryHistoryLoader;
}

type ChatPanelTab = "cards" | "history";

type SummaryHistoryLoadState = {
  readonly threadId: ThreadId;
  readonly entries: ReadonlyArray<CoordinatorSummaryHistoryEntry>;
  readonly nextCursor: OrchestrationDelegatedTaskSummaryHistoryCursor | null;
  readonly loading: boolean;
  readonly error: boolean;
  readonly loadingMore: boolean;
  readonly loadMoreError: boolean;
};

const HISTORY_LOAD_MORE_THRESHOLD_PX = 240;

function emptyHistoryState(threadId: ThreadId): SummaryHistoryLoadState {
  return {
    threadId,
    entries: [],
    nextCursor: null,
    loading: false,
    error: false,
    loadingMore: false,
    loadMoreError: false,
  };
}

const CHAT_PANEL_TAB_SCHEMA = Schema.Literals(["cards", "history"]);

function splitCardIds(cardIds: ReadonlyArray<string>, size: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < cardIds.length; index += size) {
    chunks.push(cardIds.slice(index, index + size));
  }
  return chunks;
}

export function BoardCardPinnedPanel({
  environmentId,
  threadId,
  onOpenChange,
  loadHistory,
}: BoardCardPinnedPanelProps) {
  const navigate = useNavigate();
  const key = boardCardPinsKey(environmentId, threadId);
  const [pins, setPins] = useState(() => readBoardCardPins(environmentId, threadId));
  const [details, setDetails] = useState<ReadonlyMap<string, BoardCardLookupDetail>>(new Map());
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busyCardId, setBusyCardId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [collapsedCardIds, setCollapsedCardIds] = useState<ReadonlySet<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [expandHistoryByDefault] = useExpandCoordinatorHistoryByDefault();
  // Only entries the user toggled by hand; the rest follow the default, so changing it applies to them.
  const [historyEntryOverrides, setHistoryEntryOverrides] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  const [historyState, setHistoryState] = useState<SummaryHistoryLoadState>(() =>
    emptyHistoryState(threadId),
  );
  const [activeTab, setActiveTab] = useLocalStorage<ChatPanelTab, ChatPanelTab>(
    `t3code:chat-side-panel-tab:${environmentId}:${threadId}`,
    pins.length > 0 ? "cards" : "history",
    CHAT_PANEL_TAB_SCHEMA,
  );
  const loadSequence = useRef(0);
  const historyLoadSequence = useRef(0);
  const historyLoadingMore = useRef(false);
  const historyStateRef = useRef<SummaryHistoryLoadState>(historyState);
  const resolveCards = useAtomQueryRunner(boardEnvironment.resolve, {
    reportFailure: false,
    refresh: true,
  });
  const startCard = useAtomCommand(boardEnvironment.start, { reportFailure: false });
  const updateCard = useAtomCommand(boardEnvironment.update, { reportFailure: false });
  const requestOrchestrator = useAtomCommand(boardEnvironment.requestOrchestrator, {
    reportFailure: false,
  });

  useEffect(() => {
    setPins(readBoardCardPins(environmentId, threadId));
    setDetails(new Map());
    setLoadError(false);
    setCollapsed(false);
    setCollapsedCardIds(new Set());
    setHistoryEntryOverrides(new Map());
    setActionError(null);
  }, [environmentId, threadId]);

  const currentHistoryState =
    historyState.threadId === threadId ? historyState : emptyHistoryState(threadId);
  useLayoutEffect(() => {
    historyStateRef.current = currentHistoryState;
  }, [currentHistoryState]);
  // A failed history load must stay visible; hiding it would look like "no history".
  const hasPanelContent =
    pins.length > 0 || currentHistoryState.entries.length > 0 || currentHistoryState.error;
  const open = hasPanelContent && !collapsed;
  useLayoutEffect(() => {
    onOpenChange?.(open);
    return () => onOpenChange?.(false);
  }, [open, onOpenChange]);

  const toggleCardCollapsed = useCallback((cardId: string) => {
    setCollapsedCardIds((current) => {
      const next = new Set(current);
      if (!next.delete(cardId)) next.add(cardId);
      return next;
    });
  }, []);

  const toggleHistoryEntry = useCallback((entryId: string, expanded: boolean) => {
    setHistoryEntryOverrides((current) => new Map(current).set(entryId, !expanded));
  }, []);

  useEffect(
    () =>
      subscribeBoardCardPins((changedKey, nextPins) => {
        if (changedKey === key) setPins(nextPins);
      }),
    [key],
  );

  const loadDetails = useCallback(
    async (cardIds: ReadonlyArray<string>) => {
      const sequence = ++loadSequence.current;
      setLoadError(false);
      if (cardIds.length === 0) {
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const loaded = new Map<string, BoardCardLookupDetail>();
        for (const chunk of splitCardIds(cardIds, 20)) {
          const result = await resolveCards({
            environmentId,
            input: { tokens: [], cardIds: chunk.map((cardId) => BoardCardId.make(cardId)) },
          });
          if (!AsyncResult.isSuccess(result)) throw result.cause;
          for (const detail of result.value.details) loaded.set(String(detail.card.cardId), detail);
        }
        if (sequence === loadSequence.current) setDetails(loaded);
      } catch {
        if (sequence === loadSequence.current) {
          setDetails(new Map());
          setLoadError(true);
        }
      } finally {
        if (sequence === loadSequence.current) setLoading(false);
      }
    },
    [environmentId, resolveCards],
  );

  useEffect(() => {
    void loadDetails(pins);
    return () => {
      loadSequence.current += 1;
    };
  }, [loadDetails, pins]);

  const refresh = useCallback(() => loadDetails(pins), [loadDetails, pins]);

  const refreshHistory = useCallback(async () => {
    if (!loadHistory) return;
    const sequence = ++historyLoadSequence.current;
    historyLoadingMore.current = false;
    setHistoryState((current) => ({
      ...(current.threadId === threadId ? current : emptyHistoryState(threadId)),
      loading: true,
      error: false,
      loadingMore: false,
      loadMoreError: false,
    }));
    try {
      const page = await loadHistory({ threadId });
      if (sequence === historyLoadSequence.current) {
        setHistoryState({
          ...emptyHistoryState(threadId),
          entries: page.entries,
          nextCursor: page.nextCursor,
        });
      }
    } catch {
      if (sequence === historyLoadSequence.current) {
        setHistoryState({ ...emptyHistoryState(threadId), error: true });
      }
    }
  }, [loadHistory, threadId]);

  const loadMoreHistory = useCallback(async () => {
    const { nextCursor, loading } = historyStateRef.current;
    if (!loadHistory || !nextCursor || loading || historyLoadingMore.current) return;
    const sequence = historyLoadSequence.current;
    historyLoadingMore.current = true;
    setHistoryState((current) => ({ ...current, loadingMore: true, loadMoreError: false }));
    try {
      const page = await loadHistory({ threadId, cursor: nextCursor });
      if (sequence === historyLoadSequence.current) {
        setHistoryState((current) => ({
          ...current,
          entries: [...current.entries, ...page.entries],
          nextCursor: page.nextCursor,
          loadingMore: false,
        }));
      }
    } catch {
      if (sequence === historyLoadSequence.current) {
        setHistoryState((current) => ({ ...current, loadingMore: false, loadMoreError: true }));
      }
    } finally {
      if (sequence === historyLoadSequence.current) historyLoadingMore.current = false;
    }
  }, [loadHistory, threadId]);

  useEffect(() => {
    if (!loadHistory) {
      setHistoryState(emptyHistoryState(threadId));
      return;
    }
    void refreshHistory();
    return () => {
      historyLoadSequence.current += 1;
    };
  }, [loadHistory, refreshHistory, threadId]);

  const openThread = useCallback(
    (targetThreadId: ThreadId) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: targetThreadId },
      });
    },
    [environmentId, navigate],
  );

  const start = useCallback(
    async (card: BoardCard) => {
      setBusyCardId(String(card.cardId));
      setActionError(null);
      const result = await startCard({ environmentId, input: { cardId: card.cardId } });
      setBusyCardId(null);
      if (!AsyncResult.isSuccess(result)) {
        setActionError(boardFailureText(result.cause));
        return;
      }
      clearBoardCardMentionCache(String(environmentId));
      await refresh();
    },
    [environmentId, refresh, startCard],
  );

  const toggleArchive = useCallback(
    async (card: BoardCard) => {
      setBusyCardId(String(card.cardId));
      setActionError(null);
      const result = await updateCard({
        environmentId,
        input: { cardId: card.cardId, archived: !card.archived },
      });
      setBusyCardId(null);
      if (!AsyncResult.isSuccess(result)) {
        setActionError(boardFailureText(result.cause));
        return;
      }
      clearBoardCardMentionCache(String(environmentId));
      await refresh();
    },
    [environmentId, refresh, updateCard],
  );

  const request = useCallback(
    async (card: BoardCard, text: string) => {
      const ownerRef = scopeThreadRef(environmentId, card.orchestratorThreadId);
      const ownerShell = readThreadShell(ownerRef);
      if (!ownerShell) {
        setActionError("Чат оркестратора недоступен. Проверьте соединение и повторите запрос.");
        return;
      }
      setBusyCardId(String(card.cardId));
      setActionError(null);
      const result = await requestOrchestrator({
        environmentId,
        input: {
          threadId: card.orchestratorThreadId,
          text,
          modelSelection: ownerShell.modelSelection,
          runtimeMode: ownerShell.runtimeMode,
          interactionMode: ownerShell.interactionMode,
        },
      });
      setBusyCardId(null);
      if (!AsyncResult.isSuccess(result)) {
        setActionError(boardFailureText(result.cause));
        return;
      }
      setActionError("Просьба отправлена оркестратору.");
    },
    [environmentId, requestOrchestrator],
  );

  const refreshActiveTab = activeTab === "cards" ? refresh : refreshHistory;
  const refreshingActiveTab = activeTab === "cards" ? loading : currentHistoryState.loading;
  const canRefreshActiveTab = activeTab === "cards" || loadHistory !== undefined;

  if (!hasPanelContent) return null;

  if (collapsed) {
    return (
      <Button
        type="button"
        variant="outline"
        className="absolute left-2 top-2 z-30 shadow-lg"
        aria-label="Развернуть панель чата"
        onClick={() => setCollapsed(false)}
      >
        <PanelLeftOpenIcon className="size-4" aria-hidden="true" />
        Панель чата
      </Button>
    );
  }

  return (
    <ChatSidePanelShell
      activeTab={activeTab}
      onSelectTab={setActiveTab}
      onCollapse={() => setCollapsed(true)}
      collapseButtonLabel="Свернуть панель чата"
      refreshButtonLabel={
        activeTab === "cards" ? "Повторить загрузку карточек" : "Обновить историю"
      }
      onRefresh={refreshActiveTab}
      refreshing={refreshingActiveTab}
      showRefresh={canRefreshActiveTab}
    >
      {activeTab === "cards" ? (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {pins.map((cardId) => {
            const detail = details.get(cardId);
            return (
              <PinnedCard
                key={cardId}
                cardId={cardId}
                detail={detail}
                loading={loading}
                loadError={loadError}
                busy={busyCardId === cardId}
                collapsed={collapsedCardIds.has(cardId)}
                onToggleCollapsed={() => toggleCardCollapsed(cardId)}
                actionError={actionError}
                onRetry={() => void refresh()}
                onRemove={() => removeBoardCardPin(environmentId, threadId, cardId)}
                onOpenThread={openThread}
                onStart={start}
                onToggleArchive={toggleArchive}
                onRequest={request}
              />
            );
          })}
          {pins.length === 0 ? (
            <p className="text-xs text-muted-foreground">Закреплённых карточек пока нет.</p>
          ) : null}
        </div>
      ) : (
        <div
          className="min-h-0 flex-1 overflow-y-auto p-3"
          onScroll={(event) => {
            const list = event.currentTarget;
            if (
              !currentHistoryState.loadMoreError &&
              list.scrollHeight - list.scrollTop - list.clientHeight <
                HISTORY_LOAD_MORE_THRESHOLD_PX
            ) {
              void loadMoreHistory();
            }
          }}
        >
          {currentHistoryState.loading && currentHistoryState.entries.length === 0 ? (
            <p role="status" className="text-xs text-muted-foreground">
              Загрузка выжимок…
            </p>
          ) : currentHistoryState.error ? (
            <div role="alert" className="space-y-2 text-xs">
              <p>Не удалось загрузить историю выжимок.</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void refreshHistory()}
              >
                Повторить
              </Button>
            </div>
          ) : currentHistoryState.entries.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Выжимок пока нет: ни одна делегированная задача этого чата ещё не завершила ход. Это
              не ошибка.
            </p>
          ) : (
            <>
              <ol className="space-y-3">
                {currentHistoryState.entries.map((entry) => (
                  <HistoryEntry
                    key={entry.id}
                    entry={entry}
                    expanded={historyEntryOverrides.get(entry.id) ?? expandHistoryByDefault}
                    onToggle={toggleHistoryEntry}
                  />
                ))}
              </ol>
              {currentHistoryState.loadingMore ? (
                <p role="status" className="mt-3 text-xs text-muted-foreground">
                  Загрузка выжимок…
                </p>
              ) : null}
              {currentHistoryState.loadMoreError ? (
                <div role="alert" className="mt-3 space-y-2 text-xs">
                  <p>Не удалось загрузить следующие выжимки.</p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void loadMoreHistory()}
                  >
                    Повторить
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      )}
    </ChatSidePanelShell>
  );
}

/** Collapsed keeps what identifies the digest and warns about it (title, stale, time); the rest opens on demand. */
function HistoryEntry(props: {
  readonly entry: CoordinatorSummaryHistoryEntry;
  readonly expanded: boolean;
  readonly onToggle: (entryId: string, expanded: boolean) => void;
}) {
  const { entry, expanded } = props;
  const ChevronIcon = expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <li className="rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-sm text-left font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={expanded}
          onClick={() => props.onToggle(entry.id, expanded)}
        >
          <ChevronIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className={cn("min-w-0", expanded ? "break-words" : "truncate")}>
            {entry.child} · ход {entry.turn}
          </span>
        </button>
        {entry.stale ? (
          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 font-medium text-amber-700 dark:text-amber-300">
            Устарела
          </span>
        ) : null}
      </div>
      <time className="mt-1 block text-[10px] text-muted-foreground" dateTime={entry.completedAt}>
        Завершено {new Date(entry.completedAt).toLocaleString()}
      </time>
      {expanded ? (
        <>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">
            {entry.summaryText}
          </p>
          <dl className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <div className="flex gap-1">
              <dt>Текущее состояние:</dt>
              <dd className="text-foreground">{entry.currentStatus}</dd>
            </div>
            <div className="flex gap-1">
              <dt>Состояние выжимки:</dt>
              <dd className="text-foreground">{entry.summaryStatus}</dd>
            </div>
            <div className="flex gap-1">
              <dt>Роль исполнителя:</dt>
              <dd className="text-foreground">{entry.executorRole}</dd>
            </div>
          </dl>
        </>
      ) : null}
    </li>
  );
}

function ChatSidePanelShell(props: {
  readonly activeTab: ChatPanelTab;
  readonly onSelectTab: (tab: ChatPanelTab) => void;
  readonly onCollapse: () => void;
  readonly collapseButtonLabel: string;
  readonly refreshButtonLabel: string;
  readonly onRefresh: () => void | Promise<void>;
  readonly refreshing: boolean;
  readonly showRefresh: boolean;
  readonly children: ReactNode;
}) {
  return (
    <aside
      aria-label="Панель чата"
      className="absolute inset-y-2 left-2 z-30 flex w-[min(22rem,calc(100%-1rem))] flex-col overflow-hidden rounded-xl border border-border bg-background/98 shadow-xl backdrop-blur"
      data-board-card-panel="true"
      data-chat-side-panel="true"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-2">
        <div role="tablist" aria-label="Разделы панели чата" className="flex min-w-0 flex-1 gap-1">
          {(
            [
              ["cards", "Карточки"],
              ["history", "История"],
            ] as const
          ).map(([tab, label]) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={props.activeTab === tab}
              aria-controls="chat-side-panel-content"
              id={`chat-side-panel-tab-${tab}`}
              className={cn(
                "min-w-0 rounded-md px-3 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                props.activeTab === tab
                  ? "bg-secondary font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
              onClick={() => props.onSelectTab(tab)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {props.showRefresh ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={props.refreshButtonLabel}
              disabled={props.refreshing}
              onClick={() => void props.onRefresh()}
            >
              <RotateCwIcon className="size-4" aria-hidden="true" />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={props.collapseButtonLabel}
            onClick={props.onCollapse}
          >
            <ChevronDownIcon className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
      <div
        id="chat-side-panel-content"
        role="tabpanel"
        aria-labelledby={`chat-side-panel-tab-${props.activeTab}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {props.children}
      </div>
    </aside>
  );
}

function PinnedCard(props: {
  readonly cardId: string;
  readonly detail: BoardCardLookupDetail | undefined;
  readonly loading: boolean;
  readonly loadError: boolean;
  readonly busy: boolean;
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
  readonly actionError: string | null;
  readonly onRetry: () => void;
  readonly onRemove: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onStart: (card: BoardCard) => void;
  readonly onToggleArchive: (card: BoardCard) => void;
  readonly onRequest: (card: BoardCard, text: string) => Promise<void>;
}) {
  const [requestText, setRequestText] = useState("");
  const { card, events, orchestratorThreadTitle } = props.detail ?? {};

  return (
    <article
      className="rounded-lg border border-border bg-card p-3"
      data-board-card-id={props.cardId}
    >
      <div className={cn("flex gap-2", props.collapsed ? "items-center" : "mb-2 items-start")}>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold leading-snug">
            <button
              type="button"
              className={cn(
                "w-full min-w-0 cursor-pointer rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                props.collapsed ? "truncate" : "break-words",
              )}
              aria-expanded={!props.collapsed}
              onClick={props.onToggleCollapsed}
            >
              {card?.title ?? props.cardId}
            </button>
          </h3>
          {card && !props.collapsed ? (
            <>
              <p className="mt-1 text-xs text-muted-foreground">
                {boardStatusLabel(card.status)} · {boardExecutorRoleLabel(card.executorRole)}
              </p>
              {shouldShowBoardReadiness(card.readiness) ? (
                <div className="mt-1 space-y-1 text-xs">
                  <p className="inline-flex items-center gap-1 font-medium">
                    {card.readiness === "needs_human" ? (
                      <CircleAlertIcon aria-hidden="true" className="size-3.5 text-destructive" />
                    ) : (
                      <OctagonAlertIcon aria-hidden="true" className="size-3.5 text-warning" />
                    )}
                    {boardReadinessLabel(card.readiness)}
                  </p>
                  {card.readinessNote !== null ? (
                    <p className="break-words text-muted-foreground">{card.readinessNote}</p>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Снять карточку ${props.cardId}`}
          onClick={props.onRemove}
        >
          <XIcon className="size-4" aria-hidden="true" />
        </Button>
      </div>

      {props.collapsed ? null : (
        <>
          {props.loading && !props.detail ? (
            <p className="text-xs text-muted-foreground">Загрузка карточки…</p>
          ) : null}
          {props.loadError ? (
            <div role="alert" className="space-y-2 rounded-md bg-destructive/10 p-2 text-xs">
              <p>Не удалось загрузить карточку. Проверьте соединение и повторите запрос.</p>
              <Button type="button" size="sm" variant="outline" onClick={props.onRetry}>
                Повторить
              </Button>
            </div>
          ) : null}
          {!props.loading && !props.loadError && !props.detail ? (
            <p role="status" className="text-xs text-muted-foreground">
              Карточка недоступна: она могла быть удалена.
            </p>
          ) : null}

          {card && props.detail ? (
            <>
              <p className="mb-2 text-xs text-muted-foreground">
                Оркестратор: {orchestratorThreadTitle ?? card.orchestratorThreadId}
              </p>
              {card.body ? (
                <p className="mb-3 max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed">
                  {card.body}
                </p>
              ) : null}
              <div className="mb-3 flex flex-wrap gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => props.onOpenThread(card.orchestratorThreadId)}
                >
                  <MessageCircleIcon className="size-3.5" aria-hidden="true" />
                  Чат оркестратора
                </Button>
                {card.executorThreadId ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => props.onOpenThread(card.executorThreadId!)}
                  >
                    <MessageCircleIcon className="size-3.5" aria-hidden="true" />
                    Чат исполнителя
                  </Button>
                ) : null}
                {isCardStartable(card) ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={props.busy}
                    onClick={() => props.onStart(card)}
                  >
                    <PlayIcon className="size-3.5" aria-hidden="true" />
                    Запустить
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={props.busy}
                  onClick={() => props.onToggleArchive(card)}
                >
                  {card.archived ? (
                    <ArchiveRestoreIcon className="size-3.5" aria-hidden="true" />
                  ) : (
                    <ArchiveIcon className="size-3.5" aria-hidden="true" />
                  )}
                  {card.archived ? "Разархивировать" : "Архивировать"}
                </Button>
              </div>
              <form
                className="mb-3 space-y-1.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  const text = requestText.trim();
                  if (text) void props.onRequest(card, text);
                }}
              >
                <label
                  className="block text-xs font-medium"
                  htmlFor={`board-request-${props.cardId}`}
                >
                  Просьба оркестратору
                </label>
                <textarea
                  id={`board-request-${props.cardId}`}
                  className="min-h-16 w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={requestText}
                  onChange={(event) => setRequestText(event.currentTarget.value)}
                  placeholder="Напишите, что нужно проверить или уточнить"
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  disabled={props.busy || !requestText.trim()}
                >
                  <SendIcon className="size-3.5" aria-hidden="true" />
                  Отправить
                </Button>
              </form>
              {props.actionError ? (
                <p role="status" className="mb-3 text-xs text-muted-foreground">
                  {props.actionError}
                </p>
              ) : null}
              <div className="border-t border-border pt-2">
                <h4 className="mb-1 text-xs font-semibold">История</h4>
                {events?.length ? (
                  <ol className="space-y-2">
                    {events.map((entry) => (
                      <li key={entry.entryId} className="border-l-2 border-border pl-2 text-xs">
                        <p className="font-medium">
                          {boardStatusLabel(entry.status)} ·{" "}
                          {boardExecutorRoleLabel(entry.executorRole)}
                        </p>
                        {entry.body ? (
                          <p className="break-words text-muted-foreground">{entry.body}</p>
                        ) : null}
                        <time className="text-[10px] text-muted-foreground" dateTime={entry.at}>
                          {new Date(entry.at).toLocaleString()}
                        </time>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-xs text-muted-foreground">История пуста.</p>
                )}
              </div>
            </>
          ) : null}
        </>
      )}
    </article>
  );
}

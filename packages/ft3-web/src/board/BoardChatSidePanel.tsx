import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { BoardCard, BoardCardLookupDetail } from "@t3tools/ft3-board/contracts";
import { AsyncResult } from "effect/reactivity";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  MessageCircleIcon,
  OctagonAlertIcon,
  PanelLeftOpenIcon,
  PlayIcon,
  RotateCwIcon,
  SendIcon,
  XIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useNavigate } from "@tanstack/react-router";

import {
  boardExecutorRoleLabel,
  boardFailureText,
  boardReadinessLabel,
  boardStatusLabel,
  isCardStartable,
  shouldShowBoardReadiness,
} from "./board.logic";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { readThreadShell } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useExpandCoordinatorHistoryByDefault } from "./boardPreferences";
import { removeBoardCardPin } from "./boardCardPins";
import { pinnedCardsQuery, useBoardCardPins } from "./BoardCardPinnedPanel";
import { BoardCardPlanButton } from "./BoardCardPlanButton";
import {
  coordinatorSummaryExecutorLabel,
  type CoordinatorSummaryHistoryEntry,
  type CoordinatorSummaryHistoryPage,
} from "./coordinatorSummaryHistory";
import { useCoordinatorSummaryHistoryLoader } from "./useCoordinatorSummaryHistoryLoader";
import { clearBoardCardMentionCache } from "../chat/boardCardMentions";
import { boardEnvironment } from "./state";
import { BoardMailTab, useBoardMailTasks } from "../mail/MailTabContent.tsx";

type ChatPanelTab = "cards" | "history" | "mail";

type SummaryHistoryLoadState = {
  readonly threadId: ThreadId;
  readonly entries: ReadonlyArray<CoordinatorSummaryHistoryEntry>;
  readonly nextCursor: CoordinatorSummaryHistoryPage["nextCursor"];
  readonly loading: boolean;
  readonly error: boolean;
  readonly loadingMore: boolean;
  readonly loadMoreError: boolean;
};

const HISTORY_ENTRY_OVERRIDES_SCHEMA = Schema.Record(Schema.String, Schema.Boolean);
const EMPTY_HISTORY_ENTRY_OVERRIDES: Record<string, boolean> = {};

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

const CHAT_PANEL_TAB_SCHEMA = Schema.Literals(["cards", "history", "mail"]);

export function BoardChatSidePanel(props: { readonly threadRef: ScopedThreadRef }) {
  const { environmentId, threadId } = props.threadRef;
  const navigate = useNavigate();
  const pins = useBoardCardPins(props.threadRef);
  const pinned = useEnvironmentQuery(
    pins.length > 0 ? pinnedCardsQuery(JSON.stringify({ environmentId, cardIds: pins })) : null,
  );
  const details = useMemo(
    () =>
      new Map<string, BoardCardLookupDetail>(
        (pinned.data?.details ?? []).map((detail) => [String(detail.card.cardId), detail]),
      ),
    [pinned.data],
  );
  const loading = pinned.isPending;
  const loadError = pinned.error !== null;
  const refresh = pinned.refresh;
  const [busyCardId, setBusyCardId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useLocalStorage(
    `t3code:chat-side-panel-collapsed:${environmentId}:${threadId}`,
    false,
    Schema.Boolean,
  );
  const [collapsedCardIds, setCollapsedCardIds] = useState<ReadonlySet<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [expandHistoryByDefault] = useExpandCoordinatorHistoryByDefault();
  const [historyEntryOverrides, setHistoryEntryOverrides] = useLocalStorage<
    Record<string, boolean>,
    Record<string, boolean>
  >(
    `t3code:chat-side-panel-history-entry-overrides:${environmentId}:${threadId}`,
    EMPTY_HISTORY_ENTRY_OVERRIDES,
    HISTORY_ENTRY_OVERRIDES_SCHEMA,
  );
  const [historyState, setHistoryState] = useState<SummaryHistoryLoadState>(() =>
    emptyHistoryState(threadId),
  );
  const [activeTab, setActiveTab] = useLocalStorage<ChatPanelTab, ChatPanelTab>(
    `t3code:chat-side-panel-tab:${environmentId}:${threadId}`,
    pins.length > 0 ? "cards" : "history",
    CHAT_PANEL_TAB_SCHEMA,
  );
  const loadHistory = useCoordinatorSummaryHistoryLoader(props.threadRef);
  const historyLoadSequence = useRef(0);
  const historyLoadingMore = useRef(false);
  const boardList = useEnvironmentQuery(
    boardEnvironment.listForChatPanel({ environmentId, input: { includeArchived: true } }),
  );
  const boardCardIds = useMemo(
    () => (boardList.data?.cards ?? []).map((card) => String(card.cardId)),
    [boardList.data],
  );
  const mailTasks = useBoardMailTasks(environmentId, boardCardIds);
  const startCard = useAtomCommand(boardEnvironment.start, { reportFailure: false });
  const updateCard = useAtomCommand(boardEnvironment.update, { reportFailure: false });
  const requestOrchestrator = useAtomCommand(boardEnvironment.requestOrchestrator, {
    reportFailure: false,
  });

  const currentHistoryState =
    historyState.threadId === threadId ? historyState : emptyHistoryState(threadId);
  // Failed coordinator history and failed mail task listing remain panel
  // content so their errors can be retried.
  const hasMailContent = mailTasks.error !== null || (mailTasks.data?.tasks.length ?? 0) > 0;
  const hasPanelContent =
    pins.length > 0 ||
    currentHistoryState.entries.length > 0 ||
    currentHistoryState.error ||
    hasMailContent;

  const toggleCardCollapsed = useCallback((cardId: string) => {
    setCollapsedCardIds((current) => {
      const next = new Set(current);
      if (!next.delete(cardId)) next.add(cardId);
      return next;
    });
  }, []);

  const toggleHistoryEntry = useCallback(
    (entryId: string, expanded: boolean) => {
      setHistoryEntryOverrides((current) => ({ ...current, [entryId]: !expanded }));
    },
    [setHistoryEntryOverrides],
  );

  const refreshHistory = useCallback(async () => {
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
    const { nextCursor, loading: historyLoading } = currentHistoryState;
    if (nextCursor === null || historyLoading || historyLoadingMore.current) return;
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
  }, [currentHistoryState, loadHistory, threadId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the first summary-history page on mount; paging is imperative, not an atom
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the keyed remount reloads the first page once per thread
    void refreshHistory();
    return () => {
      historyLoadSequence.current += 1;
    };
  }, [refreshHistory]);

  // A sentinel at the bottom of the history list drives the next page: a short list never scrolls, so onScroll cannot.
  const canLoadMoreHistory =
    currentHistoryState.nextCursor !== null &&
    !currentHistoryState.loading &&
    !currentHistoryState.loadingMore &&
    !currentHistoryState.loadMoreError;
  // The sentinel is held as state rather than a ref because the history footer
  // remounts as pages land: an effect reading a ref could keep observing a
  // detached node and would never fire again.
  const [historySentinel, setHistorySentinel] = useState<HTMLDivElement | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes the history sentinel DOM node while it is mounted
  useEffect(() => {
    if (historySentinel === null || !canLoadMoreHistory) return;
    const observer = new IntersectionObserver(
      (observed) => {
        if (observed.some((entry) => entry.isIntersecting)) void loadMoreHistory();
      },
      // Start the next page slightly before the sentinel is on screen.
      { rootMargin: "240px" },
    );
    observer.observe(historySentinel);
    return () => observer.disconnect();
  }, [canLoadMoreHistory, historySentinel, loadMoreHistory]);

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
        setActionError("The orchestrator chat is unavailable. Check the connection and try again.");
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
      setActionError("Request sent to the orchestrator.");
    },
    [environmentId, requestOrchestrator],
  );

  const refreshBoardCards = useCallback(() => void boardList.refresh(), [boardList]);
  const refreshMail = useCallback(() => {
    refreshBoardCards();
    void mailTasks.refresh();
  }, [refreshBoardCards, mailTasks]);

  const refreshActiveTab =
    activeTab === "cards" ? refresh : activeTab === "history" ? refreshHistory : refreshMail;
  const refreshingActiveTab =
    activeTab === "cards"
      ? loading
      : activeTab === "history"
        ? currentHistoryState.loading
        : mailTasks.isPending && mailTasks.data !== null;

  if (!hasPanelContent) return null;

  if (collapsed) {
    return (
      <Button
        type="button"
        variant="outline"
        className="absolute left-2 top-2 z-30 shadow-lg"
        aria-label="Expand chat panel"
        onClick={() => setCollapsed(false)}
      >
        <PanelLeftOpenIcon className="size-4" aria-hidden="true" />
        Chat panel
      </Button>
    );
  }

  return (
    <ChatSidePanelShell
      activeTab={activeTab}
      onSelectTab={setActiveTab}
      onCollapse={() => setCollapsed(true)}
      refreshButtonLabel={
        activeTab === "cards"
          ? "Reload cards"
          : activeTab === "history"
            ? "Refresh history"
            : "Refresh mail"
      }
      onRefresh={refreshActiveTab}
      refreshing={refreshingActiveTab}
    >
      {activeTab === "cards" ? (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {pins.map((cardId) => {
            const detail = details.get(cardId);
            return (
              <PinnedCard
                key={cardId}
                environmentId={environmentId}
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
            <p className="text-xs text-muted-foreground">No pinned cards yet.</p>
          ) : null}
        </div>
      ) : activeTab === "mail" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <BoardMailTab
            threadRef={props.threadRef}
            cardIds={boardCardIds}
            refreshCards={refreshBoardCards}
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {currentHistoryState.loading && currentHistoryState.entries.length === 0 ? (
            <p role="status" className="text-xs text-muted-foreground">
              Loading summaries…
            </p>
          ) : currentHistoryState.error ? (
            <div role="alert" className="space-y-2 text-xs">
              <p>Could not load summary history.</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void refreshHistory()}
              >
                Retry
              </Button>
            </div>
          ) : currentHistoryState.entries.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No summaries yet: no delegated task in this chat has finished a turn. This is not an
              error.
            </p>
          ) : (
            <>
              <ol className="space-y-3">
                {currentHistoryState.entries.map((entry) => (
                  <HistoryEntry
                    key={entry.id}
                    entry={entry}
                    expanded={historyEntryOverrides[entry.id] ?? expandHistoryByDefault}
                    onToggle={toggleHistoryEntry}
                  />
                ))}
              </ol>
              {currentHistoryState.loadingMore ? (
                <p role="status" className="mt-3 text-xs text-muted-foreground">
                  Loading summaries…
                </p>
              ) : null}
              {currentHistoryState.loadMoreError ? (
                <div role="alert" className="mt-3 space-y-2 text-xs">
                  <p>Could not load the next summaries.</p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void loadMoreHistory()}
                  >
                    Retry
                  </Button>
                </div>
              ) : null}
              {canLoadMoreHistory ? (
                <div
                  ref={setHistorySentinel}
                  data-history-load-more-sentinel="true"
                  aria-hidden="true"
                />
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
            {entry.child} · turn {entry.turnOrdinal}
          </span>
        </button>
        {entry.stale ? (
          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 font-medium text-amber-700 dark:text-amber-300">
            Stale
          </span>
        ) : null}
      </div>
      <time className="mt-1 block text-[10px] text-muted-foreground" dateTime={entry.completedAt}>
        Completed {new Date(entry.completedAt).toLocaleString()}
      </time>
      {expanded ? (
        <>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">
            {entry.summaryText}
          </p>
          <dl className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <div className="flex gap-1">
              <dt>Current state:</dt>
              <dd className="text-foreground">{entry.currentStatus}</dd>
            </div>
            <div className="flex gap-1">
              <dt>Summary state:</dt>
              <dd className="text-foreground">{entry.summaryStatus}</dd>
            </div>
            <div className="flex gap-1">
              <dt>Executor:</dt>
              <dd className="text-foreground">
                {coordinatorSummaryExecutorLabel(entry) ?? "not set"}
              </dd>
            </div>
            <div className="flex gap-1">
              <dt>Executor role:</dt>
              <dd className="text-foreground capitalize">
                {entry.executorRole === "" ? "not set" : entry.executorRole}
              </dd>
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
  readonly refreshButtonLabel: string;
  readonly onRefresh: () => void | Promise<void>;
  readonly refreshing: boolean;
  readonly children: ReactNode;
}) {
  const viewportWidth =
    typeof window !== "undefined" && Number.isFinite(window.innerWidth) ? window.innerWidth : 1280;
  const viewportHeight =
    typeof window !== "undefined" && Number.isFinite(window.innerHeight) ? window.innerHeight : 720;
  const [size, setSize] = useState(() => ({
    width: Math.min(352, Math.max(280, viewportWidth - 32)),
    height: Math.min(672, Math.max(240, viewportHeight - 16)),
  }));
  const resizeStartRef = useRef<{ x: number; y: number; width: number; height: number } | null>(
    null,
  );
  const resizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const panel = event.currentTarget.parentElement;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    resizeStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      width: rect.width,
      height: rect.height,
    };
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const resizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current;
    if (!start) return;
    setSize({
      width: Math.min(viewportWidth - 16, Math.max(280, start.width + event.clientX - start.x)),
      height: Math.min(viewportHeight - 16, Math.max(240, start.height + event.clientY - start.y)),
    });
  };
  const resizeEnd = () => {
    resizeStartRef.current = null;
  };

  return (
    <aside
      aria-label="Chat panel"
      className="absolute left-2 top-2 z-30 flex max-h-[calc(100dvh-1rem)] max-w-[calc(100%-1rem)] min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-background/98 shadow-xl backdrop-blur"
      style={{ width: size.width, height: size.height }}
      data-board-card-panel="true"
      data-chat-side-panel="true"
    >
      <div
        role="separator"
        aria-label="Resize chat panel"
        aria-orientation="vertical"
        className="absolute bottom-0 right-0 z-40 size-5 cursor-nwse-resize touch-none"
        data-chat-side-panel-resize="true"
        onPointerCancel={resizeEnd}
        onPointerDown={resizePointerDown}
        onPointerMove={resizePointerMove}
        onPointerUp={resizeEnd}
      >
        <span
          aria-hidden
          className="absolute bottom-1 right-1 size-2 border-b border-r border-muted-foreground/60"
        />
      </div>
      <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-2">
        <div role="tablist" aria-label="Chat panel sections" className="flex min-w-0 flex-1 gap-1">
          {(
            [
              ["cards", "Cards"],
              ["history", "History"],
              ["mail", "Mail"],
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
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Collapse chat panel"
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
  readonly environmentId: EnvironmentId;
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
                    <p className="whitespace-pre-wrap break-words text-muted-foreground">
                      {card.readinessNote}
                    </p>
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
          aria-label={`Unpin card ${props.cardId}`}
          onClick={props.onRemove}
        >
          <XIcon className="size-4" aria-hidden="true" />
        </Button>
      </div>

      {props.collapsed ? null : (
        <>
          {props.loading && !props.detail ? (
            <p className="text-xs text-muted-foreground">Loading card…</p>
          ) : null}
          {props.loadError ? (
            <div role="alert" className="space-y-2 rounded-md bg-destructive/10 p-2 text-xs">
              <p>Could not load the card. Check the connection and try again.</p>
              <Button type="button" size="sm" variant="outline" onClick={props.onRetry}>
                Retry
              </Button>
            </div>
          ) : null}
          {!props.loading && !props.loadError && !props.detail ? (
            <p role="status" className="text-xs text-muted-foreground">
              Card unavailable: it may have been deleted.
            </p>
          ) : null}

          {card && props.detail ? (
            <>
              <p className="mb-2 text-xs text-muted-foreground">
                Orchestrator: {orchestratorThreadTitle ?? card.orchestratorThreadId}
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
                  Orchestrator chat
                </Button>
                {card.executorThreadId ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => props.onOpenThread(card.executorThreadId!)}
                  >
                    <MessageCircleIcon className="size-3.5" aria-hidden="true" />
                    Executor chat
                  </Button>
                ) : null}
                <BoardCardPlanButton
                  environmentId={props.environmentId}
                  cardId={card.cardId}
                  size="sm"
                />

                {isCardStartable(card) ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={props.busy}
                    onClick={() => props.onStart(card)}
                  >
                    <PlayIcon className="size-3.5" aria-hidden="true" />
                    Start
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
                  {card.archived ? "Unarchive" : "Archive"}
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
                  Request to orchestrator
                </label>
                <textarea
                  id={`board-request-${props.cardId}`}
                  className="min-h-16 w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={requestText}
                  onChange={(event) => setRequestText(event.currentTarget.value)}
                  placeholder="Describe what to check or clarify"
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  disabled={props.busy || !requestText.trim()}
                >
                  <SendIcon className="size-3.5" aria-hidden="true" />
                  Send
                </Button>
              </form>
              {props.actionError ? (
                <p role="status" className="mb-3 text-xs text-muted-foreground">
                  {props.actionError}
                </p>
              ) : null}
              <div className="border-t border-border pt-2">
                <h4 className="mb-1 text-xs font-semibold">History</h4>
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
                  <p className="text-xs text-muted-foreground">No history.</p>
                )}
              </div>
            </>
          ) : null}
        </>
      )}
    </article>
  );
}

/** Mounts the lead board panel next to the chat timeline; null without a server thread. */
export function useFt3BoardChatPanel(threadRef: ScopedThreadRef | null): ReactNode {
  if (threadRef === null) return null;
  return (
    <BoardChatSidePanel
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
    />
  );
}

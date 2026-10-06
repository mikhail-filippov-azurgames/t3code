import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { clearBoardCardMentionCache } from "@t3tools/client-runtime/board-card-mentions";
import {
  BoardCardId,
  type BoardCard,
  type BoardCardLookupDetail,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronDownIcon,
  MessageCircleIcon,
  PlayIcon,
  RotateCwIcon,
  SendIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { boardFailureText, boardExecutorRoleLabel, boardStatusLabel } from "../board/board.logic";
import { Button } from "../ui/button";
import { boardEnvironment } from "../../state/board";
import { readThreadShell } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import {
  boardCardPinsKey,
  readBoardCardPins,
  removeBoardCardPin,
  subscribeBoardCardPins,
} from "./boardCardPins";

interface BoardCardPinnedPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

function splitCardIds(cardIds: ReadonlyArray<string>, size: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < cardIds.length; index += size) {
    chunks.push(cardIds.slice(index, index + size));
  }
  return chunks;
}

export function BoardCardPinnedPanel({ environmentId, threadId }: BoardCardPinnedPanelProps) {
  const navigate = useNavigate();
  const key = boardCardPinsKey(environmentId, threadId);
  const [pins, setPins] = useState(() => readBoardCardPins(environmentId, threadId));
  const [details, setDetails] = useState<ReadonlyMap<string, BoardCardLookupDetail>>(new Map());
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busyCardId, setBusyCardId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const loadSequence = useRef(0);
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
    setActionError(null);
  }, [environmentId, threadId]);

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

  if (pins.length === 0) return null;
  if (collapsed) {
    return (
      <Button
        type="button"
        variant="outline"
        className="absolute left-2 top-2 z-30 shadow-lg"
        aria-label={`Развернуть закреплённые карточки: ${pins.length}`}
        onClick={() => setCollapsed(false)}
      >
        Карточки · {pins.length}
      </Button>
    );
  }

  return (
    <aside
      aria-label="Закреплённые карточки доски"
      className="absolute inset-y-2 left-2 z-30 flex w-[min(22rem,calc(100%-1rem))] flex-col overflow-hidden rounded-xl border border-border bg-background/98 shadow-xl backdrop-blur"
      data-board-card-panel="true"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold">Карточки доски</h2>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Свернуть закреплённые карточки"
            onClick={() => setCollapsed(true)}
          >
            <ChevronDownIcon className="size-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Повторить загрузку карточек"
            disabled={loading}
            onClick={() => void refresh()}
          >
            <RotateCwIcon className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
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
      <div className="mb-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="break-words text-sm font-semibold leading-snug">
            {card?.title ?? props.cardId}
          </h3>
          {card ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {boardStatusLabel(card.status)} · {boardExecutorRoleLabel(card.executorRole)}
            </p>
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
            {card.status === "todo" && !card.archived ? (
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
            <label className="block text-xs font-medium" htmlFor={`board-request-${props.cardId}`}>
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
    </article>
  );
}

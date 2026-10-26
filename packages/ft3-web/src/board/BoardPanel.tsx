import { RegistryContext } from "@effect/atom-react";
import type { SettledAsyncResult } from "@t3tools/client-runtime/state/runtime";
import type {
  BoardCard,
  BoardCardEvent,
  BoardCardId,
  BoardCardResolveResult,
} from "@t3tools/ft3-board/contracts";
import { ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { Archive, Pin, RefreshCw } from "lucide-react";
import { useContext, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useThreadShells } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import type { Ft3PanelProps } from "../panels.tsx";
import { boardEnvironment } from "./state.ts";
import { BoardCardDialog } from "./BoardCardDialog.tsx";
import { BoardCardDetailDialog } from "./BoardCardDetailDialog.tsx";
import { BoardCardPinnedPanel, useBoardCardPins } from "./BoardCardPinnedPanel.tsx";
import { addBoardCardPin } from "./boardCardPins.ts";
import {
  BOARD_COLUMNS,
  BOARD_EXECUTOR_ROLES,
  DEFAULT_BOARD_FILTERS,
  boardExecutorRoleLabel,
  boardFailureText,
  boardReadinessLabel,
  countBoardCardsByStatus,
  countOmittedArchivedByStatus,
  filterBoardCards,
  groupBoardCardsByStatus,
  isCardStartable,
  shouldShowBoardReadiness,
  type BoardFilters,
} from "./board.logic.ts";

const pinnedCardsQuery = Atom.family((key: string) => {
  const { environmentId, cardIds } = JSON.parse(key) as {
    environmentId: Ft3PanelProps["threadRef"]["environmentId"];
    cardIds: BoardCardId[];
  };
  const queries = Array.from({ length: Math.ceil(cardIds.length / 20) }, (_, index) =>
    boardEnvironment.resolve({
      environmentId,
      input: {
        tokens: [],
        cardIds: cardIds.slice(index * 20, (index + 1) * 20),
      },
    }),
  );
  return Atom.make((get) => {
    const results = queries.map((query) => get(query));
    const failure = results.find(AsyncResult.isFailure);
    if (failure) return failure;
    if (results.some((result) => !AsyncResult.isSuccess(result)))
      return AsyncResult.initial<BoardCardResolveResult>(true);
    return AsyncResult.success<BoardCardResolveResult>(
      {
        matches: [],
        details: results.flatMap((result) =>
          AsyncResult.isSuccess(result) ? result.value.details : [],
        ),
      },
      { waiting: results.some((result) => result.waiting) },
    );
  });
});

export default function BoardPanel({ threadRef, visible }: Ft3PanelProps) {
  const navigate = useNavigate();
  const registry = useContext(RegistryContext);
  const shells = useThreadShells().filter(
    (shell) => shell.environmentId === threadRef.environmentId,
  );
  const [filters, setFilters] = useState<BoardFilters>(DEFAULT_BOARD_FILTERS);
  const [coordinator, setCoordinator] = useState<string>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const pins = useBoardCardPins(threadRef);
  const list = useEnvironmentQuery(
    visible
      ? boardEnvironment.list({
          environmentId: threadRef.environmentId,
          input: filters.showArchived ? { includeArchived: true } : {},
        })
      : null,
  );
  const orchestrators = useEnvironmentQuery(
    visible
      ? boardEnvironment.orchestratorsList({ environmentId: threadRef.environmentId, input: {} })
      : null,
  );
  const pinned = useEnvironmentQuery(
    visible && pins.length > 0
      ? pinnedCardsQuery(JSON.stringify({ environmentId: threadRef.environmentId, cardIds: pins }))
      : null,
  );
  const create = useAtomCommand(boardEnvironment.create, { reportFailure: false });
  const start = useAtomCommand(boardEnvironment.start, { reportFailure: false });
  const update = useAtomCommand(boardEnvironment.update, { reportFailure: false });
  const addCoordinator = useAtomCommand(boardEnvironment.orchestratorAdd, { reportFailure: false });
  const removeCoordinator = useAtomCommand(boardEnvironment.orchestratorRemove, {
    reportFailure: false,
  });
  const resendBrief = useAtomCommand(boardEnvironment.resendBrief, { reportFailure: false });
  const request = useAtomCommand(boardEnvironment.requestOrchestrator, { reportFailure: false });
  const [confirmRemove, setConfirmRemove] = useState(false);

  const registered = orchestrators.data?.orchestrators ?? [];
  const currentRegistered = registered.some((entry) => entry.threadId === threadRef.threadId);
  const selectedRegistered = registered.some((entry) => entry.threadId === coordinator);
  const cards = list.data?.cards ?? [];
  const scopedCards = cards.filter(
    (card) => coordinator === "all" || card.orchestratorThreadId === coordinator,
  );
  const filteredCards = filterBoardCards(scopedCards, filters);
  const grouped = groupBoardCardsByStatus(filteredCards);
  const counts = countBoardCardsByStatus(filteredCards);
  const archivedCounts = countOmittedArchivedByStatus(
    list.data,
    coordinator === "all" ? null : ThreadId.make(coordinator),
  );
  const pinnedCards = pinned.data?.details.map((detail) => detail.card) ?? [];
  const selectedCard =
    cards.find((card) => card.cardId === selectedId) ??
    pinnedCards.find((card) => card.cardId === selectedId) ??
    null;
  const pinnedEvents = pinned.data?.details.flatMap((detail) => detail.events) ?? [];
  const events: readonly BoardCardEvent[] = [
    ...(list.data?.events ?? []),
    ...pinnedEvents.filter(
      (event) => !list.data?.events.some((entry) => entry.entryId === event.entryId),
    ),
  ];
  const title = (id: string) => shells.find((shell) => shell.id === id)?.title ?? id;

  const refreshPinned = () => {
    for (let index = 0; index < pins.length; index += 20) {
      registry.refresh(
        boardEnvironment.resolve({
          environmentId: threadRef.environmentId,
          input: { tokens: [], cardIds: pins.slice(index, index + 20) as BoardCardId[] },
        }),
      );
    }
  };
  const refresh = () => {
    list.refresh();
    orchestrators.refresh();
    refreshPinned();
  };

  const runAction = async (operation: () => Promise<SettledAsyncResult<unknown, unknown>>) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await operation();
      if (AsyncResult.isFailure(result)) setActionError(boardFailureText(result.cause));
      else refreshPinned();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The board request failed.");
    } finally {
      setBusy(false);
    }
  };

  const openExecutor = (card: BoardCard) => {
    if (card.executorThreadId)
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: threadRef.environmentId, threadId: card.executorThreadId },
      });
  };
  const requestCoordinator = (card: BoardCard, text: string) => {
    const shell = shells.find((entry) => entry.id === card.orchestratorThreadId);
    if (!shell) {
      setActionError("Coordinator chat unavailable. Reconnect and try again.");
      return;
    }
    void runAction(() =>
      request({
        environmentId: threadRef.environmentId,
        input: {
          threadId: card.orchestratorThreadId,
          text: `Card ${card.cardId} (${card.title}): ${text}`,
          modelSelection: shell.modelSelection,
          runtimeMode: shell.runtimeMode,
          interactionMode: shell.interactionMode,
        },
      }),
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto" aria-label="Board">
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <h2 className="mr-auto text-sm font-semibold">Board</h2>
        <Button variant="ghost" size="icon-xs" aria-label="Refresh board" onClick={refresh}>
          <RefreshCw />
        </Button>
        {!currentRegistered ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !orchestrators.isSuccess}
            onClick={() =>
              void runAction(() =>
                addCoordinator({
                  environmentId: threadRef.environmentId,
                  input: { threadId: threadRef.threadId },
                }),
              )
            }
          >
            Mark this thread as Coordinator
          </Button>
        ) : null}
        <Button
          size="xs"
          disabled={busy || !selectedRegistered}
          onClick={() => setCreateOpen(true)}
        >
          New task
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 p-3">
        <Select
          value={coordinator}
          onValueChange={(value) => {
            if (value !== null) {
              setCoordinator(value);
              setConfirmRemove(false);
            }
          }}
        >
          <SelectTrigger aria-label="Coordinator">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="all">All coordinators</SelectItem>
            {!currentRegistered ? (
              <SelectItem value={threadRef.threadId}>{title(threadRef.threadId)}</SelectItem>
            ) : null}
            {registered.map((entry) => (
              <SelectItem key={entry.threadId} value={entry.threadId}>
                {title(entry.threadId)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Input
          aria-label="Search cards"
          placeholder="Search cards"
          value={filters.search}
          onChange={(event) => setFilters({ ...filters, search: event.target.value })}
        />
        <Select
          value={filters.role ?? "all"}
          onValueChange={(value) =>
            setFilters({
              ...filters,
              role: value === "all" ? null : (value as BoardFilters["role"]),
            })
          }
        >
          <SelectTrigger aria-label="Executor role">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="all">All roles</SelectItem>
            {BOARD_EXECUTOR_ROLES.map((role) => (
              <SelectItem key={role} value={role}>
                {boardExecutorRoleLabel(role)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Select
          value={filters.readiness}
          onValueChange={(value) =>
            setFilters({ ...filters, readiness: value as BoardFilters["readiness"] })
          }
        >
          <SelectTrigger aria-label="Readiness">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="all">All readiness</SelectItem>
            <SelectItem value="needs_human">Needs human</SelectItem>
            <SelectItem value="blocked">Blocked</SelectItem>
          </SelectPopup>
        </Select>
        <Button
          size="xs"
          variant="outline"
          aria-pressed={filters.showArchived}
          onClick={() => setFilters({ ...filters, showArchived: !filters.showArchived })}
        >
          <Archive />
          {filters.showArchived ? "Hide archive" : "Show archive"}
        </Button>
        {selectedRegistered ? (
          <>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void runAction(() =>
                  resendBrief({
                    environmentId: threadRef.environmentId,
                    input: { threadId: ThreadId.make(coordinator) },
                  }),
                )
              }
            >
              Resend brief
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirmRemove(true)}
            >
              Remove Coordinator
            </Button>
          </>
        ) : null}
      </div>
      {confirmRemove ? (
        <div className="flex flex-wrap items-center gap-2 border-b p-3" role="alert">
          <p>Remove this Coordinator and its board cards?</p>
          <Button
            size="xs"
            variant="destructive"
            disabled={busy}
            onClick={() =>
              void runAction(async () => {
                const result = await removeCoordinator({
                  environmentId: threadRef.environmentId,
                  input: { threadId: ThreadId.make(coordinator) },
                });
                if (AsyncResult.isSuccess(result)) {
                  setCoordinator("all");
                  setConfirmRemove(false);
                }
                return result;
              })
            }
          >
            Confirm removal
          </Button>
          <Button size="xs" variant="outline" onClick={() => setConfirmRemove(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
      {actionError ? (
        <p role="alert" className="p-3 text-sm text-destructive">
          {actionError}
        </p>
      ) : null}
      {list.error || orchestrators.error ? (
        <div role="alert" className="p-3 text-sm text-destructive">
          {list.error ?? orchestrators.error}
          <Button size="xs" variant="outline" onClick={refresh}>
            Retry board
          </Button>
        </div>
      ) : null}
      {list.isPending && !list.data ? (
        <p role="status" className="p-3 text-sm text-muted-foreground">
          Loading board…
        </p>
      ) : null}
      <BoardCardPinnedPanel
        threadRef={threadRef}
        cardIds={pins}
        cards={pinnedCards}
        loading={pinned.isPending}
        error={pinned.error}
        onRetry={refreshPinned}
        onSelect={(card) => setSelectedId(card.cardId)}
      />
      <div className="grid flex-1 grid-cols-1 gap-3 p-3 sm:grid-cols-2">
        {BOARD_COLUMNS.map((column) => (
          <section
            key={column.status}
            aria-label={column.label}
            className="flex min-w-0 flex-col gap-2 rounded-lg border bg-muted/20 p-2"
          >
            <h3 className="flex items-center gap-2 text-sm font-medium">
              {column.label}
              <span>{counts[column.status]}</span>
              {archivedCounts[column.status] > 0 ? (
                <span className="text-xs text-muted-foreground">
                  {archivedCounts[column.status]} archived
                </span>
              ) : null}
            </h3>
            {(grouped.get(column.status) ?? []).map((card) => (
              <article
                key={card.cardId}
                className="flex flex-col gap-2 rounded-md border bg-card p-2"
              >
                <Button
                  size="sm-multiline"
                  variant="ghost"
                  onClick={() => setSelectedId(card.cardId)}
                >
                  {card.title}
                </Button>
                <p className="text-xs text-muted-foreground">
                  {boardExecutorRoleLabel(card.executorRole)}
                  {card.archived ? " · Archived" : ""}
                </p>
                {shouldShowBoardReadiness(card.readiness) ? (
                  <p className="text-xs text-warning-foreground">
                    {boardReadinessLabel(card.readiness)}
                    {card.readinessNote ? `: ${card.readinessNote}` : ""}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-1">
                  {isCardStartable(card) ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void runAction(() =>
                          start({
                            environmentId: threadRef.environmentId,
                            input: { cardId: card.cardId },
                          }),
                        )
                      }
                    >
                      Start
                    </Button>
                  ) : null}
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={`Pin ${card.title}`}
                    disabled={pins.includes(card.cardId)}
                    onClick={() =>
                      addBoardCardPin(threadRef.environmentId, threadRef.threadId, card.cardId)
                    }
                  >
                    <Pin />
                    Pin
                  </Button>
                </div>
              </article>
            ))}
            {(grouped.get(column.status)?.length ?? 0) === 0 ? (
              <p className="text-xs text-muted-foreground">No cards</p>
            ) : null}
          </section>
        ))}
      </div>
      {createOpen ? (
        <BoardCardDialog
          environmentId={threadRef.environmentId}
          onClose={() => setCreateOpen(false)}
          onCreate={async (input) => {
            const result = await create({
              environmentId: threadRef.environmentId,
              input: { ...input, orchestratorThreadId: ThreadId.make(coordinator) },
            });
            if (AsyncResult.isFailure(result)) throw new Error(boardFailureText(result.cause));
          }}
        />
      ) : null}
      {selectedCard ? (
        <BoardCardDetailDialog
          key={selectedCard.cardId}
          card={selectedCard}
          events={events}
          executorTitle={
            selectedCard.executorThreadId ? title(selectedCard.executorThreadId) : null
          }
          busy={busy}
          onClose={() => setSelectedId(null)}
          onStart={(card) =>
            void runAction(() =>
              start({ environmentId: threadRef.environmentId, input: { cardId: card.cardId } }),
            )
          }
          onToggleArchive={(card, archived) =>
            void runAction(() =>
              update({
                environmentId: threadRef.environmentId,
                input: { cardId: card.cardId, archived },
              }),
            )
          }
          onRequest={requestCoordinator}
          onOpenExecutor={openExecutor}
        />
      ) : null}
    </div>
  );
}

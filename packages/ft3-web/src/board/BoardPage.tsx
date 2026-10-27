import type { ThreadId } from "@t3tools/contracts";
import type {
  BoardCard,
  BoardListResult,
  ExecutorRole as BoardExecutorRole,
} from "@t3tools/ft3-board/contracts";
import { AsyncResult } from "effect/reactivity";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  CircleAlertIcon,
  OctagonAlertIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { readLocalApi } from "~/localApi";
import { isElectron } from "~/env";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useThreadShells } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { SidebarInset } from "~/components/ui/sidebar";
import { Switch } from "~/components/ui/switch";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { toastManager } from "~/components/ui/toast";
import { WorkspacePageContainer } from "~/components/WorkspacePageContainer";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { AddOrchestratorDialog } from "./AddOrchestratorDialog";
import { BoardCardDetailDialog } from "./BoardCardDetailDialog";
import { BoardCardDialog, type BoardCardDraft } from "./BoardCardDialog";
import {
  boardExecutorRoleLabel,
  boardFailureText,
  boardListEvents,
  boardReadinessLabel,
  countArchivedBoardCardsByStatus,
  countBoardCardsByStatus,
  countNeedsHumanCards,
  addBoardStatusCounts,
  countOmittedArchivedByStatus,
  sumBoardStatusCounts,
  BOARD_COLUMNS,
  BOARD_EXECUTOR_ROLES,
  DEFAULT_BOARD_FILTERS,
  filterBoardCards,
  groupBoardCardsByStatus,
  isCardStartable,
  shouldShowBoardReadiness,
  type BoardFilters,
} from "./board.logic";
import { useSkipOrchestratorUnmarkConfirmation } from "./boardPreferences";
import { boardEnvironment, useBoardOrchestratorThreadKeys } from "./useBoardBackend";
import { BoardRoleIcon } from "./boardRoleIcons";

export interface BoardPageProps {
  readonly initialOrchestratorId: ThreadId | null;
  readonly createOnMount: boolean;
}

export function BoardPage({ initialOrchestratorId, createOnMount }: BoardPageProps) {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const [skipUnmarkConfirm] = useSkipOrchestratorUnmarkConfirmation();

  const orchestratorsQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : boardEnvironment.orchestratorsList({ environmentId, input: {} }),
  );
  const [filters, setFilters] = useState<BoardFilters>(DEFAULT_BOARD_FILTERS);
  // The archive is read only while it is shown; otherwise the server sends counts.
  const listQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : boardEnvironment.list({
          environmentId,
          input: filters.showArchived ? { includeArchived: true } : {},
        }),
  );
  // Switching the archive view changes the query; keep the last board up while the other loads.
  const [retainedList, setRetainedList] = useState<BoardListResult | null>(null);
  if (listQuery.data !== null && listQuery.data !== retainedList) setRetainedList(listQuery.data);
  const listData = listQuery.data ?? retainedList;

  const orchestratorThreadKeys = useBoardOrchestratorThreadKeys();
  const shells = useThreadShells();
  const shellByThreadKey = useMemo(() => {
    const map = new Map<string, (typeof shells)[number]>();
    for (const shell of shells) {
      map.set(`${shell.environmentId}:${shell.id}`, shell);
    }
    return map;
  }, [shells]);

  const orchestrators = orchestratorsQuery.data?.orchestrators ?? [];
  const cards = listData?.cards ?? [];
  const events = boardListEvents(listData);

  const [selectedOrchestratorId, setSelectedOrchestratorId] = useState<ThreadId | null>(
    initialOrchestratorId,
  );
  const [addOpen, setAddOpen] = useState(false);
  const [createCardOpen, setCreateCardOpen] = useState(
    createOnMount && initialOrchestratorId !== null,
  );
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const createCard = useAtomCommand(boardEnvironment.create, { reportFailure: false });
  const startCard = useAtomCommand(boardEnvironment.start, { reportFailure: false });
  const updateCard = useAtomCommand(boardEnvironment.update, { reportFailure: false });
  const removeOrchestrator = useAtomCommand(boardEnvironment.orchestratorRemove, {
    reportFailure: false,
  });
  const resendBrief = useAtomCommand(boardEnvironment.resendBrief, { reportFailure: false });
  const requestOrchestrator = useAtomCommand(boardEnvironment.requestOrchestrator, {
    reportFailure: false,
  });

  const selectedOrchestratorTitle =
    selectedOrchestratorId === null
      ? null
      : (shellByThreadKey.get(`${environmentId}:${selectedOrchestratorId}`)?.title ?? null);

  const scopedCards = useMemo(
    () =>
      selectedOrchestratorId === null
        ? cards
        : cards.filter((card) => card.orchestratorThreadId === selectedOrchestratorId),
    [cards, selectedOrchestratorId],
  );
  const needsHumanCount = countNeedsHumanCards(scopedCards);
  const visibleCards = useMemo(
    () => filterBoardCards(scopedCards, filters),
    [filters, scopedCards],
  );

  const grouped = useMemo(() => groupBoardCardsByStatus(visibleCards), [visibleCards]);
  // Headlines count the same visible array the columns render, so each
  // headline equals its column list length. The archive is broken out
  // separately (matching every filter except the archive toggle itself), so
  // headline + badge reconstruct the show-archived totals with no double
  // counting and the headline stays consistent with `board_list_cards`,
  // which excludes archived cards by default.
  const statusCounts = useMemo(() => countBoardCardsByStatus(visibleCards), [visibleCards]);
  const archiveMatchable = useMemo(
    () => filterBoardCards(scopedCards, { ...filters, showArchived: true }),
    [filters, scopedCards],
  );
  const archivedCounts = useMemo(
    () =>
      addBoardStatusCounts(
        countArchivedBoardCardsByStatus(archiveMatchable),
        countOmittedArchivedByStatus(listData, selectedOrchestratorId),
      ),
    [archiveMatchable, listData, selectedOrchestratorId],
  );
  const selectedCard = cards.find((card) => card.cardId === selectedCardId) ?? null;

  const environmentLabel = (threadId: ThreadId): string =>
    shellByThreadKey.get(`${environmentId}:${threadId}`)?.title ?? threadId;

  const refresh = () => {
    orchestratorsQuery.refresh();
    listQuery.refresh();
  };

  const handleCreate = async (input: BoardCardDraft) => {
    if (environmentId === null || selectedOrchestratorId === null) {
      throw new Error("Choose a Coordinator before creating a task.");
    }
    const result = await createCard({
      environmentId,
      input: { ...input, orchestratorThreadId: selectedOrchestratorId },
    });
    if (AsyncResult.isSuccess(result)) return;
    throw new Error(boardFailureText(result.cause));
  };

  const handleStart = async (card: BoardCard) => {
    if (environmentId === null) return;
    setBusy(true);
    const result = await startCard({ environmentId, input: { cardId: card.cardId } });
    setBusy(false);
    if (AsyncResult.isSuccess(result)) return;
    toastManager.add({
      type: "error",
      title: "Could not start the task",
      description: boardFailureText(result.cause),
    });
  };

  const handleToggleArchive = async (card: BoardCard, archived: boolean) => {
    if (environmentId === null) return;
    setBusy(true);
    const result = await updateCard({ environmentId, input: { cardId: card.cardId, archived } });
    setBusy(false);
    if (AsyncResult.isSuccess(result)) return;
    toastManager.add({
      type: "error",
      title: archived ? "Could not archive the task" : "Could not unarchive the task",
      description: boardFailureText(result.cause),
    });
  };

  const handleRequest = async (card: BoardCard, text: string) => {
    if (environmentId === null) return;
    const orchestratorShell = shellByThreadKey.get(`${environmentId}:${card.orchestratorThreadId}`);
    if (orchestratorShell === undefined) {
      toastManager.add({
        type: "error",
        title: "Coordinator chat unavailable",
        description: "Reconnect the environment and try again.",
      });
      return;
    }
    setBusy(true);
    const result = await requestOrchestrator({
      environmentId,
      input: {
        threadId: card.orchestratorThreadId,
        text,
        modelSelection: orchestratorShell.modelSelection,
        runtimeMode: orchestratorShell.runtimeMode,
        interactionMode: orchestratorShell.interactionMode,
      },
    });
    setBusy(false);
    if (AsyncResult.isSuccess(result)) {
      toastManager.add({
        type: "success",
        title: "Request sent to the Coordinator",
        description: "The Coordinator will see the request in its thread.",
      });
      return;
    }
    toastManager.add({
      type: "error",
      title: "Could not send the request",
      description: boardFailureText(result.cause),
    });
  };

  const handleOpenExecutor = (card: BoardCard) => {
    if (environmentId === null || card.executorThreadId === null) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: card.executorThreadId },
    });
  };

  const handleRemoveOrchestrator = async (threadId: ThreadId) => {
    if (environmentId === null) return;
    if (!skipUnmarkConfirm) {
      const confirmed = await readLocalApi()?.dialogs.confirm(
        "Remove this Coordinator? Its cards and delegated chats are deleted.",
        { variant: "destructive" },
      );
      if (!confirmed) return;
    }
    setBusy(true);
    const result = await removeOrchestrator({ environmentId, input: { threadId } });
    setBusy(false);
    if (AsyncResult.isSuccess(result)) {
      if (selectedOrchestratorId === threadId) setSelectedOrchestratorId(null);
      return;
    }
    toastManager.add({
      type: "error",
      title: "Could not remove the Coordinator",
      description: boardFailureText(result.cause),
    });
  };

  const drillDown = (threadId: ThreadId) => {
    setSelectedOrchestratorId(threadId);
    setSelectedCardId(null);
  };

  const handleResendBrief = async (threadId: ThreadId) => {
    if (environmentId === null) return;
    setBusy(true);
    const result = await resendBrief({ environmentId, input: { threadId } });
    setBusy(false);
    if (AsyncResult.isSuccess(result)) {
      toastManager.add({
        type: "success",
        title: "Coordinator brief resent",
        description: "The Coordinator will see it in its thread.",
      });
      return;
    }
    toastManager.add({
      type: "error",
      title: "Could not resend the Coordinator brief",
      description: boardFailureText(result.cause),
    });
  };

  const isLive =
    orchestratorsQuery.isSuccess &&
    (listQuery.isSuccess || (listQuery.isPending && listData !== null));

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto! min-h-0! max-h-none!">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {selectedOrchestratorId !== null ? (
              <>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Back to all coordinators"
                  onClick={() => {
                    setSelectedOrchestratorId(null);
                    setSelectedCardId(null);
                  }}
                >
                  <ArrowLeftIcon />
                </Button>
                <h1 className="truncate text-sm font-medium">
                  {selectedOrchestratorTitle ?? environmentLabel(selectedOrchestratorId)}
                </h1>
              </>
            ) : (
              <h1 className="text-sm font-medium text-foreground">Board</h1>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1">
            <Button size="icon-sm" variant="ghost" aria-label="Refresh" onClick={refresh}>
              <RefreshCwIcon />
            </Button>
            {selectedOrchestratorId === null ? (
              <Button size="sm" disabled={environmentId === null} onClick={() => setAddOpen(true)}>
                <PlusIcon />
                Add Coordinator
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void handleRemoveOrchestrator(selectedOrchestratorId)}
                >
                  Remove Coordinator
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void handleResendBrief(selectedOrchestratorId)}
                >
                  Resend Coordinator brief
                </Button>
                <Button size="sm" onClick={() => setCreateCardOpen(true)}>
                  <PlusIcon />
                  Create task
                </Button>
              </>
            )}
            {needsHumanCount > 0 ? (
              <Button
                size="sm"
                variant={filters.readiness === "needs_human" ? "destructive" : "outline"}
                aria-label={`Filter to ${needsHumanCount} cards needing human attention`}
                onClick={() => setFilters((current) => ({ ...current, readiness: "needs_human" }))}
              >
                <CircleAlertIcon aria-hidden="true" />
                Needs human
                <Badge variant="outline" size="sm" className="tabular-nums">
                  {needsHumanCount}
                </Badge>
              </Button>
            ) : null}
          </div>
        </WorkspacePageHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <WorkspacePageContainer width="expanded">
            {environmentId === null ? (
              <p className="rounded-lg border border-warning/32 bg-warning-surface px-3 py-2 text-xs text-warning-foreground">
                No environment is connected.
              </p>
            ) : !isLive ? (
              <p className="rounded-lg border border-warning/32 bg-warning-surface px-3 py-2 text-xs text-warning-foreground">
                {`Board server unavailable: ${orchestratorsQuery.error ?? listQuery.error ?? "connecting…"}`}
              </p>
            ) : null}

            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Input
                nativeInput
                aria-label="Filter tasks"
                className="max-w-60"
                placeholder="Filter tasks"
                value={filters.search}
                onChange={(event) =>
                  setFilters((current) => ({ ...current, search: event.target.value }))
                }
              />
              <Select
                value={filters.readiness}
                onValueChange={(value) =>
                  setFilters((current) => ({
                    ...current,
                    readiness: value as BoardFilters["readiness"],
                  }))
                }
              >
                <SelectTrigger aria-label="Filter by readiness" className="w-44">
                  <SelectValue>
                    {filters.readiness === "all"
                      ? "All readiness"
                      : filters.readiness === "needs_human"
                        ? "Needs human"
                        : "Blocked"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  <SelectItem value="all">All readiness</SelectItem>
                  <SelectItem value="needs_human">Needs human</SelectItem>
                  <SelectItem value="blocked">Blocked</SelectItem>
                </SelectPopup>
              </Select>
              <Select
                value={filters.role ?? "all"}
                onValueChange={(value) =>
                  setFilters((current) => ({
                    ...current,
                    role: value === "all" ? null : (value as BoardExecutorRole),
                  }))
                }
              >
                <SelectTrigger aria-label="Filter by executor role" className="w-40">
                  <SelectValue>
                    {filters.role === null ? "All roles" : boardExecutorRoleLabel(filters.role)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  <SelectItem value="all">All roles</SelectItem>
                  {BOARD_EXECUTOR_ROLES.map((role) => (
                    <SelectItem key={role} value={role}>
                      {boardExecutorRoleLabel(role)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Switch
                  checked={filters.showArchived}
                  onCheckedChange={(checked) =>
                    setFilters((current) => ({ ...current, showArchived: Boolean(checked) }))
                  }
                  aria-label="Show archived tasks"
                />
                Show archived
              </label>
            </div>

            {selectedOrchestratorId === null && orchestrators.length > 0 ? (
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {orchestrators.map((orchestrator) => {
                  const orchestratorCards = cards.filter(
                    (card) => card.orchestratorThreadId === orchestrator.threadId,
                  );
                  // The headline counts what the drilled-down board shows by
                  // default (archived hidden); archived tasks get their own
                  // number with an archive icon instead of inflating it.
                  const activeCount = orchestratorCards.filter((card) => !card.archived).length;
                  const archivedCount =
                    orchestratorCards.length -
                    activeCount +
                    sumBoardStatusCounts(
                      countOmittedArchivedByStatus(listData, orchestrator.threadId),
                    );
                  return (
                    <button
                      key={orchestrator.threadId}
                      type="button"
                      className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-left hover:bg-accent/40"
                      onClick={() => drillDown(orchestrator.threadId)}
                    >
                      <span className="max-w-60 truncate text-xs font-medium">
                        {environmentLabel(orchestrator.threadId)}
                      </span>
                      <span className="text-[11px] text-muted-foreground tabular-nums">
                        {activeCount === 1 ? "1 task" : `${activeCount} tasks`}
                      </span>
                      {archivedCount > 0 ? (
                        <span
                          className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground tabular-nums"
                          title={`${archivedCount} archived`}
                        >
                          <ArchiveIcon className="size-3" aria-hidden="true" />
                          {archivedCount}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}

            {selectedOrchestratorId === null && orchestrators.length === 0 && isLive ? (
              <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-16 text-center">
                <p className="text-sm text-muted-foreground">
                  No coordinators yet. Mark a chat as a Coordinator to start planning tasks.
                </p>
                <Button size="sm" onClick={() => setAddOpen(true)}>
                  <PlusIcon />
                  Add Coordinator
                </Button>
              </div>
            ) : (
              <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-6">
                {BOARD_COLUMNS.map((column) => (
                  <BoardColumn
                    key={column.status}
                    label={column.label}
                    cards={grouped.get(column.status) ?? []}
                    count={statusCounts[column.status]}
                    archivedCount={archivedCounts[column.status]}
                    onSelectCard={(card) => setSelectedCardId(card.cardId)}
                  />
                ))}
              </div>
            )}
          </WorkspacePageContainer>
        </div>
      </div>

      {addOpen && environmentId !== null ? (
        <AddOrchestratorDialog
          environmentId={environmentId}
          orchestratorThreadIds={orchestratorThreadKeys}
          onClose={() => setAddOpen(false)}
          onAdded={(threadId) => drillDown(threadId)}
        />
      ) : null}

      {createCardOpen && environmentId !== null && selectedOrchestratorId !== null ? (
        <BoardCardDialog
          environmentId={environmentId}
          onClose={() => setCreateCardOpen(false)}
          onCreate={handleCreate}
        />
      ) : null}

      {selectedCard !== null ? (
        <BoardCardDetailDialog
          card={selectedCard}
          events={events}
          executorTitle={
            selectedCard.executorThreadId === null
              ? null
              : (shellByThreadKey.get(`${environmentId}:${selectedCard.executorThreadId}`)?.title ??
                null)
          }
          busy={busy}
          onClose={() => setSelectedCardId(null)}
          onStart={(card) => void handleStart(card)}
          onToggleArchive={(card, archived) => void handleToggleArchive(card, archived)}
          onRequest={(card, text) => void handleRequest(card, text)}
          onOpenExecutor={handleOpenExecutor}
        />
      ) : null}
    </SidebarInset>
  );
}

function BoardColumn({
  label,
  cards,
  count,
  archivedCount,
  onSelectCard,
}: {
  readonly label: string;
  readonly cards: ReadonlyArray<BoardCard>;
  /** Headline: counts the same visible cards rendered below. */
  readonly count: number;
  /** Separate archive number with an icon; never mixed into the headline. */
  readonly archivedCount: number;
  readonly onSelectCard: (card: BoardCard) => void;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card/40 p-2">
      <h2 className="flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">
        <span>{label}</span>
        <span className="inline-flex items-center gap-1.5 tabular-nums">
          <span>{count}</span>
          {archivedCount > 0 ? (
            <span
              className="inline-flex items-center gap-0.5 text-muted-foreground/70"
              title={`${archivedCount} archived`}
            >
              <ArchiveIcon className="size-3" aria-hidden="true" />
              {archivedCount}
            </span>
          ) : null}
        </span>
      </h2>
      <div className="flex min-w-0 flex-col gap-1.5">
        {cards.map((card) => (
          <button
            key={card.cardId}
            type="button"
            className="flex min-w-0 flex-col gap-1 rounded-md border border-border bg-card px-2.5 py-2 text-left hover:bg-accent/40"
            onClick={() => onSelectCard(card)}
          >
            <span className="truncate text-xs font-medium">{card.title}</span>
            <span className="flex min-w-0 flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <BoardRoleIcon role={card.executorRole} />
                {boardExecutorRoleLabel(card.executorRole)}
              </span>
              {card.assignee !== null ? <span>· {card.assignee.model}</span> : null}
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              {shouldShowBoardReadiness(card.readiness) ? (
                <Badge
                  variant={card.readiness === "needs_human" ? "destructive" : "outline"}
                  size="sm"
                >
                  {card.readiness === "needs_human" ? (
                    <CircleAlertIcon aria-hidden="true" className="size-3" />
                  ) : (
                    <OctagonAlertIcon aria-hidden="true" className="size-3" />
                  )}
                  {boardReadinessLabel(card.readiness)}
                </Badge>
              ) : null}
              {card.failureStreak >= 3 ? (
                <Badge variant="destructive" size="sm">
                  needs human
                </Badge>
              ) : null}
              {card.archived ? (
                <Badge variant="outline" size="sm">
                  archived
                </Badge>
              ) : null}
              {isCardStartable(card) ? (
                <Badge variant="secondary" size="sm">
                  ready
                </Badge>
              ) : null}
              {shouldShowBoardReadiness(card.readiness) && card.readinessNote !== null ? (
                <span className="w-full whitespace-pre-line line-clamp-3 break-words text-[10px] text-muted-foreground">
                  {card.readinessNote}
                </span>
              ) : null}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

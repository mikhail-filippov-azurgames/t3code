/**
 * Orchestrator board page.
 *
 * Two modes (design §6): "all orchestrators" shows every card plus an Add
 * orchestrator action; drilling into one shows its five columns plus a Create
 * task action. The page is read-only for started cards — the human starts a
 * `todo` card and otherwise asks the orchestrator (design §5).
 *
 * @module components/board/BoardPage
 */
import type { BoardCard, BoardExecutorRole, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { ArrowLeftIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { readLocalApi } from "../../localApi";
import { isElectron } from "../../env";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useThreadShells } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { SidebarInset } from "../ui/sidebar";
import { Switch } from "../ui/switch";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { AddOrchestratorDialog } from "./AddOrchestratorDialog";
import { BoardCardDetailDialog } from "./BoardCardDetailDialog";
import { BoardCardDialog, type BoardCardDraft } from "./BoardCardDialog";
import {
  boardExecutorRoleLabel,
  boardFailureText,
  boardListEvents,
  BOARD_COLUMNS,
  BOARD_EXECUTOR_ROLES,
  DEFAULT_BOARD_FILTERS,
  filterBoardCards,
  groupBoardCardsByStatus,
  isCardStartable,
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
  const listQuery = useEnvironmentQuery(
    environmentId === null ? null : boardEnvironment.list({ environmentId, input: {} }),
  );

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
  const cards = listQuery.data?.cards ?? [];
  const events = boardListEvents(listQuery.data);

  const [selectedOrchestratorId, setSelectedOrchestratorId] = useState<ThreadId | null>(
    initialOrchestratorId,
  );
  const [addOpen, setAddOpen] = useState(false);
  const [createCardOpen, setCreateCardOpen] = useState(
    createOnMount && initialOrchestratorId !== null,
  );
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [filters, setFilters] = useState<BoardFilters>(DEFAULT_BOARD_FILTERS);
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

  const visibleCards = useMemo(() => {
    const scoped =
      selectedOrchestratorId === null
        ? cards
        : cards.filter((card) => card.orchestratorThreadId === selectedOrchestratorId);
    return filterBoardCards(scoped, filters);
  }, [cards, filters, selectedOrchestratorId]);

  const grouped = useMemo(() => groupBoardCardsByStatus(visibleCards), [visibleCards]);
  const selectedCard = cards.find((card) => card.cardId === selectedCardId) ?? null;

  const environmentLabel = (threadId: ThreadId): string =>
    shellByThreadKey.get(`${environmentId}:${threadId}`)?.title ?? threadId;

  const refresh = () => {
    orchestratorsQuery.refresh();
    listQuery.refresh();
  };

  const handleCreate = async (input: BoardCardDraft) => {
    if (environmentId === null || selectedOrchestratorId === null) {
      throw new Error("Choose an orchestrator before creating a task.");
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
        title: "Orchestrator chat unavailable",
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
        title: "Request sent to the orchestrator",
        description: "It will see the request in its thread.",
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
        "Unmark this orchestrator? Its cards and delegated chats are deleted.",
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
      title: "Could not unmark the orchestrator",
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
        title: "Brief resent",
        description: "The orchestrator will see it in its thread.",
      });
      return;
    }
    toastManager.add({
      type: "error",
      title: "Could not resend the brief",
      description: boardFailureText(result.cause),
    });
  };

  const isLive = orchestratorsQuery.isSuccess && listQuery.isSuccess;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {selectedOrchestratorId !== null ? (
              <>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Back to all orchestrators"
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
          <div className="flex shrink-0 items-center gap-1">
            <Button size="icon-sm" variant="ghost" aria-label="Refresh" onClick={refresh}>
              <RefreshCwIcon />
            </Button>
            {selectedOrchestratorId === null ? (
              <Button size="sm" disabled={environmentId === null} onClick={() => setAddOpen(true)}>
                <PlusIcon />
                Add orchestrator
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void handleRemoveOrchestrator(selectedOrchestratorId)}
                >
                  Unmark
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void handleResendBrief(selectedOrchestratorId)}
                >
                  Resend brief
                </Button>
                <Button size="sm" onClick={() => setCreateCardOpen(true)}>
                  <PlusIcon />
                  Create task
                </Button>
              </>
            )}
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
                  const cardCount = cards.filter(
                    (card) => card.orchestratorThreadId === orchestrator.threadId,
                  ).length;
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
                        {cardCount === 1 ? "1 task" : `${cardCount} tasks`}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}

            {selectedOrchestratorId === null && orchestrators.length === 0 && isLive ? (
              <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-16 text-center">
                <p className="text-sm text-muted-foreground">
                  No orchestrators yet. Mark a chat as an orchestrator to start planning tasks.
                </p>
                <Button size="sm" onClick={() => setAddOpen(true)}>
                  <PlusIcon />
                  Add orchestrator
                </Button>
              </div>
            ) : (
              <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-5">
                {BOARD_COLUMNS.map((column) => (
                  <BoardColumn
                    key={column.status}
                    label={column.label}
                    cards={grouped.get(column.status) ?? []}
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
  onSelectCard,
}: {
  readonly label: string;
  readonly cards: ReadonlyArray<BoardCard>;
  readonly onSelectCard: (card: BoardCard) => void;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card/40 p-2">
      <h2 className="flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">{cards.length}</span>
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
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

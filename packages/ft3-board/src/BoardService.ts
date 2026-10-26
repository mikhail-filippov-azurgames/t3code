import { CommandId, MessageId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../../../apps/server/src/mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import * as BoardRepository from "./BoardRepository.ts";
import * as Contracts from "./contracts.ts";
import { buildBoardWakePrompt } from "./boardWakePrompt.ts";
import { routingPolicyRef } from "./routingPolicy.ts";

type Scope = McpInvocationContext.McpInvocationScope;
export class BoardService extends Context.Service<
  BoardService,
  {
    readonly create: (
      scope: Scope,
      input: Contracts.BoardCreateCardInput,
    ) => Effect.Effect<Contracts.BoardCard, Contracts.BoardMcpFailure>;
    readonly list: (
      scope: Scope,
      input: Contracts.BoardListCardsInput,
    ) => Effect.Effect<Contracts.BoardListCardsResult, Contracts.BoardMcpFailure>;
    readonly update: (
      scope: Scope,
      input: Contracts.BoardUpdateCardInput,
    ) => Effect.Effect<Contracts.BoardCard, Contracts.BoardMcpFailure>;
    readonly delete: (
      scope: Scope,
      input: Contracts.BoardDeleteCardInput,
    ) => Effect.Effect<{}, Contracts.BoardMcpFailure>;
    readonly listOrchestrators: () => Effect.Effect<
      Contracts.BoardOrchestratorsListResult,
      Contracts.BoardMcpFailure
    >;
    readonly markOrchestrator: (
      input: Contracts.BoardOrchestratorAddInput,
    ) => Effect.Effect<Contracts.BoardOrchestrator, Contracts.BoardMcpFailure>;
    readonly unmarkOrchestrator: (
      input: Contracts.BoardOrchestratorRemoveInput,
    ) => Effect.Effect<Contracts.BoardOrchestratorRemoveResult, Contracts.BoardMcpFailure>;
    readonly resendBrief: (
      input: Contracts.BoardOrchestratorResendBriefInput,
    ) => Effect.Effect<Contracts.BoardOrchestratorResendBriefResult, Contracts.BoardMcpFailure>;
    readonly listBoard: (
      input: Contracts.BoardListInput,
    ) => Effect.Effect<Contracts.BoardListResult, Contracts.BoardMcpFailure>;
    readonly resolveCards: (
      input: Contracts.BoardCardResolveInput,
    ) => Effect.Effect<Contracts.BoardCardResolveResult, Contracts.BoardMcpFailure>;
    readonly createHumanCard: (
      input: Contracts.BoardCreateInput,
    ) => Effect.Effect<Contracts.BoardCard, Contracts.BoardMcpFailure>;
    readonly startCard: (
      input: Contracts.BoardStartInput,
    ) => Effect.Effect<Contracts.BoardCard, Contracts.BoardMcpFailure>;
    readonly updateHumanCard: (
      input: Contracts.BoardUpdateInput,
    ) => Effect.Effect<Contracts.BoardCard, Contracts.BoardMcpFailure>;
    readonly deleteHumanCard: (
      input: Contracts.BoardDeleteInput,
    ) => Effect.Effect<Contracts.BoardDeleteResult, Contracts.BoardMcpFailure>;
  }
>()("@t3tools/ft3-board/BoardService") {}

const unavailable = () =>
  new Contracts.BoardMcpFailure({
    code: "orchestration_error",
    message: "The board operation could not be completed.",
  });
const repositoryFailure = (
  error: BoardRepository.BoardRepositoryError | Contracts.BoardMcpFailure,
) => (error._tag === "OrchestratorMcpFailure" ? error : unavailable());
const notFound = () =>
  new Contracts.BoardMcpFailure({
    code: "task_not_found",
    message: "The board card was not found.",
  });
const encodeList = Schema.encodeSync(Schema.fromJsonString(Contracts.BoardListCardsResult));

function buildEvent(
  card: Contracts.BoardCard,
  at: string,
  entryId: string,
  body?: string,
): Contracts.BoardCardEvent {
  const option = (id: string) => {
    const value = card.assignee?.options?.find((selection) => selection.id === id)?.value;
    return typeof value === "string" ? value : undefined;
  };
  return {
    entryId: Contracts.BoardCardEventId.make(entryId),
    cardId: card.cardId,
    at,
    status: card.status,
    executorRole: card.executorRole,
    model: card.assignee?.model ?? null,
    effort: option("effort") ?? option("reasoningEffort") ?? null,
    source: "system",
    ...(body === undefined ? {} : { body }),
  };
}

const make = Effect.gen(function* () {
  const repo = yield* BoardRepository.BoardRepository;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const crypto = yield* Crypto.Crypto;
  const routingPolicyRefValue = yield* routingPolicyRef;
  const event = Effect.fn("Ft3BoardService.event")(function* (
    card: Contracts.BoardCard,
    at: string,
    body?: string,
  ) {
    return buildEvent(
      card,
      at,
      yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable)),
      body,
    );
  });

  const requireOrchestrator = Effect.fn("Ft3BoardService.requireOrchestrator")(function* (
    scope: Scope,
    writing: boolean,
  ) {
    if (
      !scope.capabilities.has("orchestration") ||
      (writing && scope.client?.access === "read-only")
    ) {
      return yield* new Contracts.BoardMcpFailure({
        code: "capability_denied",
        message: "This credential cannot access the board for this operation.",
      });
    }
    const caller = yield* McpInvocationContext.requireThreadScope(scope, "Board tools");
    const threadId = caller.thread.threadId;
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
    if (shell === null || shell.deletedAt !== null) {
      return yield* new Contracts.BoardMcpFailure({
        code: "thread_not_found",
        message: "The calling thread was not found.",
      });
    }
    if (String(threadId).startsWith("arch:")) {
      return yield* new Contracts.BoardMcpFailure({
        code: "architect_denied",
        message: "Architect threads cannot own or read boards.",
      });
    }
    if (shell.lineage.relationshipToParent === "subagent") {
      return yield* new Contracts.BoardMcpFailure({
        code: "delegated_executor_denied",
        message: "Delegated executor threads cannot own or read boards.",
      });
    }
    const orchestrators = yield* repo.listOrchestrators().pipe(Effect.mapError(unavailable));
    if (!orchestrators.some((mark) => mark.threadId === threadId && mark.createdBy === "human")) {
      return yield* new Contracts.BoardMcpFailure({
        code: "capability_denied",
        message:
          "This thread is not a registered board orchestrator. Ask a human to mark this thread as a board orchestrator, then retry this tool; restarting the session is unnecessary.",
      });
    }
    return threadId;
  });

  const requireOwnedCard = Effect.fn("Ft3BoardService.requireOwnedCard")(function* (
    threadId: ThreadId,
    cardId: string,
  ) {
    const card = yield* repo
      .getCard(Contracts.BoardCardId.make(cardId))
      .pipe(Effect.mapError(unavailable));
    return card === null || card.orchestratorThreadId !== threadId ? yield* notFound() : card;
  });

  const requireMarkableThread = Effect.fn("Ft3BoardService.requireMarkableThread")(function* (
    threadId: ThreadId,
  ) {
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
    if (shell === null || shell.deletedAt !== null) {
      return yield* new Contracts.BoardMcpFailure({
        code: "thread_not_found",
        message: `Thread ${threadId} was not found.`,
      });
    }
    if (String(threadId).startsWith("arch:")) {
      return yield* new Contracts.BoardMcpFailure({
        code: "architect_denied",
        message: "Architect threads cannot be board Coordinators.",
      });
    }
    if (shell.lineage.relationshipToParent === "subagent") {
      return yield* new Contracts.BoardMcpFailure({
        code: "delegated_executor_denied",
        message: "Delegated child threads cannot be board Coordinators.",
      });
    }
  });

  const wakeOrchestrator = Effect.fn("Ft3BoardService.wakeOrchestrator")(function* (
    threadId: ThreadId,
    key: string,
    context: string,
  ) {
    yield* threads
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(key),
        threadId,
        messageId: MessageId.make(key),
        text: buildBoardWakePrompt(routingPolicyRefValue, "", context),
        attachments: [],
        createdBy: "agent",
        creationSource: "server",
        dispatchMode: { type: "start_immediately" },
      })
      .pipe(Effect.mapError(unavailable));
  });

  return BoardService.of({
    create: Effect.fn("Ft3BoardService.create")(function* (scope, input) {
      const threadId = yield* requireOrchestrator(scope, true);
      const at = DateTime.formatIso(yield* DateTime.now);
      const card: Contracts.BoardCard = {
        cardId: Contracts.BoardCardId.make(
          yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable)),
        ),
        orchestratorThreadId: threadId,
        title: input.title,
        body: input.body,
        status: input.status ?? "orchestrator",
        createdBy: "orchestrator",
        assignee: input.assignee ?? null,
        executorRole: input.executorRole,
        executorThreadId: null,
        outcome: null,
        lastError: null,
        readiness: "ready",
        readinessNote: null,
        failureStreak: 0,
        order: 0,
        archived: false,
        createdAt: at,
        updatedAt: at,
      };
      yield* repo
        .createCard(card, [yield* event(card, at)])
        .pipe(Effect.mapError(repositoryFailure));
      return card;
    }),
    update: Effect.fn("Ft3BoardService.update")(function* (scope, input) {
      const threadId = yield* requireOrchestrator(scope, true);
      const card = yield* requireOwnedCard(threadId, input.cardId);
      if (input.executorThreadId != null && String(input.executorThreadId).startsWith("arch:")) {
        return yield* new Contracts.BoardMcpFailure({
          code: "architect_denied",
          message: "Architect threads cannot be board executors.",
        });
      }
      const at = DateTime.formatIso(yield* DateTime.now);
      const readiness = input.readiness ?? card.readiness;
      const next: Contracts.BoardCard = {
        ...card,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.executorRole === undefined ? {} : { executorRole: input.executorRole }),
        ...(input.assignee === undefined ? {} : { assignee: input.assignee }),
        ...(input.executorThreadId === undefined
          ? {}
          : { executorThreadId: input.executorThreadId }),
        ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
        ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
        ...(input.failureStreak === undefined ? {} : { failureStreak: input.failureStreak }),
        ...(input.order === undefined ? {} : { order: input.order }),
        ...(input.archived === undefined ? {} : { archived: input.archived }),
        readiness,
        readinessNote: readiness === "ready" ? null : (input.readinessNote ?? card.readinessNote),
        updatedAt: at,
      };
      if (input.archived === true && next.status !== "done") {
        return yield* new Contracts.BoardMcpFailure({
          code: "archive_requires_done",
          message:
            "Only done cards can be archived. Move the card to done first, or omit archived.",
        });
      }
      if (next.status === "done" && next.readiness !== "ready") {
        return yield* new Contracts.BoardMcpFailure({
          code: "readiness_not_ready",
          message: "A card must be ready before it can move to done.",
        });
      }
      if (
        next.readiness !== "ready" &&
        (next.readinessNote === null || next.readinessNote.trim().length === 0)
      ) {
        return yield* new Contracts.BoardMcpFailure({
          code: "readiness_note_required",
          message: "A non-ready card needs a non-empty readinessNote.",
        });
      }
      const startingExecution = card.status !== "in_progress" && next.status === "in_progress";
      for (const field of ["title", "body", "lastError", "readinessNote"] as const) {
        const text = next[field];
        if (
          text !== null &&
          (startingExecution || text !== card[field] || field === "readinessNote")
        ) {
          yield* BoardRepository.validateAuthoredText(field, text);
        }
      }
      if (
        next.status === "in_progress" &&
        (next.executorThreadId === null || next.assignee === null)
      ) {
        return yield* new Contracts.BoardMcpFailure({
          code: "executor_required",
          message: "Link assignee and executorThreadId before moving a card to in_progress.",
        });
      }
      const statusChanged = next.status !== card.status;
      const executorChanged =
        next.executorRole !== card.executorRole ||
        next.executorThreadId !== card.executorThreadId ||
        !Equal.equals(next.assignee, card.assignee);
      const events: Contracts.BoardCardEvent[] = [];
      if (statusChanged || executorChanged)
        events.push(
          yield* event(
            next,
            at,
            statusChanged ? `status -> ${next.status}` : `executor -> ${next.executorRole}`,
          ),
        );
      if (next.readiness !== card.readiness || next.readinessNote !== card.readinessNote) {
        events.push(
          yield* event(
            next,
            at,
            next.readiness === "ready"
              ? "readiness -> ready"
              : `readiness -> ${next.readiness}: ${next.readinessNote}`,
          ),
        );
      }
      yield* repo.updateCard(next, events).pipe(Effect.mapError(repositoryFailure));
      return next;
    }),
    delete: Effect.fn("Ft3BoardService.delete")(function* (scope, input) {
      const threadId = yield* requireOrchestrator(scope, true);
      const card = yield* requireOwnedCard(threadId, input.cardId);
      yield* repo.deleteCard(card.cardId).pipe(Effect.mapError(unavailable));
      return {};
    }),
    list: Effect.fn("Ft3BoardService.list")(function* (scope, input) {
      const threadId = yield* requireOrchestrator(scope, false);
      const cards = yield* repo.listCards(threadId).pipe(Effect.mapError(unavailable));
      if (input.cardIds !== undefined) {
        const owned = new Map(cards.map((card) => [String(card.cardId), card]));
        const found: Contracts.BoardCard[] = [];
        const notFound: Contracts.BoardCardId[] = [];
        for (const id of new Set(input.cardIds)) {
          const card = owned.get(id);
          if (card === undefined) notFound.push(Contracts.BoardCardId.make(id));
          else found.push(card);
        }
        return { cards: found, truncated: false, omittedCount: 0, notFound };
      }
      const summaries = cards
        .filter((card) => input.includeArchived === true || !card.archived)
        .toSorted((left, right) =>
          left.order === right.order
            ? left.cardId.localeCompare(right.cardId)
            : left.order - right.order,
        )
        .map(({ body, ...rest }) => ({ ...rest, bodyChars: body.length }));
      const accepted: Contracts.BoardCardSummary[] = [];
      for (const summary of summaries) {
        const candidate = {
          cards: [...accepted, summary],
          truncated: accepted.length + 1 < summaries.length,
          omittedCount: summaries.length - accepted.length - 1,
          notFound: [],
        };
        if (Buffer.byteLength(encodeList(candidate), "utf8") > Contracts.BOARD_LIST_BUDGET_BYTES)
          break;
        accepted.push(summary);
      }
      return {
        cards: accepted,
        truncated: accepted.length < summaries.length,
        omittedCount: summaries.length - accepted.length,
        notFound: [],
      };
    }),
    listOrchestrators: Effect.fn("Ft3BoardService.listOrchestrators")(function* () {
      const orchestrators = yield* repo.listOrchestrators().pipe(Effect.mapError(unavailable));
      return { orchestrators };
    }),
    markOrchestrator: Effect.fn("Ft3BoardService.markOrchestrator")(function* (input) {
      yield* requireMarkableThread(input.threadId);
      const orchestrators = yield* repo.listOrchestrators().pipe(Effect.mapError(unavailable));
      const existing = orchestrators.find((row) => row.threadId === input.threadId);
      if (existing !== undefined) return existing;
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const created = yield* repo
        .addOrchestrator({ threadId: input.threadId, createdBy: "human", createdAt })
        .pipe(Effect.mapError(repositoryFailure));
      yield* wakeOrchestrator(
        input.threadId,
        `ft3:board:mark:${input.threadId}`,
        "This thread was marked a board Coordinator by a human.",
      );
      return created;
    }),
    unmarkOrchestrator: Effect.fn("Ft3BoardService.unmarkOrchestrator")(function* (input) {
      yield* repo.removeOrchestrator(input.threadId).pipe(Effect.mapError(unavailable));
      const cards = yield* repo.listCards(input.threadId).pipe(Effect.mapError(unavailable));
      const executors = new Set(
        cards.flatMap((card) => (card.executorThreadId === null ? [] : [card.executorThreadId])),
      );
      yield* Effect.forEach(
        Array.from(executors),
        (threadId) =>
          threads
            .dispatch({
              type: "thread.delete",
              commandId: CommandId.make(`ft3:board:unmark:child:${threadId}`),
              threadId,
            })
            .pipe(Effect.asVoid, Effect.mapError(unavailable)),
        { discard: true },
      );
      return {};
    }),
    resendBrief: Effect.fn("Ft3BoardService.resendBrief")(function* (input) {
      const orchestrators = yield* repo.listOrchestrators().pipe(Effect.mapError(unavailable));
      if (!orchestrators.some((row) => row.threadId === input.threadId)) {
        return yield* new Contracts.BoardMcpFailure({
          code: "task_not_found",
          message: `Thread ${input.threadId} is not a registered board Coordinator.`,
        });
      }
      yield* requireMarkableThread(input.threadId);
      const nonce = yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable));
      yield* wakeOrchestrator(
        input.threadId,
        `ft3:board:brief:${input.threadId}:${nonce}`,
        "The board brief was re-delivered by a human.",
      );
      return {};
    }),
    listBoard: Effect.fn("Ft3BoardService.listBoard")(function* (input) {
      const includeArchived = input.includeArchived === true;
      const [cards, events, archivedCounts] = yield* Effect.all(
        [
          repo.listCardsAll({ includeArchived }).pipe(Effect.mapError(unavailable)),
          repo.listEventsAll({ includeArchived }).pipe(Effect.mapError(unavailable)),
          includeArchived
            ? Effect.succeed([] as ReadonlyArray<Contracts.BoardArchivedCount>)
            : repo.countArchivedCards().pipe(Effect.mapError(unavailable)),
        ],
        { concurrency: 3 },
      );
      return { cards, events, ...(includeArchived ? {} : { archivedCounts }) };
    }),
    resolveCards: Effect.fn("Ft3BoardService.resolveCards")(function* (input) {
      const resolved = yield* Effect.forEach(
        [...new Set(input.tokens)],
        (token) =>
          Effect.gen(function* () {
            const tokenText = String(token);
            let card: Contracts.BoardCard | undefined;
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tokenText)) {
              card =
                (yield* repo
                  .getCard(Contracts.BoardCardId.make(tokenText.toLowerCase()))
                  .pipe(Effect.mapError(unavailable))) ?? undefined;
            } else {
              const matches = yield* repo
                .findCardsByPrefix(tokenText.toLowerCase())
                .pipe(Effect.mapError(unavailable));
              card = matches.length === 1 ? matches[0] : undefined;
            }
            return card === undefined ? undefined : { token, card };
          }),
        { concurrency: 8 },
      );
      const title = (owner: { readonly title: string } | null) =>
        owner === null || owner.title.trim() === "" ? null : owner.title;
      const matches = yield* Effect.forEach(
        resolved.filter((entry) => entry !== undefined),
        ({ token, card }) =>
          Effect.gen(function* () {
            const [owner, events] = yield* Effect.all(
              [
                threads
                  .getThreadShell(card.orchestratorThreadId)
                  .pipe(Effect.mapError(unavailable)),
                repo.listEventsForCard(card.cardId).pipe(Effect.mapError(unavailable)),
              ],
              { concurrency: 2 },
            );
            return {
              token,
              card,
              orchestratorThreadTitle: title(owner),
              recentEvents: [...events].reverse().slice(0, 3),
            };
          }),
        { concurrency: 8 },
      );
      const details = yield* Effect.forEach(
        [...new Set(input.cardIds)],
        (cardId) =>
          Effect.gen(function* () {
            const card = yield* repo.getCard(cardId).pipe(Effect.mapError(unavailable));
            if (card === null) return undefined;
            const [owner, events] = yield* Effect.all(
              [
                threads
                  .getThreadShell(card.orchestratorThreadId)
                  .pipe(Effect.mapError(unavailable)),
                repo.listEventsForCard(card.cardId).pipe(Effect.mapError(unavailable)),
              ],
              { concurrency: 2 },
            );
            return { card, orchestratorThreadTitle: title(owner), events };
          }),
        { concurrency: 8 },
      );
      return {
        matches,
        details: details.filter((entry) => entry !== undefined),
      };
    }),
    createHumanCard: Effect.fn("Ft3BoardService.createHumanCard")(function* (input) {
      const at = DateTime.formatIso(yield* DateTime.now);
      const card: Contracts.BoardCard = {
        cardId: Contracts.BoardCardId.make(
          yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable)),
        ),
        orchestratorThreadId: input.orchestratorThreadId,
        title: input.title,
        body: input.body,
        status: "todo",
        createdBy: "human",
        assignee: input.assignee ?? null,
        executorRole: input.executorRole,
        executorThreadId: null,
        outcome: null,
        lastError: null,
        readiness: "ready",
        readinessNote: null,
        failureStreak: 0,
        order: 0,
        archived: false,
        createdAt: at,
        updatedAt: at,
      };
      yield* repo
        .createCard(card, [yield* event(card, at, "created by human")])
        .pipe(Effect.mapError(repositoryFailure));
      return card;
    }),
    startCard: Effect.fn("Ft3BoardService.startCard")(function* (input) {
      const card = yield* repo.getCard(input.cardId).pipe(Effect.mapError(unavailable));
      if (card === null) return yield* notFound();
      if (card.archived) {
        return yield* new Contracts.BoardMcpFailure({
          code: "archive_requires_done",
          message: `Archived board card ${card.cardId} cannot be started.`,
        });
      }
      if (card.status !== "todo" && card.status !== "backlog") {
        return yield* new Contracts.BoardMcpFailure({
          code: "readiness_not_ready",
          message: `Board card ${card.cardId} is '${card.status}'; only 'todo' or 'backlog' cards can start.`,
        });
      }
      const at = DateTime.formatIso(yield* DateTime.now);
      const next: Contracts.BoardCard = { ...card, status: "orchestrator", updatedAt: at };
      yield* repo
        .updateCard(next, [yield* event(next, at, "started by human")])
        .pipe(Effect.mapError(repositoryFailure));
      yield* wakeOrchestrator(
        card.orchestratorThreadId,
        `ft3:board:start:${card.cardId}`,
        `Board card "${card.title}" (${card.cardId}) was started by a human. Executor role: ${card.executorRole}.\n\n${card.body}`,
      );
      return next;
    }),
    updateHumanCard: Effect.fn("Ft3BoardService.updateHumanCard")(function* (input) {
      const rejected = (
        [
          "title",
          "body",
          "status",
          "executorRole",
          "assignee",
          "executorThreadId",
          "outcome",
          "lastError",
          "failureStreak",
          "order",
        ] as const
      ).filter((field) => input[field] !== undefined);
      if (rejected.length > 0) {
        return yield* new Contracts.BoardMcpFailure({
          code: "author_text_rejected",
          message: `Human clients may only change 'archived'; rejected fields: ${[...rejected].sort().join(", ")}.`,
        });
      }
      const card = yield* repo.getCard(input.cardId).pipe(Effect.mapError(unavailable));
      if (card === null) return yield* notFound();
      const at = DateTime.formatIso(yield* DateTime.now);
      const next: Contracts.BoardCard = {
        ...card,
        archived: input.archived ?? card.archived,
        updatedAt: at,
      };
      yield* repo
        .updateCard(
          next,
          next.archived === card.archived
            ? []
            : [yield* event(next, at, next.archived ? "archived by human" : "unarchived by human")],
        )
        .pipe(Effect.mapError(repositoryFailure));
      return next;
    }),
    deleteHumanCard: Effect.fn("Ft3BoardService.deleteHumanCard")(function* () {
      return yield* new Contracts.BoardMcpFailure({
        code: "capability_denied",
        message:
          "Human clients cannot delete board cards; the Coordinator deletes cards through MCP.",
      });
    }),
  });
});

export const layer = Layer.effect(BoardService, make);

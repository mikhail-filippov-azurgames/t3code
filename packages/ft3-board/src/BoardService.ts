import type { ThreadId } from "@t3tools/contracts";
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
  });
});

export const layer = Layer.effect(BoardService, make);

import * as NodeCrypto from "node:crypto";

import {
  BoardCardId,
  ORCHESTRATOR_MCP_BOARD_LIST_BUDGET_BYTES,
  OrchestratorMcpBoardListCardsResult,
  type BoardCard,
  type OrchestratorMcpBoardCardSummary,
  type OrchestratorMcpBoardCreateCardInput,
  type OrchestratorMcpBoardDeleteCardInput,
  type OrchestratorMcpBoardListCardsInput,
  type OrchestratorMcpBoardUpdateCardInput,
  type OrchestratorMcpFailure,
  type OrchestratorMcpFailureCode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  buildBoardCardEvent,
  type BoardRepositoryShape,
} from "../../../persistence/Services/Board.ts";
import type { AuthorTextField } from "../../../security/SecretTextPolicy.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";

interface BoardServiceDependencies {
  readonly requireCapability: (
    scope: McpInvocationScope,
  ) => Effect.Effect<unknown, OrchestratorMcpFailure>;
  readonly denyArchitectCaller: (
    scope: McpInvocationScope,
    operation: string,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly denyExecutorCaller: (
    scope: McpInvocationScope,
    operation: string,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly denyArchitectTarget: (
    threadId: ThreadId,
    operation: string,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly ensureAuthorTextAllowed: (
    field: AuthorTextField,
    text: string,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly requireBoardRepository: () => Effect.Effect<
    BoardRepositoryShape,
    OrchestratorMcpFailure
  >;
  readonly requireRegisteredOrchestrator: (
    repo: BoardRepositoryShape,
    scope: McpInvocationScope,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly nowIso: () => Effect.Effect<string>;
  readonly failure: (code: OrchestratorMcpFailureCode, message: string) => OrchestratorMcpFailure;
  readonly orchestrationFailure: (operation: string) => (error: unknown) => OrchestratorMcpFailure;
}

export function makeBoardService(dependencies: BoardServiceDependencies) {
  const toBoardCardSummary = (card: BoardCard): OrchestratorMcpBoardCardSummary => {
    const { body, ...rest } = card;
    return { ...rest, bodyChars: body.length };
  };

  const encodeBoardListCards = Schema.encodeSync(
    Schema.fromJsonString(OrchestratorMcpBoardListCardsResult),
  );
  const boardListCardsByteLength = (result: OrchestratorMcpBoardListCardsResult): number =>
    Buffer.byteLength(encodeBoardListCards(result), "utf8");

  const requireOwnedCard = (
    repo: BoardRepositoryShape,
    scope: McpInvocationScope,
    cardId: BoardCardId,
  ): Effect.Effect<BoardCard, OrchestratorMcpFailure> =>
    repo.getCard(cardId).pipe(
      Effect.mapError(dependencies.orchestrationFailure(`read board card ${cardId}`)),
      Effect.flatMap((option) => {
        if (Option.isNone(option) || option.value.orchestratorThreadId !== scope.threadId) {
          return Effect.fail(
            dependencies.failure("task_not_found", "The board card was not found."),
          );
        }
        return Effect.succeed(option.value);
      }),
    );

  return {
    boardCreateCard: (scope: McpInvocationScope, input: OrchestratorMcpBoardCreateCardInput) =>
      Effect.gen(function* () {
        yield* dependencies.requireCapability(scope);
        yield* dependencies.denyArchitectCaller(scope, "own boards");
        yield* Effect.all(
          [
            dependencies.ensureAuthorTextAllowed("title", input.title),
            dependencies.ensureAuthorTextAllowed("body", input.body),
          ],
          { discard: true },
        );
        const repo = yield* dependencies.requireBoardRepository();
        yield* dependencies.requireRegisteredOrchestrator(repo, scope);
        const at = yield* dependencies.nowIso();
        const card: BoardCard = {
          cardId: BoardCardId.make(NodeCrypto.randomUUID()),
          orchestratorThreadId: scope.threadId,
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
          .createCard(card)
          .pipe(Effect.mapError(dependencies.orchestrationFailure("create board card")));
        yield* repo
          .appendEvent(buildBoardCardEvent(card, { at }))
          .pipe(Effect.mapError(dependencies.orchestrationFailure("append board card event")));
        return card;
      }),
    boardUpdateCard: (scope: McpInvocationScope, input: OrchestratorMcpBoardUpdateCardInput) =>
      Effect.gen(function* () {
        yield* dependencies.requireCapability(scope);
        yield* dependencies.denyArchitectCaller(scope, "own boards");
        yield* dependencies.denyExecutorCaller(scope, "own boards");
        const repo = yield* dependencies.requireBoardRepository();
        yield* dependencies.requireRegisteredOrchestrator(repo, scope);
        const card = yield* requireOwnedCard(repo, scope, BoardCardId.make(input.cardId));
        if (input.executorThreadId !== undefined && input.executorThreadId !== null) {
          yield* dependencies.denyArchitectTarget(input.executorThreadId, "board_update_card");
        }
        const at = yield* dependencies.nowIso();
        const statusChanged = input.status !== undefined && input.status !== card.status;
        const readiness = input.readiness ?? card.readiness;
        const readinessNote =
          readiness === "ready" ? null : (input.readinessNote ?? card.readinessNote);
        const readinessChanged =
          readiness !== card.readiness || readinessNote !== card.readinessNote;
        const executorChanged =
          (input.executorRole !== undefined && input.executorRole !== card.executorRole) ||
          (input.executorThreadId !== undefined &&
            input.executorThreadId !== card.executorThreadId) ||
          (input.assignee !== undefined && !Equal.equals(input.assignee, card.assignee));
        const next: BoardCard = {
          ...card,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(input.status === undefined ? {} : { status: input.status }),
          readiness,
          readinessNote,
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
          updatedAt: at,
        };
        if (input.archived === true && next.status !== "done") {
          return yield* dependencies.failure(
            "archive_requires_done",
            "Only done cards can be archived. Move the card to done first, or omit archived.",
          );
        }
        if (next.status === "done" && next.readiness !== "ready") {
          return yield* dependencies.failure(
            "readiness_not_ready",
            "A card must be ready before it can move to done.",
          );
        }
        if (
          next.readiness !== "ready" &&
          (next.readinessNote === null || next.readinessNote.trim().length === 0)
        ) {
          return yield* dependencies.failure(
            "readiness_note_required",
            "A non-ready card needs a non-empty readinessNote.",
          );
        }
        const startingExecution = card.status !== "in_progress" && next.status === "in_progress";
        const lastErrorCheck =
          next.lastError === null || (!startingExecution && next.lastError === card.lastError)
            ? []
            : [dependencies.ensureAuthorTextAllowed("lastError", next.lastError)];
        yield* Effect.all(
          [
            ...(startingExecution || next.title !== card.title
              ? [dependencies.ensureAuthorTextAllowed("title", next.title)]
              : []),
            ...(startingExecution || next.body !== card.body
              ? [dependencies.ensureAuthorTextAllowed("body", next.body)]
              : []),
            ...lastErrorCheck,
            ...(next.readinessNote === null
              ? []
              : [dependencies.ensureAuthorTextAllowed("readinessNote", next.readinessNote)]),
          ],
          { discard: true },
        );
        // The reactor matches cards by executor thread; without a linked
        // executor and model a card would sit in progress forever.
        if (
          next.status === "in_progress" &&
          (next.executorThreadId === null || next.assignee === null)
        ) {
          return yield* dependencies.failure(
            "executor_required",
            "Link assignee and executorThreadId before moving a card to in_progress.",
          );
        }
        // `card` above is the already-read previous value, so the check inside
        // runs against it and this update costs one read plus one write.
        yield* repo
          .updateCardWithPrevious(next, Option.some(card))
          .pipe(Effect.mapError(dependencies.orchestrationFailure("update board card")));
        if (statusChanged || executorChanged) {
          const body = statusChanged
            ? `status -> ${next.status}`
            : `executor -> ${next.executorRole}`;
          yield* repo
            .appendEvent(buildBoardCardEvent(next, { at, body }))
            .pipe(Effect.mapError(dependencies.orchestrationFailure("append board card event")));
        }
        if (readinessChanged) {
          const body =
            next.readiness === "ready"
              ? "readiness -> ready"
              : `readiness -> ${next.readiness}: ${next.readinessNote}`;
          yield* repo
            .appendEvent(buildBoardCardEvent(next, { at, body }))
            .pipe(Effect.mapError(dependencies.orchestrationFailure("append board card event")));
        }
        return next;
      }),
    boardDeleteCard: (scope: McpInvocationScope, input: OrchestratorMcpBoardDeleteCardInput) =>
      Effect.gen(function* () {
        yield* dependencies.requireCapability(scope);
        yield* dependencies.denyArchitectCaller(scope, "own boards");
        yield* dependencies.denyExecutorCaller(scope, "own boards");
        const repo = yield* dependencies.requireBoardRepository();
        yield* dependencies.requireRegisteredOrchestrator(repo, scope);
        const cardId = BoardCardId.make(input.cardId);
        yield* requireOwnedCard(repo, scope, cardId);
        yield* repo
          .deleteCard(cardId)
          .pipe(Effect.mapError(dependencies.orchestrationFailure("delete board card")));
        return {};
      }),
    boardListCards: (scope: McpInvocationScope, input: OrchestratorMcpBoardListCardsInput) =>
      Effect.gen(function* () {
        yield* dependencies.requireCapability(scope);
        yield* dependencies.denyArchitectCaller(scope, "read boards");
        yield* dependencies.denyExecutorCaller(scope, "read boards");
        const repo = yield* dependencies.requireBoardRepository();
        yield* dependencies.requireRegisteredOrchestrator(repo, scope);
        const cards = yield* repo
          .listCards()
          .pipe(Effect.mapError(dependencies.orchestrationFailure("list board cards")));
        const owned = cards.filter((card) => card.orchestratorThreadId === scope.threadId);
        if (input.cardIds !== undefined) {
          // Explicit body reads: full cards in request order. The archive
          // filter does not apply here; ownership is the only gate, and
          // foreign or missing ids land in `notFound` instead of failing.
          const ownedById = new Map(owned.map((card) => [card.cardId, card] as const));
          const seen = new Set<string>();
          const found: Array<BoardCard> = [];
          const notFound: Array<BoardCardId> = [];
          for (const rawId of input.cardIds) {
            if (seen.has(rawId)) {
              continue;
            }
            seen.add(rawId);
            const cardId = BoardCardId.make(rawId);
            const card = ownedById.get(cardId);
            if (card === undefined) {
              notFound.push(cardId);
            } else {
              found.push(card);
            }
          }
          return {
            cards: found,
            truncated: false,
            omittedCount: 0,
            notFound,
          } satisfies OrchestratorMcpBoardListCardsResult;
        }
        // Pointer list: summaries without bodies so a large board does not
        // flood the coordinator's context on every wake. Bodies are read
        // explicitly through `cardIds`.
        const includeArchived = input.includeArchived ?? false;
        const summaries = owned
          .filter((card) => includeArchived || !card.archived)
          .toSorted((left, right) =>
            left.order === right.order
              ? left.cardId.localeCompare(right.cardId)
              : left.order - right.order,
          )
          .map(toBoardCardSummary);
        const accepted: Array<OrchestratorMcpBoardCardSummary> = [];
        for (const summary of summaries) {
          const candidate: OrchestratorMcpBoardListCardsResult = {
            cards: [...accepted, summary],
            truncated: false,
            omittedCount: 0,
            notFound: [],
          };
          if (boardListCardsByteLength(candidate) > ORCHESTRATOR_MCP_BOARD_LIST_BUDGET_BYTES) {
            break;
          }
          accepted.push(summary);
        }
        return {
          cards: accepted,
          truncated: accepted.length < summaries.length,
          omittedCount: summaries.length - accepted.length,
          notFound: [],
        } satisfies OrchestratorMcpBoardListCardsResult;
      }),
  };
}

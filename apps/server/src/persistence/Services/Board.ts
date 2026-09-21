// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  BoardCard,
  BoardCardEvent,
  BoardCardEventId,
  BoardCardId,
  BoardCreatedBy,
  BoardOrchestrator,
  IsoDateTime,
  ThreadId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * BoardRepository - local persistence for the orchestrator kanban board.
 *
 * Board state is a local store (repo + RPC + reactor), not part of the
 * orchestration event log. This module owns the service contract so consumers
 * depend on it without pulling in SQL; the SQLite `Live` layer lives in
 * `../Layers/Board.ts`.
 *
 * @module BoardRepository
 */
export class BoardRepositoryError extends Schema.TaggedError<BoardRepositoryError>()(
  "BoardRepositoryError",
  {
    operation: Schema.String,
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail === undefined
      ? `Board repository error in ${this.operation}`
      : `Board repository error in ${this.operation}: ${this.detail}`;
  }
}

export const AddBoardOrchestratorInput = Schema.Struct({
  threadId: ThreadId,
  createdBy: BoardCreatedBy,
  createdAt: IsoDateTime,
});
export type AddBoardOrchestratorInput = typeof AddBoardOrchestratorInput.Type;

export interface BoardRepositoryShape {
  readonly listOrchestrators: () => Effect.Effect<
    ReadonlyArray<BoardOrchestrator>,
    BoardRepositoryError
  >;
  readonly addOrchestrator: (
    input: AddBoardOrchestratorInput,
  ) => Effect.Effect<BoardOrchestrator, BoardRepositoryError>;
  /** Cascade-deletes the orchestrator's cards and their progress history. */
  readonly removeOrchestrator: (threadId: ThreadId) => Effect.Effect<void, BoardRepositoryError>;
  readonly listCards: () => Effect.Effect<ReadonlyArray<BoardCard>, BoardRepositoryError>;
  readonly getCard: (
    cardId: BoardCardId,
  ) => Effect.Effect<Option.Option<BoardCard>, BoardRepositoryError>;
  readonly createCard: (card: BoardCard) => Effect.Effect<void, BoardRepositoryError>;
  readonly updateCard: (card: BoardCard) => Effect.Effect<void, BoardRepositoryError>;
  readonly deleteCard: (cardId: BoardCardId) => Effect.Effect<void, BoardRepositoryError>;
  readonly listEvents: () => Effect.Effect<ReadonlyArray<BoardCardEvent>, BoardRepositoryError>;
  readonly appendEvent: (event: BoardCardEvent) => Effect.Effect<void, BoardRepositoryError>;
}

export class BoardRepository extends Context.Service<BoardRepository, BoardRepositoryShape>()(
  "t3/persistence/Services/Board/BoardRepository",
) {}

/**
 * Build a system progress entry from the card's current state without an LLM
 * call. `model`/`effort` come from the assigned executor, so they are null
 * until an assignee exists.
 */
export function buildBoardCardEvent(
  card: BoardCard,
  input: { at: IsoDateTime; body?: string },
): BoardCardEvent {
  const effort =
    getModelSelectionStringOptionValue(card.assignee, "effort") ??
    getModelSelectionStringOptionValue(card.assignee, "reasoningEffort") ??
    null;
  return {
    entryId: BoardCardEventId.make(NodeCrypto.randomUUID()),
    cardId: card.cardId,
    at: input.at,
    status: card.status,
    executorRole: card.executorRole,
    model: card.assignee?.model ?? null,
    effort,
    source: "system",
    ...(input.body === undefined ? {} : { body: input.body }),
  };
}

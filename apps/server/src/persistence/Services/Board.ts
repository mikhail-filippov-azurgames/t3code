// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  BoardArchivedCount,
  BoardCard,
  BoardCardDeletionReason,
  BoardCardDeletionRecord,
  BoardCardEvent,
  BoardCardEventId,
  BoardCardId,
  BoardCreatedBy,
  BoardOrchestrator,
  IsoDateTime,
  NonNegativeInt,
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

export const ARCHIVE_REQUIRES_DONE_CODE = "archive_requires_done";
export const ARCHIVE_REQUIRES_DONE_DETAIL =
  "Only done cards can be archived. Move the card to done first, or omit archived.";

/**
 * The archive invariant, enforced by every repository write so no caller can
 * bypass it: a card may only be archived while `done`. It rejects a write that
 * newly produces an archived unfinished card (a fresh card, an unfinished card
 * being archived, or an archived done card leaving `done`). A card that was
 * already archived unfinished stays writable, so legacy rows are neither
 * blocked nor silently repaired.
 */
export const archiveRequiresDoneFailure = (
  card: Pick<BoardCard, "archived" | "status">,
  previous: Pick<BoardCard, "archived" | "status"> | undefined,
): BoardRepositoryError | null => {
  const violates = (value: Pick<BoardCard, "archived" | "status">) =>
    value.archived && value.status !== "done";
  return violates(card) && (previous === undefined || !violates(previous))
    ? new BoardRepositoryError({
        operation: `BoardRepository.${ARCHIVE_REQUIRES_DONE_CODE}`,
        detail: ARCHIVE_REQUIRES_DONE_DETAIL,
      })
    : null;
};

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
  /** Every card unless `includeArchived` is `false`, which filters in SQL. */
  readonly listCards: (input?: {
    readonly includeArchived?: boolean;
  }) => Effect.Effect<ReadonlyArray<BoardCard>, BoardRepositoryError>;
  /** Archived cards per coordinator and column, counted without reading the rows. */
  readonly countArchivedCards: () => Effect.Effect<
    ReadonlyArray<BoardArchivedCount>,
    BoardRepositoryError
  >;
  /**
   * Sweep candidates for the coordinator idle-nudge pass: unarchived cards in
   * a nudge-relevant status (`orchestrator`, `review`, `todo`, `in_progress`),
   * plus any card the sweep logs and skips (`needs_human`, failure-capped).
   * Rows the sweep only ever skips silently (archived, `backlog`, `done`)
   * stay in SQL, in the same order as `listCards`, so a sweep never hydrates
   * the whole table.
   */
  readonly listNudgeCandidateCards: () => Effect.Effect<
    ReadonlyArray<BoardCard>,
    BoardRepositoryError
  >;
  /**
   * Whether the coordinator has a working-ready card: unarchived, readiness
   * `ready`, status `todo`/`orchestrator`/`in_progress`/`review`. Backs the
   * blocked-nudge recheck without rereading the whole table.
   */
  readonly hasWorkingReadyCard: (
    orchestratorThreadId: ThreadId,
  ) => Effect.Effect<boolean, BoardRepositoryError>;
  /**
   * Whether a progress-history entry exists. Backs the nudge dedup check
   * without hydrating the card's whole history.
   */
  readonly hasCardEvent: (
    entryId: BoardCardEventId,
  ) => Effect.Effect<boolean, BoardRepositoryError>;
  /** Returns at most two rows, enough to distinguish a unique prefix from an ambiguous one. */
  readonly findCardsByPrefix: (
    prefix: string,
  ) => Effect.Effect<ReadonlyArray<BoardCard>, BoardRepositoryError>;
  readonly getCard: (
    cardId: BoardCardId,
  ) => Effect.Effect<Option.Option<BoardCard>, BoardRepositoryError>;
  /**
   * The single card currently linked to an executor thread, if any. Backed by
   * an index on `executor_thread_id`, so executor lookups never scan the table.
   */
  readonly findCardByExecutor: (
    executorThreadId: ThreadId,
  ) => Effect.Effect<Option.Option<BoardCard>, BoardRepositoryError>;
  /**
   * Every card linked to an executor thread. One delegated thread may back
   * several cards (shared executor threads are normal), so executor-thread
   * deletion selects all of them (INV-D1) instead of the first match. Backed
   * by the same `executor_thread_id` index as `findCardByExecutor`.
   */
  readonly listCardsByExecutor: (
    executorThreadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<BoardCard>, BoardRepositoryError>;
  readonly createCard: (card: BoardCard) => Effect.Effect<void, BoardRepositoryError>;
  readonly updateCard: (card: BoardCard) => Effect.Effect<void, BoardRepositoryError>;
  /**
   * Write a card whose previous state the caller already read. The
   * author-text check runs against that value, so the update itself is a
   * single statement with no extra read.
   */
  readonly updateCardWithPrevious: (
    card: BoardCard,
    previous: Option.Option<BoardCard>,
  ) => Effect.Effect<void, BoardRepositoryError>;
  readonly deleteCard: (cardId: BoardCardId) => Effect.Effect<void, BoardRepositoryError>;
  /** Every entry unless `includeArchived` is `false`, which skips archived cards' history in SQL. */
  readonly listEvents: (input?: {
    readonly includeArchived?: boolean;
  }) => Effect.Effect<ReadonlyArray<BoardCardEvent>, BoardRepositoryError>;
  /** Reads history for one card; a limit returns the newest entries first. */
  readonly listEventsForCard: (input: {
    readonly cardId: BoardCardId;
    readonly limit?: typeof NonNegativeInt.Type;
  }) => Effect.Effect<ReadonlyArray<BoardCardEvent>, BoardRepositoryError>;
  readonly appendEvent: (event: BoardCardEvent) => Effect.Effect<void, BoardRepositoryError>;
  /**
   * Retention candidates the board-retention pass may archive: `done`,
   * unarchived, untouched since `cutoff`. Oldest first, at most `limit`.
   */
  readonly listArchiveCandidates: (input: {
    readonly cutoff: typeof IsoDateTime.Type;
    readonly limit: typeof NonNegativeInt.Type;
  }) => Effect.Effect<ReadonlyArray<BoardCard>, BoardRepositoryError>;
  /**
   * Retention candidates the board-retention pass may delete: `done`,
   * archived, untouched since `cutoff`. Oldest first, at most `limit`.
   */
  readonly listDeleteCandidates: (input: {
    readonly cutoff: typeof IsoDateTime.Type;
    readonly limit: typeof NonNegativeInt.Type;
  }) => Effect.Effect<ReadonlyArray<BoardCard>, BoardRepositoryError>;
  /**
   * Archive a card and its retention history entry in one transaction, so a
   * crash cannot leave an archived card without its `archived by retention`
   * entry (or the reverse).
   */
  readonly updateCardWithEvent: (
    card: BoardCard,
    event: BoardCardEvent,
  ) => Effect.Effect<void, BoardRepositoryError>;
  /**
   * Delete a card (its history cascades) and record a minimal deletion proof
   * in one transaction. The record carries no title or body.
   */
  readonly deleteCardWithRecord: (input: {
    readonly cardId: BoardCardId;
    readonly orchestratorThreadId: ThreadId;
    readonly deletedAt: typeof IsoDateTime.Type;
    readonly reason: BoardCardDeletionReason;
    readonly historyEventCount: typeof NonNegativeInt.Type;
  }) => Effect.Effect<void, BoardRepositoryError>;
  /** Minimal proofs of card deletions (`retention`, `executor-thread-deleted`), newest last. */
  readonly listDeletionRecords: () => Effect.Effect<
    ReadonlyArray<BoardCardDeletionRecord>,
    BoardRepositoryError
  >;
}

export class BoardRepository extends Context.Service<BoardRepository, BoardRepositoryShape>()(
  "t3/persistence/Services/Board/BoardRepository",
) {}

/**
 * Build a system progress entry from the card's current state without an LLM
 * call. `model`/`effort` come from the assigned executor, so they are null
 * until an assignee exists.
 */
export interface DeleteBoardCardInput {
  readonly card: BoardCard;
  readonly deletedAt: typeof IsoDateTime.Type;
  readonly reason: BoardCardDeletionReason;
}

/**
 * The single card-deletion path (INV-D2): count the card's history, then
 * delete the card (its history cascades) with a deletion proof in one
 * transaction. Both the retention pass and executor-thread deletion call
 * this function, so the two paths cannot drift apart.
 */
export const deleteBoardCardWithRecord = (
  board: Pick<BoardRepositoryShape, "listEventsForCard" | "deleteCardWithRecord">,
  input: DeleteBoardCardInput,
): Effect.Effect<void, BoardRepositoryError> =>
  Effect.gen(function* () {
    const events = yield* board.listEventsForCard({ cardId: input.card.cardId });
    yield* board.deleteCardWithRecord({
      cardId: input.card.cardId,
      orchestratorThreadId: input.card.orchestratorThreadId,
      deletedAt: input.deletedAt,
      reason: input.reason,
      historyEventCount: events.length,
    });
  });

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

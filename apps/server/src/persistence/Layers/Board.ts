import {
  BoardCard,
  BoardCardEvent,
  BoardCardId,
  BoardOrchestrator,
  ModelSelection,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Struct from "effect/Struct";

import {
  AddBoardOrchestratorInput,
  BoardRepository,
  BoardRepositoryError,
  type BoardRepositoryShape,
} from "../Services/Board.ts";

const GetOrchestratorInput = Schema.Struct({ threadId: ThreadId });
const GetCardInput = Schema.Struct({ cardId: BoardCardId });

const BoardCardDbRow = BoardCard.mapFields(
  Struct.assign({
    assignee: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    archived: Schema.Finite,
  }),
);
type BoardCardDbRow = typeof BoardCardDbRow.Type;

const BoardCardEventDbRow = BoardCardEvent.mapFields(
  Struct.assign({
    body: Schema.NullOr(TrimmedNonEmptyString),
  }),
);
type BoardCardEventDbRow = typeof BoardCardEventDbRow.Type;

const toBoardCard = (row: BoardCardDbRow): BoardCard => ({
  ...row,
  archived: row.archived === 1,
});

const toBoardCardEvent = (row: BoardCardEventDbRow): BoardCardEvent => ({
  entryId: row.entryId,
  cardId: row.cardId,
  at: row.at,
  status: row.status,
  executorRole: row.executorRole,
  model: row.model,
  effort: row.effort,
  source: row.source,
  ...(row.body === null ? {} : { body: row.body }),
});

const toBoardRepositoryError =
  (operation: string) =>
  (cause: unknown): BoardRepositoryError =>
    new BoardRepositoryError({ operation, cause });

const makeBoardRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertOrchestratorRow = SqlSchema.void({
    Request: AddBoardOrchestratorInput,
    execute: (row) =>
      sql`
        INSERT INTO board_orchestrators (thread_id, created_by, created_at)
        VALUES (${row.threadId}, ${row.createdBy}, ${row.createdAt})
        ON CONFLICT (thread_id) DO NOTHING
      `,
  });

  const getOrchestratorRow = SqlSchema.findOneOption({
    Request: GetOrchestratorInput,
    Result: BoardOrchestrator,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          created_by AS "createdBy",
          created_at AS "createdAt"
        FROM board_orchestrators
        WHERE thread_id = ${threadId}
      `,
  });

  const listOrchestratorRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardOrchestrator,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          created_by AS "createdBy",
          created_at AS "createdAt"
        FROM board_orchestrators
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const deleteOrchestratorRow = SqlSchema.void({
    Request: GetOrchestratorInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM board_orchestrators
        WHERE thread_id = ${threadId}
      `,
  });

  const insertCardRow = SqlSchema.void({
    Request: BoardCard,
    execute: (row) =>
      sql`
        INSERT INTO board_cards (
          card_id,
          orchestrator_thread_id,
          title,
          body,
          status,
          created_by,
          assignee_json,
          executor_role,
          executor_thread_id,
          outcome,
          last_error,
          failure_streak,
          order_index,
          archived,
          created_at,
          updated_at
        )
        VALUES (
          ${row.cardId},
          ${row.orchestratorThreadId},
          ${row.title},
          ${row.body},
          ${row.status},
          ${row.createdBy},
          ${row.assignee === null ? null : JSON.stringify(row.assignee)},
          ${row.executorRole},
          ${row.executorThreadId},
          ${row.outcome},
          ${row.lastError},
          ${row.failureStreak},
          ${row.order},
          ${row.archived ? 1 : 0},
          ${row.createdAt},
          ${row.updatedAt}
        )
      `,
  });

  const updateCardRow = SqlSchema.void({
    Request: BoardCard,
    execute: (row) =>
      sql`
        UPDATE board_cards
        SET title = ${row.title},
            body = ${row.body},
            status = ${row.status},
            assignee_json = ${row.assignee === null ? null : JSON.stringify(row.assignee)},
            executor_role = ${row.executorRole},
            executor_thread_id = ${row.executorThreadId},
            outcome = ${row.outcome},
            last_error = ${row.lastError},
            failure_streak = ${row.failureStreak},
            order_index = ${row.order},
            archived = ${row.archived ? 1 : 0},
            updated_at = ${row.updatedAt}
        WHERE card_id = ${row.cardId}
      `,
  });

  const getCardRow = SqlSchema.findOneOption({
    Request: GetCardInput,
    Result: BoardCardDbRow,
    execute: ({ cardId }) =>
      sql`
        SELECT
          card_id AS "cardId",
          orchestrator_thread_id AS "orchestratorThreadId",
          title,
          body,
          status,
          created_by AS "createdBy",
          assignee_json AS "assignee",
          executor_role AS "executorRole",
          executor_thread_id AS "executorThreadId",
          outcome,
          last_error AS "lastError",
          failure_streak AS "failureStreak",
          order_index AS "order",
          archived,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM board_cards
        WHERE card_id = ${cardId}
      `,
  });

  const listCardRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardCardDbRow,
    execute: () =>
      sql`
        SELECT
          card_id AS "cardId",
          orchestrator_thread_id AS "orchestratorThreadId",
          title,
          body,
          status,
          created_by AS "createdBy",
          assignee_json AS "assignee",
          executor_role AS "executorRole",
          executor_thread_id AS "executorThreadId",
          outcome,
          last_error AS "lastError",
          failure_streak AS "failureStreak",
          order_index AS "order",
          archived,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM board_cards
        ORDER BY orchestrator_thread_id ASC, order_index ASC, created_at ASC, card_id ASC
      `,
  });

  const deleteCardRow = SqlSchema.void({
    Request: GetCardInput,
    execute: ({ cardId }) =>
      sql`
        DELETE FROM board_cards
        WHERE card_id = ${cardId}
      `,
  });

  const insertEventRow = SqlSchema.void({
    Request: BoardCardEvent,
    execute: (row) =>
      sql`
        INSERT INTO board_card_events (
          entry_id,
          card_id,
          at,
          status,
          executor_role,
          model,
          effort,
          body,
          source
        )
        VALUES (
          ${row.entryId},
          ${row.cardId},
          ${row.at},
          ${row.status},
          ${row.executorRole},
          ${row.model},
          ${row.effort},
          ${row.body === undefined ? null : row.body},
          ${row.source}
        )
      `,
  });

  const listEventRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardCardEventDbRow,
    execute: () =>
      sql`
        SELECT
          entry_id AS "entryId",
          card_id AS "cardId",
          at,
          status,
          executor_role AS "executorRole",
          model,
          effort,
          body,
          source
        FROM board_card_events
        ORDER BY at ASC, entry_id ASC
      `,
  });

  const listOrchestrators: BoardRepositoryShape["listOrchestrators"] = () =>
    listOrchestratorRows().pipe(
      Effect.mapError(toBoardRepositoryError("BoardRepository.listOrchestrators:query")),
    );

  const addOrchestrator: BoardRepositoryShape["addOrchestrator"] = (input) =>
    insertOrchestratorRow(input).pipe(
      Effect.flatMap(() => getOrchestratorRow({ threadId: input.threadId })),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.die("BoardRepository.addOrchestrator: orchestrator missing after insert"),
          onSome: (orchestrator) => Effect.succeed(orchestrator),
        }),
      ),
      Effect.mapError(toBoardRepositoryError("BoardRepository.addOrchestrator:query")),
    );

  const removeOrchestrator: BoardRepositoryShape["removeOrchestrator"] = (threadId) =>
    deleteOrchestratorRow({ threadId }).pipe(
      Effect.mapError(toBoardRepositoryError("BoardRepository.removeOrchestrator:query")),
    );

  const listCards: BoardRepositoryShape["listCards"] = () =>
    listCardRows().pipe(
      Effect.map((rows) => rows.map(toBoardCard)),
      Effect.mapError(toBoardRepositoryError("BoardRepository.listCards:query")),
    );

  const getCard: BoardRepositoryShape["getCard"] = (cardId) =>
    getCardRow({ cardId }).pipe(
      Effect.map(Option.map(toBoardCard)),
      Effect.mapError(toBoardRepositoryError("BoardRepository.getCard:query")),
    );

  const createCard: BoardRepositoryShape["createCard"] = (card) =>
    insertCardRow(card).pipe(
      Effect.mapError(toBoardRepositoryError("BoardRepository.createCard:query")),
    );

  const updateCard: BoardRepositoryShape["updateCard"] = (card) =>
    updateCardRow(card).pipe(
      Effect.mapError(toBoardRepositoryError("BoardRepository.updateCard:query")),
    );

  const deleteCard: BoardRepositoryShape["deleteCard"] = (cardId) =>
    deleteCardRow({ cardId }).pipe(
      Effect.mapError(toBoardRepositoryError("BoardRepository.deleteCard:query")),
    );

  const listEvents: BoardRepositoryShape["listEvents"] = () =>
    listEventRows().pipe(
      Effect.map((rows) => rows.map(toBoardCardEvent)),
      Effect.mapError(toBoardRepositoryError("BoardRepository.listEvents:query")),
    );

  const appendEvent: BoardRepositoryShape["appendEvent"] = (event) =>
    insertEventRow(event).pipe(
      Effect.mapError(toBoardRepositoryError("BoardRepository.appendEvent:query")),
    );

  return {
    listOrchestrators,
    addOrchestrator,
    removeOrchestrator,
    listCards,
    getCard,
    createCard,
    updateCard,
    deleteCard,
    listEvents,
    appendEvent,
  } satisfies BoardRepositoryShape;
});

export const BoardRepositoryLive = Layer.effect(BoardRepository, makeBoardRepository);

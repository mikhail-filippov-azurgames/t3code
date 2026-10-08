import {
  BoardArchivedCount,
  BoardCard,
  BoardCardDeletionRecord,
  BoardCardEvent,
  BoardCardEventId,
  BoardCardId,
  BoardOrchestrator,
  IsoDateTime,
  ModelSelection,
  NonNegativeInt,
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
import { applyAuthorTextPolicy, type AuthorTextField } from "../../security/SecretTextPolicy.ts";

import {
  AddBoardOrchestratorInput,
  archiveRequiresDoneFailure,
  BoardRepository,
  BoardRepositoryError,
  type BoardRepositoryShape,
} from "../Services/Board.ts";

const ListScopeInput = Schema.Struct({ includeArchived: Schema.Boolean });
const GetOrchestratorInput = Schema.Struct({ threadId: ThreadId });
const GetCardInput = Schema.Struct({ cardId: BoardCardId });
const FindCardByExecutorInput = Schema.Struct({ executorThreadId: ThreadId });
const FindCardsByPrefixInput = Schema.Struct({
  prefix: Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}$/)),
});
const ListCardEventsInput = Schema.Struct({
  cardId: BoardCardId,
  limit: Schema.optional(NonNegativeInt),
});
const HasWorkingReadyCardInput = Schema.Struct({ orchestratorThreadId: ThreadId });
const HasCardEventInput = Schema.Struct({ entryId: BoardCardEventId });
const ExistsDbRow = Schema.Struct({ exists: Schema.Number });
const RetentionCandidatesInput = Schema.Struct({
  cutoff: IsoDateTime,
  limit: NonNegativeInt,
});

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

const boardCardAuthorTextFailure = (
  card: BoardCard,
  previous?: Pick<BoardCard, "title" | "body" | "lastError" | "readinessNote">,
): BoardRepositoryError | null => {
  const texts: ReadonlyArray<readonly [AuthorTextField, string, boolean]> = [
    ["title", card.title, previous === undefined || card.title !== previous.title],
    ["body", card.body, previous === undefined || card.body !== previous.body],
    ...(card.lastError === null
      ? []
      : [
          [
            "lastError",
            card.lastError,
            previous === undefined || card.lastError !== previous.lastError,
          ] as const,
        ]),
    ...(card.readinessNote === null
      ? []
      : [
          [
            "readinessNote",
            card.readinessNote,
            previous === undefined || card.readinessNote !== previous.readinessNote,
          ] as const,
        ]),
  ];
  for (const [field, text, changed] of texts) {
    if (!changed) continue;
    try {
      if (applyAuthorTextPolicy(field, text)._tag === "Accepted") continue;
    } catch {
      // A failed check must reject persisted board text.
    }
    return new BoardRepositoryError({
      operation: `BoardRepository.${field}:author_text_rejected`,
      detail: `The authored ${field} could not be confirmed secret-free. Remove sensitive values and try again.`,
    });
  }
  return null;
};

const boardCardWriteFailure = (
  card: BoardCard,
  previous: BoardCard | undefined,
): BoardRepositoryError | null =>
  archiveRequiresDoneFailure(card, previous) ?? boardCardAuthorTextFailure(card, previous);

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
          readiness,
          readiness_note,
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
          ${row.readiness},
          ${row.readinessNote},
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
            readiness = ${row.readiness},
            readiness_note = ${row.readinessNote},
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
          readiness,
          readiness_note AS "readinessNote",
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

  const findCardByExecutorRow = SqlSchema.findOneOption({
    Request: FindCardByExecutorInput,
    Result: BoardCardDbRow,
    execute: ({ executorThreadId }) =>
      sql`
        SELECT
          card_id AS "cardId",
          orchestrator_thread_id AS "orchestratorThreadId",
          title,
          body,
          status,
          readiness,
          readiness_note AS "readinessNote",
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
        WHERE executor_thread_id = ${executorThreadId}
        ORDER BY orchestrator_thread_id ASC, order_index ASC, created_at ASC, card_id ASC
        LIMIT 1
      `,
  });

  const listCardsByExecutorRows = SqlSchema.findAll({
    Request: FindCardByExecutorInput,
    Result: BoardCardDbRow,
    execute: ({ executorThreadId }) =>
      sql`
        SELECT
          card_id AS "cardId",
          orchestrator_thread_id AS "orchestratorThreadId",
          title,
          body,
          status,
          readiness,
          readiness_note AS "readinessNote",
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
        WHERE executor_thread_id = ${executorThreadId}
        ORDER BY orchestrator_thread_id ASC, order_index ASC, created_at ASC, card_id ASC
      `,
  });

  const listCardRows = SqlSchema.findAll({
    Request: ListScopeInput,
    Result: BoardCardDbRow,
    execute: ({ includeArchived }) =>
      sql`
        SELECT
          card_id AS "cardId",
          orchestrator_thread_id AS "orchestratorThreadId",
          title,
          body,
          status,
          readiness,
          readiness_note AS "readinessNote",
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
        ${includeArchived ? sql`` : sql`WHERE archived = 0`}
        ORDER BY orchestrator_thread_id ASC, order_index ASC, created_at ASC, card_id ASC
      `,
  });

  const countArchivedCardRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardArchivedCount,
    execute: () =>
      sql`
        SELECT
          orchestrator_thread_id AS "orchestratorThreadId",
          status,
          COUNT(*) AS "count"
        FROM board_cards
        WHERE archived = 1
        GROUP BY orchestrator_thread_id, status
        ORDER BY orchestrator_thread_id ASC, status ASC
      `,
  });

  const listNudgeCandidateCardRows = SqlSchema.findAll({
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
          readiness,
          readiness_note AS "readinessNote",
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
        WHERE archived = 0
          AND (
            status IN ('orchestrator', 'review', 'todo', 'in_progress')
            OR readiness = 'needs_human'
            OR failure_streak >= 3
          )
        ORDER BY orchestrator_thread_id ASC, order_index ASC, created_at ASC, card_id ASC
      `,
  });

  const hasWorkingReadyCardRow = SqlSchema.findOne({
    Request: HasWorkingReadyCardInput,
    Result: ExistsDbRow,
    execute: ({ orchestratorThreadId }) =>
      sql`
        SELECT EXISTS (
          SELECT 1
          FROM board_cards
          WHERE orchestrator_thread_id = ${orchestratorThreadId}
            AND archived = 0
            AND readiness = 'ready'
            AND status IN ('todo', 'orchestrator', 'in_progress', 'review')
          LIMIT 1
        ) AS "exists"
      `,
  });

  const hasCardEventRow = SqlSchema.findOne({
    Request: HasCardEventInput,
    Result: ExistsDbRow,
    execute: ({ entryId }) =>
      sql`
        SELECT EXISTS (
          SELECT 1
          FROM board_card_events
          WHERE entry_id = ${entryId}
          LIMIT 1
        ) AS "exists"
      `,
  });

  const findCardsByPrefixRows = SqlSchema.findAll({
    Request: FindCardsByPrefixInput,
    Result: BoardCardDbRow,
    execute: ({ prefix }) =>
      sql`
        SELECT
          card_id AS "cardId",
          orchestrator_thread_id AS "orchestratorThreadId",
          title,
          body,
          status,
          readiness,
          readiness_note AS "readinessNote",
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
        WHERE card_id GLOB ${`${prefix}*`}
        ORDER BY card_id ASC
        LIMIT 2
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
    Request: ListScopeInput,
    Result: BoardCardEventDbRow,
    execute: ({ includeArchived }) =>
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
        ${
          includeArchived
            ? sql``
            : sql`WHERE card_id IN (SELECT card_id FROM board_cards WHERE archived = 0)`
        }
        ORDER BY at ASC, entry_id ASC
      `,
  });

  const listCardEventRows = SqlSchema.findAll({
    Request: ListCardEventsInput,
    Result: BoardCardEventDbRow,
    execute: ({ cardId, limit }) =>
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
        WHERE card_id = ${cardId}
        ORDER BY
          at ${limit === undefined ? sql`ASC` : sql`DESC`},
          entry_id ${limit === undefined ? sql`ASC` : sql`DESC`}
        ${limit === undefined ? sql`` : sql`LIMIT ${limit}`}
      `,
  });

  const listArchiveCandidateRows = SqlSchema.findAll({
    Request: RetentionCandidatesInput,
    Result: BoardCardDbRow,
    execute: ({ cutoff, limit }) =>
      sql`
        SELECT
          card_id AS "cardId",
          orchestrator_thread_id AS "orchestratorThreadId",
          title,
          body,
          status,
          readiness,
          readiness_note AS "readinessNote",
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
        WHERE status = 'done' AND archived = 0 AND updated_at <= ${cutoff}
        ORDER BY updated_at ASC, card_id ASC
        LIMIT ${limit}
      `,
  });

  const listDeleteCandidateRows = SqlSchema.findAll({
    Request: RetentionCandidatesInput,
    Result: BoardCardDbRow,
    execute: ({ cutoff, limit }) =>
      sql`
        SELECT
          card_id AS "cardId",
          orchestrator_thread_id AS "orchestratorThreadId",
          title,
          body,
          status,
          readiness,
          readiness_note AS "readinessNote",
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
        WHERE status = 'done' AND archived = 1 AND updated_at <= ${cutoff}
        ORDER BY updated_at ASC, card_id ASC
        LIMIT ${limit}
      `,
  });

  const insertDeletionRow = SqlSchema.void({
    Request: BoardCardDeletionRecord,
    execute: (row) =>
      sql`
        INSERT INTO board_card_deletions (
          card_id,
          orchestrator_thread_id,
          deleted_at,
          reason,
          history_event_count
        )
        VALUES (
          ${row.cardId},
          ${row.orchestratorThreadId},
          ${row.deletedAt},
          ${row.reason},
          ${row.historyEventCount}
        )
      `,
  });

  const listDeletionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardCardDeletionRecord,
    execute: () =>
      sql`
        SELECT
          card_id AS "cardId",
          orchestrator_thread_id AS "orchestratorThreadId",
          deleted_at AS "deletedAt",
          reason,
          history_event_count AS "historyEventCount"
        FROM board_card_deletions
        ORDER BY deleted_at ASC, card_id ASC
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

  const listCards: BoardRepositoryShape["listCards"] = (input) =>
    listCardRows({ includeArchived: input?.includeArchived ?? true }).pipe(
      Effect.map((rows) => rows.map(toBoardCard)),
      Effect.mapError(toBoardRepositoryError("BoardRepository.listCards:query")),
    );

  const countArchivedCards: BoardRepositoryShape["countArchivedCards"] = () =>
    countArchivedCardRows().pipe(
      Effect.mapError(toBoardRepositoryError("BoardRepository.countArchivedCards:query")),
    );

  const listNudgeCandidateCards: BoardRepositoryShape["listNudgeCandidateCards"] = () =>
    listNudgeCandidateCardRows().pipe(
      Effect.map((rows) => rows.map(toBoardCard)),
      Effect.mapError(toBoardRepositoryError("BoardRepository.listNudgeCandidateCards:query")),
    );

  const hasWorkingReadyCard: BoardRepositoryShape["hasWorkingReadyCard"] = (orchestratorThreadId) =>
    hasWorkingReadyCardRow({ orchestratorThreadId }).pipe(
      Effect.map((row) => row.exists === 1),
      Effect.mapError(toBoardRepositoryError("BoardRepository.hasWorkingReadyCard:query")),
    );

  const hasCardEvent: BoardRepositoryShape["hasCardEvent"] = (entryId) =>
    hasCardEventRow({ entryId }).pipe(
      Effect.map((row) => row.exists === 1),
      Effect.mapError(toBoardRepositoryError("BoardRepository.hasCardEvent:query")),
    );

  const findCardsByPrefix: BoardRepositoryShape["findCardsByPrefix"] = (prefix) =>
    findCardsByPrefixRows({ prefix }).pipe(
      Effect.map((rows) => rows.map(toBoardCard)),
      Effect.mapError(toBoardRepositoryError("BoardRepository.findCardsByPrefix:query")),
    );

  const getCardById = (cardId: BoardCardId, operation: string) =>
    getCardRow({ cardId }).pipe(
      Effect.map(Option.map(toBoardCard)),
      Effect.mapError(toBoardRepositoryError(operation)),
    );

  const getCard: BoardRepositoryShape["getCard"] = (cardId) =>
    getCardById(cardId, "BoardRepository.getCard:query");

  const findCardByExecutor: BoardRepositoryShape["findCardByExecutor"] = (executorThreadId) =>
    findCardByExecutorRow({ executorThreadId }).pipe(
      Effect.map(Option.map(toBoardCard)),
      Effect.mapError(toBoardRepositoryError("BoardRepository.findCardByExecutor:query")),
    );

  const listCardsByExecutor: BoardRepositoryShape["listCardsByExecutor"] = (executorThreadId) =>
    listCardsByExecutorRows({ executorThreadId }).pipe(
      Effect.map((rows) => rows.map(toBoardCard)),
      Effect.mapError(toBoardRepositoryError("BoardRepository.listCardsByExecutor:query")),
    );

  const createCard: BoardRepositoryShape["createCard"] = (card) => {
    const textFailure = boardCardWriteFailure(card, undefined);
    return textFailure === null
      ? insertCardRow(card).pipe(
          Effect.mapError(toBoardRepositoryError("BoardRepository.createCard:query")),
        )
      : Effect.fail(textFailure);
  };

  const updateCard: BoardRepositoryShape["updateCard"] = (card) =>
    getCardById(card.cardId, "BoardRepository.updateCard:read").pipe(
      Effect.flatMap((previous) => {
        const textFailure = boardCardWriteFailure(card, Option.getOrUndefined(previous));
        return textFailure === null
          ? updateCardRow(card).pipe(
              Effect.mapError(toBoardRepositoryError("BoardRepository.updateCard:query")),
            )
          : Effect.fail(textFailure);
      }),
    );

  const updateCardWithPrevious: BoardRepositoryShape["updateCardWithPrevious"] = (
    card,
    previous,
  ) => {
    const textFailure = boardCardWriteFailure(card, Option.getOrUndefined(previous));
    return textFailure === null
      ? updateCardRow(card).pipe(
          Effect.mapError(toBoardRepositoryError("BoardRepository.updateCardWithPrevious:query")),
        )
      : Effect.fail(textFailure);
  };

  const deleteCard: BoardRepositoryShape["deleteCard"] = (cardId) =>
    deleteCardRow({ cardId }).pipe(
      Effect.mapError(toBoardRepositoryError("BoardRepository.deleteCard:query")),
    );

  const listEvents: BoardRepositoryShape["listEvents"] = (input) =>
    listEventRows({ includeArchived: input?.includeArchived ?? true }).pipe(
      Effect.map((rows) => rows.map(toBoardCardEvent)),
      Effect.mapError(toBoardRepositoryError("BoardRepository.listEvents:query")),
    );

  const listEventsForCard: BoardRepositoryShape["listEventsForCard"] = (input) =>
    listCardEventRows(input).pipe(
      Effect.map((rows) => rows.map(toBoardCardEvent)),
      Effect.mapError(toBoardRepositoryError("BoardRepository.listEventsForCard:query")),
    );

  const appendEvent: BoardRepositoryShape["appendEvent"] = (event) =>
    insertEventRow(event).pipe(
      Effect.mapError(toBoardRepositoryError("BoardRepository.appendEvent:query")),
    );

  const listArchiveCandidates: BoardRepositoryShape["listArchiveCandidates"] = (input) =>
    listArchiveCandidateRows(input).pipe(
      Effect.map((rows) => rows.map(toBoardCard)),
      Effect.mapError(toBoardRepositoryError("BoardRepository.listArchiveCandidates:query")),
    );

  const listDeleteCandidates: BoardRepositoryShape["listDeleteCandidates"] = (input) =>
    listDeleteCandidateRows(input).pipe(
      Effect.map((rows) => rows.map(toBoardCard)),
      Effect.mapError(toBoardRepositoryError("BoardRepository.listDeleteCandidates:query")),
    );

  const updateCardWithEvent: BoardRepositoryShape["updateCardWithEvent"] = (card, event) =>
    getCardById(card.cardId, "BoardRepository.updateCardWithEvent:read").pipe(
      Effect.flatMap((previous) => {
        const textFailure = boardCardWriteFailure(card, Option.getOrUndefined(previous));
        return textFailure === null
          ? sql
              .withTransaction(
                updateCardRow(card).pipe(Effect.flatMap(() => insertEventRow(event))),
              )
              .pipe(
                Effect.mapError(
                  toBoardRepositoryError("BoardRepository.updateCardWithEvent:query"),
                ),
              )
          : Effect.fail(textFailure);
      }),
    );

  const deleteCardWithRecord: BoardRepositoryShape["deleteCardWithRecord"] = (input) =>
    sql
      .withTransaction(
        insertDeletionRow({
          cardId: input.cardId,
          orchestratorThreadId: input.orchestratorThreadId,
          deletedAt: input.deletedAt,
          reason: input.reason,
          historyEventCount: input.historyEventCount,
        }).pipe(Effect.flatMap(() => deleteCardRow({ cardId: input.cardId }))),
      )
      .pipe(Effect.mapError(toBoardRepositoryError("BoardRepository.deleteCardWithRecord:query")));

  const listDeletionRecords: BoardRepositoryShape["listDeletionRecords"] = () =>
    listDeletionRows().pipe(
      Effect.mapError(toBoardRepositoryError("BoardRepository.listDeletionRecords:query")),
    );

  return {
    listOrchestrators,
    addOrchestrator,
    removeOrchestrator,
    listCards,
    countArchivedCards,
    listNudgeCandidateCards,
    hasWorkingReadyCard,
    hasCardEvent,
    findCardsByPrefix,
    getCard,
    findCardByExecutor,
    listCardsByExecutor,
    createCard,
    updateCard,
    updateCardWithPrevious,
    deleteCard,
    listEvents,
    listEventsForCard,
    appendEvent,
    listArchiveCandidates,
    listDeleteCandidates,
    updateCardWithEvent,
    deleteCardWithRecord,
    listDeletionRecords,
  } satisfies BoardRepositoryShape;
});

export const BoardRepositoryLive = Layer.effect(BoardRepository, makeBoardRepository);

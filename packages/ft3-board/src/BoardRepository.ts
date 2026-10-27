import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Contracts from "./contracts.ts";
import { applyAuthorTextPolicy } from "./authorTextPolicy.ts";

export class BoardRepositoryError extends Schema.TaggedError<BoardRepositoryError>()(
  "BoardRepositoryError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `The board repository could not ${this.operation}.`;
  }
}

type WriteError = BoardRepositoryError | Contracts.BoardMcpFailure;
export class BoardRepository extends Context.Service<
  BoardRepository,
  {
    readonly listOrchestrators: () => Effect.Effect<
      ReadonlyArray<Contracts.BoardOrchestrator>,
      BoardRepositoryError
    >;
    readonly addOrchestrator: (input: {
      readonly threadId: ThreadId;
      readonly createdBy: "human";
      readonly createdAt: string;
    }) => Effect.Effect<Contracts.BoardOrchestrator, BoardRepositoryError>;
    readonly removeOrchestrator: (threadId: ThreadId) => Effect.Effect<void, BoardRepositoryError>;
    readonly getCard: (
      cardId: Contracts.BoardCardId,
    ) => Effect.Effect<Contracts.BoardCard | null, BoardRepositoryError>;
    readonly listCards: (
      orchestratorThreadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<Contracts.BoardCard>, BoardRepositoryError>;
    readonly createCard: (
      card: Contracts.BoardCard,
      events?: ReadonlyArray<Contracts.BoardCardEvent>,
    ) => Effect.Effect<void, WriteError>;
    readonly updateCard: (
      card: Contracts.BoardCard,
      events?: ReadonlyArray<Contracts.BoardCardEvent>,
    ) => Effect.Effect<void, WriteError>;
    readonly deleteCard: (
      cardId: Contracts.BoardCardId,
    ) => Effect.Effect<void, BoardRepositoryError>;
    readonly listEventsForCard: (
      cardId: Contracts.BoardCardId,
    ) => Effect.Effect<ReadonlyArray<Contracts.BoardCardEvent>, BoardRepositoryError>;
    readonly listDeletionRecords: () => Effect.Effect<
      ReadonlyArray<Contracts.BoardCardDeletionRecord>,
      BoardRepositoryError
    >;
    readonly listCardsAll: (input: {
      readonly includeArchived: boolean;
    }) => Effect.Effect<ReadonlyArray<Contracts.BoardCard>, BoardRepositoryError>;
    readonly listEventsAll: (input: {
      readonly includeArchived: boolean;
    }) => Effect.Effect<ReadonlyArray<Contracts.BoardCardEvent>, BoardRepositoryError>;
    readonly countArchivedCards: () => Effect.Effect<
      ReadonlyArray<{
        readonly orchestratorThreadId: ThreadId;
        readonly status: Contracts.BoardCard["status"];
        readonly count: number;
      }>,
      BoardRepositoryError
    >;
    readonly findCardsByPrefix: (
      prefix: string,
    ) => Effect.Effect<ReadonlyArray<Contracts.BoardCard>, BoardRepositoryError>;
    readonly listArchiveCandidates: (input: {
      readonly cutoff: string;
      readonly limit: number;
    }) => Effect.Effect<
      ReadonlyArray<{ readonly cardId: Contracts.BoardCardId }>,
      BoardRepositoryError
    >;
    readonly listDeleteCandidates: (input: {
      readonly cutoff: string;
      readonly limit: number;
    }) => Effect.Effect<
      ReadonlyArray<{ readonly cardId: Contracts.BoardCardId }>,
      BoardRepositoryError
    >;
    readonly listNudgeCandidateCards: () => Effect.Effect<
      ReadonlyArray<Contracts.BoardCard>,
      BoardRepositoryError
    >;
    readonly hasWorkingReadyCard: (
      orchestratorThreadId: ThreadId,
    ) => Effect.Effect<boolean, BoardRepositoryError>;
    readonly hasCardEvent: (
      entryId: Contracts.BoardCardEventId,
    ) => Effect.Effect<boolean, BoardRepositoryError>;
    readonly deleteCardWithRecord: (input: {
      readonly card: Contracts.BoardCard;
      readonly deletedAt: string;
      readonly reason: "retention" | "executor-thread-deleted";
    }) => Effect.Effect<void, BoardRepositoryError>;
  }
>()("@t3tools/ft3-board/BoardRepository") {}

export const buildBoardCardEvent = (
  card: Contracts.BoardCard,
  input: {
    readonly at: string;
    readonly body: string;
    readonly entryId: Contracts.BoardCardEventId;
  },
): Contracts.BoardCardEvent => ({
  entryId: input.entryId,
  cardId: card.cardId,
  at: input.at,
  status: card.status,
  executorRole: card.executorRole,
  model: card.assignee?.model ?? null,
  effort: null,
  body: input.body,
  source: "system",
});

const CardRow = Schema.Struct({
  ...Contracts.BoardCard.fields,
  assignee: Schema.NullOr(Schema.String),
  archived: Schema.Number,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(CardRow));
const decodeCard = Schema.decodeUnknownEffect(Contracts.BoardCard);
const decodeEvent = Schema.decodeUnknownEffect(Contracts.BoardCardEvent);
const decodeEvents = Schema.decodeUnknownEffect(Schema.Array(Contracts.BoardCardEvent));
const decodeOrchestrator = Schema.decodeUnknownEffect(Contracts.BoardOrchestrator);
const decodeOrchestrators = Schema.decodeUnknownEffect(Schema.Array(Contracts.BoardOrchestrator));
const decodeDeletions = Schema.decodeUnknownEffect(Schema.Array(Contracts.BoardCardDeletionRecord));
const decodeAssignee = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Contracts.BoardCard.fields.assignee),
);
const databaseError = (operation: string) => (cause: unknown) =>
  new BoardRepositoryError({ operation, cause });

export const validateAuthoredText = Effect.fn("Ft3BoardRepository.validateAuthoredText")((
  field: "title" | "body" | "lastError" | "readinessNote",
  text: string,
): Effect.Effect<void, Contracts.BoardMcpFailure> => {
  try {
    if (applyAuthorTextPolicy(field, text)._tag === "Accepted") return Effect.void;
  } catch {
    // Reject when verification fails.
  }
  return Effect.fail(
    new Contracts.BoardMcpFailure({
      code: "author_text_rejected",
      message: `The authored ${field} could not be confirmed secret-free. Remove sensitive values and try again.`,
    }),
  );
});

const validateWrite = Effect.fn("Ft3BoardRepository.validateWrite")(function* (
  card: Contracts.BoardCard,
  previous: Contracts.BoardCard | null,
) {
  const unfinishedArchive = (value: Contracts.BoardCard) =>
    value.archived && value.status !== "done";
  if (unfinishedArchive(card) && (previous === null || !unfinishedArchive(previous))) {
    return yield* new Contracts.BoardMcpFailure({
      code: "archive_requires_done",
      message: "Only done cards can be archived. Move the card to done first, or omit archived.",
    });
  }
  for (const field of ["title", "body", "lastError", "readinessNote"] as const) {
    const text = card[field];
    if (text !== null && (previous === null || text !== previous[field]))
      yield* validateAuthoredText(field, text);
  }
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql`
    card_id AS "cardId", orchestrator_thread_id AS "orchestratorThreadId", title, body, status,
    readiness, readiness_note AS "readinessNote", created_by AS "createdBy", assignee_json AS assignee,
    executor_role AS "executorRole", executor_thread_id AS "executorThreadId", outcome, last_error AS "lastError",
    failure_streak AS "failureStreak", order_index AS "order", archived, created_at AS "createdAt", updated_at AS "updatedAt"
  `;
  const cardsFromRows = Effect.fn("Ft3BoardRepository.decodeCards")(function* (rows: unknown) {
    const decoded = yield* decodeRows(rows);
    return yield* Effect.forEach(decoded, (row) =>
      Effect.gen(function* () {
        const assignee = row.assignee === null ? null : yield* decodeAssignee(row.assignee);
        return { ...row, assignee, archived: row.archived === 1 };
      }),
    );
  });
  const getCard = Effect.fn("Ft3BoardRepository.getCard")(
    function* (cardId: Contracts.BoardCardId) {
      const rows = yield* sql`SELECT ${columns} FROM ft3_board_cards WHERE card_id = ${cardId}`;
      const cards = yield* cardsFromRows(rows);
      return cards[0] ?? null;
    },
    Effect.mapError(databaseError("read card")),
  );
  const insertEvents = Effect.fn("Ft3BoardRepository.insertEvents")(function* (
    events: ReadonlyArray<Contracts.BoardCardEvent>,
  ) {
    for (const input of events) {
      const event = yield* decodeEvent(input);
      yield* sql`INSERT INTO ft3_board_card_events ${sql.insert({ entry_id: event.entryId, card_id: event.cardId, at: event.at, status: event.status, executor_role: event.executorRole, model: event.model, effort: event.effort, body: event.body ?? null, source: event.source })}`;
    }
  });
  const cardValues = (card: Contracts.BoardCard) => ({
    card_id: card.cardId,
    orchestrator_thread_id: card.orchestratorThreadId,
    title: card.title,
    body: card.body,
    status: card.status,
    readiness: card.readiness,
    readiness_note: card.readinessNote,
    created_by: card.createdBy,
    assignee_json: card.assignee === null ? null : JSON.stringify(card.assignee),
    executor_role: card.executorRole,
    executor_thread_id: card.executorThreadId,
    outcome: card.outcome,
    last_error: card.lastError,
    failure_streak: card.failureStreak,
    order_index: card.order,
    archived: card.archived ? 1 : 0,
    created_at: card.createdAt,
    updated_at: card.updatedAt,
  });
  return BoardRepository.of({
    listOrchestrators: Effect.fn("Ft3BoardRepository.listOrchestrators")(
      function* () {
        const rows =
          yield* sql`SELECT thread_id AS "threadId", created_by AS "createdBy", created_at AS "createdAt" FROM ft3_board_orchestrators ORDER BY created_at, thread_id`;
        return yield* decodeOrchestrators(rows);
      },
      Effect.mapError(databaseError("list orchestrators")),
    ),
    addOrchestrator: Effect.fn("Ft3BoardRepository.addOrchestrator")(
      function* (input) {
        yield* sql`INSERT INTO ft3_board_orchestrators (thread_id, created_by, created_at) VALUES (${input.threadId}, ${input.createdBy}, ${input.createdAt}) ON CONFLICT (thread_id) DO NOTHING`;
        const rows =
          yield* sql`SELECT thread_id AS "threadId", created_by AS "createdBy", created_at AS "createdAt" FROM ft3_board_orchestrators WHERE thread_id = ${input.threadId}`;
        return yield* decodeOrchestrator(rows[0]);
      },
      Effect.mapError(databaseError("add orchestrator")),
    ),
    removeOrchestrator: Effect.fn("Ft3BoardRepository.removeOrchestrator")((threadId) =>
      sql`DELETE FROM ft3_board_orchestrators WHERE thread_id = ${threadId}`.pipe(
        Effect.asVoid,
        Effect.mapError(databaseError("remove orchestrator")),
      ),
    ),
    getCard,
    listCards: Effect.fn("Ft3BoardRepository.listCards")(
      function* (threadId) {
        return yield* cardsFromRows(
          yield* sql`SELECT ${columns} FROM ft3_board_cards WHERE orchestrator_thread_id = ${threadId} ORDER BY order_index, card_id`,
        );
      },
      Effect.mapError(databaseError("list cards")),
    ),
    createCard: Effect.fn("Ft3BoardRepository.createCard")(function* (input, events = []) {
      const card = yield* decodeCard(input).pipe(Effect.mapError(databaseError("decode card")));
      yield* validateWrite(card, null);
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO ft3_board_cards ${sql.insert(cardValues(card))}`;
            yield* insertEvents(events);
          }),
        )
        .pipe(Effect.mapError(databaseError("create card")));
    }),
    updateCard: Effect.fn("Ft3BoardRepository.updateCard")(function* (input, events = []) {
      const card = yield* decodeCard(input).pipe(Effect.mapError(databaseError("decode card")));
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const previous = yield* getCard(card.cardId);
            yield* validateWrite(card, previous);
            yield* sql`UPDATE ft3_board_cards SET ${sql.update(cardValues(card), ["card_id", "orchestrator_thread_id", "created_by", "created_at"])} WHERE card_id = ${card.cardId} AND orchestrator_thread_id = ${card.orchestratorThreadId}`.pipe(
              Effect.mapError(databaseError("update card")),
            );
            yield* insertEvents(events).pipe(Effect.mapError(databaseError("append card events")));
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "OrchestratorMcpFailure" || error._tag === "BoardRepositoryError"
              ? error
              : databaseError("update card")(error),
          ),
        );
    }),
    deleteCard: Effect.fn("Ft3BoardRepository.deleteCard")((cardId) =>
      sql`DELETE FROM ft3_board_cards WHERE card_id = ${cardId}`.pipe(
        Effect.asVoid,
        Effect.mapError(databaseError("delete card")),
      ),
    ),
    listEventsForCard: Effect.fn("Ft3BoardRepository.listEventsForCard")(
      function* (cardId) {
        const rows =
          yield* sql`SELECT entry_id AS "entryId", card_id AS "cardId", at, status, executor_role AS "executorRole", model, effort, body, source FROM ft3_board_card_events WHERE card_id = ${cardId} ORDER BY at, entry_id`;
        return yield* decodeEvents(
          rows.map(({ body, ...row }) => (body === null ? row : { ...row, body })),
        );
      },
      Effect.mapError(databaseError("list card events")),
    ),
    listDeletionRecords: Effect.fn("Ft3BoardRepository.listDeletionRecords")(
      function* () {
        const rows =
          yield* sql`SELECT card_id AS "cardId", orchestrator_thread_id AS "orchestratorThreadId", deleted_at AS "deletedAt", reason, history_event_count AS "historyEventCount" FROM ft3_board_card_deletions ORDER BY deleted_at, card_id`;
        return yield* decodeDeletions(rows);
      },
      Effect.mapError(databaseError("list deletion records")),
    ),
    listCardsAll: Effect.fn("Ft3BoardRepository.listCardsAll")(
      function* (input) {
        const rows = input.includeArchived
          ? yield* sql`SELECT ${columns} FROM ft3_board_cards ORDER BY order_index, card_id`
          : yield* sql`SELECT ${columns} FROM ft3_board_cards WHERE archived = 0 ORDER BY order_index, card_id`;
        return yield* cardsFromRows(rows);
      },
      Effect.mapError(databaseError("list all cards")),
    ),
    listEventsAll: Effect.fn("Ft3BoardRepository.listEventsAll")(
      function* (input) {
        const rows = input.includeArchived
          ? yield* sql`SELECT e.entry_id AS "entryId", e.card_id AS "cardId", e.at, e.status, e.executor_role AS "executorRole", e.model, e.effort, e.body, e.source FROM ft3_board_card_events e ORDER BY e.at, e.entry_id`
          : yield* sql`SELECT e.entry_id AS "entryId", e.card_id AS "cardId", e.at, e.status, e.executor_role AS "executorRole", e.model, e.effort, e.body, e.source FROM ft3_board_card_events e JOIN ft3_board_cards c ON c.card_id = e.card_id WHERE c.archived = 0 ORDER BY e.at, e.entry_id`;
        return yield* decodeEvents(
          rows.map(({ body, ...row }) => (body === null ? row : { ...row, body })),
        );
      },
      Effect.mapError(databaseError("list all card events")),
    ),
    countArchivedCards: Effect.fn("Ft3BoardRepository.countArchivedCards")(
      function* () {
        const rows = yield* sql<{
          readonly orchestratorThreadId: string;
          readonly status: string;
          readonly count: number;
        }>`SELECT orchestrator_thread_id AS "orchestratorThreadId", status, COUNT(*) AS "count" FROM ft3_board_cards WHERE archived = 1 GROUP BY orchestrator_thread_id, status`;
        return rows.map((row) => ({
          orchestratorThreadId: ThreadId.make(row.orchestratorThreadId),
          status: Schema.decodeUnknownSync(Contracts.BoardCardStatus)(row.status),
          count: row.count,
        }));
      },
      Effect.mapError(databaseError("count archived cards")),
    ),
    findCardsByPrefix: Effect.fn("Ft3BoardRepository.findCardsByPrefix")(
      function* (prefix) {
        return yield* cardsFromRows(
          yield* sql`SELECT ${columns} FROM ft3_board_cards WHERE card_id LIKE ${`${prefix}%`}`,
        );
      },
      Effect.mapError(databaseError("find cards by prefix")),
    ),
    listArchiveCandidates: Effect.fn("Ft3BoardRepository.listArchiveCandidates")(
      function* (input) {
        const rows = yield* sql<{ readonly cardId: string }>`
          SELECT card_id AS "cardId" FROM ft3_board_cards
          WHERE status = 'done' AND archived = 0 AND updated_at <= ${input.cutoff}
          ORDER BY updated_at, card_id
          LIMIT ${input.limit}
        `;
        return rows.map((row) => ({ cardId: Contracts.BoardCardId.make(row.cardId) }));
      },
      Effect.mapError(databaseError("list archive candidates")),
    ),
    listDeleteCandidates: Effect.fn("Ft3BoardRepository.listDeleteCandidates")(
      function* (input) {
        const rows = yield* sql<{ readonly cardId: string }>`
          SELECT card_id AS "cardId" FROM ft3_board_cards
          WHERE status = 'done' AND archived = 1 AND updated_at <= ${input.cutoff}
          ORDER BY updated_at, card_id
          LIMIT ${input.limit}
        `;
        return rows.map((row) => ({ cardId: Contracts.BoardCardId.make(row.cardId) }));
      },
      Effect.mapError(databaseError("list delete candidates")),
    ),
    listNudgeCandidateCards: Effect.fn("Ft3BoardRepository.listNudgeCandidateCards")(
      function* () {
        return yield* cardsFromRows(
          yield* sql`SELECT ${columns} FROM ft3_board_cards
            WHERE archived = 0
              AND (status IN ('orchestrator', 'review', 'todo')
                OR readiness = 'needs_human'
                OR failure_streak >= 3)
            ORDER BY orchestrator_thread_id, order_index, created_at, card_id`,
        );
      },
      Effect.mapError(databaseError("list nudge candidates")),
    ),
    hasWorkingReadyCard: Effect.fn("Ft3BoardRepository.hasWorkingReadyCard")(
      function* (orchestratorThreadId) {
        const rows = yield* sql<{ readonly present: number }>`
          SELECT 1 AS "present" FROM ft3_board_cards
          WHERE orchestrator_thread_id = ${orchestratorThreadId}
            AND archived = 0 AND readiness = 'ready'
            AND status IN ('todo', 'orchestrator', 'in_progress', 'review')
          LIMIT 1
        `;
        return rows.length > 0;
      },
      Effect.mapError(databaseError("check working ready card")),
    ),
    hasCardEvent: Effect.fn("Ft3BoardRepository.hasCardEvent")(
      function* (entryId) {
        const rows = yield* sql<{ readonly present: number }>`
          SELECT 1 AS "present" FROM ft3_board_card_events WHERE entry_id = ${entryId} LIMIT 1
        `;
        return rows.length > 0;
      },
      Effect.mapError(databaseError("check card event")),
    ),
    deleteCardWithRecord: Effect.fn("Ft3BoardRepository.deleteCardWithRecord")(
      function* (input) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO ft3_board_card_deletions (card_id, orchestrator_thread_id, deleted_at, reason, history_event_count)
              SELECT card_id, orchestrator_thread_id, ${input.deletedAt}, ${input.reason},
                (SELECT COUNT(*) FROM ft3_board_card_events e WHERE e.card_id = c.card_id)
              FROM ft3_board_cards c WHERE card_id = ${input.card.cardId}
              ON CONFLICT DO NOTHING`;
            yield* sql`DELETE FROM ft3_board_cards WHERE card_id = ${input.card.cardId}`;
          }),
        );
      },
      Effect.mapError(databaseError("delete card with record")),
    ),
  });
});

export const layer = Layer.effect(BoardRepository, make);

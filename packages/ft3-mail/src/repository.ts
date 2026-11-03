import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type {
  MailDelivery,
  MailDeliveryState,
  MailIsolation,
  MailKindFeedback,
  MailLetter,
  MailLetterKind,
  MailLevel,
  MailMember,
  MailMemberStatus,
  MailOutcome,
  MailPlanPhase,
  MailRound,
  MailRoundKind,
  MailTask,
  MailTaskStatus,
  MailTimelineEntry,
  MailWake,
} from "./contracts.ts";

export class MailRepositoryError extends Schema.TaggedError<MailRepositoryError>()(
  "MailRepositoryError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `The mail repository could not ${this.operation}.`;
  }
}

/** A retried request reused its idempotency key with a different payload. */
export class MailIdempotencyConflict extends Schema.TaggedError<MailIdempotencyConflict>()(
  "MailIdempotencyConflict",
  {
    operation: Schema.String,
    key: Schema.String,
  },
) {
  override get message() {
    return `The mail repository rejected a repeated ${this.operation} with a different payload.`;
  }
}

export interface AppendLetterResult {
  readonly letter: MailLetter;
  readonly created: boolean;
}

export interface CreateTaskInput {
  readonly taskId: string;
  readonly title: string;
  readonly brief: string;
  readonly level: MailLevel;
  readonly cardId: string | null;
  readonly isolation: MailIsolation | null;
  readonly runtimeMode: string | null;
  readonly interactionMode: string | null;
  readonly responseBudgetSeconds: number;
  readonly createdByThreadId: string;
  readonly clientRequestId: string;
  readonly requestFingerprint: string;
  readonly createdAt: string;
}

export interface AddMemberInput {
  readonly memberId: string;
  readonly taskId: string;
  readonly roleId: string;
  readonly specialization: string | null;
  readonly level: MailLevel | null;
  readonly responseBudgetSeconds: number | null;
  readonly documentsWrite: boolean;
  readonly modelOverrideJson: string | null;
  readonly humanInstruction: string | null;
  readonly participantThreadId: string | null;
  readonly createdAt: string;
}

export interface AppendLetterInput {
  readonly letterId: string;
  readonly taskId: string;
  readonly senderThreadId: string;
  readonly recipient: string;
  readonly kind: MailLetterKind;
  readonly body: string;
  readonly replyToLetterId: string | null;
  readonly sourceLetterId: string | null;
  readonly planPhase: MailPlanPhase | null;
  readonly planStep: string | null;
  readonly planSha256: string | null;
  readonly planDocId: string | null;
  readonly classifierKind: MailLetterKind | null;
  readonly classifierConfidence: number | null;
  readonly kindDisputed: boolean;
  readonly leadKind: MailLetterKind | null;
  readonly clientRequestId: string;
  readonly requestFingerprint: string;
  readonly createdAt: string;
}

export interface RecordDeliveryInput {
  readonly deliveryId: string;
  readonly taskId: string;
  readonly letterId: string;
  readonly memberId: string | null;
  readonly recipient: string;
  readonly participantThreadId: string | null;
  readonly createdAt: string;
}

export interface CreateRoundInput {
  readonly roundId: string;
  readonly taskId: string;
  readonly roundNumber: number;
  readonly kind: MailRoundKind;
  readonly openedAt: string;
}

export interface CreateRoundResult {
  readonly round: MailRound;
  readonly created: boolean;
}

export interface RecordWakeInput {
  readonly wakeId: string;
  readonly taskId: string;
  readonly targetThreadId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export interface RecordWakeResult {
  readonly wake: MailWake;
  readonly created: boolean;
}

export interface RecordKindFeedbackInput {
  readonly letterId: string;
  readonly senderKind: MailLetterKind;
  readonly classifierKind: MailLetterKind | null;
  readonly confidence: number | null;
  readonly leadKind: MailLetterKind | null;
  readonly classifierVersion: string | null;
  readonly createdAt: string;
}

export interface SetLetterClassifierInput {
  readonly letterId: string;
  readonly classifierKind: MailLetterKind | null;
  readonly classifierConfidence: number | null;
  readonly kindDisputed: boolean;
  readonly leadKind: MailLetterKind | null;
}

export interface MailTimelineInput {
  readonly taskId: string;
  readonly beforeSequence?: number;
  readonly limit: number;
}

interface TaskRow {
  readonly taskId: string;
  readonly title: string;
  readonly brief: string;
  readonly level: MailLevel;
  readonly cardId: string | null;
  readonly isolation: MailIsolation | null;
  readonly runtimeMode: string | null;
  readonly interactionMode: string | null;
  readonly responseBudgetSeconds: number;
  readonly status: MailTaskStatus;
  readonly outcome: MailOutcome | null;
  readonly summary: string | null;
  readonly createdByThreadId: string;
  readonly clientRequestId: string;
  readonly requestFingerprint: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

interface MemberRow {
  readonly memberId: string;
  readonly taskId: string;
  readonly roleId: string;
  readonly specialization: string | null;
  readonly level: MailLevel | null;
  readonly responseBudgetSeconds: number | null;
  readonly documentsWrite: number;
  readonly modelOverrideJson: string | null;
  readonly humanInstruction: string | null;
  readonly participantThreadId: string | null;
  readonly status: MailMemberStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface LetterRow {
  readonly letterId: string;
  readonly taskId: string;
  readonly sequence: number;
  readonly senderThreadId: string;
  readonly recipient: string;
  readonly kind: MailLetterKind;
  readonly body: string;
  readonly replyToLetterId: string | null;
  readonly sourceLetterId: string | null;
  readonly planPhase: MailPlanPhase | null;
  readonly planStep: string | null;
  readonly planSha256: string | null;
  readonly planDocId: string | null;
  readonly classifierKind: MailLetterKind | null;
  readonly classifierConfidence: number | null;
  readonly kindDisputed: number;
  readonly leadKind: MailLetterKind | null;
  readonly clientRequestId: string;
  readonly requestFingerprint: string;
  readonly createdAt: string;
}

interface DeliveryRow {
  readonly deliveryId: string;
  readonly taskId: string;
  readonly letterId: string;
  readonly memberId: string | null;
  readonly recipient: string;
  readonly participantThreadId: string | null;
  readonly state: MailDeliveryState;
  readonly deliveredAt: string | null;
  readonly readAt: string | null;
  readonly answeredAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RoundRow {
  readonly roundId: string;
  readonly taskId: string;
  readonly roundNumber: number;
  readonly kind: MailRoundKind;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly outcome: MailOutcome | null;
}

interface WakeRow {
  readonly wakeId: string;
  readonly taskId: string;
  readonly targetThreadId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
}

interface KindFeedbackRow {
  readonly letterId: string;
  readonly senderKind: MailLetterKind;
  readonly classifierKind: MailLetterKind | null;
  readonly confidence: number | null;
  readonly leadKind: MailLetterKind | null;
  readonly classifierVersion: string | null;
  readonly createdAt: string;
}

const TASK_COLUMNS = `
  task_id AS "taskId", title, brief, level, card_id AS "cardId", isolation,
  runtime_mode AS "runtimeMode", interaction_mode AS "interactionMode",
  response_budget_seconds AS "responseBudgetSeconds", status, outcome, summary,
  created_by_thread_id AS "createdByThreadId", client_request_id AS "clientRequestId",
  request_fingerprint AS "requestFingerprint", created_at AS "createdAt",
  updated_at AS "updatedAt", closed_at AS "closedAt"
`;

const MEMBER_COLUMNS = `
  member_id AS "memberId", task_id AS "taskId", role_id AS "roleId",
  specialization, level, response_budget_seconds AS "responseBudgetSeconds",
  documents_write AS "documentsWrite", model_override_json AS "modelOverrideJson",
  human_instruction AS "humanInstruction", participant_thread_id AS "participantThreadId",
  status, created_at AS "createdAt", updated_at AS "updatedAt"
`;

const LETTER_COLUMNS = `
  letter_id AS "letterId", task_id AS "taskId", sequence,
  sender_thread_id AS "senderThreadId", recipient, kind, body,
  reply_to_letter_id AS "replyToLetterId", source_letter_id AS "sourceLetterId",
  plan_phase AS "planPhase", plan_step AS "planStep", plan_sha256 AS "planSha256",
  plan_doc_id AS "planDocId", classifier_kind AS "classifierKind",
  classifier_confidence AS "classifierConfidence", kind_disputed AS "kindDisputed",
  lead_kind AS "leadKind", client_request_id AS "clientRequestId",
  request_fingerprint AS "requestFingerprint", created_at AS "createdAt"
`;

const DELIVERY_COLUMNS = `
  delivery_id AS "deliveryId", task_id AS "taskId", letter_id AS "letterId",
  member_id AS "memberId", recipient, participant_thread_id AS "participantThreadId",
  state, delivered_at AS "deliveredAt", read_at AS "readAt",
  answered_at AS "answeredAt", created_at AS "createdAt", updated_at AS "updatedAt"
`;

const ROUND_COLUMNS = `
  round_id AS "roundId", task_id AS "taskId", round_number AS "roundNumber", kind,
  opened_at AS "openedAt", closed_at AS "closedAt", outcome
`;

const WAKE_COLUMNS = `
  wake_id AS "wakeId", task_id AS "taskId", target_thread_id AS "targetThreadId",
  reason, idempotency_key AS "idempotencyKey", created_at AS "createdAt",
  delivered_at AS "deliveredAt"
`;

const KIND_FEEDBACK_COLUMNS = `
  letter_id AS "letterId", sender_kind AS "senderKind",
  classifier_kind AS "classifierKind", confidence, lead_kind AS "leadKind",
  classifier_version AS "classifierVersion", created_at AS "createdAt"
`;

const toTask = (row: TaskRow): MailTask => ({
  taskId: row.taskId,
  title: row.title,
  brief: row.brief,
  level: row.level,
  cardId: row.cardId,
  isolation: row.isolation,
  runtimeMode: row.runtimeMode,
  interactionMode: row.interactionMode,
  responseBudgetSeconds: row.responseBudgetSeconds,
  status: row.status,
  outcome: row.outcome,
  summary: row.summary,
  createdByThreadId: row.createdByThreadId,
  clientRequestId: row.clientRequestId,
  requestFingerprint: row.requestFingerprint,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  closedAt: row.closedAt,
});

const toMember = (row: MemberRow): MailMember => ({
  memberId: row.memberId,
  taskId: row.taskId,
  roleId: row.roleId,
  specialization: row.specialization,
  level: row.level,
  responseBudgetSeconds: row.responseBudgetSeconds,
  documentsWrite: row.documentsWrite === 1,
  modelOverrideJson: row.modelOverrideJson,
  humanInstruction: row.humanInstruction,
  participantThreadId: row.participantThreadId,
  status: row.status,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toLetter = (row: LetterRow): MailLetter => ({
  letterId: row.letterId,
  taskId: row.taskId,
  sequence: row.sequence,
  senderThreadId: row.senderThreadId,
  recipient: row.recipient,
  kind: row.kind,
  body: row.body,
  replyToLetterId: row.replyToLetterId,
  sourceLetterId: row.sourceLetterId,
  planPhase: row.planPhase,
  planStep: row.planStep,
  planSha256: row.planSha256,
  planDocId: row.planDocId,
  classifierKind: row.classifierKind,
  classifierConfidence: row.classifierConfidence,
  kindDisputed: row.kindDisputed === 1,
  leadKind: row.leadKind,
  clientRequestId: row.clientRequestId,
  requestFingerprint: row.requestFingerprint,
  createdAt: row.createdAt,
});

const toDelivery = (row: DeliveryRow): MailDelivery => ({
  deliveryId: row.deliveryId,
  taskId: row.taskId,
  letterId: row.letterId,
  memberId: row.memberId,
  recipient: row.recipient,
  participantThreadId: row.participantThreadId,
  state: row.state,
  deliveredAt: row.deliveredAt,
  readAt: row.readAt,
  answeredAt: row.answeredAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toRound = (row: RoundRow): MailRound => ({
  roundId: row.roundId,
  taskId: row.taskId,
  roundNumber: row.roundNumber,
  kind: row.kind,
  openedAt: row.openedAt,
  closedAt: row.closedAt,
  outcome: row.outcome,
});

const toWake = (row: WakeRow): MailWake => ({
  wakeId: row.wakeId,
  taskId: row.taskId,
  targetThreadId: row.targetThreadId,
  reason: row.reason,
  idempotencyKey: row.idempotencyKey,
  createdAt: row.createdAt,
  deliveredAt: row.deliveredAt,
});

const toKindFeedback = (row: KindFeedbackRow): MailKindFeedback => ({
  letterId: row.letterId,
  senderKind: row.senderKind,
  classifierKind: row.classifierKind,
  confidence: row.confidence,
  leadKind: row.leadKind,
  classifierVersion: row.classifierVersion,
  createdAt: row.createdAt,
});

const isIdempotencyConflict = (value: unknown): value is MailIdempotencyConflict =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "MailIdempotencyConflict";

const mapError =
  (operation: string) =>
  <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, MailRepositoryError> =>
    Effect.mapError(effect, (cause) => new MailRepositoryError({ operation, cause }));

/** Keeps the conflict error, which the service turns into `idempotency_conflict`. */
const mapIdempotentError =
  (operation: string) =>
  <A, E>(
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, MailRepositoryError | MailIdempotencyConflict> =>
    Effect.mapError(effect, (cause) =>
      isIdempotencyConflict(cause) ? cause : new MailRepositoryError({ operation, cause }),
    );

export class MailRepository extends Context.Service<
  MailRepository,
  {
    readonly createTask: (
      input: CreateTaskInput,
    ) => Effect.Effect<MailTask, MailRepositoryError | MailIdempotencyConflict>;
    readonly getTask: (taskId: string) => Effect.Effect<MailTask | null, MailRepositoryError>;
    readonly closeTask: (input: {
      readonly taskId: string;
      readonly outcome: MailOutcome;
      readonly summary: string;
      readonly closedAt: string;
    }) => Effect.Effect<MailTask | null, MailRepositoryError>;
    readonly addMember: (input: AddMemberInput) => Effect.Effect<MailMember, MailRepositoryError>;
    readonly listMembers: (
      taskId: string,
    ) => Effect.Effect<ReadonlyArray<MailMember>, MailRepositoryError>;
    readonly appendLetter: (
      input: AppendLetterInput,
    ) => Effect.Effect<AppendLetterResult, MailRepositoryError | MailIdempotencyConflict>;
    readonly getLetter: (letterId: string) => Effect.Effect<MailLetter | null, MailRepositoryError>;
    readonly recordDelivery: (
      input: RecordDeliveryInput,
    ) => Effect.Effect<MailDelivery, MailRepositoryError>;
    readonly createRound: (
      input: CreateRoundInput,
    ) => Effect.Effect<CreateRoundResult, MailRepositoryError>;
    readonly closeRound: (input: {
      readonly roundId: string;
      readonly outcome: MailOutcome;
      readonly closedAt: string;
    }) => Effect.Effect<MailRound | null, MailRepositoryError>;
    readonly listRounds: (
      taskId: string,
    ) => Effect.Effect<ReadonlyArray<MailRound>, MailRepositoryError>;
    readonly recordWake: (
      input: RecordWakeInput,
    ) => Effect.Effect<RecordWakeResult, MailRepositoryError>;
    readonly recordKindFeedback: (
      input: RecordKindFeedbackInput,
    ) => Effect.Effect<MailKindFeedback, MailRepositoryError>;
    readonly setLetterClassifier: (
      input: SetLetterClassifierInput,
    ) => Effect.Effect<MailLetter | null, MailRepositoryError>;
    readonly markDeliveryDelivered: (input: {
      readonly deliveryId: string;
      readonly at: string;
    }) => Effect.Effect<MailDelivery | null, MailRepositoryError>;
    readonly markDeliveryRead: (input: {
      readonly deliveryId: string;
      readonly at: string;
    }) => Effect.Effect<MailDelivery | null, MailRepositoryError>;
    readonly markDeliveryAnswered: (input: {
      readonly deliveryId: string;
      readonly at: string;
    }) => Effect.Effect<MailDelivery | null, MailRepositoryError>;
    readonly listTimeline: (
      input: MailTimelineInput,
    ) => Effect.Effect<ReadonlyArray<MailTimelineEntry>, MailRepositoryError>;
    readonly purgeFinishedTasks: (input: {
      readonly before: string;
      readonly limit: number;
    }) => Effect.Effect<number, MailRepositoryError>;
  }
>()("@t3tools/ft3-mail/repository/MailRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findTaskByKey = (input: {
    readonly createdByThreadId: string;
    readonly clientRequestId: string;
  }) =>
    sql<TaskRow>`SELECT ${sql.literal(TASK_COLUMNS)} FROM ft3_mail_tasks
      WHERE created_by_thread_id = ${input.createdByThreadId}
        AND client_request_id = ${input.clientRequestId}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : toTask(rows[0]))),
    );

  const findLetterByKey = (input: {
    readonly taskId: string;
    readonly senderThreadId: string;
    readonly clientRequestId: string;
  }) =>
    sql<LetterRow>`SELECT ${sql.literal(LETTER_COLUMNS)} FROM ft3_mail_letters
      WHERE task_id = ${input.taskId} AND sender_thread_id = ${input.senderThreadId}
        AND client_request_id = ${input.clientRequestId}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : toLetter(rows[0]))),
    );

  const findTask = (taskId: string) =>
    sql<TaskRow>`SELECT ${sql.literal(TASK_COLUMNS)} FROM ft3_mail_tasks WHERE task_id = ${taskId}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : toTask(rows[0]))),
    );

  const findLetter = (letterId: string) =>
    sql<LetterRow>`SELECT ${sql.literal(LETTER_COLUMNS)} FROM ft3_mail_letters
      WHERE letter_id = ${letterId}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : toLetter(rows[0]))),
    );

  const findDelivery = (deliveryId: string) =>
    sql<DeliveryRow>`SELECT ${sql.literal(DELIVERY_COLUMNS)} FROM ft3_mail_deliveries
      WHERE delivery_id = ${deliveryId}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : toDelivery(rows[0]))),
    );

  const findRoundByNumber = (input: { readonly taskId: string; readonly roundNumber: number }) =>
    sql<RoundRow>`SELECT ${sql.literal(ROUND_COLUMNS)} FROM ft3_mail_rounds
      WHERE task_id = ${input.taskId} AND round_number = ${input.roundNumber}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : toRound(rows[0]))),
    );

  const findRound = (roundId: string) =>
    sql<RoundRow>`SELECT ${sql.literal(ROUND_COLUMNS)} FROM ft3_mail_rounds
      WHERE round_id = ${roundId}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : toRound(rows[0]))),
    );

  const findWakeByKey = (idempotencyKey: string) =>
    sql<WakeRow>`SELECT ${sql.literal(WAKE_COLUMNS)} FROM ft3_mail_wakes
      WHERE idempotency_key = ${idempotencyKey}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : toWake(rows[0]))),
    );

  const findKindFeedback = (letterId: string) =>
    sql<KindFeedbackRow>`SELECT ${sql.literal(KIND_FEEDBACK_COLUMNS)}
      FROM ft3_mail_kind_feedback WHERE letter_id = ${letterId}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : toKindFeedback(rows[0]))),
    );

  const updateDelivery = Effect.fn("MailRepository.updateDelivery")(function* (
    deliveryId: string,
    at: string,
    assignment: "delivered" | "read" | "answered",
  ) {
    const delivered = assignment === "delivered" ? 1 : 0;
    const read = assignment === "read" || assignment === "answered" ? 1 : 0;
    const answered = assignment === "answered" ? 1 : 0;
    const deliveredOrRead = assignment === "delivered" || read === 1 ? 1 : 0;
    yield* sql`UPDATE ft3_mail_deliveries SET
        delivered_at = CASE WHEN ${deliveredOrRead} = 1 THEN COALESCE(delivered_at, ${at}) ELSE delivered_at END,
        read_at = CASE WHEN ${read} = 1 THEN COALESCE(read_at, ${at}) ELSE read_at END,
        answered_at = CASE WHEN ${answered} = 1 THEN COALESCE(answered_at, ${at}) ELSE answered_at END,
        state = CASE
          WHEN state = 'answered' THEN 'answered'
          WHEN ${answered} = 1 THEN 'answered'
          WHEN ${read} = 1 THEN 'read'
          WHEN ${delivered} = 1 THEN 'delivered'
          ELSE state
        END,
        updated_at = ${at}
      WHERE delivery_id = ${deliveryId}`;
    return yield* findDelivery(deliveryId);
  });

  return MailRepository.of({
    createTask: Effect.fn("MailRepository.createTask")((input: CreateTaskInput) =>
      mapIdempotentError("createTask")(
        Effect.gen(function* () {
          yield* sql`INSERT INTO ft3_mail_tasks (
              task_id, title, brief, level, card_id, isolation, runtime_mode, interaction_mode,
              response_budget_seconds, status, created_by_thread_id, client_request_id,
              request_fingerprint, created_at, updated_at
            ) VALUES (
              ${input.taskId}, ${input.title}, ${input.brief}, ${input.level}, ${input.cardId},
              ${input.isolation}, ${input.runtimeMode}, ${input.interactionMode},
              ${input.responseBudgetSeconds}, 'open', ${input.createdByThreadId},
              ${input.clientRequestId}, ${input.requestFingerprint}, ${input.createdAt},
              ${input.createdAt}
            ) ON CONFLICT(created_by_thread_id, client_request_id) DO NOTHING`;
          const task = yield* findTaskByKey({
            createdByThreadId: input.createdByThreadId,
            clientRequestId: input.clientRequestId,
          });
          if (task === null) {
            return yield* Effect.die(new Error("the inserted mail task is missing"));
          }
          if (task.requestFingerprint !== input.requestFingerprint) {
            return yield* new MailIdempotencyConflict({
              operation: "createTask",
              key: `${input.createdByThreadId}:${input.clientRequestId}`,
            });
          }
          return task;
        }),
      ),
    ),
    getTask: Effect.fn("MailRepository.getTask")((taskId: string) =>
      mapError("getTask")(findTask(taskId)),
    ),
    closeTask: Effect.fn("MailRepository.closeTask")((input) =>
      mapError("closeTask")(
        Effect.gen(function* () {
          yield* sql`UPDATE ft3_mail_tasks SET
              status = 'closed', outcome = ${input.outcome}, summary = ${input.summary},
              closed_at = ${input.closedAt}, updated_at = ${input.closedAt}
            WHERE task_id = ${input.taskId}`;
          return yield* findTask(input.taskId);
        }),
      ),
    ),
    addMember: Effect.fn("MailRepository.addMember")((input: AddMemberInput) =>
      mapError("addMember")(
        Effect.gen(function* () {
          yield* sql`INSERT INTO ft3_mail_members (
              member_id, task_id, role_id, specialization, level, response_budget_seconds,
              documents_write, model_override_json, human_instruction, participant_thread_id,
              status, created_at, updated_at
            ) VALUES (
              ${input.memberId}, ${input.taskId}, ${input.roleId}, ${input.specialization},
              ${input.level}, ${input.responseBudgetSeconds}, ${input.documentsWrite ? 1 : 0},
              ${input.modelOverrideJson}, ${input.humanInstruction}, ${input.participantThreadId},
              'active', ${input.createdAt}, ${input.createdAt}
            ) ON CONFLICT(member_id) DO NOTHING`;
          const rows = yield* sql<MemberRow>`SELECT ${sql.literal(MEMBER_COLUMNS)}
            FROM ft3_mail_members WHERE member_id = ${input.memberId}`;
          const row = rows[0];
          if (row === undefined) {
            return yield* Effect.die(new Error("the inserted mail member is missing"));
          }
          return toMember(row);
        }),
      ),
    ),
    listMembers: Effect.fn("MailRepository.listMembers")((taskId: string) =>
      mapError("listMembers")(
        sql<MemberRow>`SELECT ${sql.literal(MEMBER_COLUMNS)} FROM ft3_mail_members
          WHERE task_id = ${taskId} ORDER BY created_at ASC, member_id ASC`,
      ).pipe(Effect.map((rows) => rows.map(toMember))),
    ),
    appendLetter: Effect.fn("MailRepository.appendLetter")((input: AppendLetterInput) =>
      mapIdempotentError("appendLetter")(
        sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* findLetterByKey({
              taskId: input.taskId,
              senderThreadId: input.senderThreadId,
              clientRequestId: input.clientRequestId,
            });
            if (existing !== null) {
              if (existing.requestFingerprint !== input.requestFingerprint) {
                return yield* new MailIdempotencyConflict({
                  operation: "appendLetter",
                  key: `${input.taskId}:${input.senderThreadId}:${input.clientRequestId}`,
                });
              }
              return { letter: existing, created: false };
            }

            const last = yield* sql<{
              readonly sequence: number;
            }>`SELECT COALESCE(MAX(sequence), 0) AS sequence
              FROM ft3_mail_letters WHERE task_id = ${input.taskId}`;
            const sequence = (last[0]?.sequence ?? 0) + 1;
            yield* sql`INSERT INTO ft3_mail_letters (
                letter_id, task_id, sequence, sender_thread_id, recipient, kind, body,
                reply_to_letter_id, source_letter_id, plan_phase, plan_step, plan_sha256,
                plan_doc_id, classifier_kind, classifier_confidence, kind_disputed, lead_kind,
                client_request_id, request_fingerprint, created_at
              ) VALUES (
                ${input.letterId}, ${input.taskId}, ${sequence}, ${input.senderThreadId},
                ${input.recipient}, ${input.kind}, ${input.body}, ${input.replyToLetterId},
                ${input.sourceLetterId}, ${input.planPhase}, ${input.planStep},
                ${input.planSha256}, ${input.planDocId}, ${input.classifierKind},
                ${input.classifierConfidence}, ${input.kindDisputed ? 1 : 0}, ${input.leadKind},
                ${input.clientRequestId}, ${input.requestFingerprint}, ${input.createdAt}
              )`;
            const letter = yield* findLetterByKey({
              taskId: input.taskId,
              senderThreadId: input.senderThreadId,
              clientRequestId: input.clientRequestId,
            });
            if (letter === null) {
              return yield* Effect.die(new Error("the inserted mail letter is missing"));
            }
            return { letter, created: true };
          }),
        ),
      ),
    ),
    getLetter: Effect.fn("MailRepository.getLetter")((letterId: string) =>
      mapError("getLetter")(findLetter(letterId)),
    ),
    recordDelivery: Effect.fn("MailRepository.recordDelivery")((input: RecordDeliveryInput) =>
      mapError("recordDelivery")(
        Effect.gen(function* () {
          yield* sql`INSERT INTO ft3_mail_deliveries (
              delivery_id, task_id, letter_id, member_id, recipient, participant_thread_id,
              state, created_at, updated_at
            ) VALUES (
              ${input.deliveryId}, ${input.taskId}, ${input.letterId}, ${input.memberId},
              ${input.recipient}, ${input.participantThreadId}, 'pending', ${input.createdAt},
              ${input.createdAt}
            ) ON CONFLICT(letter_id, recipient) DO NOTHING`;
          const rows = yield* sql<DeliveryRow>`SELECT ${sql.literal(DELIVERY_COLUMNS)}
            FROM ft3_mail_deliveries
            WHERE letter_id = ${input.letterId} AND recipient = ${input.recipient}`;
          const row = rows[0];
          if (row === undefined) {
            return yield* Effect.die(new Error("the inserted mail delivery is missing"));
          }
          return toDelivery(row);
        }),
      ),
    ),
    markDeliveryDelivered: Effect.fn("MailRepository.markDeliveryDelivered")((input) =>
      mapError("markDeliveryDelivered")(updateDelivery(input.deliveryId, input.at, "delivered")),
    ),
    markDeliveryRead: Effect.fn("MailRepository.markDeliveryRead")((input) =>
      mapError("markDeliveryRead")(updateDelivery(input.deliveryId, input.at, "read")),
    ),
    markDeliveryAnswered: Effect.fn("MailRepository.markDeliveryAnswered")((input) =>
      mapError("markDeliveryAnswered")(updateDelivery(input.deliveryId, input.at, "answered")),
    ),
    createRound: Effect.fn("MailRepository.createRound")((input: CreateRoundInput) =>
      mapError("createRound")(
        sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* findRoundByNumber({
              taskId: input.taskId,
              roundNumber: input.roundNumber,
            });
            if (existing !== null) return { round: existing, created: false };
            yield* sql`INSERT INTO ft3_mail_rounds (
                round_id, task_id, round_number, kind, opened_at
              ) VALUES (
                ${input.roundId}, ${input.taskId}, ${input.roundNumber}, ${input.kind},
                ${input.openedAt}
              )`;
            const round = yield* findRound(input.roundId);
            if (round === null) {
              return yield* Effect.die(new Error("the inserted mail round is missing"));
            }
            return { round, created: true };
          }),
        ),
      ),
    ),
    closeRound: Effect.fn("MailRepository.closeRound")((input) =>
      mapError("closeRound")(
        Effect.gen(function* () {
          yield* sql`UPDATE ft3_mail_rounds SET
              closed_at = ${input.closedAt}, outcome = ${input.outcome}
            WHERE round_id = ${input.roundId}`;
          return yield* findRound(input.roundId);
        }),
      ),
    ),
    listRounds: Effect.fn("MailRepository.listRounds")((taskId: string) =>
      mapError("listRounds")(
        sql<RoundRow>`SELECT ${sql.literal(ROUND_COLUMNS)} FROM ft3_mail_rounds
          WHERE task_id = ${taskId} ORDER BY round_number ASC`,
      ).pipe(Effect.map((rows) => rows.map(toRound))),
    ),
    recordWake: Effect.fn("MailRepository.recordWake")((input: RecordWakeInput) =>
      mapError("recordWake")(
        sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* findWakeByKey(input.idempotencyKey);
            if (existing !== null) return { wake: existing, created: false };
            yield* sql`INSERT INTO ft3_mail_wakes (
                wake_id, task_id, target_thread_id, reason, idempotency_key, created_at
              ) VALUES (
                ${input.wakeId}, ${input.taskId}, ${input.targetThreadId}, ${input.reason},
                ${input.idempotencyKey}, ${input.createdAt}
              ) ON CONFLICT(idempotency_key) DO NOTHING`;
            const wake = yield* findWakeByKey(input.idempotencyKey);
            if (wake === null) {
              return yield* Effect.die(new Error("the inserted mail wake is missing"));
            }
            return { wake, created: true };
          }),
        ),
      ),
    ),
    recordKindFeedback: Effect.fn("MailRepository.recordKindFeedback")(
      (input: RecordKindFeedbackInput) =>
        mapError("recordKindFeedback")(
          Effect.gen(function* () {
            yield* sql`INSERT INTO ft3_mail_kind_feedback (
                letter_id, sender_kind, classifier_kind, confidence, lead_kind,
                classifier_version, created_at
              ) VALUES (
                ${input.letterId}, ${input.senderKind}, ${input.classifierKind},
                ${input.confidence}, ${input.leadKind}, ${input.classifierVersion},
                ${input.createdAt}
              ) ON CONFLICT(letter_id) DO UPDATE SET
                sender_kind = excluded.sender_kind,
                classifier_kind = excluded.classifier_kind,
                confidence = excluded.confidence,
                lead_kind = excluded.lead_kind,
                classifier_version = excluded.classifier_version,
                created_at = excluded.created_at`;
            const feedback = yield* findKindFeedback(input.letterId);
            if (feedback === null) {
              return yield* Effect.die(new Error("the recorded mail kind feedback is missing"));
            }
            return feedback;
          }),
        ),
    ),
    setLetterClassifier: Effect.fn("MailRepository.setLetterClassifier")(
      (input: SetLetterClassifierInput) =>
        mapError("setLetterClassifier")(
          Effect.gen(function* () {
            yield* sql`UPDATE ft3_mail_letters SET
                classifier_kind = ${input.classifierKind},
                classifier_confidence = ${input.classifierConfidence},
                kind_disputed = ${input.kindDisputed ? 1 : 0},
                lead_kind = ${input.leadKind}
              WHERE letter_id = ${input.letterId}`;
            return yield* findLetter(input.letterId);
          }),
        ),
    ),
    listTimeline: Effect.fn("MailRepository.listTimeline")((input: MailTimelineInput) =>
      mapError("listTimeline")(
        Effect.gen(function* () {
          const before = input.beforeSequence ?? null;
          const letters = yield* sql<LetterRow>`SELECT ${sql.literal(LETTER_COLUMNS)}
            FROM ft3_mail_letters
            WHERE task_id = ${input.taskId} AND (${before} IS NULL OR sequence < ${before})
            ORDER BY sequence DESC LIMIT ${input.limit}`;
          const deliveries = yield* sql<DeliveryRow>`SELECT ${sql.literal(DELIVERY_COLUMNS)}
            FROM ft3_mail_deliveries
            WHERE task_id = ${input.taskId} ORDER BY created_at ASC, delivery_id ASC`;
          const byLetter = new Map<string, MailDelivery[]>();
          for (const row of deliveries) {
            const list = byLetter.get(row.letterId) ?? [];
            list.push(toDelivery(row));
            byLetter.set(row.letterId, list);
          }
          return letters.map((row) => ({
            letter: toLetter(row),
            deliveries: byLetter.get(row.letterId) ?? [],
          }));
        }),
      ),
    ),
    purgeFinishedTasks: Effect.fn("MailRepository.purgeFinishedTasks")((input) =>
      mapError("purgeFinishedTasks")(
        sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ readonly taskId: string }>`SELECT task_id AS "taskId"
              FROM ft3_mail_tasks
              WHERE status = 'closed' AND closed_at IS NOT NULL AND closed_at < ${input.before}
              ORDER BY closed_at ASC LIMIT ${input.limit}`;
            const ids = rows.map((row) => row.taskId);
            if (ids.length === 0) return 0;
            yield* sql`DELETE FROM ft3_mail_kind_feedback
              WHERE letter_id IN (
                SELECT letter_id FROM ft3_mail_letters WHERE task_id IN ${sql.in(ids)}
              )`;
            yield* sql`DELETE FROM ft3_mail_wakes WHERE task_id IN ${sql.in(ids)}`;
            yield* sql`DELETE FROM ft3_mail_rounds WHERE task_id IN ${sql.in(ids)}`;
            yield* sql`DELETE FROM ft3_mail_deliveries WHERE task_id IN ${sql.in(ids)}`;
            yield* sql`DELETE FROM ft3_mail_letters WHERE task_id IN ${sql.in(ids)}`;
            yield* sql`DELETE FROM ft3_mail_members WHERE task_id IN ${sql.in(ids)}`;
            yield* sql`DELETE FROM ft3_mail_tasks WHERE task_id IN ${sql.in(ids)}`;
            return ids.length;
          }),
        ),
      ),
    ),
  });
});

export const layer = Layer.effect(MailRepository, make);

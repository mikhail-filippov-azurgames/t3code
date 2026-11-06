import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { effectiveLetterKind } from "./classifier.ts";
import { MailRepository, type MailIdempotencyConflict, MailRepositoryError } from "./repository.ts";
import {
  FT3_MAIL_WS_METHODS,
  type MailLetterRpcInput,
  type MailTasksRpcInput,
  type MailTimelineRpcInput,
} from "./rpc-contracts.ts";
import { MailService, MailServiceError } from "./service.ts";
import { MailMcpFailure } from "./toolContracts.ts";

export { FT3_MAIL_WS_METHODS, mailRpcs, mailRpcScopes } from "./rpc-contracts.ts";
export type {
  MailLetterRpcInput,
  MailLetterRpcSuccess,
  MailTasksRpcInput,
  MailTasksRpcSuccess,
  MailTimelineRpcInput,
  MailTimelineRpcSuccess,
} from "./rpc-contracts.ts";

const isMailServiceError = Schema.is(MailServiceError);

/** The board panel lists at most this many mail tasks per refresh. */
const MAIL_TASKS_MAX_LIMIT = 50;
/** A batched task page carries at most this many letters per task. */
const MAIL_TASKS_MAX_LETTERS = 100;

const toMcpFailure = (
  error: MailServiceError | MailRepositoryError | MailIdempotencyConflict,
): MailMcpFailure => {
  if (isMailServiceError(error)) {
    if (error.code === "mail_disabled") {
      return new MailMcpFailure({ code: "mail_disabled_notice", message: error.message });
    }
    return new MailMcpFailure({ code: error.code, message: error.message });
  }
  if (error._tag === "MailIdempotencyConflict") {
    return new MailMcpFailure({ code: "idempotency_conflict", message: error.message });
  }
  return new MailMcpFailure({ code: "internal", message: error.message });
};

/**
 * The RPC handlers take MailService and MailRepository from scope; the host
 * provides its enriched mail stack, which carries both.
 */
export const mailRpcHandlers = {
  [FT3_MAIL_WS_METHODS.mailTimeline]: Effect.fn("MailRpc.mailTimeline")(function* (
    input: MailTimelineRpcInput,
  ) {
    // The human client reads through the lead's eyes; orchestration:read
    // already established the operator may see orchestration state.
    const repository = yield* MailRepository;
    const task = yield* repository
      .getTask(input.taskId)
      .pipe(
        Effect.mapError(
          (error) => new MailMcpFailure({ code: "internal", message: error.message }),
        ),
      );
    if (task === null) {
      return yield* new MailMcpFailure({
        code: "task_not_found",
        message: `Mail task "${input.taskId}" was not found.`,
      });
    }
    const service = yield* MailService;
    const entries = yield* service
      .listTimeline({
        callerThreadId: task.createdByThreadId,
        taskId: task.taskId,
        ...(input.beforeSequence === undefined ? {} : { beforeSequence: input.beforeSequence }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      })
      .pipe(Effect.mapError(toMcpFailure));
    return { task, entries };
  }),
  [FT3_MAIL_WS_METHODS.mailTasks]: Effect.fn("MailRpc.mailTasks")(function* (
    input: MailTasksRpcInput,
  ) {
    // Task listing mirrors the timeline: the history of board cards stays
    // readable while the mail feature is off, so no feature gate here.
    const limit = input.limit ?? MAIL_TASKS_MAX_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAIL_TASKS_MAX_LIMIT) {
      return yield* new MailMcpFailure({
        code: "invalid_request",
        message: `A mail tasks limit must be 1..${MAIL_TASKS_MAX_LIMIT}.`,
      });
    }
    let lettersPerTask: number | null = null;
    if (input.lettersPerTask !== undefined) {
      if (
        !Number.isInteger(input.lettersPerTask) ||
        input.lettersPerTask < 1 ||
        input.lettersPerTask > MAIL_TASKS_MAX_LETTERS
      ) {
        return yield* new MailMcpFailure({
          code: "invalid_request",
          message: `A lettersPerTask limit must be 1..${MAIL_TASKS_MAX_LETTERS}.`,
        });
      }
      lettersPerTask = input.lettersPerTask;
    }
    const repository = yield* MailRepository;
    const tasks = yield* repository
      .listTasksByCardIds({ cardIds: input.cardIds, limit })
      .pipe(
        Effect.mapError(
          (error) => new MailMcpFailure({ code: "internal", message: error.message }),
        ),
      );
    const letters =
      lettersPerTask === null
        ? undefined
        : Object.fromEntries(
            yield* Effect.forEach(tasks, (task) =>
              repository.listTimeline({ taskId: task.taskId, limit: lettersPerTask }).pipe(
                Effect.mapError(
                  (error) => new MailMcpFailure({ code: "internal", message: error.message }),
                ),
                Effect.map((entries) => [task.taskId, entries] as const),
              ),
            ),
          );
    return { tasks, ...(letters === undefined ? {} : { letters }) };
  }),
  [FT3_MAIL_WS_METHODS.mailLetter]: Effect.fn("MailRpc.mailLetter")(function* (
    input: MailLetterRpcInput,
  ) {
    const repository = yield* MailRepository;
    const letter = yield* repository
      .getLetter(input.letterId)
      .pipe(
        Effect.mapError(
          (error) => new MailMcpFailure({ code: "internal", message: error.message }),
        ),
      );
    if (letter === null) {
      return yield* new MailMcpFailure({
        code: "letter_not_found",
        message: `Letter "${input.letterId}" was not found.`,
      });
    }
    const task = yield* repository
      .getTask(letter.taskId)
      .pipe(
        Effect.mapError(
          (error) => new MailMcpFailure({ code: "internal", message: error.message }),
        ),
      );
    // The lead's notice is the only reader here; participants read letters through mail_read.
    if (task === null || task.createdByThreadId !== input.threadId) {
      return yield* new MailMcpFailure({
        code: "capability_denied",
        message: `Letter "${input.letterId}" is not readable from thread "${input.threadId}".`,
      });
    }
    return { letter, effectiveKind: effectiveLetterKind(letter) };
  }),
};

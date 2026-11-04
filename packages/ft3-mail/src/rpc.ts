import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { MailRepository, type MailIdempotencyConflict, MailRepositoryError } from "./repository.ts";
import { FT3_MAIL_WS_METHODS } from "./rpc-contracts.ts";
import { layer as mailServiceLayer } from "./server.ts";
import { MailService, MailServiceError } from "./service.ts";
import { MailMcpFailure } from "./toolContracts.ts";

export { FT3_MAIL_WS_METHODS, mailRpcs, mailRpcScopes } from "./rpc-contracts.ts";
export type { MailTimelineRpcInput, MailTimelineRpcSuccess } from "./rpc-contracts.ts";

const isMailServiceError = Schema.is(MailServiceError);

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

/** The host mail stack backing the RPC handlers. */
export const mailRpcServiceLayer = mailServiceLayer;

export const mailRpcHandlers = {
  [FT3_MAIL_WS_METHODS.mailTimeline]: Effect.fn("MailRpc.mailTimeline")(function* (input: {
    readonly taskId: string;
    readonly beforeSequence?: number;
    readonly limit?: number;
  }) {
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
};

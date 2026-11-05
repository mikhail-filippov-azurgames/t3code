import * as FeatureGate from "@t3tools/ft3-policies/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { toolkitRegistration } from "../../../apps/server/src/mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../../apps/server/src/mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../apps/server/src/mcp/McpToolAccess.ts";
import type { MailIdempotencyConflict } from "./repository.ts";
import { MailRepositoryError } from "./repository.ts";
import { MailService, MailServiceError, type MailMemberRequest } from "./service.ts";
import { MailMcpFailure, type MailMemberRequestInput } from "./toolContracts.ts";
import { toolkit } from "./tools.ts";

type MailFailure = MailServiceError | MailRepositoryError | MailIdempotencyConflict;

const isMailServiceError = Schema.is(MailServiceError);

const toMcpFailure = (error: MailFailure): MailMcpFailure => {
  if (isMailServiceError(error)) {
    if (error.code === "mail_disabled") {
      // The only mail diagnostic the MCP surface reports while off (design §15 row 23).
      return new MailMcpFailure({ code: "mail_disabled_notice", message: error.message });
    }
    return new MailMcpFailure({ code: error.code, message: error.message });
  }
  if (error._tag === "MailIdempotencyConflict") {
    return new MailMcpFailure({ code: "idempotency_conflict", message: error.message });
  }
  return new MailMcpFailure({ code: "internal", message: error.message });
};

/** Mail tools act as the calling thread; outside clients have no caller. */
const callerThreadId = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const threadId = scope.thread?.threadId;
  if (threadId === undefined) {
    return yield* new MailMcpFailure({
      code: "thread_credential_required",
      message: "Mail tools act as the calling T3 thread, so they need an agent inside T3 Code.",
    });
  }
  return String(threadId);
});

const toMemberRequest = (member: MailMemberRequestInput): MailMemberRequest => ({
  role: member.role,
  ...(member.specialization === undefined ? {} : { specialization: member.specialization }),
  ...(member.level === undefined ? {} : { level: member.level }),
  ...(member.responseBudgetSeconds === undefined
    ? {}
    : { responseBudgetSeconds: member.responseBudgetSeconds }),
  ...(member.documentsWrite === undefined ? {} : { documentsWrite: member.documentsWrite }),
  ...(member.modelOverride === undefined ? {} : { modelOverride: member.modelOverride }),
});

/**
 * The mail toolkit over a mail service stack; tests inject the harness stack
 * and gate, the host passes the live stack and feature gate.
 */
export const mailMcpLayerFrom = <E1, R1, E2, R2>(
  serviceLayer: Layer.Layer<MailService, E1, R1>,
  gate: Layer.Layer<FeatureGate.FeatureGate, E2, R2>,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const gateService = yield* FeatureGate.FeatureGate;
      const requireMail = gateService.isEffective("mail").pipe(
        Effect.flatMap((effective) =>
          effective
            ? Effect.void
            : new MailMcpFailure({
                code: "mail_disabled_notice",
                message: "Mail is off for this environment, so no mail tool can run.",
              }),
        ),
      );

      const handlers = McpToolAccess.toLayer(toolkit, {
        mail_task_create: McpToolAccess.actsAsCaller((input) =>
          Effect.gen(function* () {
            yield* requireMail;
            const service = yield* MailService;
            return yield* service
              .createTask({
                title: input.title,
                brief: input.brief,
                level: input.level,
                members: input.members.map(toMemberRequest),
                clientRequestId: input.clientRequestId,
                callerThreadId: yield* callerThreadId,
                ...(input.responseBudgetSeconds === undefined
                  ? {}
                  : { responseBudgetSeconds: input.responseBudgetSeconds }),
              })
              .pipe(Effect.mapError(toMcpFailure));
          }),
        ),
        mail_send: McpToolAccess.actsAsCaller((input) =>
          Effect.gen(function* () {
            yield* requireMail;
            const service = yield* MailService;
            return yield* service
              .sendLetter({
                taskId: input.taskId,
                to: input.to,
                kind: input.kind,
                body: input.body,
                clientRequestId: input.clientRequestId,
                callerThreadId: yield* callerThreadId,
                ...(input.replyToLetterId === undefined
                  ? {}
                  : { replyToLetterId: input.replyToLetterId }),
                ...(input.plan === undefined ? {} : { plan: input.plan }),
              })
              .pipe(Effect.mapError(toMcpFailure));
          }),
        ),
        mail_read: McpToolAccess.readsAsCaller((input) =>
          Effect.gen(function* () {
            const service = yield* MailService;
            return yield* service
              .readLetter({ letterId: input.letterId, callerThreadId: yield* callerThreadId })
              .pipe(Effect.mapError(toMcpFailure));
          }),
        ),
        mail_task_read: McpToolAccess.readsAsCaller((input) =>
          Effect.gen(function* () {
            const service = yield* MailService;
            return yield* service
              .readTask({
                taskId: input.taskId,
                callerThreadId: yield* callerThreadId,
                ...(input.beforeLetterId === undefined
                  ? {}
                  : { beforeLetterId: input.beforeLetterId }),
                ...(input.limit === undefined ? {} : { limit: input.limit }),
              })
              .pipe(Effect.mapError(toMcpFailure));
          }),
        ),
        mail_member_set_model: McpToolAccess.actsAsCaller((input) =>
          Effect.gen(function* () {
            yield* requireMail;
            const service = yield* MailService;
            return yield* service
              .setMemberModel({
                taskId: input.taskId,
                memberId: input.memberId,
                modelSelection: input.modelSelection,
                humanInstruction: input.humanInstruction,
                clientRequestId: input.clientRequestId,
                callerThreadId: yield* callerThreadId,
              })
              .pipe(Effect.mapError(toMcpFailure));
          }),
        ),
        mail_letter_set_kind: McpToolAccess.actsAsCaller((input) =>
          Effect.gen(function* () {
            yield* requireMail;
            const service = yield* MailService;
            return yield* service
              .setLetterKind({
                letterId: input.letterId,
                kind: input.kind,
                clientRequestId: input.clientRequestId,
                callerThreadId: yield* callerThreadId,
              })
              .pipe(Effect.mapError(toMcpFailure));
          }),
        ),
        mail_task_close: McpToolAccess.actsAsCaller((input) =>
          Effect.gen(function* () {
            yield* requireMail;
            const service = yield* MailService;
            return yield* service
              .closeTask({
                taskId: input.taskId,
                outcome: input.outcome,
                summary: input.summary,
                callerThreadId: yield* callerThreadId,
              })
              .pipe(Effect.mapError(toMcpFailure));
          }),
        ),
      });

      return toolkitRegistration(toolkit, handlers).pipe(Layer.provide(serviceLayer));
    }),
  ).pipe(Layer.provide(gate));

import {
  CommandId,
  MessageId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import { FeatureGate } from "@t3tools/ft3-policies/server";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../../../apps/server/src/orchestration-v2/EventSink.ts";
import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../../../apps/server/src/serverActivation.ts";
import {
  decodeParticipantModelSelection,
  participantLabel,
  participantReplyLine,
} from "./participantLauncher.ts";
import { projectIdOfMailTask } from "./projectContext.ts";
import { MailRepository, layer as mailRepositoryLayer } from "./repository.ts";
import { MAIL_URGENT_LETTER_WAKE_REASON, MailService } from "./service.ts";

export class MailReactorError extends Schema.TaggedError<MailReactorError>()("MailReactorError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    return `The mail reactor could not ${this.operation}.`;
  }
}

export class MailDeliveryReactor extends Context.Service<
  MailDeliveryReactor,
  {
    readonly process: (event: OrchestrationV2StoredEvent) => Effect.Effect<void, MailReactorError>;
    readonly recover: Effect.Effect<void, MailReactorError>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/ft3-mail/reactor/MailDeliveryReactor") {}

const terminal = (status: string) =>
  ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(status);

/** Wake rows point at the delivery they were recorded for. */
const WAKE_KEY_PREFIX = "mail:wake:";

const parseWakeDeliveryId = (key: string): string | null =>
  key.startsWith(WAKE_KEY_PREFIX) ? key.slice(WAKE_KEY_PREFIX.length) : null;

const failure = (operation: string) => (cause: unknown) =>
  new MailReactorError({ operation, cause });

type MailWakeDispatchMode = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "message.dispatch" }
>["dispatchMode"];

/**
 * The server's answer for a turn that ended with a lead letter unanswered:
 * the terminal status as the reason, then the participant's last words.
 * Overlong turns keep their end, with a marker saying what was cut.
 */
const SERVER_ANSWER_TAIL_CHARS = 2000;

const serverAnswerBody = (input: {
  readonly status: string;
  readonly result: string | null;
}): string => {
  const head = `Written by the server: the participant's turn ended (${input.status}) without a mail_send answer.`;
  const words = input.result === null || input.result.trim() === "" ? null : input.result;
  if (words === null) return `${head}\n\n(the participant left no message)`;
  if (words.length <= SERVER_ANSWER_TAIL_CHARS) return `${head}\n\n${words}`;
  return `${head}\n\n(showing the last ${SERVER_ANSWER_TAIL_CHARS} of ${words.length} characters)\n\n${words.slice(-SERVER_ANSWER_TAIL_CHARS)}`;
};

const PREVIEW_MAX_LENGTH = 200;

/** Two lines at most; overlong previews cut at the last whole line. */
const letterPreview = (body: string): string => {
  const trimmed = body.trim().split(/\r?\n/, 2).join("\n");
  if (trimmed.length <= PREVIEW_MAX_LENGTH) return trimmed;
  const cut = trimmed.slice(0, PREVIEW_MAX_LENGTH);
  const lineEnd = cut.lastIndexOf("\n");
  return (lineEnd > 0 ? cut.slice(0, lineEnd) : cut).trimEnd();
};

const questionBody = (input: {
  readonly roleId: string;
  readonly threadId: string;
  readonly requestId: string;
  readonly live: boolean;
}): string => {
  const situation = input.live
    ? `Participant ${input.roleId} is blocked on a question and cannot continue until it is answered.`
    : `Participant ${input.roleId} asked a question and is still working.`;
  return `${situation} Read it with t3_pending_request action read, threadId ${input.threadId}, and requestId ${input.requestId}. Answer it with action respond when the answer follows from the task; otherwise ask the user, then answer it.`;
};

const make = Effect.fn("MailDeliveryReactor.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* MailRepository;
  const mail = yield* MailService;
  const gate = yield* FeatureGate;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const sink = yield* EventSink.EventSinkV2;
  const lane = yield* Semaphore.make(1);

  const cursor = Effect.fn("MailDeliveryReactor.cursor")(function* () {
    const rows = yield* sql<{ readonly sequence: number }>`
      SELECT sequence FROM ft3_mail_reactor_cursor WHERE id = 1`;
    return rows[0]!.sequence;
  });

  const aliveShell = Effect.fn("MailDeliveryReactor.aliveShell")(function* (threadId: string) {
    const shell = yield* threads.getThreadShell(ThreadId.make(threadId));
    return shell !== null && shell.deletedAt === null ? shell : null;
  });

  const wake = Effect.fn("MailDeliveryReactor.wake")(function* (input: {
    readonly threadId: ThreadId;
    readonly key: string;
    readonly text: string;
    readonly summary: string;
    /** An urgent wake steers the active run instead of queueing behind it. */
    readonly urgent: boolean;
    /** The participant that wrote the letter; the notice opens its thread. */
    readonly senderThreadId?: ThreadId;
    /** Points the lead chat at the letter: its task, id and a bounded preview. */
    readonly mail?: {
      readonly taskId: string;
      readonly letterId: string;
      readonly preview: string;
    };
    /** A lead override: the next dispatch on this thread runs on the new model. */
    readonly modelSelection?: ModelSelection;
  }) {
    const records = yield* threads.getThreadRecords(input.senderThreadId ?? input.threadId, [
      "runs",
    ]);
    const delegatedTaskId = records.runs
      .filter((run) => run.delegatedTaskId !== null && run.delegatedTaskId !== undefined)
      .toSorted((left, right) => right.ordinal - left.ordinal)[0]?.delegatedTaskId;
    let dispatchMode: MailWakeDispatchMode = { type: "queue_after_active" };
    if (input.urgent) {
      const active = ThreadManagement.latestActiveRun(records);
      dispatchMode =
        active === undefined
          ? { type: "start_immediately" }
          : { type: "steer_active", targetRunId: active.id };
    }
    // The fallback gets its own command id: the refused steer already claimed the first one.
    const send = (mode: MailWakeDispatchMode, suffix = "") =>
      threads
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`mail:wake:${input.key}${suffix}`),
          threadId: input.threadId,
          messageId: MessageId.make(`mail:wake:${input.key}${suffix}`),
          text: input.text,
          attachments: [],
          ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
          dispatchMode: mode,
          notification: {
            source: {
              kind: "delegated_task",
              taskIds: delegatedTaskId === undefined ? [] : [delegatedTaskId],
              ...(input.senderThreadId === undefined
                ? {}
                : { childThreadId: input.senderThreadId }),
              ...(input.mail === undefined ? {} : { mail: input.mail }),
            },
            outcome: "updated",
            summary: input.summary,
          },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(Effect.mapError(failure("dispatch a mail wake")));
    // A run that ended after the lookup refuses the steer; the letter still
    // goes out behind the turn instead of being dropped.
    yield* input.urgent
      ? send(dispatchMode).pipe(Effect.catch(() => send({ type: "queue_after_active" }, ":queued")))
      : send(dispatchMode);
  });

  const deliver = Effect.fn("MailDeliveryReactor.deliver")(function* (input: {
    readonly deliveryId: string;
    readonly participantThreadId: string;
    readonly key: string;
    /** The wake row this delivery drains; marked handled on every dead end. */
    readonly wakeId: string;
    /** Urgent letters steer the recipient; the catch-up path never knows, so it queues. */
    readonly urgent: boolean;
  }) {
    const at = DateTime.formatIso(yield* DateTime.now);
    const dead = Effect.fn("MailDeliveryReactor.dead")(function* () {
      yield* repository.markWakeDelivered({ wakeId: input.wakeId, at });
    });
    const delivery = yield* repository.getDelivery(input.deliveryId);
    if (delivery === null) {
      yield* dead();
      return;
    }
    const letter = yield* repository.getLetter(delivery.letterId);
    const task = yield* repository.getTask(delivery.taskId);
    if (letter === null || task === null || task.status !== "open") {
      yield* dead();
      return;
    }
    const projectId = Option.getOrUndefined(yield* projectIdOfMailTask(task));
    if (!(yield* gate.isEffective("mail", projectId).pipe(Effect.orElseSucceed(() => false)))) {
      // Keep the delivery queued so a later enablement can drain it.
      return;
    }
    // A closed member never gets another dispatch, and a corrupt override never
    // blocks the letter. A shell deleted without settle closes the member
    // instead of leaving its deliveries pending forever.
    const member =
      delivery.memberId === null ? null : yield* repository.getMember(delivery.memberId);
    if (member !== null && member.status !== "active") {
      yield* dead();
      return;
    }
    let modelSelection: ModelSelection | undefined;
    if (member !== null && member.modelOverrideJson !== null) {
      const decoded = yield* decodeParticipantModelSelection(member.modelOverrideJson).pipe(
        Effect.option,
      );
      if (decoded._tag === "Some") modelSelection = decoded.value;
    }
    if ((yield* aliveShell(input.participantThreadId)) === null) {
      if (member !== null) {
        yield* mail.settleMember({
          memberId: member.memberId,
          settledAs: "was deleted",
          at,
        });
      }
      yield* dead();
      return;
    }
    let sender: string | null = null;
    let senderParticipantThreadId: ThreadId | undefined;
    if (letter.senderThreadId === task.createdByThreadId) {
      sender = "lead";
    } else if (letter.senderThreadId === "system") {
      sender = "system";
    } else {
      // A sender lookup failure must not abort the delivery: the drain would
      // stall on the same wake forever. Log it and deliver without a sender.
      const lookedUp = yield* repository.findParticipantByThread(letter.senderThreadId).pipe(
        Effect.tapError((error) =>
          Effect.logWarning(
            `Mail wake could not resolve the sender of letter ${letter.letterId}: ${error.message}`,
          ),
        ),
        Effect.option,
      );
      const found = lookedUp._tag === "Some" ? lookedUp.value : null;
      if (found !== null) {
        sender = participantLabel(found.member);
        senderParticipantThreadId = ThreadId.make(letter.senderThreadId);
      }
    }
    // The header is model-facing and parsed by legacy notices; keep `New <kind>
    // letter[ from <sender>] in mail task "<title>":` stable. A participant wake
    // trails the ids its reply needs, past the parsed header.
    const from = sender === null ? "" : ` from ${sender}`;
    const replyLine =
      member === null
        ? ""
        : `

${participantReplyLine({ taskId: task.taskId, letterId: letter.letterId })}`;
    yield* wake({
      threadId: ThreadId.make(input.participantThreadId),
      key: input.key,
      text: `New ${letter.kind} letter${from} in mail task "${task.title}":

${letter.body}${replyLine}`,
      summary: `Mail ${letter.kind} letter${from} in "${task.title}"`,
      urgent: input.urgent,
      ...(input.participantThreadId === task.createdByThreadId
        ? {
            mail: {
              taskId: task.taskId,
              letterId: letter.letterId,
              preview: letterPreview(letter.body),
            },
          }
        : {}),
      ...(senderParticipantThreadId === undefined
        ? {}
        : { senderThreadId: senderParticipantThreadId }),
      ...(modelSelection === undefined ? {} : { modelSelection }),
    });
    yield* repository.markWakeDelivered({ wakeId: input.wakeId, at });
    yield* repository.markDeliveryDelivered({ deliveryId: delivery.deliveryId, at });
  });

  const isolated =
    (wakeId: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.asVoid,
        Effect.catch((cause) =>
          Effect.logWarning("Mail wake failed; retrying it on the next tick", { wakeId, cause }),
        ),
      );

  const drain = Effect.fn("MailDeliveryReactor.drain")(function* () {
    const wakes = yield* repository.listUndeliveredWakes({ limit: 100 });
    for (const queued of wakes) {
      const deliveryId = parseWakeDeliveryId(queued.idempotencyKey);
      if (deliveryId === null) {
        // No consumer parses this key, so the wake could never be delivered.
        yield* repository.markWakeDelivered({
          wakeId: queued.wakeId,
          at: DateTime.formatIso(yield* DateTime.now),
        });
        continue;
      }
      // One stable key per delivery: a retried dispatch reuses the same command id.
      // A failing wake is retried on the next tick but never blocks the wakes behind it.
      yield* deliver({
        deliveryId,
        participantThreadId: queued.targetThreadId,
        key: `delivery:${deliveryId}`,
        wakeId: queued.wakeId,
        urgent: queued.reason === MAIL_URGENT_LETTER_WAKE_REASON,
      }).pipe(isolated(queued.wakeId));
    }
    const pending = yield* repository.listUndeliveredDeliveries({ limit: 100 });
    for (const { delivery, participantThreadId } of pending) {
      yield* deliver({
        deliveryId: delivery.deliveryId,
        participantThreadId,
        key: `delivery:${delivery.deliveryId}`,
        wakeId: `mail:wake:${delivery.deliveryId}`,
        urgent: false,
      }).pipe(isolated(`mail:wake:${delivery.deliveryId}`));
    }
  });

  const stage = Effect.fn("MailDeliveryReactor.stage")(function* (
    stored: OrchestrationV2StoredEvent,
  ) {
    const { event } = stored;
    if (event.type === "subagent.updated") {
      const subagentEvent = event.payload;
      if (subagentEvent.childThreadId === null || !terminal(subagentEvent.status)) return;
      const found = yield* repository.findParticipantByThread(subagentEvent.childThreadId);
      if (found === null || found.member.status !== "active" || found.taskStatus !== "open") {
        return;
      }
      const mailTask = yield* repository.getTask(found.member.taskId);
      if (mailTask === null) return;
      const projectId = Option.getOrUndefined(yield* projectIdOfMailTask(mailTask));
      if (!(yield* gate.isEffective("mail", projectId).pipe(Effect.orElseSucceed(() => false)))) {
        return;
      }
      // No settle: the member stays active. An unanswered lead letter gets
      // one server answer from the member, which marks the delivery answered
      // and wakes the lead; a later participant answer still counts.
      const unanswered = yield* repository.listUnansweredMemberDeliveries(found.member.memberId);
      for (const delivery of unanswered) {
        const open = yield* repository.getLetter(delivery.letterId);
        if (open === null) continue;
        yield* mail
          .sendLetter({
            callerThreadId: subagentEvent.childThreadId,
            taskId: found.member.taskId,
            to: "lead",
            kind: "answer",
            body: serverAnswerBody({ status: subagentEvent.status, result: subagentEvent.result }),
            replyToLetterId: open.letterId,
            clientRequestId: `mail:server-answer:${delivery.deliveryId}`,
          })
          .pipe(Effect.mapError(failure("report an unanswered participant turn")));
      }
      return;
    }
    if (event.type !== "runtime-request.updated") return;
    if (event.payload.kind !== "user_input" || event.payload.status !== "pending") return;
    const found = yield* repository.findParticipantByThread(event.threadId);
    if (found === null || found.member.status !== "active" || found.taskStatus !== "open") return;
    const task = yield* repository.getTask(found.member.taskId);
    if (task === null) return;
    const projectId = Option.getOrUndefined(yield* projectIdOfMailTask(task));
    if (!(yield* gate.isEffective("mail", projectId).pipe(Effect.orElseSucceed(() => false))))
      return;
    yield* mail
      .sendLetter({
        callerThreadId: event.threadId,
        taskId: found.member.taskId,
        to: "lead",
        kind: "question",
        body: questionBody({
          roleId: found.member.roleId,
          threadId: event.threadId,
          requestId: event.payload.id,
          live: event.payload.responseCapability.type === "live",
        }),
        clientRequestId: `mail:question:${event.payload.id}`,
      })
      .pipe(Effect.mapError(failure("forward a participant question")));
  });

  const process = Effect.fn("MailDeliveryReactor.process")(
    function* (stored: OrchestrationV2StoredEvent) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (stored.sequence <= (yield* cursor())) return;
          yield* stage(stored);
          yield* sql`UPDATE ft3_mail_reactor_cursor SET sequence = ${stored.sequence} WHERE id = 1`;
        }),
      );
      yield* drain();
    },
    (effect) => lane.withPermit(effect),
    Effect.mapError(failure("process event")),
  );

  const recover = Effect.gen(function* () {
    const afterSequence = yield* cursor();
    const throughSequence = yield* sink.latestSequence();
    if (throughSequence > afterSequence) {
      yield* sink.stream({ afterSequence }).pipe(
        Stream.takeUntil((stored) => stored.sequence >= throughSequence),
        Stream.runForEach(process),
      );
    }
    yield* lane.withPermit(drain());
  }).pipe(Effect.mapError(failure("recover")));

  const start = Effect.fn("MailDeliveryReactor.start")(function* () {
    yield* forkParked(
      Effect.gen(function* () {
        yield* recover;
        const afterSequence = yield* cursor();
        yield* sink.stream({ afterSequence }).pipe(Stream.runForEach(process));
      }).pipe(
        Effect.tapError(() =>
          Effect.logWarning("Mail reactor failed; resuming from its durable cursor"),
        ),
        Effect.retry(Schedule.spaced("1 second")),
      ),
    );
  });
  return { process, recover, start };
});

export const layer = Layer.effect(MailDeliveryReactor, make());

export const layerWorker = () =>
  Layer.effectDiscard(Effect.flatMap(MailDeliveryReactor, (reactor) => reactor.start())).pipe(
    Layer.provide(layer),
    Layer.provide(mailRepositoryLayer),
  );

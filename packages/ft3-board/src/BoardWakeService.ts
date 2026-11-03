/**
 * Board event wakes for the lead: the wake texts, the message id namespace and
 * the feature gate live here, so planning and mail call one place.
 */
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import { documentsBriefLine } from "@t3tools/ft3-docs/brief";
import * as FeatureGate from "@t3tools/ft3-policies/server";
import { RoleResolver, roleResolverLayer } from "@t3tools/ft3-policies/server";
import { buildBoardWakePrompt, buildBoardWakeShortMessage } from "./boardWakePrompt.ts";

/** Existing wake reasons; each owns its `ft3:board:*` id namespace. */
export const BOARD_WAKE_REASONS = ["marked", "brief", "started", "executor", "orphaned"] as const;
export type BoardWakeReason = (typeof BOARD_WAKE_REASONS)[number];
const BoardWakeReason = Schema.Literals(BOARD_WAKE_REASONS);

const ID_PREFIX: Readonly<Record<BoardWakeReason, string>> = {
  marked: "ft3:board:mark:",
  brief: "ft3:board:brief:",
  started: "ft3:board:start:",
  executor: "ft3:board:wake:",
  orphaned: "ft3:board:orphan:",
};

/** Only the first wake of a lead carries the whole brief. */
const BRIEF_REASONS: ReadonlySet<BoardWakeReason> = new Set(["marked", "brief"]);

/** The stable message id for one wake; a repeat of the same key is the same message. */
export function boardWakeMessageId(reason: BoardWakeReason, key: string): string {
  return `${ID_PREFIX[reason]}${key}`;
}

/** Splits a stored or delivered id back into its reason and key, for replay. */
export function parseBoardWakeMessageId(
  id: string,
): { readonly reason: BoardWakeReason; readonly key: string } | null {
  for (const reason of BOARD_WAKE_REASONS) {
    const prefix = ID_PREFIX[reason];
    if (id.startsWith(prefix)) return { reason, key: id.slice(prefix.length) };
  }
  return null;
}

export interface BoardWakeInput {
  readonly reason: BoardWakeReason;
  /** Completes the reason's id namespace: an id, a sequence, or a joined tuple. */
  readonly key: string;
  readonly threadId: ThreadId;
  readonly context: string;
}

/** `skipped` means the board feature is off; nothing was sent. */
export type BoardWakeOutcome = "sent" | "skipped";

export class BoardWakeFailure extends Schema.TaggedError<BoardWakeFailure>()("BoardWakeFailure", {
  reason: BoardWakeReason,
  threadId: ThreadId,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `The board wake for ${this.reason} on thread ${this.threadId} could not be sent.`;
  }
}

export class BoardWakeService extends Context.Service<
  BoardWakeService,
  {
    readonly wake: (input: BoardWakeInput) => Effect.Effect<BoardWakeOutcome, BoardWakeFailure>;
  }
>()("@t3tools/ft3-board/BoardWakeService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const gate = yield* FeatureGate.FeatureGate;
  const roles = yield* RoleResolver;

  const wake = Effect.fn("Ft3BoardWakeService.wake")(function* (input: BoardWakeInput) {
    const enabled = yield* gate
      .require("board")
      .pipe(
        Effect.as(true),
        Effect.catchTags({ FeatureDisabledError: () => Effect.succeed(false) }),
      );
    if (!enabled) return "skipped" as const;
    const messageId = boardWakeMessageId(input.reason, input.key);
    const text = BRIEF_REASONS.has(input.reason)
      ? buildBoardWakePrompt(input.context, yield* roles.leadLine, documentsBriefLine())
      : buildBoardWakeShortMessage(input.context);
    yield* threads
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(messageId),
        threadId: input.threadId,
        messageId: MessageId.make(messageId),
        text,
        attachments: [],
        createdBy: "agent",
        creationSource: "server",
        dispatchMode: { type: "start_immediately" },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new BoardWakeFailure({ reason: input.reason, threadId: input.threadId, cause }),
        ),
      );
    return "sent" as const;
  });

  return BoardWakeService.of({ wake });
});

export const layer = Layer.effect(BoardWakeService, make).pipe(
  Layer.provide(Layer.mergeAll(FeatureGate.layer, roleResolverLayer)),
);

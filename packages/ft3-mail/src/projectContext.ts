import * as BoardRepository from "@t3tools/ft3-board/repository";
import { BoardCardId } from "@t3tools/ft3-board/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { projectIdOfThread } from "@t3tools/ft3-policies/server";

import type { MailTask } from "./contracts.ts";

export const projectIdOfMailTask = Effect.fn("MailService.projectIdOfTask")(function* (
  task: Pick<MailTask, "createdByThreadId" | "cardId">,
) {
  const createdBy = yield* projectIdOfThread(task.createdByThreadId);
  if (Option.isSome(createdBy) || task.cardId === null) return createdBy;

  const board = yield* Effect.serviceOption(BoardRepository.BoardRepository);
  if (Option.isNone(board)) {
    yield* Effect.logDebug("Mail task project lookup has no board repository", {
      taskCardId: task.cardId,
    });
    return Option.none();
  }
  const card = yield* board.value.getCard(BoardCardId.make(task.cardId)).pipe(
    Effect.tapError((cause) =>
      Effect.logDebug("Mail task card lookup failed", {
        taskCardId: task.cardId,
        cause: String(cause),
      }),
    ),
    Effect.orElseSucceed(() => null),
  );
  if (card === null) {
    yield* Effect.logDebug("Mail task project lookup found no card shell", {
      taskCardId: task.cardId,
    });
    return Option.none();
  }
  return yield* projectIdOfThread(card.orchestratorThreadId);
});

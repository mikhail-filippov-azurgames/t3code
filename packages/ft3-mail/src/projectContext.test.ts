import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import { liveThreadShell } from "../../../apps/server/src/mcp/McpToolAccess.testkit.ts";
import * as BoardRepository from "@t3tools/ft3-board/repository";
import * as BoardContracts from "@t3tools/ft3-board/contracts";

import { projectIdOfMailTask } from "./projectContext.ts";

const creatorThreadId = ThreadId.make("thread:unresolved-mail-creator");
const cardLeadThreadId = ThreadId.make("thread:mail-card-lead");
const card = {
  cardId: BoardContracts.BoardCardId.make("card:one"),
  orchestratorThreadId: cardLeadThreadId,
  title: "Mail project fallback",
  body: "",
  status: "todo",
  readiness: "ready",
  readinessNote: null,
  createdBy: "human",
  assignee: null,
  executorRole: "implementation",
  executorThreadId: null,
  outcome: null,
  lastError: null,
  failureStreak: 0,
  order: 0,
  archived: false,
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
} satisfies BoardContracts.BoardCard;

it.effect("falls back to the board card's lead thread when the creator is unresolved", () => {
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (threadId) =>
      Effect.succeed(
        threadId === cardLeadThreadId
          ? { ...liveThreadShell(threadId), projectId: ProjectId.make("project:card-lead") }
          : null,
      ),
  });
  const board = Layer.mock(BoardRepository.BoardRepository)({
    getCard: (cardId) => Effect.succeed(cardId === card.cardId ? card : null),
  });
  return Effect.gen(function* () {
    const projectId = yield* projectIdOfMailTask({
      createdByThreadId: creatorThreadId,
      cardId: card.cardId,
    });
    assert.deepStrictEqual(projectId, Option.some(ProjectId.make("project:card-lead")));
  }).pipe(Effect.provide(Layer.mergeAll(threads, board)));
});

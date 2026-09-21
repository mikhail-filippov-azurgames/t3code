import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  BoardCard,
  BoardCardEvent,
  BoardCreateInput,
  BoardListInput,
  BoardListResult,
  BoardOrchestrator,
  BoardOrchestratorAddInput,
  BoardStartInput,
  BoardUpdateInput,
} from "./board.ts";
import { BoardRpcs, WS_METHODS } from "./rpc.ts";

const decodeCard = Schema.decodeUnknownEffect(BoardCard);
const decodeEvent = Schema.decodeUnknownEffect(BoardCardEvent);
const decodeOrchestrator = Schema.decodeUnknownEffect(BoardOrchestrator);
const decodeCreateInput = Schema.decodeUnknownEffect(BoardCreateInput);
const decodeUpdateInput = Schema.decodeUnknownEffect(BoardUpdateInput);
const decodeStartInput = Schema.decodeUnknownEffect(BoardStartInput);
const decodeAddInput = Schema.decodeUnknownEffect(BoardOrchestratorAddInput);
const decodeListInput = Schema.decodeUnknownEffect(BoardListInput);
const decodeListResult = Schema.decodeUnknownEffect(BoardListResult);

const minimalCard = {
  cardId: "card-1",
  orchestratorThreadId: "orch-thread",
  title: "Wire board contracts",
  body: "Add board.ts and RPC methods.",
  status: "todo",
  createdBy: "human",
  assignee: null,
  executorRole: "general",
  executorThreadId: null,
  outcome: null,
  lastError: null,
  failureStreak: 0,
  order: 0,
  archived: false,
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
} as const;

it.effect("decodes a minimal board card", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeCard(minimalCard);
    assert.strictEqual(parsed.status, "todo");
    assert.strictEqual(parsed.assignee, null);
    assert.strictEqual(parsed.executorThreadId, null);
    assert.strictEqual(parsed.failureStreak, 0);
  }),
);

it.effect("decodes a fully populated board card with model selection", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeCard({
      ...minimalCard,
      status: "in_progress",
      createdBy: "orchestrator",
      assignee: {
        instanceId: "deepseek-flash",
        model: "deepseek-v4.1-flash",
        options: [{ id: "effort", value: "high" }],
      },
      executorRole: "implementation",
      executorThreadId: "exec-thread",
      outcome: "failed",
      lastError: "provider exited 1",
      failureStreak: 2,
      order: 7,
      archived: true,
    });
    assert.strictEqual(parsed.assignee?.model, "deepseek-v4.1-flash");
    assert.strictEqual(parsed.outcome, "failed");
    assert.strictEqual(parsed.failureStreak, 2);
    assert.strictEqual(parsed.archived, true);
  }),
);

it.effect("decodes a progress event with and without body", () =>
  Effect.gen(function* () {
    const withBody = yield* decodeEvent({
      entryId: "entry-1",
      cardId: "card-1",
      at: "2026-09-20T00:00:00.000Z",
      status: "review",
      executorRole: "review",
      model: null,
      effort: null,
      body: "executor finished: success",
      source: "system",
    });
    assert.strictEqual(withBody.body, "executor finished: success");

    const withoutBody = yield* decodeEvent({
      entryId: "entry-2",
      cardId: "card-1",
      at: "2026-09-20T00:01:00.000Z",
      status: "in_progress",
      executorRole: "implementation",
      model: "deepseek-v4.1-flash",
      effort: "high",
      source: "system",
    });
    assert.strictEqual(withoutBody.body, undefined);
    assert.strictEqual(withoutBody.model, "deepseek-v4.1-flash");
  }),
);

it.effect("decodes a board list result with progress events", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeListResult({
      cards: [minimalCard],
      events: [
        {
          entryId: "entry-1",
          cardId: "card-1",
          at: "2026-09-20T00:00:00.000Z",
          status: "todo",
          executorRole: "general",
          model: null,
          effort: null,
          source: "system",
        },
      ],
    });
    assert.strictEqual(parsed.cards.length, 1);
    assert.strictEqual(parsed.events.length, 1);
    assert.strictEqual(parsed.events[0]?.cardId, "card-1");
  }),
);

it.effect("decodes an orchestrator row", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrator({
      threadId: "orch-thread",
      createdBy: "human",
      createdAt: "2026-09-20T00:00:00.000Z",
    });
    assert.strictEqual(parsed.threadId, "orch-thread");
  }),
);

it.effect("decodes board RPC inputs", () =>
  Effect.gen(function* () {
    const create = yield* decodeCreateInput({
      orchestratorThreadId: "orch-thread",
      title: "Add board page",
      body: "Build the two-mode board page.",
      executorRole: "implementation",
    });
    assert.strictEqual(create.executorRole, "implementation");

    const update = yield* decodeUpdateInput({
      cardId: "card-1",
      status: "review",
      failureStreak: 0,
    });
    assert.strictEqual(update.status, "review");

    const start = yield* decodeStartInput({ cardId: "card-1" });
    assert.strictEqual(start.cardId, "card-1");

    const add = yield* decodeAddInput({ threadId: "orch-thread" });
    assert.strictEqual(add.threadId, "orch-thread");

    yield* decodeListInput({});
  }),
);

describe("board card validation", () => {
  it.effect("rejects an unknown status", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(decodeCard({ ...minimalCard, status: "inprogress" }));
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("rejects an unknown executor role", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(decodeCard({ ...minimalCard, executorRole: "pm" }));
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("rejects a negative failure streak", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(decodeCard({ ...minimalCard, failureStreak: -1 }));
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("rejects a blank title", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(decodeCard({ ...minimalCard, title: "   " }));
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("rejects a card missing the orchestrator thread", () =>
    Effect.gen(function* () {
      const { orchestratorThreadId: _dropped, ...withoutOrchestrator } = minimalCard;
      const exit = yield* Effect.exit(decodeCard(withoutOrchestrator));
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("rejects a board list result without its events", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(decodeListResult({ cards: [minimalCard] }));
      assert.isTrue(Exit.isFailure(exit));
    }),
  );
});

describe("board RPC wiring", () => {
  it("declares exactly the board RPC methods from the design", () => {
    assert.deepStrictEqual(
      BoardRpcs.map((rpc) => rpc._tag).sort(),
      [
        WS_METHODS.boardCreate,
        WS_METHODS.boardDelete,
        WS_METHODS.boardList,
        WS_METHODS.boardOrchestratorAdd,
        WS_METHODS.boardOrchestratorRemove,
        WS_METHODS.boardOrchestratorsList,
        WS_METHODS.boardStart,
        WS_METHODS.boardUpdate,
      ].sort(),
    );
  });
});

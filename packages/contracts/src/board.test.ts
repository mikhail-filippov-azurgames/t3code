import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  BoardCard,
  BoardCardEvent,
  BoardCardLookupToken,
  BoardCardStatus,
  BoardCreateInput,
  BoardListInput,
  BoardListResult,
  BoardOrchestrator,
  BoardOrchestratorAddInput,
  BoardStartInput,
  BoardUpdateInput,
} from "./board.ts";
import {
  OrchestratorMcpBoardCreateCardInput,
  OrchestratorMcpBoardUpdateCardInput,
} from "./orchestratorMcp.ts";
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
const decodeBoardCardLookupToken = Schema.decodeUnknownEffect(BoardCardLookupToken);
const decodeMcpCreateInput = Schema.decodeUnknownEffect(OrchestratorMcpBoardCreateCardInput);
const decodeMcpUpdateInput = Schema.decodeUnknownEffect(OrchestratorMcpBoardUpdateCardInput);

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

it.effect("decodes short and full board card lookup tokens", () =>
  Effect.gen(function* () {
    const short = yield* decodeBoardCardLookupToken("cb37d411");
    const full = yield* decodeBoardCardLookupToken("cb37d411-840c-4c70-8fe7-240b1ddc6a10");
    const uppercase = yield* decodeBoardCardLookupToken("CB37D411-840C-4C70-8FE7-240B1DDC6A10");
    const invalid = yield* Effect.exit(decodeBoardCardLookupToken("cb37d411-840c-4c70"));

    assert.strictEqual(String(short), "cb37d411");
    assert.strictEqual(String(full), "cb37d411-840c-4c70-8fe7-240b1ddc6a10");
    assert.strictEqual(String(uppercase), "CB37D411-840C-4C70-8FE7-240B1DDC6A10");
    assert.isTrue(Exit.isFailure(invalid));
  }),
);

it.effect("decodes a minimal board card", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeCard(minimalCard);
    assert.strictEqual(parsed.status, "todo");
    assert.strictEqual(parsed.readiness, "ready");
    assert.strictEqual(parsed.readinessNote, null);
    assert.strictEqual(parsed.assignee, null);
    assert.strictEqual(parsed.executorThreadId, null);
    assert.strictEqual(parsed.failureStreak, 0);
  }),
);

it.effect("ignores extra board card fields for mixed-version clients", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeCard({ ...minimalCard, futureField: "ignored" });
    assert.strictEqual(parsed.readiness, "ready");
    assert.strictEqual(parsed.readinessNote, null);
  }),
);

it.effect("decodes all supported readiness values and rejects unknown values", () =>
  Effect.gen(function* () {
    for (const readiness of ["ready", "needs_human", "blocked"] as const) {
      const parsed = yield* decodeCard({ ...minimalCard, readiness });
      assert.strictEqual(parsed.readiness, readiness);
    }
    const invalid = yield* Effect.exit(decodeCard({ ...minimalCard, readiness: "waiting" }));
    assert.isTrue(Exit.isFailure(invalid));
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

    const humanUpdate = yield* decodeUpdateInput({
      cardId: "card-1",
      readiness: "blocked",
      readinessNote: "Waiting on a person",
    });
    assert.isFalse("readiness" in humanUpdate);
    assert.isFalse("readinessNote" in humanUpdate);

    const start = yield* decodeStartInput({ cardId: "card-1" });
    assert.strictEqual(start.cardId, "card-1");

    const add = yield* decodeAddInput({ threadId: "orch-thread" });
    assert.strictEqual(add.threadId, "orch-thread");

    yield* decodeListInput({});
  }),
);

describe("backlog status", () => {
  it.effect("decodes a backlog card, its history entry, and a coordinator update to backlog", () =>
    Effect.gen(function* () {
      const card = yield* decodeCard({ ...minimalCard, status: "backlog" });
      assert.strictEqual(card.status, "backlog");

      const event = yield* decodeEvent({
        entryId: "entry-1",
        cardId: "card-1",
        at: "2026-09-20T00:00:00.000Z",
        status: "backlog",
        executorRole: "general",
        model: null,
        effort: null,
        source: "system",
      });
      assert.strictEqual(event.status, "backlog");

      const update = yield* decodeUpdateInput({ cardId: "card-1", status: "backlog" });
      assert.strictEqual(update.status, "backlog");
    }),
  );

  it("is one of the six card statuses in lifecycle order", () => {
    assert.deepStrictEqual(BoardCardStatus.literals, [
      "backlog",
      "todo",
      "orchestrator",
      "in_progress",
      "review",
      "done",
    ]);
  });

  it.effect(
    "keeps the whole list strict: one card with a status the reader does not know fails the list",
    () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          decodeListResult({
            cards: [minimalCard, { ...minimalCard, cardId: "card-2", status: "someday" }],
            events: [],
          }),
        );
        assert.isTrue(Exit.isFailure(exit));
      }),
  );

  it.effect("lets the coordinator create a card as backlog, todo, or orchestrator only", () =>
    Effect.gen(function* () {
      const base = { title: "Defer me", body: "", executorRole: "general" } as const;
      for (const status of ["backlog", "todo", "orchestrator"] as const) {
        const parsed = yield* decodeMcpCreateInput({ ...base, status });
        assert.strictEqual(parsed.status, status);
      }
      for (const status of ["in_progress", "review", "done"]) {
        const exit = yield* Effect.exit(decodeMcpCreateInput({ ...base, status }));
        assert.isTrue(Exit.isFailure(exit));
      }
    }),
  );

  it.effect("lets the coordinator move an existing card to backlog", () =>
    Effect.gen(function* () {
      const parsed = yield* decodeMcpUpdateInput({ cardId: "card-1", status: "backlog" });
      assert.strictEqual(parsed.status, "backlog");
    }),
  );
});

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
        WS_METHODS.boardOrchestratorResendBrief,
        WS_METHODS.boardOrchestratorsList,
        WS_METHODS.boardResolve,
        WS_METHODS.boardStart,
        WS_METHODS.boardUpdate,
      ].sort(),
    );
  });
});

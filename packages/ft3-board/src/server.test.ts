import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";

import * as McpInvocationContext from "../../../apps/server/src/mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../../../apps/server/src/mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../apps/server/src/persistence/Sqlite.ts";
import * as Ft3Host from "../../ft3-host/src/server.ts";
import * as Contracts from "./contracts.ts";

const parentId = ThreadId.make("thread:board-parent");
const otherId = ThreadId.make("thread:other-board");
const childId = ThreadId.make("thread:executor");
const architectId = ThreadId.make("arch:advisor");
const epoch = "2026-10-26T00:00:00.000Z";
const decodeCard = Schema.decodeUnknownEffect(Contracts.BoardCard);
const decodeList = Schema.decodeUnknownEffect(Contracts.BoardListCardsResult);
const decodeFailure = Schema.decodeUnknownSync(Contracts.BoardMcpFailure);
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:board-test"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "session:board-test",
  thread: {
    threadId: parentId,
    providerSessionId: "session:board-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "board-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "board-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const crypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: () => Effect.die("unused"),
  }),
);

function fixture() {
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>(
    [parentId, otherId, childId, architectId].map((id) => [id, liveThreadShell(id)]),
  );
  const child = shells.get(childId)!;
  shells.set(childId, {
    ...child,
    lineage: { parentThreadId: parentId, rootThreadId: parentId, relationshipToParent: "subagent" },
  });
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
  });
  const layer = Layer.mergeAll(...Ft3Host.mcpToolkits, Ft3Host.layer).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(threads),
    Layer.provide(crypto),
  );
  return { layer, shells };
}

const seedThreads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const threadId of [parentId, otherId, childId, architectId]) {
    yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
      thread_id: threadId,
      project_id: "project:board",
      title: "Board",
      default_provider: "codex",
      provider_instance_id: "codex",
      runtime_mode: "full-access",
      interaction_mode: "default",
      created_at: epoch,
      updated_at: epoch,
      payload_json: "{}",
    })}`;
  }
});
const mark = Effect.fn("test.mark")(function* (threadId = parentId) {
  const repo = yield* Ft3Host.BoardRepository.BoardRepository;
  return yield* repo.addOrchestrator({ threadId, createdBy: "human", createdAt: epoch });
});
const call = Effect.fn("test.callBoard")(function* (
  name: string,
  args: Record<string, unknown>,
  invocation = scope,
) {
  const server = yield* McpServer.McpServer;
  return yield* server
    .callTool({ name, arguments: args })
    .pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
});
const create = Effect.fn("test.createCard")(function* (
  args: Record<string, unknown> = {},
  invocation = scope,
) {
  const result = yield* call(
    "board_create_card",
    {
      title: "Implement parser",
      body: "Full task description",
      executorRole: "implementation",
      ...args,
    },
    invocation,
  );
  assert.isFalse(result.isError);
  return yield* decodeCard(result.structuredContent);
});
const list = Effect.fn("test.listCards")(function* (
  args: Record<string, unknown> = {},
  invocation = scope,
) {
  const result = yield* call("board_list_cards", args, invocation);
  assert.isFalse(result.isError);
  return yield* decodeList(result.structuredContent);
});
function failure(result: McpSchema.CallToolResult) {
  assert.isTrue(result.isError);
  const content = result.content[0];
  assert.equal(content?.type, "text");
  if (content?.type !== "text") throw new Error("Expected a text failure");
  return decodeFailure(JSON.parse(content.text));
}
const asThread = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  ...scope,
  thread: { ...scope.thread!, threadId },
});

describe("ft3 board toolkit through ft3-host", () => {
  it.effect("advertises tools before a human mark and checks grants on every call", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* seedThreads;
      const server = yield* McpServer.McpServer;
      const advertised = server.tools.filter(({ tool }) => tool.name.startsWith("board_"));
      assert.deepStrictEqual(advertised.map(({ tool }) => tool.name).sort(), [
        "board_create_card",
        "board_delete_card",
        "board_list_cards",
        "board_update_card",
      ]);
      assert.equal(
        advertised.find(({ tool }) => tool.name === "board_list_cards")!.tool.annotations
          ?.readOnlyHint,
        true,
      );
      assert.equal(
        advertised.find(({ tool }) => tool.name === "board_delete_card")!.tool.annotations
          ?.destructiveHint,
        true,
      );
      for (const [name, args] of [
        ["board_create_card", { title: "Task", body: "Body", executorRole: "general" }],
        ["board_list_cards", {}],
        ["board_update_card", { cardId: "missing" }],
        ["board_delete_card", { cardId: "missing" }],
      ] as const) {
        const denied = failure(yield* call(name, args));
        assert.equal(denied.code, "capability_denied");
        assert.include(denied.message, "mark this thread");
      }
      yield* mark();
      const card = yield* create();
      assert.equal((yield* list()).cards[0]!.cardId, card.cardId);
      const repo = yield* Ft3Host.BoardRepository.BoardRepository;
      yield* repo.removeOrchestrator(parentId);
      assert.equal(failure(yield* call("board_list_cards", {})).code, "capability_denied");
      yield* mark();
      assert.deepStrictEqual((yield* list()).cards, []);
      yield* create();
      assert.deepStrictEqual(
        server.tools.filter(({ tool }) => tool.name.startsWith("board_")),
        advertised,
      );
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("creates, reads, updates and deletes cards with cascading history", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      const repo = yield* Ft3Host.BoardRepository.BoardRepository;
      const card = yield* create();
      assert.equal(card.status, "orchestrator");
      assert.equal(card.readiness, "ready");
      assert.equal(card.createdBy, "orchestrator");
      assert.isNull(card.assignee);
      assert.isNull(card.executorThreadId);
      assert.equal(card.failureStreak, 0);
      assert.isFalse(card.archived);
      const initialEvents = yield* repo.listEventsForCard(card.cardId);
      assert.equal(initialEvents.length, 1);
      assert.equal(initialEvents[0]!.source, "system");
      const update = yield* call("board_update_card", {
        cardId: card.cardId,
        status: "in_progress",
        executorThreadId: childId,
        assignee: {
          instanceId: "codex",
          model: "gpt-5",
          options: [{ id: "effort", value: "high" }],
        },
        order: 7,
      });
      assert.isFalse(update.isError);
      const updated = yield* decodeCard(update.structuredContent);
      assert.equal(updated.status, "in_progress");
      assert.equal(updated.order, 7);
      const events = yield* repo.listEventsForCard(card.cardId);
      assert.equal(events.length, 2);
      assert.isTrue(
        events.some(
          (event) =>
            event.body === "status -> in_progress" &&
            event.model === "gpt-5" &&
            event.effort === "high",
        ),
      );
      const pointer = yield* list();
      assert.isFalse("body" in pointer.cards[0]!);
      assert.equal((pointer.cards[0] as Contracts.BoardCardSummary).bodyChars, card.body.length);
      const full = yield* list({ cardIds: [card.cardId] });
      assert.equal((full.cards[0] as Contracts.BoardCard).body, card.body);
      assert.isFalse((yield* call("board_delete_card", { cardId: card.cardId })).isError);
      assert.isNull(yield* repo.getCard(card.cardId));
      assert.deepStrictEqual(yield* repo.listEventsForCard(card.cardId), []);
      assert.deepStrictEqual(yield* repo.listDeletionRecords(), []);
      assert.equal(
        failure(yield* call("board_delete_card", { cardId: card.cardId })).code,
        "task_not_found",
      );
    }).pipe(Effect.provide(f.layer));
  });

  it.effect(
    "isolates boards and explicit body reads preserve request order and deduplicate IDs",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        yield* seedThreads;
        yield* mark();
        yield* mark(otherId);
        const first = yield* create({ title: "First" });
        const second = yield* create({ title: "Second" });
        const foreign = yield* create({ title: "Foreign" }, asThread(otherId));
        assert.equal((yield* list()).cards.length, 2);
        const page = yield* list({
          cardIds: [
            second.cardId,
            foreign.cardId,
            first.cardId,
            second.cardId,
            "missing",
            "missing",
          ],
        });
        assert.deepStrictEqual(
          page.cards.map((card) => card.cardId),
          [second.cardId, first.cardId],
        );
        assert.deepStrictEqual(page.notFound, [
          foreign.cardId,
          Contracts.BoardCardId.make("missing"),
        ]);
        assert.isFalse(page.truncated);
        for (const name of ["board_update_card", "board_delete_card"]) {
          assert.equal(
            failure(yield* call(name, { cardId: foreign.cardId })).code,
            "task_not_found",
          );
        }
        assert.equal((yield* list({}, asThread(otherId))).cards.length, 1);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "requires orchestration, a live calling thread and a human mark; refuses children and architects",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        yield* seedThreads;
        for (const id of [parentId, childId, architectId]) yield* mark(id);
        const card = yield* create();
        for (const [name, args] of [
          ["board_create_card", { title: "Task", body: "Body", executorRole: "general" }],
          ["board_list_cards", {}],
          ["board_update_card", { cardId: card.cardId }],
          ["board_delete_card", { cardId: card.cardId }],
        ] as const) {
          assert.equal(
            failure(yield* call(name, args, { ...scope, capabilities: new Set() })).code,
            "capability_denied",
          );
          assert.equal(
            failure(yield* call(name, args, asThread(childId))).code,
            "delegated_executor_denied",
          );
          assert.equal(
            failure(yield* call(name, args, asThread(architectId))).code,
            "architect_denied",
          );
          assert.equal(
            failure(yield* call(name, args, { ...scope, thread: undefined })).code,
            "thread_credential_required",
          );
          assert.equal(
            failure(yield* call(name, args, asThread(ThreadId.make("missing")))).code,
            "thread_not_found",
          );
        }
        assert.equal(
          failure(
            yield* call("board_update_card", {
              cardId: card.cardId,
              executorThreadId: architectId,
            }),
          ).code,
          "architect_denied",
        );
        const readonlyScope = {
          ...scope,
          client: { sessionId: "client:test", label: "Test", access: "read-only" as const },
        };
        assert.equal((yield* list({}, readonlyScope)).cards.length, 1);
        assert.equal(
          failure(yield* call("board_delete_card", { cardId: card.cardId }, readonlyScope)).code,
          "capability_denied",
        );
        const shell = f.shells.get(parentId)!;
        f.shells.set(parentId, { ...shell, activeRunId: null, status: "idle" });
        assert.equal(
          failure(yield* call("board_delete_card", { cardId: card.cardId })).code,
          "parent_not_active",
        );
        f.shells.set(parentId, { ...shell, deletedAt: DateTime.makeUnsafe(epoch) });
        assert.equal(failure(yield* call("board_list_cards", {})).code, "thread_not_found");
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "enforces readiness, execution and archive transitions and records only progress changes",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        yield* seedThreads;
        yield* mark();
        const repo = yield* Ft3Host.BoardRepository.BoardRepository;
        const card = yield* create({ status: "todo" });
        for (const [patch, code] of [
          [{ status: "in_progress" }, "executor_required"],
          [{ archived: true }, "archive_requires_done"],
          [{ readiness: "blocked" }, "readiness_note_required"],
          [{ readiness: "needs_human", readinessNote: "  " }, "readiness_note_required"],
        ] as const) {
          assert.equal(
            failure(yield* call("board_update_card", { cardId: card.cardId, ...patch })).code,
            code,
          );
        }
        assert.isFalse(
          (yield* call("board_update_card", {
            cardId: card.cardId,
            title: "Revised task",
            order: 2,
          })).isError,
        );
        assert.equal((yield* repo.listEventsForCard(card.cardId)).length, 1);
        assert.isFalse(
          (yield* call("board_update_card", {
            cardId: card.cardId,
            readiness: "blocked",
            readinessNote: "Waiting for input",
          })).isError,
        );
        assert.equal(
          failure(yield* call("board_update_card", { cardId: card.cardId, status: "done" })).code,
          "readiness_not_ready",
        );
        const completed = yield* call("board_update_card", {
          cardId: card.cardId,
          status: "done",
          readiness: "ready",
          archived: true,
        });
        assert.isFalse(completed.isError);
        const done = yield* decodeCard(completed.structuredContent);
        assert.isNull(done.readinessNote);
        assert.deepStrictEqual((yield* list()).cards, []);
        assert.equal((yield* list({ includeArchived: true })).cards.length, 1);
        assert.equal((yield* list({ cardIds: [card.cardId] })).cards.length, 1);
        assert.equal(
          failure(yield* call("board_update_card", { cardId: card.cardId, status: "todo" })).code,
          "archive_requires_done",
        );
        assert.isFalse(
          (yield* call("board_update_card", {
            cardId: card.cardId,
            status: "todo",
            archived: false,
          })).isError,
        );
        const bodies = (yield* repo.listEventsForCard(card.cardId)).flatMap((event) =>
          event.body === undefined ? [] : [event.body],
        );
        assert.includeMembers(bodies, [
          "readiness -> blocked: Waiting for input",
          "readiness -> ready",
          "status -> done",
          "status -> todo",
        ]);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect("rejects authored secrets without echoing them or persisting a partial write", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      const secret = "ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6";
      const rejected = failure(
        yield* call("board_create_card", { title: "Task", body: secret, executorRole: "general" }),
      );
      assert.equal(rejected.code, "author_text_rejected");
      assert.notInclude(rejected.message, secret);
      assert.deepStrictEqual((yield* list()).cards, []);
      const card = yield* create();
      for (const field of ["title", "body", "lastError"] as const) {
        assert.equal(
          failure(yield* call("board_update_card", { cardId: card.cardId, [field]: secret })).code,
          "author_text_rejected",
        );
      }
      assert.equal(
        failure(
          yield* call("board_update_card", {
            cardId: card.cardId,
            readiness: "blocked",
            readinessNote: secret,
          }),
        ).code,
        "author_text_rejected",
      );
      const repo = yield* Ft3Host.BoardRepository.BoardRepository;
      assert.equal((yield* repo.getCard(card.cardId))!.body, card.body);
      assert.equal((yield* repo.listEventsForCard(card.cardId)).length, 1);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect(
    "bounds UTF-8 summaries, omits bodies and returns explicit bodies without truncating",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        yield* seedThreads;
        yield* mark();
        const repo = yield* Ft3Host.BoardRepository.BoardRepository;
        const card = yield* create({ body: "Body ".repeat(20000) });
        for (let index = 1; index <= 50; index++) {
          yield* repo.createCard({
            ...card,
            cardId: Contracts.BoardCardId.make(`budget:${String(index).padStart(3, "0")}`),
            title: "К".repeat(500),
            body: card.body,
            order: index,
          });
        }
        const page = yield* list();
        assert.isTrue(page.truncated);
        assert.equal(page.omittedCount, 51 - page.cards.length);
        assert.isTrue(page.cards.every((item) => !("body" in item)));
        assert.isAtMost(
          Buffer.byteLength(JSON.stringify(page), "utf8"),
          Contracts.BOARD_LIST_BUDGET_BYTES,
        );
        assert.equal(page.cards[0]!.cardId, card.cardId);
        const full = yield* list({ cardIds: [card.cardId] });
        assert.isFalse(full.truncated);
        assert.equal((full.cards[0] as Contracts.BoardCard).body.length, 100000);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect(
    "rolls back a card and its events together and cascades physical thread removal",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        yield* seedThreads;
        yield* mark();
        const repo = yield* Ft3Host.BoardRepository.BoardRepository;
        const card = yield* create();
        const [event] = yield* repo.listEventsForCard(card.cardId);
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(repo.updateCard({ ...card, title: "Changed" }, [event!])),
          ),
        );
        assert.equal((yield* repo.getCard(card.cardId))!.title, card.title);
        const newCard = { ...card, cardId: Contracts.BoardCardId.make("rolled-back") };
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(repo.createCard(newCard, [{ ...event!, cardId: newCard.cardId }])),
          ),
        );
        assert.isNull(yield* repo.getCard(newCard.cardId));
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = ${parentId}`;
        assert.deepStrictEqual(yield* repo.listOrchestrators(), []);
        assert.isNull(yield* repo.getCard(card.cardId));
        assert.deepStrictEqual(yield* repo.listEventsForCard(card.cardId), []);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect("counts truncation metadata inside the summary byte budget", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      const card = yield* create();
      const second = yield* create({ title: "Second card" });
      const { body, ...summary } = card;
      const envelope = {
        cards: [{ ...summary, bodyChars: body.length, lastError: "" }],
        truncated: true,
        omittedCount: 1,
        notFound: [],
      };
      const padding =
        Contracts.BOARD_LIST_BUDGET_BYTES - Buffer.byteLength(JSON.stringify(envelope), "utf8");
      const repo = yield* Ft3Host.BoardRepository.BoardRepository;
      yield* repo.updateCard({ ...second, order: 1 });
      yield* repo.updateCard({ ...card, lastError: "x".repeat(padding) });
      const page = yield* list();
      assert.deepStrictEqual(
        page.cards.map((item) => item.cardId),
        [card.cardId],
      );
      assert.isTrue(page.truncated);
      assert.equal(page.omittedCount, 1);
      assert.equal(
        Buffer.byteLength(JSON.stringify(page), "utf8"),
        Contracts.BOARD_LIST_BUDGET_BYTES,
      );
    }).pipe(Effect.provide(f.layer));
  });
});

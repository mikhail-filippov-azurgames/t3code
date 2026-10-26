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

const parentId = ThreadId.make("thread:arch-coord");
const otherId = ThreadId.make("thread:other-coord");
const architectId = ThreadId.make("arch:advisor");
const childId = ThreadId.make("thread:executor");
const epoch = "2026-10-26T00:00:00.000Z";
const decodeGet = Schema.decodeUnknownEffect(Contracts.ArchitectGetCoordinatorBindingResult);
const decodeList = Schema.decodeUnknownEffect(Contracts.ArchitectListArchitectureReviewsResult);
const decodeFailure = Schema.decodeUnknownSync(Contracts.ArchitectMcpFailure);
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:architect-test"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "session:architect-test",
  thread: {
    threadId: parentId,
    providerSessionId: "session:architect-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "architect-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "architect-test", version: "1" },
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
    [parentId, otherId, architectId, childId].map((id) => [id, liveThreadShell(id)]),
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
  for (const threadId of [parentId, otherId, architectId, childId]) {
    yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
      thread_id: threadId,
      project_id: "project:architect",
      title: "Architect",
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
const seedArchitect = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO ft3_architect_binding (binding_id, coordinator_thread_id, architect_thread_id, project_id, architect_task_effort, status, created_at, created_by, create_idempotency_key, create_request_fingerprint, routing_evidence_json) VALUES ('binding:1', ${parentId}, ${architectId}, 'project:architect', 'medium', 'active', ${epoch}, ${parentId}, 'key:1', 'fp:1', ${JSON.stringify(
    {
      policyRef: "policy",
      policyRevision: 1,
      role: "architecture",
      taskEffort: "medium",
      consideredCandidates: [
        {
          alias: "gpt-5",
          providerInstanceId: "codex",
          driverKind: "codex",
          model: "gpt-5",
          options: [],
          disposition: "selected",
          reason: "accepted",
        },
      ],
    },
  )})`;
  yield* sql`INSERT INTO ft3_architect_review (review_id, binding_id, coordinator_thread_id, architect_thread_id, reason, question, refs_json, execution_posture, status, request_idempotency_key, created_at) VALUES ('review:1', 'binding:1', ${parentId}, ${architectId}, 'direct-advice', 'Is this contract safe?', '{}', 'continue', 'open', 'req:1', ${epoch})`;
});
const call = Effect.fn("test.callArchitect")(function* (
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

describe("ft3 architect toolkit through ft3-host", () => {
  it.effect("advertises read-only tools and denies before a human mark", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* seedThreads;
      const server = yield* McpServer.McpServer;
      const advertised = server.tools.filter(
        ({ tool }) =>
          tool.name === "get_coordinator_binding" || tool.name === "list_architecture_reviews",
      );
      assert.deepStrictEqual(advertised.map(({ tool }) => tool.name).sort(), [
        "get_coordinator_binding",
        "list_architecture_reviews",
      ]);
      assert.isTrue(advertised.every(({ tool }) => tool.annotations?.readOnlyHint === true));
      assert.equal(
        failure(yield* call("get_coordinator_binding", { coordinatorThreadId: parentId })).code,
        "capability_denied",
      );
      assert.equal(
        failure(yield* call("list_architecture_reviews", { coordinatorThreadId: parentId })).code,
        "capability_denied",
      );
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("returns the active binding and reviews for a marked coordinator", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      yield* seedArchitect;
      const got = yield* decodeGet(
        (yield* call("get_coordinator_binding", { coordinatorThreadId: parentId }))
          .structuredContent,
      );
      assert.isNotNull(got.binding);
      assert.equal(got.binding.bindingId, "binding:1");
      assert.equal(got.binding.coordinatorThreadId, parentId);
      assert.equal(got.binding.architectThreadId, architectId);
      assert.equal(got.binding.status, "active");
      assert.equal(got.binding.architectTaskEffort, "medium");
      assert.equal(got.binding.routingEvidence!.taskEffort, "medium");
      const listed = yield* decodeList(
        (yield* call("list_architecture_reviews", { coordinatorThreadId: parentId }))
          .structuredContent,
      );
      assert.equal(listed.reviews.length, 1);
      assert.equal(listed.reviews[0]!.reviewId, "review:1");
      assert.equal(listed.reviews[0]!.status, "open");
      assert.equal(listed.reviews[0]!.question, "Is this contract safe?");
      assert.deepStrictEqual(listed.reviews[0]!.refs, {});
      const open = yield* decodeList(
        (yield* call("list_architecture_reviews", {
          coordinatorThreadId: parentId,
          status: "open",
        })).structuredContent,
      );
      assert.equal(open.reviews.length, 1);
      const published = yield* decodeList(
        (yield* call("list_architecture_reviews", {
          coordinatorThreadId: parentId,
          status: "published",
        })).structuredContent,
      );
      assert.equal(published.reviews.length, 0);
      yield* mark(otherId);
      const other = yield* decodeGet(
        (yield* call(
          "get_coordinator_binding",
          { coordinatorThreadId: otherId },
          asThread(otherId),
        )).structuredContent,
      );
      assert.isNull(other.binding);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("refuses unmarked, foreign, architect, executor, and threadless callers", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark(otherId);
      yield* seedArchitect;
      assert.equal(
        failure(yield* call("get_coordinator_binding", { coordinatorThreadId: parentId })).code,
        "capability_denied",
      );
      assert.equal(
        failure(
          yield* call(
            "get_coordinator_binding",
            { coordinatorThreadId: parentId },
            asThread(otherId),
          ),
        ).code,
        "capability_denied",
      );
      assert.equal(
        failure(
          yield* call(
            "list_architecture_reviews",
            { coordinatorThreadId: otherId },
            asThread(architectId),
          ),
        ).code,
        "architect_denied",
      );
      for (const [name, args] of [
        ["get_coordinator_binding", { coordinatorThreadId: parentId }],
        ["list_architecture_reviews", { coordinatorThreadId: parentId }],
      ] as const) {
        assert.equal(
          failure(yield* call(name, args, { ...scope, capabilities: new Set() })).code,
          "capability_denied",
        );
        assert.equal(
          failure(yield* call(name, args, { ...scope, thread: undefined })).code,
          "thread_credential_required",
        );
        assert.equal(
          failure(yield* call(name, args, asThread(childId))).code,
          "delegated_executor_denied",
        );
        assert.equal(
          failure(yield* call(name, args, asThread(ThreadId.make("missing")))).code,
          "thread_not_found",
        );
      }
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("lets the bound architect read its own binding and reviews", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      yield* seedArchitect;
      const got = yield* decodeGet(
        (yield* call(
          "get_coordinator_binding",
          { coordinatorThreadId: parentId },
          asThread(architectId),
        )).structuredContent,
      );
      assert.isNotNull(got.binding);
      assert.equal(got.binding.bindingId, "binding:1");
      const listed = yield* decodeList(
        (yield* call(
          "list_architecture_reviews",
          { coordinatorThreadId: parentId },
          asThread(architectId),
        )).structuredContent,
      );
      assert.equal(listed.reviews.length, 1);
      assert.equal(
        failure(
          yield* call(
            "get_coordinator_binding",
            { coordinatorThreadId: otherId },
            asThread(architectId),
          ),
        ).code,
        "architect_denied",
      );
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("cascades bindings and reviews when a coordinator thread is deleted", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      yield* seedArchitect;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = ${parentId}`;
      assert.deepStrictEqual(yield* sql`SELECT * FROM ft3_architect_binding`, []);
      assert.deepStrictEqual(yield* sql`SELECT * FROM ft3_architect_review`, []);
    }).pipe(Effect.provide(f.layer));
  });

  it("bounds legacy input limits", () => {
    assert.isFalse(
      Schema.is(Contracts.ArchitectGetCoordinatorBindingInput)({ coordinatorThreadId: "" }),
    );
  });
});

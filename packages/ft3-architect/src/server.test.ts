// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";

import * as McpInvocationContext from "../../../apps/server/src/mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../../../apps/server/src/mcp/McpToolAccess.testkit.ts";
import * as ProviderRegistry from "../../../apps/server/src/provider/ProviderRegistry.ts";
import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../apps/server/src/persistence/Sqlite.ts";
import * as BoardRepository from "@t3tools/ft3-board/repository";
import * as Ft3Host from "../../ft3-host/src/server.ts";
import * as ArchitectRepository from "./ArchitectRepository.ts";
import * as ArchitectService from "./ArchitectService.ts";
import * as Contracts from "./contracts.ts";
import { ARCHITECT_SKILL_PATH } from "./skillLocation.ts";

const parentId = ThreadId.make("thread:arch-coord");
const otherId = ThreadId.make("thread:other-coord");
const architectId = ThreadId.make("arch:advisor");
const childId = ThreadId.make("thread:executor");
const epoch = "2026-10-26T00:00:00.000Z";
const decodeGet = Schema.decodeUnknownEffect(Contracts.ArchitectGetCoordinatorBindingResult);
const decodeList = Schema.decodeUnknownEffect(Contracts.ArchitectListArchitectureReviewsResult);
const decodeCreate = Schema.decodeUnknownEffect(Contracts.ArchitectCreateOrGetResult);
const decodeReplace = Schema.decodeUnknownEffect(Contracts.ArchitectReplaceResult);
const decodeDetach = Schema.decodeUnknownEffect(Contracts.ArchitectDetachResult);
const decodeRequest = Schema.decodeUnknownEffect(Contracts.ArchitectReviewRequestResult);
const decodeAnswer = Schema.decodeUnknownEffect(Contracts.ArchitectReviewAnswerResult);
const decodeCancel = Schema.decodeUnknownEffect(Contracts.ArchitectReviewCancelResult);
const decodePrepare = Schema.decodeUnknownEffect(
  Contracts.ArchitectPrepareCoordinatorPublicationResult,
);
const decodePublish = Schema.decodeUnknownEffect(Contracts.ArchitectPublishToCoordinatorResult);
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
    digest: (_algorithm, data) =>
      Effect.promise(async () => {
        const bytes = new Uint8Array(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
      }),
  }),
);

const codexProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: epoch,
  models: [{ slug: "gpt-5", name: "GPT-5", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};

const createEvidence: Contracts.CoordinatorArchitectRoutingEvidence = {
  policyRef: "policy",
  policyRevision: 1,
  role: "architecture",
  taskEffort: "medium",
  consideredCandidates: [
    {
      alias: "gpt-5",
      providerInstanceId: ProviderInstanceId.make("codex"),
      driverKind: ProviderDriverKind.make("codex"),
      model: "gpt-5",
      options: [],
      disposition: "selected",
      reason: "accepted",
    },
  ],
};

const createArgs = (overrides: Record<string, unknown> = {}) => ({
  coordinatorThreadId: parentId,
  taskEffort: "medium",
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  routingEvidence: createEvidence,
  idempotencyKey: "create:1",
  ...overrides,
});

const replaceArgs = (overrides: Record<string, unknown> = {}) => ({
  coordinatorThreadId: parentId,
  taskEffort: "medium",
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  routingEvidence: createEvidence,
  reason: "Replace the advisor.",
  idempotencyKey: "replace:1",
  ...overrides,
});

const detachArgs = (overrides: Record<string, unknown> = {}) => ({
  coordinatorThreadId: parentId,
  reason: "Detach the advisor.",
  idempotencyKey: "detach:1",
  ...overrides,
});

const requestArgs = (overrides: Record<string, unknown> = {}) => ({
  coordinatorThreadId: parentId,
  reason: "direct-advice",
  question: "Is this contract safe?",
  executionPosture: "continue",
  idempotencyKey: "req:wake:1",
  ...overrides,
});

const answerArgs = (overrides: Record<string, unknown> = {}) => ({
  reviewId: "review:1",
  disposition: "recommendation",
  summary: "Looks safe.",
  idempotencyKey: "ans:1",
  ...overrides,
});

const cancelArgs = (overrides: Record<string, unknown> = {}) => ({
  reviewId: "review:1",
  reason: "No longer needed.",
  idempotencyKey: "cancel:1",
  ...overrides,
});

const prepareArgs = (overrides: Record<string, unknown> = {}) => ({
  summary: "Add a bounded cache.",
  disposition: "recommendation",
  executionPosture: "continue",
  idempotencyKey: "prepare:1",
  ...overrides,
});

const publishArgs = (overrides: Record<string, unknown> = {}) => ({
  reviewId: "review:1",
  idempotencyKey: "publish:1",
  ...overrides,
});

function fixture() {
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>(
    [parentId, otherId, architectId, childId].map((id) => [id, liveThreadShell(id)]),
  );
  const child = shells.get(childId)!;
  shells.set(childId, {
    ...child,
    lineage: { parentThreadId: parentId, rootThreadId: parentId, relationshipToParent: "subagent" },
  });
  const createdCommands = new Array<unknown>();
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
    dispatch: (command) =>
      Effect.sync(() => {
        createdCommands.push(command);
        if (command.type === "thread.create") {
          shells.set(command.threadId, liveThreadShell(command.threadId));
        }
        if (command.type === "thread.delete") {
          shells.delete(command.threadId);
        }
        return { sequence: 0, storedEvents: [] };
      }),
  });
  const providerRegistry = Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders: Effect.succeed([codexProvider]),
  });
  const layer = Layer.mergeAll(...Ft3Host.mcpToolkits, Ft3Host.layer).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(threads),
    Layer.provide(providerRegistry),
    Layer.provide(crypto),
  );
  return { layer, shells, createdCommands };
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

  it.effect("creates a binding and architect thread for a marked coordinator", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      const result = yield* decodeCreate(
        (yield* call("architect_create_or_get", createArgs())).structuredContent,
      );
      assert.equal(result.created, true);
      assert.equal(result.binding.status, "active");
      assert.equal(result.binding.coordinatorThreadId, parentId);
      assert.equal(result.binding.architectThreadId, result.architectThreadId);
      assert.equal(result.binding.architectTaskEffort, "medium");
      assert.equal(result.binding.routingEvidence!.policyRef, "policy");
      assert.isTrue(String(result.architectThreadId).startsWith("arch:"));
      assert.equal(f.createdCommands.length, 1);
      const command = f.createdCommands[0] as {
        readonly type: string;
        readonly threadId: ThreadId;
      };
      assert.equal(command.type, "thread.create");
      assert.equal(command.threadId, result.architectThreadId);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("rejects routing evidence that does not reference the configured policy", () => {
    const f = fixture();
    const layer = f.layer.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { T3CODE_FT3_ROUTING_POLICY_REF: "other-policy" } }),
        ),
      ),
    );
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      assert.equal(
        failure(yield* call("architect_create_or_get", createArgs())).code,
        "routing_evidence_mismatch",
      );
      assert.equal(f.createdCommands.length, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("accepts routing evidence that references the configured policy", () => {
    const f = fixture();
    const layer = f.layer.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { T3CODE_FT3_ROUTING_POLICY_REF: "policy" } }),
        ),
      ),
    );
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      const result = yield* decodeCreate(
        (yield* call("architect_create_or_get", createArgs())).structuredContent,
      );
      assert.equal(result.created, true);
      assert.equal(result.binding.routingEvidence!.policyRef, "policy");
    }).pipe(Effect.provide(layer));
  });

  it.effect("repeats an exact create idempotently", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      const first = yield* decodeCreate(
        (yield* call("architect_create_or_get", createArgs())).structuredContent,
      );
      const second = yield* decodeCreate(
        (yield* call("architect_create_or_get", createArgs())).structuredContent,
      );
      assert.equal(first.created, true);
      assert.equal(second.created, false);
      assert.equal(second.binding.bindingId, first.binding.bindingId);
      assert.equal(second.architectThreadId, first.architectThreadId);
      assert.equal(f.createdCommands.length, 1);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("refuses an unmarked coordinator", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* seedThreads;
      assert.equal(
        failure(yield* call("architect_create_or_get", createArgs())).code,
        "capability_denied",
      );
      assert.equal(f.createdCommands.length, 0);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("refuses an unknown model", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      const unknown = "gpt-unknown";
      const evidence: Contracts.CoordinatorArchitectRoutingEvidence = {
        ...createEvidence,
        consideredCandidates: [{ ...createEvidence.consideredCandidates[0]!, model: unknown }],
      };
      assert.equal(
        failure(
          yield* call(
            "architect_create_or_get",
            createArgs({
              modelSelection: { instanceId: "codex", model: unknown },
              routingEvidence: evidence,
            }),
          ),
        ).code,
        "model_unavailable",
      );
      assert.equal(f.createdCommands.length, 0);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("an architect cannot create another architect", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      yield* seedArchitect;
      assert.equal(
        failure(yield* call("architect_create_or_get", createArgs(), asThread(architectId))).code,
        "architect_denied",
      );
      assert.equal(f.createdCommands.length, 0);
    }).pipe(Effect.provide(f.layer));
  });

  it("bounds legacy input limits", () => {
    assert.isFalse(
      Schema.is(Contracts.ArchitectGetCoordinatorBindingInput)({ coordinatorThreadId: "" }),
    );
  });

  it.effect("replaces the architect and closes the old binding", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      const created = yield* decodeCreate(
        (yield* call("architect_create_or_get", createArgs())).structuredContent,
      );
      const replaced = yield* decodeReplace(
        (yield* call("architect_replace", replaceArgs())).structuredContent,
      );
      assert.notEqual(replaced.binding.bindingId, created.binding.bindingId);
      assert.equal(replaced.binding.status, "active");
      assert.equal(replaced.binding.architectThreadId, replaced.architectThreadId);
      const sql = yield* SqlClient.SqlClient;
      const old =
        (yield* sql`SELECT status, replaced_by_binding_id, detach_reason FROM ft3_architect_binding WHERE binding_id = ${created.binding.bindingId}`)[0]!;
      assert.equal(old.status, "replaced");
      assert.equal(old.replaced_by_binding_id, replaced.binding.bindingId);
      assert.equal(old.detach_reason, "Replace the advisor.");
      assert.isUndefined(f.shells.get(created.architectThreadId));
      assert.isDefined(f.shells.get(replaced.architectThreadId));
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("detaches the architect and revokes its thread", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      yield* seedArchitect;
      const result = yield* decodeDetach(
        (yield* call("architect_detach", detachArgs())).structuredContent,
      );
      assert.equal(result.binding.status, "detached");
      assert.equal(result.binding.bindingId, "binding:1");
      assert.equal(result.binding.detachReason, "Detach the advisor.");
      assert.isUndefined(f.shells.get(architectId));
      const got = yield* decodeGet(
        (yield* call("get_coordinator_binding", { coordinatorThreadId: parentId }))
          .structuredContent,
      );
      assert.isNull(got.binding);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("repeats detach idempotently", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      yield* seedArchitect;
      const first = yield* decodeDetach(
        (yield* call("architect_detach", detachArgs())).structuredContent,
      );
      assert.equal(first.binding.status, "detached");
      const second = yield* decodeDetach(
        (yield* call("architect_detach", detachArgs())).structuredContent,
      );
      assert.equal(second.binding.bindingId, first.binding.bindingId);
      assert.equal(second.binding.status, "detached");
      const deletes = f.createdCommands.filter(
        (command) => (command as { type: string }).type === "thread.delete",
      );
      assert.equal(deletes.length, 1);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("refuses a foreign coordinator thread", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      yield* mark(otherId);
      yield* seedArchitect;
      assert.equal(
        failure(yield* call("architect_replace", replaceArgs(), asThread(otherId))).code,
        "capability_denied",
      );
      assert.equal(
        failure(yield* call("architect_detach", detachArgs(), asThread(otherId))).code,
        "capability_denied",
      );
      assert.equal(f.createdCommands.length, 0);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("requests a review and wakes the architect exactly once", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      yield* seedArchitect;
      const first = yield* decodeRequest(
        (yield* call("architecture_review_request", requestArgs())).structuredContent,
      );
      assert.equal(first.status, "open");
      const second = yield* decodeRequest(
        (yield* call("architecture_review_request", requestArgs())).structuredContent,
      );
      assert.equal(second.reviewId, first.reviewId);
      const wakes = f.createdCommands.filter(
        (command) => (command as { type: string }).type === "message.dispatch",
      );
      assert.equal(wakes.length, 1);
      const wake = wakes[0] as { threadId: ThreadId; commandId: string; text: string };
      assert.equal(wake.threadId, architectId);
      assert.equal(wake.commandId, `arch:review-wake:${first.reviewId}`);
      assert.include(wake.text, first.reviewId);
      const sql = yield* SqlClient.SqlClient;
      const delivered =
        (yield* sql`SELECT request_wake_delivered_at FROM ft3_architect_review WHERE review_id = ${first.reviewId}`)[0]!
          .request_wake_delivered_at;
      assert.isNotNull(delivered);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("answers a review without waking the coordinator", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      yield* seedArchitect;
      const result = yield* decodeAnswer(
        (yield* call("architecture_review_answer", answerArgs(), asThread(architectId)))
          .structuredContent,
      );
      assert.equal(result.status, "answered");
      assert.equal(result.disposition, "recommendation");
      assert.equal(f.createdCommands.length, 0);
      const sql = yield* SqlClient.SqlClient;
      const stored =
        (yield* sql`SELECT status, answer_summary, answer_disposition FROM ft3_architect_review WHERE review_id = 'review:1'`)[0]!;
      assert.equal(stored.status, "answered");
      assert.equal(stored.answer_summary, "Looks safe.");
      assert.equal(stored.answer_disposition, "recommendation");
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("cancels a review as the coordinator", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      yield* seedArchitect;
      const result = yield* decodeCancel(
        (yield* call("architecture_review_cancel", cancelArgs())).structuredContent,
      );
      assert.equal(result.status, "cancelled");
      const sql = yield* SqlClient.SqlClient;
      const stored =
        (yield* sql`SELECT status, cancelled_by FROM ft3_architect_review WHERE review_id = 'review:1'`)[0]!;
      assert.equal(stored.status, "cancelled");
      assert.equal(stored.cancelled_by, parentId);
      assert.equal(f.createdCommands.length, 0);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("refuses a foreign coordinator and the architect on the review cycle", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      yield* mark(otherId);
      yield* seedArchitect;
      assert.equal(
        failure(yield* call("architecture_review_request", requestArgs(), asThread(otherId))).code,
        "capability_denied",
      );
      assert.equal(
        failure(yield* call("architecture_review_cancel", cancelArgs(), asThread(otherId))).code,
        "capability_denied",
      );
      assert.equal(
        failure(yield* call("architecture_review_answer", answerArgs(), asThread(otherId))).code,
        "architect_denied",
      );
      assert.equal(f.createdCommands.length, 0);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("rejects secrets in review request, answer, cancel, replace and detach text", () => {
    const f = fixture();
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456";
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      yield* seedArchitect;
      assert.equal(
        failure(
          yield* call("architecture_review_request", requestArgs({ question: `Use ${secret}` })),
        ).code,
        "author_text_rejected",
      );
      assert.equal(
        failure(
          yield* call(
            "architecture_review_answer",
            answerArgs({ summary: `Token ${secret}` }),
            asThread(architectId),
          ),
        ).code,
        "author_text_rejected",
      );
      assert.equal(
        failure(yield* call("architecture_review_cancel", cancelArgs({ reason: secret }))).code,
        "author_text_rejected",
      );
      assert.equal(
        failure(yield* call("architect_replace", replaceArgs({ reason: `Key ${secret}` }))).code,
        "author_text_rejected",
      );
      assert.equal(
        failure(yield* call("architect_detach", detachArgs({ reason: secret }))).code,
        "author_text_rejected",
      );
      assert.equal(f.createdCommands.length, 0);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("prepares a coordinator publication without waking the coordinator", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      yield* seedArchitect;
      const result = yield* decodePrepare(
        (yield* call("prepare_coordinator_publication", prepareArgs(), asThread(architectId)))
          .structuredContent,
      );
      assert.equal(result.status, "answered");
      const sql = yield* SqlClient.SqlClient;
      const stored =
        (yield* sql`SELECT origin, status, answer_summary, answer_disposition, published_by FROM ft3_architect_review WHERE review_id = ${result.reviewId}`)[0]!;
      assert.equal(stored.origin, "architect-advice");
      assert.equal(stored.status, "answered");
      assert.equal(stored.answer_summary, "Add a bounded cache.");
      assert.equal(stored.answer_disposition, "recommendation");
      assert.equal(stored.published_by, null);
      assert.equal(f.createdCommands.length, 0);
      const replaced = yield* decodePrepare(
        (yield* call(
          "prepare_coordinator_publication",
          prepareArgs({ summary: "Cache behind a flag.", idempotencyKey: "prepare:2" }),
          asThread(architectId),
        )).structuredContent,
      );
      assert.equal(replaced.reviewId, result.reviewId);
      const advice =
        (yield* sql`SELECT answer_summary FROM ft3_architect_review WHERE origin = 'architect-advice'`)[0]!;
      assert.equal(advice.answer_summary, "Cache behind a flag.");
      assert.equal(
        failure(
          yield* call(
            "publish_to_coordinator",
            publishArgs({ reviewId: result.reviewId }),
            asThread(architectId),
          ),
        ).code,
        "human_publish_required",
      );
      assert.equal(f.createdCommands.length, 0);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("publishes once and wakes the coordinator, repeat does not wake", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      yield* seedArchitect;
      yield* decodeAnswer(
        (yield* call("architecture_review_answer", answerArgs(), asThread(architectId)))
          .structuredContent,
      );
      const first = yield* decodePublish(
        (yield* call("publish_to_coordinator", publishArgs(), asThread(architectId)))
          .structuredContent,
      );
      assert.equal(first.status, "published");
      const wake = () =>
        f.createdCommands.filter(
          (command) => (command as { type: string }).type === "message.dispatch",
        );
      assert.equal(wake().length, 1);
      const dispatched = wake()[0] as { threadId: ThreadId; commandId: string; text: string };
      assert.equal(dispatched.threadId, parentId);
      assert.equal(dispatched.commandId, "arch:publish-wake:review:1");
      assert.include(dispatched.text, "[recommendation]");
      const replay = yield* decodePublish(
        (yield* call("publish_to_coordinator", publishArgs(), asThread(architectId)))
          .structuredContent,
      );
      assert.equal(replay.status, "published");
      assert.equal(wake().length, 1);
      const sql = yield* SqlClient.SqlClient;
      const stored =
        (yield* sql`SELECT publish_delivered_at, published_by FROM ft3_architect_review WHERE review_id = 'review:1'`)[0]!;
      assert.isNotNull(stored.publish_delivered_at);
      assert.equal(stored.published_by, "architect");
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("publishes an answered review on behalf of a human", () => {
    const shells = new Map<ThreadId, OrchestrationV2ThreadShell>(
      [parentId, otherId, architectId, childId].map((id) => [id, liveThreadShell(id)]),
    );
    const createdCommands = new Array<unknown>();
    const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
      dispatch: (command) =>
        Effect.sync(() => {
          createdCommands.push(command);
          return { sequence: 0, storedEvents: [] };
        }),
    });
    const providerRegistry = Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([codexProvider]),
    });
    const serviceLayer = ArchitectService.layer.pipe(
      Layer.provide(ArchitectRepository.layer),
      Layer.provideMerge(BoardRepository.layer),
      Layer.provide(threads),
      Layer.provide(providerRegistry),
      Layer.provide(crypto),
    );
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      yield* seedArchitect;
      const service = yield* ArchitectService.ArchitectService;
      yield* service.answerReview(asThread(architectId), {
        reviewId: "review:1",
        disposition: "recommendation",
        summary: "Looks safe.",
        idempotencyKey: "ans:1",
      });
      const result = yield* service.publishHumanPublication({
        reviewId: "review:1",
        idempotencyKey: "human:1",
      });
      assert.equal(result.status, "published");
      const wakes = createdCommands.filter(
        (command) => (command as { type: string }).type === "message.dispatch",
      );
      assert.equal(wakes.length, 1);
      const dispatched = wakes[0] as { threadId: ThreadId; text: string };
      assert.equal(dispatched.threadId, parentId);
      assert.include(dispatched.text, "Published by the human via the Publish button");
      const sql = yield* SqlClient.SqlClient;
      const stored =
        (yield* sql`SELECT published_by FROM ft3_architect_review WHERE review_id = 'review:1'`)[0]!;
      assert.equal(stored.published_by, "human");
    }).pipe(Effect.provide(serviceLayer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))));
  });

  it.effect("refuses a foreign coordinator thread from publishing", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      yield* mark(otherId);
      yield* seedArchitect;
      yield* decodeAnswer(
        (yield* call("architecture_review_answer", answerArgs(), asThread(architectId)))
          .structuredContent,
      );
      assert.equal(
        failure(yield* call("publish_to_coordinator", publishArgs(), asThread(otherId))).code,
        "capability_denied",
      );
      assert.equal(f.createdCommands.length, 0);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("rejects secrets in prepared publications and stored publish text", () => {
    const f = fixture();
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456";
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      yield* seedArchitect;
      assert.equal(
        failure(
          yield* call(
            "prepare_coordinator_publication",
            prepareArgs({ summary: `Token ${secret}` }),
            asThread(architectId),
          ),
        ).code,
        "author_text_rejected",
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO ft3_architect_review (review_id, binding_id, coordinator_thread_id, architect_thread_id, reason, question, refs_json, execution_posture, status, answer_disposition, answer_summary, request_idempotency_key, created_at, answered_at) VALUES ('review:secret', 'binding:1', ${parentId}, ${architectId}, 'direct-advice', 'Safe question?', '{}', 'continue', 'answered', 'recommendation', ${`Token ${secret}`}, 'req:secret', ${epoch}, ${epoch})`;
      assert.equal(
        failure(
          yield* call(
            "publish_to_coordinator",
            publishArgs({ reviewId: "review:secret" }),
            asThread(architectId),
          ),
        ).code,
        "author_text_rejected",
      );
      assert.equal(f.createdCommands.length, 0);
      const stored =
        (yield* sql`SELECT status, last_publish_failure_reason FROM ft3_architect_review WHERE review_id = 'review:secret'`)[0]!;
      assert.equal(stored.status, "answered");
      assert.equal(stored.last_publish_failure_reason, "author_text_rejected");
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("races two replaces to a single winner", () => {
    const shells = new Map<ThreadId, OrchestrationV2ThreadShell>(
      [parentId, otherId, architectId, childId].map((id) => [id, liveThreadShell(id)]),
    );
    const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
      dispatch: (command) =>
        Effect.sync(() => {
          if (command.type === "thread.create") {
            shells.set(command.threadId, liveThreadShell(command.threadId));
          }
          if (command.type === "thread.delete") {
            shells.delete(command.threadId);
          }
          return { sequence: 0, storedEvents: [] };
        }),
    });
    const providerRegistry = Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([codexProvider]),
    });
    let injected = false;
    const wrappedRepo = Layer.effect(
      ArchitectRepository.ArchitectRepository,
      Effect.gen(function* () {
        const real = yield* ArchitectRepository.ArchitectRepository;
        return ArchitectRepository.ArchitectRepository.of({
          ...real,
          closeBinding: (input) =>
            Effect.gen(function* () {
              const closed = yield* real.closeBinding(input);
              if (closed !== null && input.status === "replaced" && !injected) {
                injected = true;
                yield* real.createOrGetBinding({
                  bindingId: "binding:winner",
                  coordinatorThreadId: parentId,
                  architectThreadId: ThreadId.make("arch:winner"),
                  projectId: ProjectId.make("project:architect"),
                  architectTaskEffort: "medium",
                  routingEvidence: createEvidence,
                  createdAt: epoch,
                  createdBy: parentId,
                  createIdempotencyKey: "race:winner",
                  createRequestFingerprint: "winner-fp",
                });
              }
              return closed;
            }),
        });
      }),
    ).pipe(Layer.provide(ArchitectRepository.layer));
    const serviceLayer = ArchitectService.layer.pipe(
      Layer.provide(wrappedRepo),
      Layer.provideMerge(BoardRepository.layer),
      Layer.provide(threads),
      Layer.provide(providerRegistry),
      Layer.provide(crypto),
    );
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      yield* seedArchitect;
      const service = yield* ArchitectService.ArchitectService;
      const loser = yield* service.replace(scope, {
        coordinatorThreadId: parentId,
        taskEffort: "medium",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        routingEvidence: createEvidence,
        reason: "Replace loses the race.",
        idempotencyKey: "race:loser",
      });
      assert.equal(loser.binding.bindingId, "binding:winner");
      assert.equal(loser.architectThreadId, ThreadId.make("arch:winner"));
      const sql = yield* SqlClient.SqlClient;
      const original =
        (yield* sql`SELECT status, replaced_by_binding_id FROM ft3_architect_binding WHERE binding_id = 'binding:1'`)[0]!;
      assert.equal(original.status, "replaced");
      assert.equal(original.replaced_by_binding_id, "binding:winner");
      const active =
        yield* sql`SELECT binding_id FROM ft3_architect_binding WHERE coordinator_thread_id = ${parentId} AND status = 'active'`;
      assert.equal(active.length, 1);
      assert.equal(active[0]!.binding_id, "binding:winner");
    }).pipe(Effect.provide(serviceLayer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))));
  });
});

function reconcileFixture() {
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>(
    [parentId, otherId, architectId, childId].map((id) => [id, liveThreadShell(id)]),
  );
  const createdCommands = new Array<unknown>();
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
    dispatch: (command) =>
      Effect.sync(() => {
        createdCommands.push(command);
        if (command.type === "thread.create") {
          shells.set(command.threadId, liveThreadShell(command.threadId));
        }
        if (command.type === "thread.delete") {
          shells.delete(command.threadId);
        }
        return { sequence: 0, storedEvents: [] };
      }),
  });
  const providerRegistry = Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders: Effect.succeed([codexProvider]),
  });
  const layer = ArchitectService.layer.pipe(
    Layer.provide(ArchitectRepository.layer),
    Layer.provideMerge(BoardRepository.layer),
    Layer.provide(threads),
    Layer.provide(providerRegistry),
    Layer.provide(crypto),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  return { layer, shells, createdCommands };
}

describe("ft3 architect restart reconciliation", () => {
  const detachedArchitectId = ThreadId.make("arch:retired");

  it.effect("replays thread.delete for closed bindings whose architect threads survived", () => {
    const f = reconcileFixture();
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      yield* seedArchitect;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM ft3_architect_review`;
      yield* sql`UPDATE ft3_architect_binding SET status = 'detached' WHERE binding_id = 'binding:1'`;
      f.shells.set(detachedArchitectId, liveThreadShell(detachedArchitectId));
      yield* sql`INSERT INTO ft3_architect_binding (binding_id, coordinator_thread_id, architect_thread_id, project_id, architect_task_effort, status, created_at, created_by, create_idempotency_key, create_request_fingerprint) VALUES ('binding:2', ${parentId}, ${detachedArchitectId}, 'project:architect', 'medium', 'replaced', ${epoch}, ${parentId}, 'key:2', 'fp:2')`;
      const service = yield* ArchitectService.ArchitectService;
      assert.deepStrictEqual(yield* service.reconcileAfterRestart(), [
        { kind: "thread-delete-replayed", bindingId: "binding:1" },
        { kind: "thread-delete-replayed", bindingId: "binding:2" },
      ]);
      const deletes = f.createdCommands.filter(
        (command) => (command as { type: string }).type === "thread.delete",
      ) as ReadonlyArray<{ readonly threadId: ThreadId; readonly commandId: string }>;
      assert.deepStrictEqual(
        deletes.map((command) => [command.threadId, command.commandId]),
        [
          [architectId, `architect-delete:${architectId}`],
          [detachedArchitectId, `architect-delete:${detachedArchitectId}`],
        ],
      );
      assert.isUndefined(f.shells.get(architectId));
      assert.isUndefined(f.shells.get(detachedArchitectId));
      assert.deepStrictEqual(yield* service.reconcileAfterRestart(), []);
      assert.equal(
        f.createdCommands.filter(
          (command) => (command as { type: string }).type === "thread.delete",
        ).length,
        2,
      );
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("delivers an undelivered review wake exactly once", () => {
    const f = reconcileFixture();
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      yield* seedArchitect;
      const service = yield* ArchitectService.ArchitectService;
      assert.deepStrictEqual(yield* service.reconcileAfterRestart(), [
        { kind: "review-wake-delivered", bindingId: "binding:1", reviewId: "review:1" },
      ]);
      const wakes = f.createdCommands.filter(
        (command) => (command as { type: string }).type === "message.dispatch",
      ) as ReadonlyArray<{
        readonly threadId: ThreadId;
        readonly commandId: string;
        readonly text: string;
      }>;
      assert.equal(wakes.length, 1);
      assert.equal(wakes[0]!.threadId, architectId);
      assert.equal(wakes[0]!.commandId, "arch:review-wake:review:1");
      assert.include(wakes[0]!.text, "review:1");
      const sql = yield* SqlClient.SqlClient;
      assert.isNotNull(
        (yield* sql`SELECT request_wake_delivered_at FROM ft3_architect_review WHERE review_id = 'review:1'`)[0]!
          .request_wake_delivered_at,
      );
      assert.deepStrictEqual(yield* service.reconcileAfterRestart(), []);
      assert.equal(
        f.createdCommands.filter(
          (command) => (command as { type: string }).type === "message.dispatch",
        ).length,
        1,
      );
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("delivers an undelivered publish wake exactly once", () => {
    const f = reconcileFixture();
    return Effect.gen(function* () {
      yield* seedThreads;
      yield* mark();
      yield* seedArchitect;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE ft3_architect_review SET status = 'published', answer_disposition = 'recommendation', answer_summary = 'Looks safe.', answer_idempotency_key = 'ans:1', publish_idempotency_key = 'publish:1', published_at = ${epoch}, published_by = 'architect', request_wake_delivered_at = ${epoch} WHERE review_id = 'review:1'`;
      const service = yield* ArchitectService.ArchitectService;
      assert.deepStrictEqual(yield* service.reconcileAfterRestart(), [
        { kind: "publish-wake-delivered", bindingId: "binding:1", reviewId: "review:1" },
      ]);
      const wakes = f.createdCommands.filter(
        (command) => (command as { type: string }).type === "message.dispatch",
      ) as ReadonlyArray<{
        readonly threadId: ThreadId;
        readonly commandId: string;
        readonly text: string;
      }>;
      assert.equal(wakes.length, 1);
      assert.equal(wakes[0]!.threadId, parentId);
      assert.equal(wakes[0]!.commandId, "arch:publish-wake:review:1");
      assert.include(wakes[0]!.text, "[recommendation]");
      assert.isNotNull(
        (yield* sql`SELECT publish_delivered_at FROM ft3_architect_review WHERE review_id = 'review:1'`)[0]!
          .publish_delivered_at,
      );
      assert.deepStrictEqual(yield* service.reconcileAfterRestart(), []);
      assert.equal(
        f.createdCommands.filter(
          (command) => (command as { type: string }).type === "message.dispatch",
        ).length,
        1,
      );
    }).pipe(Effect.provide(f.layer));
  });
});

describe("ft3 architect shipped skill", () => {
  it("exists on disk and carries no local document reference", () => {
    const content = NodeFS.readFileSync(ARCHITECT_SKILL_PATH, "utf8");
    assert.include(ARCHITECT_SKILL_PATH, "create-orchestrator-architect");
    assert.notInclude(content, "oc://");
    assert.notInclude(content, ".opencontext");
    assert.include(content, "routing policy");
  });
});

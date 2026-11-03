// @effect-diagnostics nodeBuiltinImport:off - the tests create a document store on disk.
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { McpSchema, McpServer } from "effect/ai";

import * as McpInvocationContext from "../../../apps/server/src/mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../../../apps/server/src/mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../apps/server/src/persistence/Sqlite.ts";
import * as ServerSettings from "../../../apps/server/src/serverSettings.ts";
import * as Service from "./service.ts";
import * as Contracts from "./toolContracts.ts";
import { mcpLayer } from "./mcp.ts";
import * as WriteRule from "./writeRule.ts";

const NIL_ID = "00000000-0000-0000-0000-000000000000";
const parentId = ThreadId.make("thread:docs-parent");
const childId = ThreadId.make("thread:docs-child");

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:docs-test"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "session:docs-test",
  thread: {
    threadId: parentId,
    providerSessionId: "session:docs-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "docs-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "docs-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const cryptoLayer = Layer.succeed(
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

const makeRoot = () =>
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-docs-mcp-")));

const removeRoot = (root: string) =>
  Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true }));

const writeDoc = (root: string, relPath: string, content: string) =>
  Effect.promise(async () => {
    const absolute = NodePath.join(root, "contexts", ...relPath.split("/"));
    await NodeFSP.mkdir(NodePath.dirname(absolute), { recursive: true });
    await NodeFSP.writeFile(absolute, content, "utf8");
  });

const allowStoreWrite = Layer.succeed(
  Service.DocumentsWriteAccess,
  Service.DocumentsWriteAccess.of({
    decide: () =>
      Effect.succeed({ _tag: "Allow", scope: "store", reason: "top_level_thread" } as const),
  }),
);

const factsLayer = (value: WriteRule.DocumentsWriteFacts) =>
  Layer.succeed(
    WriteRule.DocumentsWriteFactsPort,
    WriteRule.DocumentsWriteFactsPort.of({ factsOf: () => Effect.succeed(value) }),
  );

interface FixtureOptions {
  readonly writable?: boolean;
  /** A guard that refuses every call, as the feature gate does when documents are off. */
  readonly documentsOff?: boolean;
  /** Facts the lineage write rule reads; the default is no role, plan or grant. */
  readonly writeFacts?: WriteRule.DocumentsWriteFacts;
}

function fixture(root: string, options: FixtureOptions = {}) {
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>(
    [parentId, childId].map((id) => [id, liveThreadShell(id)]),
  );
  const child = shells.get(childId)!;
  shells.set(childId, {
    ...child,
    lineage: { parentThreadId: parentId, rootThreadId: parentId, relationshipToParent: "subagent" },
  });
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
  });
  return mcpLayer({
    root,
    requireEnabled:
      options.documentsOff === true
        ? Effect.fail(
            new Contracts.DocsMcpFailure({
              code: "feature_disabled",
              message: "documents is off. Open Settings → Policies.",
            }),
          )
        : Effect.void,
    ...(options.writable === true ? { writeAccess: allowStoreWrite } : {}),
    ...(options.writeFacts === undefined ? {} : { writeFacts: factsLayer(options.writeFacts) }),
  }).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(threads),
    Layer.provide(cryptoLayer),
    Layer.provide(ServerSettings.layerTest()),
  );
}

const call = (name: string, args: Record<string, unknown>, threadId: ThreadId = parentId) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server.callTool({ name, arguments: args }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        ...scope,
        thread: {
          threadId,
          providerSessionId: "session:docs-test",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
      }),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
  });

const decodeFailure = (result: McpSchema.CallToolResult) => {
  assert.isTrue(result.isError);
  const content = result.content[0];
  assert.equal(content?.type, "text");
  if (content?.type !== "text") throw new Error("Expected a text failure");
  return JSON.parse(content.text) as { readonly code: string; readonly message: string };
};

const structured = (_name: string) => (result: McpSchema.CallToolResult) => {
  assert.isFalse(result.isError);
  return result.structuredContent as Record<string, unknown>;
};

const seed = (root: string) =>
  Effect.gen(function* () {
    yield* writeDoc(
      root,
      "project/plan.md",
      `---\nstable_id: ${NIL_ID}\n---\n# Plan\n\nStorage decisions.\n`,
    );
    yield* writeDoc(root, "project/notes.md", "# Notes\n\nNothing yet.\n");
  });

const withFixture = <A, E>(
  options: FixtureOptions,
  use: (root: string) => Effect.Effect<A, E, McpServer.McpServer>,
  setup?: (root: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const root = yield* makeRoot();
    const body = Effect.gen(function* () {
      if (setup !== undefined) yield* Effect.orDie(setup(root));
      return yield* use(root);
    });
    return yield* body.pipe(
      Effect.provide(fixture(root, options)),
      Effect.ensuring(removeRoot(root)),
    );
  });

/** Registers the seeded files through the tool that runs a reconcile on an id miss. */
const prime = (root: string) =>
  call("docs_read", { ref: `oc://doc/${NIL_ID}` }).pipe(Effect.as(root));

describe("docs MCP tools", () => {
  it.effect("docs_read resolves by path and by oc:// id without an absolute path", () =>
    withFixture(
      {},
      (root) =>
        Effect.gen(function* () {
          yield* prime(root);
          const byPath = structured("docs_read")(
            yield* call("docs_read", { ref: "project/plan.md" }),
          );
          assert.equal(byPath.stableId, NIL_ID);
          assert.equal(byPath.ocLink, `oc://doc/${NIL_ID}`);
          assert.include(String(byPath.content), "# Plan");
          assert.notInclude(JSON.stringify(byPath), root);

          const byId = structured("docs_read")(
            yield* call("docs_read", { ref: `oc://doc/${NIL_ID}` }),
          );
          assert.equal(byId.relPath, "project/plan.md");
        }),
      seed,
    ),
  );

  it.effect("docs_list returns one folder level", () =>
    withFixture(
      {},
      (root) =>
        Effect.gen(function* () {
          yield* prime(root);
          const listed = structured("docs_list")(yield* call("docs_list", { folder: "project" }));
          assert.deepStrictEqual(
            (listed.documents as ReadonlyArray<{ relPath: string }>).map((entry) => entry.relPath),
            ["project/notes.md", "project/plan.md"],
          );
          assert.notInclude(JSON.stringify(listed), root);
        }),
      seed,
    ),
  );

  it.effect("docs_manifest returns every document without a limit", () =>
    withFixture(
      {},
      (root) =>
        Effect.gen(function* () {
          yield* prime(root);
          const manifest = structured("docs_manifest")(yield* call("docs_manifest", {}));
          assert.deepStrictEqual(
            (manifest.documents as ReadonlyArray<{ relPath: string }>).map(
              (entry) => entry.relPath,
            ),
            ["project/notes.md", "project/plan.md"],
          );
          const limited = structured("docs_manifest")(yield* call("docs_manifest", { limit: 1 }));
          assert.equal((limited.documents as ReadonlyArray<unknown>).length, 1);
        }),
      seed,
    ),
  );

  it.effect("docs_resolve returns metadata without content", () =>
    withFixture(
      {},
      (root) =>
        Effect.gen(function* () {
          yield* prime(root);
          const resolved = structured("docs_resolve")(
            yield* call("docs_resolve", { ref: `oc://doc/${NIL_ID}` }),
          );
          assert.equal(resolved.relPath, "project/plan.md");
          assert.equal(resolved.description, "");
          assert.isUndefined(resolved.content);
          assert.notInclude(JSON.stringify(resolved), root);
        }),
      seed,
    ),
  );

  it.effect("docs_search finds text of a written document", () =>
    withFixture({ writable: true }, () =>
      Effect.gen(function* () {
        structured("docs_write")(
          yield* call("docs_write", {
            relPath: "project/searchable.md",
            content: "# Searchable\n\nstorage decisions\n",
            clientRequestId: "write:search",
          }),
        );
        const found = structured("docs_search")(yield* call("docs_search", { query: "storag*" }));
        assert.deepStrictEqual(
          (found.results as ReadonlyArray<{ relPath: string; title: string }>).map((result) => [
            result.relPath,
            result.title,
          ]),
          [["project/searchable.md", "Searchable"]],
        );
      }),
    ),
  );

  it.effect("docs_write follows the lineage rule: top-level writes, a child reads", () =>
    withFixture({}, () =>
      Effect.gen(function* () {
        const created = structured("docs_write")(
          yield* call("docs_write", {
            relPath: "project/top.md",
            content: "# Top\n",
            clientRequestId: "write:top",
          }),
        );
        assert.equal(created.relPath, "project/top.md");

        const denied = decodeFailure(
          yield* call(
            "docs_write",
            {
              relPath: "project/child.md",
              content: "# Child\n",
              clientRequestId: "write:child",
            },
            childId,
          ),
        );
        assert.equal(denied.code, "capability_denied");
        assert.include(denied.message, "child_read_only");

        const described = decodeFailure(
          yield* call(
            "docs_set_description",
            { ref: String(created.ocLink), description: "Child edit." },
            childId,
          ),
        );
        assert.equal(described.code, "capability_denied");
        assert.include(described.message, "child_read_only");
      }),
    ),
  );

  it.effect("a planner child writes only the plan document of its card", () =>
    withFixture(
      { writeFacts: { role: "planner", planStableId: NIL_ID, granted: false } },
      (root) =>
        Effect.gen(function* () {
          yield* prime(root);
          const plan = structured("docs_read")(
            yield* call("docs_read", { ref: `oc://doc/${NIL_ID}` }, childId),
          );
          const saved = structured("docs_write")(
            yield* call(
              "docs_write",
              {
                ref: `oc://doc/${NIL_ID}`,
                content: `---\nstable_id: ${NIL_ID}\n---\n# Plan\n\nOwned.\n`,
                baseSha256: String(plan.sha256),
                clientRequestId: "write:plan",
              },
              childId,
            ),
          );
          assert.equal(saved.stableId, NIL_ID);

          const notes = structured("docs_read")(
            yield* call("docs_read", { ref: "project/notes.md" }, childId),
          );
          const other = decodeFailure(
            yield* call(
              "docs_write",
              {
                ref: "project/notes.md",
                content: "# Notes\n\nChanged.\n",
                baseSha256: String(notes.sha256),
                clientRequestId: "write:other",
              },
              childId,
            ),
          );
          assert.equal(other.code, "capability_denied");
          assert.include(other.message, "planner_other_document");
        }),
      seed,
    ),
  );

  it.effect("docs_write creates, replaces and reports a stale base sha", () =>
    withFixture({ writable: true }, () =>
      Effect.gen(function* () {
        const created = structured("docs_write")(
          yield* call("docs_write", {
            relPath: "project/created.md",
            content: "# Created\n",
            clientRequestId: "write:1",
          }),
        );
        assert.equal(created.relPath, "project/created.md");
        const replaced = structured("docs_write")(
          yield* call("docs_write", {
            ref: created.ocLink,
            content: "# Created\n\nmore\n",
            baseSha256: created.sha256,
            clientRequestId: "write:2",
          }),
        );
        assert.notEqual(replaced.sha256, created.sha256);
        const stale = decodeFailure(
          yield* call("docs_write", {
            ref: created.ocLink,
            content: "# Later\n",
            baseSha256: created.sha256,
            clientRequestId: "write:3",
          }),
        );
        assert.equal(stale.code, "document_changed");
      }),
    ),
  );

  it.effect("docs_set_description updates metadata", () =>
    withFixture(
      { writable: true },
      (root) =>
        Effect.gen(function* () {
          yield* prime(root);
          const updated = structured("docs_set_description")(
            yield* call("docs_set_description", {
              ref: `oc://doc/${NIL_ID}`,
              description: "The storage plan.",
            }),
          );
          assert.equal(updated.description, "The storage plan.");
          const resolved = structured("docs_resolve")(
            yield* call("docs_resolve", { ref: "project/plan.md" }),
          );
          assert.equal(resolved.description, "The storage plan.");
        }),
      seed,
    ),
  );

  it.effect("every tool refuses while the documents feature is off", () =>
    withFixture({ documentsOff: true }, () =>
      Effect.gen(function* () {
        for (const [name, args] of [
          ["docs_list", {}],
          ["docs_manifest", {}],
          ["docs_read", { ref: "project/plan.md" }],
          ["docs_resolve", { ref: "project/plan.md" }],
          ["docs_search", { query: "plan" }],
          ["docs_write", { relPath: "project/new.md", content: "# New\n", clientRequestId: "w" }],
          ["docs_set_description", { ref: "project/plan.md", description: "x" }],
        ] as const) {
          assert.equal(decodeFailure(yield* call(name, args)).code, "feature_disabled");
        }
      }),
    ),
  );

  it.effect("docs_read reports an unknown reference as outside the store", () =>
    withFixture({}, () =>
      Effect.gen(function* () {
        const failure = decodeFailure(yield* call("docs_read", { ref: "C:/elsewhere/plan.md" }));
        assert.equal(failure.code, "document_outside_store");
      }),
    ),
  );
});

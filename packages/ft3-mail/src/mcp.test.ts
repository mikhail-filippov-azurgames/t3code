import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../../apps/server/src/mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../../apps/server/src/mcp/McpInvocationContext.ts";
import * as SqlitePersistence from "../../../apps/server/src/persistence/Sqlite.ts";

import { databaseLayer, gateLayer, mailHarness, migrateMail } from "./mail.testkit.ts";
import { mailMcpLayerFrom } from "./mcp.ts";

const leadId = ThreadId.make("thread:mail-lead");

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:mail-test"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "session:mail-test",
  thread: {
    threadId: leadId,
    providerSessionId: "session:mail-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mail-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mail-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const cryptoLayer = Layer.merge(
  Layer.succeed(
    SecureRandom.SecureRandom,
    SecureRandom.make((size) => globalThis.crypto.getRandomValues(new Uint8Array(size))),
  ),
  Digest.layerWebCrypto,
);

const fixture = (
  enabled: boolean,
  projectOverrides: Record<string, { readonly mail?: boolean }> = {},
) => {
  const otherLeadId = ThreadId.make("thread:mail-other-lead");
  const harness = mailHarness({
    enabled,
    cardOwners: { "card:one": leadId },
    threadProjects: {
      [leadId]: "project:mcp-test",
      [otherLeadId]: "project:other",
    },
    projectOverrides,
  });
  const layer = mailMcpLayerFrom(harness.layer, gateLayer(enabled, true, projectOverrides)).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provideMerge(harness.threadLayer),
    Layer.provide(cryptoLayer),
    // Exposes the same in-memory database the harness stack writes to.
    Layer.provideMerge(databaseLayer),
  );
  return { layer, otherLeadId };
};

const call = (
  name: string,
  args: Record<string, unknown>,
  invocationScope: McpInvocationContext.McpInvocationScope = scope,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocationScope),
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

const structured = (result: McpSchema.CallToolResult) => {
  assert.isFalse(result.isError);
  return result.structuredContent as Record<string, unknown>;
};

const taskOf = (result: Record<string, unknown>) =>
  result.task as {
    readonly taskId: string;
    readonly title: string;
    readonly cardId: string | null;
    readonly isolation: string | null;
  };
const letterOf = (result: Record<string, unknown>) =>
  result.letter as { readonly letterId: string; readonly body: string };
const memberOf = (result: Record<string, unknown>) =>
  (result.members as ReadonlyArray<{ readonly member: { readonly memberId: string } }>)[0]!.member;

describe("mail MCP tools", () => {
  it.effect("creates, sends, reads and overrides through the tools", () =>
    Effect.gen(function* () {
      yield* migrateMail;
      const created = structured(
        yield* call("mail_task_create", {
          title: "Refactor",
          brief: "Split the module.",
          level: "medium",
          cardId: "card:one",
          isolation: "worktree",
          members: [{ role: "implementation" }],
          clientRequestId: "request:team",
        }),
      );
      assert.isTrue(created.created);
      const task = taskOf(created);
      assert.equal(task.title, "Refactor");
      assert.equal(task.cardId, "card:one");
      assert.equal(task.isolation, "worktree");
      const member = memberOf(created);

      const sent = structured(
        yield* call("mail_send", {
          taskId: task.taskId,
          to: "role:implementation",
          kind: "request",
          body: "Start.",
          clientRequestId: "request:letter",
        }),
      );
      const letter = letterOf(sent);
      assert.equal(letter.body, "Start.");
      assert.equal((sent.launched as ReadonlyArray<unknown>).length, 1);

      const read = structured(yield* call("mail_task_read", { taskId: task.taskId }));
      assert.equal((read.entries as ReadonlyArray<unknown>).length, 1);
      assert.equal(taskOf(read).taskId, task.taskId);

      const full = structured(yield* call("mail_read", { letterId: letter.letterId }));
      assert.equal(letterOf(full).body, "Start.");
      assert.equal(full.effectiveKind, "request");

      const overridden = structured(
        yield* call("mail_member_set_model", {
          taskId: task.taskId,
          memberId: member.memberId,
          modelSelection: { instanceId: "codex", model: "gpt-other" },
          humanInstruction: "Use the other box.",
          clientRequestId: "request:override",
        }),
      ) as unknown as { readonly modelOverrideJson: string | null };
      assert.isNotNull(overridden.modelOverrideJson);

      // The no-op classifier never disputes a kind, so the decision is refused.
      assert.equal(
        decodeFailure(
          yield* call("mail_letter_set_kind", {
            letterId: letter.letterId,
            kind: "blocked",
            clientRequestId: "request:decide",
          }),
        ).code,
        "kind_not_disputed",
      );

      // Closing with an active member closes the member with the task.
      const closed = structured(
        yield* call("mail_task_close", {
          taskId: task.taskId,
          outcome: "succeeded",
          summary: "Done.",
        }),
      ) as unknown as { readonly status: string };
      assert.equal(closed.status, "closed");
    }).pipe(Effect.provide(fixture(true).layer)),
  );

  it.effect("refuses writes with the mail notice while mail is off and lets reads through", () =>
    Effect.gen(function* () {
      yield* migrateMail;
      assert.equal(
        decodeFailure(
          yield* call("mail_task_create", {
            title: "Refactor",
            brief: "Split the module.",
            level: "medium",
            members: [{ role: "implementation" }],
            clientRequestId: "request:team",
          }),
        ).code,
        "mail_disabled_notice",
      );
      // A read that reaches the service reports the missing record, not the notice.
      assert.equal(
        decodeFailure(yield* call("mail_task_read", { taskId: "task:missing" })).code,
        "task_not_found",
      );
      assert.equal(
        decodeFailure(yield* call("mail_read", { letterId: "letter:missing" })).code,
        "letter_not_found",
      );
    }).pipe(Effect.provide(fixture(false).layer)),
  );

  it.effect("refuses callers without a calling thread", () =>
    Effect.gen(function* () {
      yield* migrateMail;
      const hidden = yield* call(
        "mail_task_read",
        { taskId: "task:missing" },
        { ...scope, thread: undefined },
      ).pipe(Effect.flip);
      assert.instanceOf(hidden, McpSchema.InvalidParams);
    }).pipe(Effect.provide(fixture(true).layer)),
  );

  it.effect("checks a mail MCP caller's project independently of the task project", () => {
    const { layer, otherLeadId } = fixture(true, { "project:mcp-test": { mail: false } });
    return Effect.gen(function* () {
      yield* migrateMail;
      const created = structured(
        yield* call(
          "mail_task_create",
          {
            title: "Refactor",
            brief: "Split the module.",
            level: "medium",
            members: [{ role: "implementation" }],
            clientRequestId: "request:other-team",
          },
          { ...scope, thread: { ...scope.thread!, threadId: otherLeadId } },
        ),
      );
      const task = taskOf(created);

      assert.equal(
        decodeFailure(
          yield* call("mail_send", {
            taskId: task.taskId,
            to: "human",
            kind: "info",
            body: "Blocked by the caller project.",
            clientRequestId: "request:caller-off",
          }),
        ).code,
        "mail_disabled_notice",
      );
      assert.isTrue(
        structured(
          yield* call(
            "mail_send",
            {
              taskId: task.taskId,
              to: "human",
              kind: "info",
              body: "Allowed from the task project.",
              clientRequestId: "request:caller-on",
            },
            { ...scope, thread: { ...scope.thread!, threadId: otherLeadId } },
          ),
        ).created,
      );
    }).pipe(Effect.provide(layer));
  });
});

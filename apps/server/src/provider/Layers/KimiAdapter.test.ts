// @effect-diagnostics nodeBuiltinImport:off - resolves the mock ACP agent relative to this test file.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  KimiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { makeKimiAdapter } from "./KimiAdapter.ts";

const decodeKimiSettings = Schema.decodeSync(KimiSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockKimiWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-mock-"));
  return writeFakeCli({
    directory: dir,
    name: "fake-kimi",
    env: extraEnv ?? {},
    source: execScriptSource({ scriptPath: mockAgentPath }),
  });
}

const kimiAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-kimi-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string) =>
  makeKimiAdapter(decodeKimiSettings({ enabled: true, binaryPath })).pipe(Effect.orDie);

it.layer(kimiAdapterTestLayer)("KimiAdapterLive", (it) => {
  it.effect("starts a session, completes a prompt and returns to ready", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-mock-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockKimiWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const events: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, undefined);
          }
        }),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("kimi"), model: "default" },
      });
      assert.equal(session.provider, "kimi");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({ threadId, input: "hello kimi", attachments: [] });
      yield* Deferred.await(turnCompleted);
      assert.includeMembers(
        events.map((event) => event.type),
        ["session.started", "thread.started", "turn.started", "content.delta", "turn.completed"],
      );
      const delta = events.find((event) => event.type === "content.delta");
      if (delta?.type === "content.delta") assert.equal(delta.payload.delta, "hello from mock");

      const readySession = (yield* adapter.listSessions()).find(
        (candidate) => candidate.threadId === threadId,
      );
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("maps an ACP spawn failure to a provider process error", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestAdapter("/definitely/not/installed/kimi");
      const error = yield* adapter
        .startSession({
          threadId: ThreadId.make("kimi-spawn-error"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterProcessError");
      assert.equal(error.provider, "kimi");
    }),
  );
});

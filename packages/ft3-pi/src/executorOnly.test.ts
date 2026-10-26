import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../../../apps/server/src/environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "../../../apps/server/src/mcp/McpSessionRegistry.ts";
import {
  EXECUTOR_ONLY_INSTANCES_ENV,
  isExecutorOnlyProviderInstance,
  parseExecutorOnlyInstances,
} from "./executorOnly.ts";

const fakeHttpServer = HttpServer.HttpServer.of({
  address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-1")),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = McpSessionRegistry.__testing
  .make({ now: () => 1_000 })
  .pipe(
    Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
    Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
    Effect.provide(NodeServices.layer),
  );

const withExecutorOnly = <A, E, R>(value: string, use: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env[EXECUTOR_ONLY_INSTANCES_ENV];
      process.env[EXECUTOR_ONLY_INSTANCES_ENV] = value;
      return previous;
    }),
    () => use,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[EXECUTOR_ONLY_INSTANCES_ENV];
        else process.env[EXECUTOR_ONLY_INSTANCES_ENV] = previous;
      }),
  );

it("parses a comma-separated instance list", () => {
  expect([...parseExecutorOnlyInstances(" pi-local , ,codex ")]).toEqual(["pi-local", "codex"]);
  expect(parseExecutorOnlyInstances(undefined).size).toBe(0);
  expect(
    isExecutorOnlyProviderInstance("pi-local", { [EXECUTOR_ONLY_INSTANCES_ENV]: "pi-local" }),
  ).toBe(true);
});

it.effect("an executor-only instance never receives the orchestration capability", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry;
    const executor = yield* registry.issue({
      threadId: ThreadId.make("thread-executor"),
      providerInstanceId: ProviderInstanceId.make("pi-local"),
    });
    const coordinator = yield* registry.issue({
      threadId: ThreadId.make("thread-coordinator"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect([...(executor.config.capabilities ?? [])].sort()).toEqual([
      "preview",
      "pull-requests",
      "worktree",
    ]);
    expect([...(coordinator.config.capabilities ?? [])].sort()).toEqual([
      "orchestration",
      "preview",
      "pull-requests",
      "worktree",
    ]);
  }).pipe((use) => withExecutorOnly("pi-local", use)),
);

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { vi } from "vite-plus/test";

import { ProviderInstanceId, ProviderSetupError } from "@t3tools/contracts";
import * as MuseMspRuntime from "./MuseMspRuntime.ts";
import { makeMuseCodeAuth } from "./MuseCodeAuth.ts";

const museMspMocks = vi.hoisted(() => ({
  spawnMuseHost: vi.fn(),
  listMuseModels: vi.fn(),
}));

vi.mock("./MuseMspRuntime.ts", () => museMspMocks);

const OPTIONS = {
  instanceId: ProviderInstanceId.make("muse-auth-test"),
  museBin: "muse",
  env: { PATH: "/bin" },
} as const;

const logoutSpawner = (exitCode: number) =>
  ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );

const runLogout = (exitCode: number, onLogout: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const auth = yield* makeMuseCodeAuth({ ...OPTIONS, onLogout });
    return yield* auth.logout(Effect.void);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, logoutSpawner(exitCode)),
      ),
    ),
  );

const runComplete = (
  models: ReadonlyArray<MuseMspRuntime.MuseModelRow>,
  onLogin: Effect.Effect<void>,
) => {
  const host = { close: async () => undefined } as unknown as MuseMspRuntime.MuseHost;
  vi.mocked(MuseMspRuntime.spawnMuseHost).mockReturnValue(Effect.succeed(host));
  vi.mocked(MuseMspRuntime.listMuseModels).mockReturnValue(Effect.succeed(models));

  return Effect.gen(function* () {
    const auth = yield* makeMuseCodeAuth({ ...OPTIONS, onLogin });
    const opened = yield* auth.start("owner-1");
    return yield* auth.complete("owner-1", {
      flowId: opened.flowId as string,
      callbackUrl: "https://localhost/",
    });
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
};

describe("makeMuseCodeAuth", () => {
  it.effect("opens a manual waiting step with a flow id", () =>
    Effect.gen(function* () {
      const auth = yield* makeMuseCodeAuth({ ...OPTIONS, env: { ...OPTIONS.env } });
      const state = yield* auth.start("owner-1");

      expect(state.phase).toBe("waiting");
      expect(state.flowId).toEqual(expect.any(String));
      expect(state.message).toContain("muse login");
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("rejects completion for an unknown flow without spawning", () =>
    Effect.gen(function* () {
      const auth = yield* makeMuseCodeAuth({ ...OPTIONS, env: { ...OPTIONS.env } });
      const failure = yield* Effect.flip(
        auth.complete("owner-1", { flowId: "nope", callbackUrl: "https://localhost/" }),
      );

      expect(failure).toBeInstanceOf(ProviderSetupError);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("cancels an opened flow", () =>
    Effect.gen(function* () {
      const auth = yield* makeMuseCodeAuth({ ...OPTIONS, env: { ...OPTIONS.env } });
      const opened = yield* auth.start("owner-1");
      const cancelled = yield* auth.cancel("owner-1", opened.flowId as string);

      expect(cancelled.phase).toBe("cancelled");
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("detects the logout prompt command", () =>
    Effect.gen(function* () {
      const auth = yield* makeMuseCodeAuth({ ...OPTIONS, env: { ...OPTIONS.env } });

      expect(auth.isLogoutPrompt?.("/logout", false)).toBe(true);
      expect(auth.isLogoutPrompt?.("/login", false)).toBe(false);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("clears cached usage after successful logout", () =>
    Effect.gen(function* () {
      let clearCalls = 0;

      const state = yield* runLogout(
        0,
        Effect.sync(() => {
          clearCalls += 1;
        }),
      );

      expect(state.phase).toBe("idle");
      expect(clearCalls).toBe(1);
    }),
  );

  it.effect("keeps cached usage when the CLI logout fails", () =>
    Effect.gen(function* () {
      let clearCalls = 0;

      const error = yield* Effect.flip(
        runLogout(
          1,
          Effect.sync(() => {
            clearCalls += 1;
          }),
        ),
      );

      expect(error).toBeInstanceOf(ProviderSetupError);
      expect(clearCalls).toBe(0);
    }),
  );

  it.effect("clears cached usage after successful login verification", () =>
    Effect.gen(function* () {
      let clearCalls = 0;

      const state = yield* runComplete(
        [
          {
            modelId: "muse-spark",
            displayLabel: "Muse Spark",
            isDefault: true,
            providerId: "meta",
          },
        ],
        Effect.sync(() => {
          clearCalls += 1;
        }),
      );

      expect(state.phase).toBe("succeeded");
      expect(clearCalls).toBe(1);
    }),
  );

  it.effect("keeps cached usage when login verification finds no models", () =>
    Effect.gen(function* () {
      let clearCalls = 0;

      const state = yield* runComplete(
        [],
        Effect.sync(() => {
          clearCalls += 1;
        }),
      );

      expect(state.phase).toBe("failed");
      expect(clearCalls).toBe(0);
    }),
  );
});

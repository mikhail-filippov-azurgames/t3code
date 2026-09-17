import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProviderInstanceId, ProviderSetupError } from "@t3tools/contracts";

import { makeMuseCodeAuth } from "./MuseCodeAuth.ts";

const OPTIONS = {
  instanceId: ProviderInstanceId.make("muse-auth-test"),
  museBin: "muse",
  env: { PATH: "/bin" },
} as const;

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
});

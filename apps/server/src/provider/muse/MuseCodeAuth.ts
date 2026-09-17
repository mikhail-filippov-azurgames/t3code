/**
 * MuseCodeAuth — external login controller for the Muse Code driver.
 *
 * Sign-in itself happens outside T3 Code: the user runs `muse login` in a
 * terminal and approves the Meta account in a browser. The controller only
 * opens the waiting step, verifies via a scoped `model/list` probe on
 * continue, and signs out via `muse logout`. No tokens ever pass through.
 *
 * @module provider/muse/MuseCodeAuth
 */
import {
  type ProviderAuthState,
  type ProviderInstanceId,
  ProviderSetupError,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { ProviderAuthController } from "../Services/ProviderAuthService.ts";
import { listMuseModels, spawnMuseHost } from "./MuseMspRuntime.ts";

const VERIFY_TIMEOUT_MS = 20_000;
const CLI_TIMEOUT_MS = 30_000;

export interface MuseCodeAuthOptions {
  readonly instanceId: ProviderInstanceId;
  readonly museBin: string;
  readonly env: NodeJS.ProcessEnv;
}

const idleState = (instanceId: ProviderInstanceId): ProviderAuthState => ({
  instanceId,
  phase: "idle",
  flowId: null,
  authorizationUrl: null,
  expiresAt: null,
  message: null,
});

export const makeMuseCodeAuth = Effect.fn("makeMuseCodeAuth")(function* (
  options: MuseCodeAuthOptions,
): Effect.fn.Return<ProviderAuthController, never, Crypto.Crypto | ChildProcessSpawner.ChildProcessSpawner> {
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const stateRef = yield* SubscriptionRef.make(idleState(options.instanceId));
  const activeFlowRef = yield* Ref.make<{ readonly flowId: string; readonly owner: string } | undefined>(
    undefined,
  );

  const setupError = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail });

  const publish = (state: ProviderAuthState) => SubscriptionRef.set(stateRef, state);

  const requireFlow = (ownerSessionId: string, flowId: string, operation: string) =>
    Effect.gen(function* () {
      const active = yield* Ref.get(activeFlowRef);
      if (active === undefined || active.flowId !== flowId || active.owner !== ownerSessionId) {
        return yield* setupError(operation, "This Muse sign-in is no longer active in this client.");
      }
      return active;
    });

  const verifySubscription = Effect.gen(function* () {
    const host = yield* spawnMuseHost({ museBin: options.museBin, env: options.env });
    yield* Effect.addFinalizer(() => Effect.promise(() => host.close()));
    const rows = yield* listMuseModels(host);
    return rows.length > 0;
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(VERIFY_TIMEOUT_MS),
    Effect.map((rows) => rows._tag === "Some"),
    Effect.orElseSucceed(() => false),
  );

  const start: ProviderAuthController["start"] = (ownerSessionId, stopSessions) =>
    Effect.gen(function* () {
      if (stopSessions) {
        yield* stopSessions.pipe(
          Effect.mapError((cause) => setupError("start", `Failed to stop sessions: ${String(cause)}`)),
        );
      }
      const active = yield* Ref.get(activeFlowRef);
      if (active !== undefined) {
        return yield* setupError("start", "Muse sign-in is already in progress.");
      }
      const flowId = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) => setupError("start", `Failed to open sign-in flow: ${String(cause)}`)),
      );
      yield* Ref.set(activeFlowRef, { flowId, owner: ownerSessionId });
      const state: ProviderAuthState = {
        ...idleState(options.instanceId),
        phase: "waiting",
        flowId,
        message: "Run `muse login` in a terminal and approve the Meta account, then choose Continue.",
      };
      yield* publish(state);
      return state;
    });

  const complete: ProviderAuthController["complete"] = (ownerSessionId, input) =>
    Effect.gen(function* () {
      yield* requireFlow(ownerSessionId, input.flowId, "complete");
      const verifying: ProviderAuthState = {
        ...idleState(options.instanceId),
        phase: "verifying",
        flowId: input.flowId,
        message: "Checking Muse subscription access and models.",
      };
      yield* publish(verifying);
      const ok = yield* verifySubscription;
      yield* Ref.set(activeFlowRef, undefined);
      const done: ProviderAuthState = ok
        ? {
            ...idleState(options.instanceId),
            phase: "succeeded",
            message: "Muse subscription verified.",
          }
        : {
            ...idleState(options.instanceId),
            phase: "failed",
            flowId: input.flowId,
            message: "No Muse subscription found. Run `muse login` and try again.",
          };
      yield* publish(done);
      return done;
    });

  const cancel: ProviderAuthController["cancel"] = (ownerSessionId, flowId) =>
    Effect.gen(function* () {
      yield* requireFlow(ownerSessionId, flowId, "cancel");
      yield* Ref.set(activeFlowRef, undefined);
      const state: ProviderAuthState = {
        ...idleState(options.instanceId),
        phase: "cancelled",
        message: "Muse sign-in cancelled.",
      };
      yield* publish(state);
      return state;
    });

  const logout: ProviderAuthController["logout"] = (stopSessions) =>
    Effect.gen(function* () {
      yield* stopSessions.pipe(
        Effect.mapError((cause) => setupError("logout", `Failed to stop sessions: ${String(cause)}`)),
      );
      const spawnCommand = yield* resolveSpawnCommand(options.museBin, ["logout"], {
        env: options.env,
      }).pipe(Effect.mapError((cause) => setupError("logout", `Failed to resolve Muse spawn: ${String(cause)}`)));
      const exitCode = yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(spawnCommand.command, spawnCommand.args, {
              env: options.env,
              shell: spawnCommand.shell,
            }),
          ).pipe(
            Effect.mapError((cause) => setupError("logout", `Failed to spawn Muse logout: ${String(cause)}`)),
          );
          return yield* child.exitCode.pipe(
            Effect.mapError((cause) => setupError("logout", `Muse logout failed: ${String(cause)}`)),
          );
        }),
      ).pipe(
        Effect.timeoutOption(CLI_TIMEOUT_MS),
        Effect.flatMap((code) =>
          code._tag === "Some"
            ? Effect.succeed(code.value)
            : Effect.fail(setupError("logout", "Muse logout timed out.")),
        ),
      );
      if (exitCode !== 0) {
        return yield* setupError("logout", "Muse CLI logout failed.");
      }
      yield* Ref.set(activeFlowRef, undefined);
      const state = idleState(options.instanceId);
      yield* publish(state);
      return state;
    });

  return {
    start,
    complete,
    cancel,
    logout,
    subscribe: () => SubscriptionRef.changes(stateRef),
    isLogoutPrompt: (text) => text.trim().toLowerCase().startsWith("/logout"),
  } satisfies ProviderAuthController;
});

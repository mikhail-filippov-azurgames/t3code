import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as OpenCodeRuntime from "./opencodeRuntime.ts";

const OPENCODE_SERVER_IDLE_TTL = "30 seconds";

interface OpenCodeServerOwnerState {
  server: OpenCodeRuntime.OpenCodeServerProcess | null;
  serverScope: Scope.Closeable | null;
  borrowers: number;
  idleCloseFiber: Fiber.Fiber<void, never> | null;
}

interface OpenCodeServerOwnerShape {
  readonly withServer: <A, E, R>(
    use: (server: OpenCodeRuntime.OpenCodeServerProcess) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | OpenCodeRuntime.OpenCodeRuntimeError, R>;
  /**
   * Takes one reference without releasing it. Pair every borrow with exactly
   * one `release` — the server closes on the idle TTL after the last one.
   * Prefer `withServer` when acquire/use/release fit in one effect; this is
   * for lifetimes that outlive a single effect, such as a provider session.
   */
  readonly borrow: () => Effect.Effect<
    OpenCodeRuntime.OpenCodeServerProcess,
    OpenCodeRuntime.OpenCodeRuntimeError
  >;
  readonly release: (server: OpenCodeRuntime.OpenCodeServerProcess) => Effect.Effect<void>;
}

export class OpenCodeServerOwner extends Context.Service<
  OpenCodeServerOwner,
  OpenCodeServerOwnerShape
>()("t3/provider/OpenCodeServerOwner") {}

/** A refcounted handle to one owner's shared server. */
export interface OpenCodeServerOwnerHandle {
  readonly borrow: OpenCodeServerOwnerShape["borrow"];
  readonly release: OpenCodeServerOwnerShape["release"];
}

/** Owns the lazy local OpenCode server shared by one provider instance. */
export const make = Effect.fn("OpenCodeServerOwner.make")(function* (input: {
  readonly binaryPath: string;
  readonly directory: string;
  readonly serverPassword?: string;
  readonly environment?: NodeJS.ProcessEnv;
}) {
  const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
  const ownerScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const mutex = yield* Semaphore.make(1);
  const state: OpenCodeServerOwnerState = {
    server: null,
    serverScope: null,
    borrowers: 0,
    idleCloseFiber: null,
  };

  const cancelIdleClose = Effect.fn("OpenCodeServerOwner.cancelIdleClose")(function* () {
    const fiber = state.idleCloseFiber;
    state.idleCloseFiber = null;
    if (fiber !== null) {
      yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
    }
  });

  const closeServer = Effect.fn("OpenCodeServerOwner.closeServer")(function* (
    expected?: OpenCodeRuntime.OpenCodeServerProcess,
  ) {
    if (expected !== undefined && state.server !== expected) {
      return;
    }
    const scope = state.serverScope;
    state.server = null;
    state.serverScope = null;
    if (scope !== null) {
      yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
    }
  });

  const watchServerExit = Effect.fn("OpenCodeServerOwner.watchServerExit")(function* (
    server: OpenCodeRuntime.OpenCodeServerProcess,
  ) {
    yield* server.exitCode;
    yield* mutex.withPermit(
      Effect.gen(function* () {
        if (state.server !== server) {
          return;
        }
        yield* cancelIdleClose();
        yield* closeServer(server);
      }),
    );
  });

  const acquireServer = mutex.withPermit(
    Effect.gen(function* () {
      yield* cancelIdleClose();
      if (state.server !== null) {
        if (yield* state.server.isRunning) {
          state.borrowers += 1;
          return state.server;
        }
        yield* closeServer(state.server);
      }

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const serverScope = yield* Scope.make();
          const started = yield* Effect.exit(
            restore(
              runtime
                .startOpenCodeServerProcess({
                  binaryPath: input.binaryPath,
                  directory: input.directory,
                  ...(input.serverPassword !== undefined
                    ? { serverPassword: input.serverPassword }
                    : {}),
                  ...(input.environment ? { environment: input.environment } : {}),
                })
                .pipe(Effect.provideService(Scope.Scope, serverScope)),
            ),
          );
          if (Exit.isFailure(started)) {
            yield* Scope.close(serverScope, Exit.void).pipe(Effect.ignore);
            return yield* Effect.failCause(started.cause);
          }

          const server = started.value;
          state.server = server;
          state.serverScope = serverScope;
          state.borrowers = 1;
          yield* watchServerExit(server).pipe(Effect.forkIn(ownerScope));
          return server;
        }),
      );
    }),
  );

  const releaseServer = (server: OpenCodeRuntime.OpenCodeServerProcess) =>
    mutex.withPermit(
      Effect.gen(function* () {
        if (state.server !== server) {
          return;
        }
        state.borrowers = Math.max(0, state.borrowers - 1);
        if (state.borrowers > 0) {
          return;
        }
        yield* cancelIdleClose();
        state.idleCloseFiber = yield* Effect.sleep(OPENCODE_SERVER_IDLE_TTL).pipe(
          Effect.andThen(
            mutex.withPermit(
              Effect.gen(function* () {
                if (state.server !== server || state.borrowers > 0) {
                  return;
                }
                state.idleCloseFiber = null;
                yield* closeServer(server);
              }),
            ),
          ),
          Effect.forkIn(ownerScope),
        );
      }),
    );

  yield* Effect.addFinalizer(() =>
    mutex.withPermit(
      Effect.gen(function* () {
        yield* cancelIdleClose();
        state.borrowers = 0;
        yield* closeServer();
      }),
    ),
  );

  return OpenCodeServerOwner.of({
    withServer: (use) =>
      Effect.uninterruptibleMask((restore) =>
        restore(acquireServer).pipe(
          Effect.flatMap((server) =>
            restore(use(server)).pipe(Effect.ensuring(releaseServer(server))),
          ),
        ),
      ),
    borrow: () => Effect.uninterruptibleMask((restore) => restore(acquireServer)),
    release: releaseServer,
  });
});

/**
 * One refcounted owner per (binaryPath, serverPassword, directory). Owners live
 * until the registry's scope closes; each owned server still closes on its own
 * idle TTL when the last borrower releases. Chat sessions that can share a
 * server resolve the same key and therefore reuse one process.
 */
export interface OpenCodeServerOwnerRegistry {
  readonly resolve: (input: {
    readonly binaryPath: string;
    readonly directory: string;
    readonly serverPassword?: string;
    readonly environment?: NodeJS.ProcessEnv;
  }) => Effect.Effect<OpenCodeServerOwnerHandle>;
}

const ownerKey = (input: {
  readonly binaryPath: string;
  readonly directory: string;
  readonly serverPassword?: string;
}): string => `${input.binaryPath}\u0000${input.serverPassword ?? ""}\u0000${input.directory}`;

export const makeRegistry = Effect.fn("OpenCodeServerOwner.makeRegistry")(function* () {
  const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
  const ownersScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const mutex = yield* Semaphore.make(1);
  const owners = new Map<string, OpenCodeServerOwnerHandle>();

  const resolve: OpenCodeServerOwnerRegistry["resolve"] = (input) =>
    mutex.withPermit(
      Effect.gen(function* () {
        const key = ownerKey(input);
        const existing = owners.get(key);
        if (existing !== undefined) {
          return existing;
        }
        // Bind every owner to the registry scope so owners outlive individual
        // borrowers and only close when the adapter layer shuts down.
        const owner = yield* make(input).pipe(
          Effect.provideService(Scope.Scope, ownersScope),
          Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime),
        );
        owners.set(key, owner);
        return owner;
      }),
    );

  return { resolve } satisfies OpenCodeServerOwnerRegistry;
});

/** @public Service construction is part of the canonical Effect module API. */
export const layer = (input: {
  readonly binaryPath: string;
  readonly directory: string;
  readonly serverPassword?: string;
  readonly environment?: NodeJS.ProcessEnv;
}) => Layer.effect(OpenCodeServerOwner, make(input));

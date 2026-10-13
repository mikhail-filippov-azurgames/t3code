import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import { HttpClient } from "effect/unstable/http";

import type {
  DesktopBackendInstance,
  DesktopBackendSnapshot,
  DesktopBackendStartConfig,
  BackendInstanceSpec,
} from "./DesktopBackendManager.ts";

const POLL_INTERVAL = Duration.seconds(2);
const REQUEST_TIMEOUT = Duration.seconds(3);
const MAX_CONSECUTIVE_FAILURES = 3;

export type ExternalBackendAvailabilityTransition = "ready" | "shutdown" | "none";

export function resolveAvailabilityTransition(
  wasReady: boolean,
  isHealthy: boolean,
  consecutiveFailures = 0,
): ExternalBackendAvailabilityTransition {
  if (isHealthy && !wasReady) return "ready";
  if (!isHealthy && wasReady && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return "shutdown";
  return "none";
}

export const isExternalServerMode = () => process.env.FT3_EXTERNAL_SERVER === "1";

export const makeExternalBackendInstance = Effect.fn("desktop.externalBackend.make")(function* (
  spec: BackendInstanceSpec,
  options: {
    readonly healthCheck?: () => Effect.Effect<boolean>;
    readonly pollInterval?: Duration.Duration;
  } = {},
): Effect.fn.Return<DesktopBackendInstance, never, HttpClient.HttpClient | Scope.Scope> {
  const parentScope = yield* Scope.Scope;
  const httpClient = yield* HttpClient.HttpClient;
  const state = yield* Ref.make({
    desiredRunning: false,
    ready: false,
    consecutiveFailures: 0,
    config: Option.none<DesktopBackendStartConfig>(),
    fiber: Option.none<Fiber.Fiber<void, never>>(),
  });

  const snapshot = Ref.get(state).pipe(
    Effect.map((current): DesktopBackendSnapshot => ({
      desiredRunning: current.desiredRunning,
      ready: current.ready,
      activePid: Option.none(),
      restartAttempt: 0,
      restartScheduled: false,
    })),
  );

  const currentConfig = Ref.get(state).pipe(Effect.map((current) => current.config));

  const probe = () =>
    options.healthCheck
      ? options.healthCheck()
      : httpClient.get("http://127.0.0.1:3773/.well-known/t3/environment").pipe(
          Effect.flatMap((response) =>
            response.text.pipe(Effect.as(response.status >= 200 && response.status < 300)),
          ),
          Effect.timeoutOption(REQUEST_TIMEOUT),
          Effect.map(Option.getOrElse(() => false)),
          Effect.orElseSucceed(() => false),
        );

  const poll = Effect.fn("desktop.externalBackend.poll")(function* () {
    const healthy = yield* probe();
    const current = yield* Ref.get(state);
    const consecutiveFailures = current.ready && !healthy ? current.consecutiveFailures + 1 : 0;
    const transition = resolveAvailabilityTransition(current.ready, healthy, consecutiveFailures);
    yield* Ref.update(state, (value) => ({
      ...value,
      consecutiveFailures: transition === "shutdown" ? 0 : consecutiveFailures,
    }));
    if (transition === "ready") {
      const config = yield* spec.configResolve.pipe(Effect.option);
      if (Option.isSome(config)) {
        yield* Ref.update(state, (value) => ({ ...value, ready: true, config }));
        yield* (spec.onReady?.(new URL("http://127.0.0.1:3773")) ?? Effect.void).pipe(
          Effect.ignore,
        );
      }
    } else if (transition === "shutdown") {
      yield* Ref.update(state, (value) => ({ ...value, ready: false }));
      yield* (spec.onShutdown?.() ?? Effect.void).pipe(Effect.ignore);
    }
  });

  const start = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    if (current.desiredRunning) return;
    yield* Ref.update(state, (value) => ({ ...value, desiredRunning: true }));
    const fiber = yield* Effect.forkIn(
      poll().pipe(
        Effect.repeat(Schedule.spaced(options.pollInterval ?? POLL_INTERVAL)),
        Effect.asVoid,
      ),
      parentScope,
    );
    yield* Ref.update(state, (value) => ({ ...value, fiber: Option.some(fiber) }));
  }).pipe(Effect.withSpan("desktop.externalBackend.start"));

  const stop = Effect.fn("desktop.externalBackend.stop")(function* () {
    const current = yield* Ref.getAndUpdate(state, (value) => ({
      ...value,
      desiredRunning: false,
      ready: false,
      fiber: Option.none(),
    }));
    if (Option.isSome(current.fiber)) yield* Fiber.interrupt(current.fiber.value);
  });

  const waitForReady = Effect.fn("desktop.externalBackend.waitForReady")(function* (
    timeout: Duration.Duration,
  ) {
    return yield* Ref.get(state).pipe(
      Effect.map((value) => ({ done: value.ready, ready: value.ready })),
      Effect.repeat({
        until: (value) => value.done,
        schedule: Schedule.spaced(Duration.millis(100)),
      }),
      Effect.map((value) => value.ready),
      Effect.timeoutOption(timeout),
      Effect.map(Option.getOrElse(() => false)),
    );
  });

  yield* Effect.addFinalizer(() => stop());
  return {
    id: spec.id,
    label: spec.label,
    start,
    stop,
    currentConfig,
    snapshot,
    waitForReady,
  } satisfies DesktopBackendInstance;
});

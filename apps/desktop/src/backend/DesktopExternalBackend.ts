import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import { HttpClient, HttpClientRequest } from "effect/http";

import type {
  BackendInstanceSpec,
  DesktopBackendInstance,
  DesktopBackendSnapshot,
  DesktopBackendStartConfig,
} from "./DesktopBackendManager.ts";

const POLL_INTERVAL = Duration.seconds(2);
const REQUEST_TIMEOUT = Duration.seconds(3);
const MAX_CONSECUTIVE_FAILURES = 3;
// Same unauthenticated probe the manager uses to declare a backend ready.
const READINESS_PATH = "/.well-known/t3/environment";

const EXTERNAL_SERVER_ENV = "FT3_EXTERNAL_SERVER";
const BOOTSTRAP_TOKEN_FILE = "desktop-bootstrap-token";

export type ExternalBackendAvailabilityTransition = "ready" | "shutdown" | "none";

/** The window only owns a client when a separately started server holds the port. */
export const isExternalServerMode = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env[EXTERNAL_SERVER_ENV] === "1";

export function resolveAvailabilityTransition(
  wasReady: boolean,
  isHealthy: boolean,
  consecutiveFailures = 0,
): ExternalBackendAvailabilityTransition {
  if (isHealthy && !wasReady) return "ready";
  if (!isHealthy && wasReady && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return "shutdown";
  return "none";
}

export interface ExternalStartConfigInput {
  readonly port: number;
  readonly bindHost: string;
  readonly httpBaseUrl: URL;
  readonly tailscaleServeEnabled: boolean;
  readonly tailscaleServePort: number;
  readonly baseDir: string;
  readonly backendEntryPath: string;
  readonly backendCwd: string;
  readonly bootstrapToken: string;
}

/**
 * A start config without a process: the headless launcher owns the server, the window only
 * needs the matching bootstrap token and URL.
 */
export function resolveExternalStartConfig(
  input: ExternalStartConfigInput,
): DesktopBackendStartConfig {
  return {
    executablePath: process.execPath,
    entryPath: input.backendEntryPath,
    cwd: input.backendCwd,
    args: [],
    env: {},
    extendEnv: true,
    bootstrap: {
      mode: "desktop",
      noBrowser: true,
      port: input.port,
      t3Home: input.baseDir,
      host: input.bindHost,
      desktopBootstrapToken: input.bootstrapToken,
      shellEnvironmentPrepared: true,
      tailscaleServeEnabled: input.tailscaleServeEnabled,
      tailscaleServePort: input.tailscaleServePort,
    },
    bootstrapDelivery: "fd3",
    httpBaseUrl: input.httpBaseUrl,
    captureOutput: false,
    preflightFailure: Option.none(),
  };
}

export const resolveBootstrapTokenPath = (input: {
  readonly joinPath: (...segments: ReadonlyArray<string>) => string;
  readonly baseDir: string;
}): string => input.joinPath(input.baseDir, "userdata", "secrets", BOOTSTRAP_TOKEN_FILE);

/** The launcher writes the token; a missing file keeps the window waiting instead of spawning a server. */
export const readExternalBootstrapToken = (
  fileSystem: FileSystem.FileSystem,
  tokenPath: string,
): Effect.Effect<string, PlatformError.PlatformError> =>
  fileSystem.readFileString(tokenPath).pipe(Effect.map((raw) => raw.trim()));

export const makeExternalBackendInstance = Effect.fn("desktop.externalBackend.make")(function* (
  spec: BackendInstanceSpec,
  options: {
    readonly healthCheck?: (baseUrl: URL) => Effect.Effect<boolean>;
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

  const probe = (baseUrl: URL) =>
    options.healthCheck
      ? options.healthCheck(baseUrl)
      : httpClient.execute(HttpClientRequest.get(new URL(READINESS_PATH, baseUrl).href)).pipe(
          Effect.map((response) => response.status >= 200 && response.status < 300),
          Effect.timeoutOption(REQUEST_TIMEOUT),
          Effect.map(Option.getOrElse(() => false)),
          Effect.orElseSucceed(() => false),
        );

  const poll = Effect.fn("desktop.externalBackend.poll")(function* () {
    const current = yield* Ref.get(state);
    const resolved = Option.isSome(current.config)
      ? current.config
      : yield* spec.configResolve.pipe(Effect.option);
    if (Option.isNone(resolved)) {
      return;
    }
    const config = resolved.value;
    const healthy = yield* probe(config.httpBaseUrl);
    const consecutiveFailures = current.ready && !healthy ? current.consecutiveFailures + 1 : 0;
    const transition = resolveAvailabilityTransition(current.ready, healthy, consecutiveFailures);
    yield* Ref.update(state, (value) => ({
      ...value,
      config: Option.some(config),
      consecutiveFailures: transition === "shutdown" ? 0 : consecutiveFailures,
    }));
    if (transition === "ready") {
      yield* Ref.update(state, (value) => ({ ...value, ready: true }));
      yield* (spec.onReady?.(config.httpBaseUrl) ?? Effect.void).pipe(Effect.ignore);
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

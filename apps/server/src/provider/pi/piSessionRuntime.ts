import * as NodeCrypto from "node:crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import type { RuntimeMode } from "@t3tools/contracts";

import {
  buildPiAbortCommand,
  buildPiClearQueueCommand,
  buildPiExtensionUiResponse,
  buildPiGetStateCommand,
  buildPiPromptCommand,
  classifyPiStdoutRecord,
  encodePiCommand,
  isPiSettledEvent,
  nextPiCommandId,
  parsePiResponseRecord,
  readPiPromptDisposition,
  readPiSessionIdFromState,
  splitPiJsonl,
  type PiCommand,
} from "./piRpcProtocol.ts";
import {
  nodePiProcessFactory,
  type PiProcessFactory,
  type PiSpawnedProcess,
} from "./piProcessFactory.ts";
import { PI_TOOL_GUARD_READY_MESSAGE } from "./piToolGuard.ts";
import { buildPiLaunchEnvironment, resolvePiLaunchProfile } from "./piPermissionBridge.ts";

export type { PiProcessFactory, PiSpawnedProcess };

export const PI_RPC_SETTLED_TIMEOUT_MS = 10 * 60 * 1_000;
export const PI_RPC_ACCEPT_TIMEOUT_MS = 30_000;
export const PI_RPC_INTERRUPT_SETTLED_TIMEOUT_MS = 15_000;
export const PI_RPC_GUARD_READY_TIMEOUT_MS = 10_000;

function piSessionIdForThread(threadId: string): string {
  // Pi rejects ':' (used by delegated FT3 thread IDs). Preserve existing
  // valid IDs so ordinary sessions keep their current Pi history.
  if (/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(threadId)) return threadId;
  return `ft3-${NodeCrypto.createHash("sha256").update(threadId).digest("hex")}`;
}

export interface PiPromptAcceptedState {
  /** Whether Pi was still processing when it accepted this RPC prompt. */
  readonly runActive: boolean;
}

export interface PiSessionRuntimeOptions {
  readonly threadId: string;
  /**
   * Pre-resolved pinned launch (see `resolvePiRuntime`): bundled `node cli.js`.
   * The runtime appends Pi CLI args to `commandPrefixArgs`.
   */
  readonly launchCommand: string;
  readonly launchPrefixArgs: ReadonlyArray<string>;
  readonly launchOrigin: string;
  readonly runtimeMode: RuntimeMode;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly agentDir: string;
  /** Explicit FT3-managed extension; all ambient extension discovery is disabled. */
  readonly guardExtensionPath: string;
  /** Explicit project SKILL.md files for this cwd while Pi project trust stays disabled. */
  readonly projectSkillPaths?: ReadonlyArray<string> | undefined;
  readonly model?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly settledTimeoutMs?: number | undefined;
  readonly guardReadyTimeoutMs?: number | undefined;
  readonly processFactory?: PiProcessFactory | undefined;
}

export interface PiSessionEvent {
  readonly record: unknown;
  /** FT3 turn owning this record, captured in Pi RPC stdout order. */
  readonly turnId?: string | undefined;
}

export interface PiExtensionUiCall {
  readonly id: string;
  readonly method: string;
  readonly record: Record<string, unknown>;
  readonly turnId?: string | undefined;
}

export type PiPromptAcceptedHandler = (
  state: PiPromptAcceptedState,
) => Effect.Effect<string | undefined>;

/**
 * One Pi RPC child per FT3 thread. Scope-owned: closing the scope ends
 * stdin and kills the child, so no Pi process outlives its thread.
 */
export type PiPromptStreamingBehavior = "steer" | "followUp";

export interface PiSessionRuntime {
  readonly start: () => Effect.Effect<{ readonly sessionId: string | undefined }, Error>;
  readonly sendPrompt: (
    message: string,
    streamingBehavior?: PiPromptStreamingBehavior | undefined,
    onAccepted?: PiPromptAcceptedHandler | undefined,
  ) => Effect.Effect<
    { readonly disposition: string; readonly acceptedTurnId?: string | undefined },
    Error
  >;
  readonly interrupt: () => Effect.Effect<void, Error>;
  readonly getSessionId: Effect.Effect<string | undefined>;
  readonly events: Queue.Queue<PiSessionEvent>;
  readonly extensionUiRequests: Queue.Queue<PiExtensionUiCall>;
  readonly answerExtensionUi: (id: string, payload: Record<string, unknown>) => Effect.Effect<void>;
  readonly waitForSettled: () => Effect.Effect<void, Error>;
  readonly close: Effect.Effect<void>;
}

function piError(detail: string, cause?: unknown): Error {
  return new Error(`Pi RPC: ${detail}`, cause === undefined ? undefined : { cause });
}

/** Truncate rich Pi payloads for transparent error messages. */
function piPayloadSnippet(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 500);
  if (value === null || value === undefined) return "null";
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}

export const makePiSessionRuntime = (
  options: PiSessionRuntimeOptions,
): Effect.Effect<PiSessionRuntime, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<PiSessionEvent>();
    const extensionUiRequests = yield* Queue.unbounded<PiExtensionUiCall>();
    const pendingResponses = new Map<
      string,
      {
        readonly deferred: Deferred.Deferred<unknown, Error>;
        readonly onPromptAccepted?: PiPromptAcceptedHandler | undefined;
      }
    >();
    const sessionIdRef = yield* Ref.make<string | undefined>(options.sessionId);
    const activeTurnIdRef = yield* Ref.make<string | undefined>(undefined);
    const settledDeferredRef = yield* Ref.make<Deferred.Deferred<void, Error> | undefined>(
      undefined,
    );
    const guardReadyDeferred = yield* Deferred.make<void, Error>();
    const closedRef = yield* Ref.make(false);
    // True between `agent_start` and `agent_settled`: the only window where
    // an `agent_settled` can still arrive. `interrupt` consults it so an
    // idle abort returns without waiting (and without killing) while an
    // in-flight run still gets the waiter-first treatment below.
    const runActiveRef = yield* Ref.make(false);
    const dropUntilAgentStartRef = yield* Ref.make(options.sessionId !== undefined);
    const settledTimeoutMs = options.settledTimeoutMs ?? PI_RPC_SETTLED_TIMEOUT_MS;

    const profile = resolvePiLaunchProfile(options.runtimeMode);
    const piArgs: Array<string> = [
      "--mode",
      "rpc",
      "--session-id",
      piSessionIdForThread(options.threadId),
      "--no-tools",
      "--tools",
      profile.tools.join(","),
      "--no-extensions",
      "--no-skills",
      "--extension",
      options.guardExtensionPath,
    ];
    for (const skillPath of options.projectSkillPaths ?? []) {
      piArgs.push("--skill", skillPath);
    }
    if (options.model?.trim()) piArgs.push("--model", options.model.trim());
    const args = [...options.launchPrefixArgs, ...piArgs];

    const launchEnvironment = buildPiLaunchEnvironment(profile, options.env, options.agentDir);
    if (!launchEnvironment.ok) return yield* Effect.fail(piError(launchEnvironment.reason));
    const env = launchEnvironment.environment;

    const factory = options.processFactory ?? nodePiProcessFactory;
    // Node spawn reports real failures (missing binary, bad cwd) through
    // the async `error`/exit handlers below, which fail pending work with
    // the launch origin attached.
    const child: PiSpawnedProcess = yield* Effect.sync(() =>
      factory({ command: options.launchCommand, args, cwd: options.cwd, env }),
    );

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        try {
          child.endStdin();
        } catch {
          // Finalizer must not throw; kill below still runs.
        }
        try {
          child.kill("SIGTERM");
        } catch {
          // Already exited.
        }
      }),
    );

    const failPending = (cause: Error): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const pending of pendingResponses.values()) {
          yield* Deferred.fail(pending.deferred, cause).pipe(Effect.ignore);
        }
        pendingResponses.clear();
        const settled = yield* Ref.get(settledDeferredRef);
        if (settled) {
          yield* Deferred.fail(settled, cause).pipe(Effect.ignore);
          yield* Ref.set(settledDeferredRef, undefined);
        }
        yield* Deferred.fail(guardReadyDeferred, cause).pipe(Effect.ignore);
      });

    const handleRecord = (value: unknown): Effect.Effect<void> =>
      Effect.gen(function* () {
        const kind = classifyPiStdoutRecord(value);
        if (kind === "response") {
          const response = parsePiResponseRecord(value);
          if (response?.id && pendingResponses.has(response.id)) {
            const pending = pendingResponses.get(response.id)!;
            pendingResponses.delete(response.id);
            if (response.success) {
              if (response.command === "prompt" && pending.onPromptAccepted) {
                const activation = yield* Effect.exit(
                  pending.onPromptAccepted({ runActive: yield* Ref.get(runActiveRef) }),
                );
                if (activation._tag === "Failure") {
                  // Pi accepted the prompt, but FT3 could not establish its
                  // turn owner. Fail the caller promptly and leave following
                  // events untagged instead of reusing a stale turn id.
                  yield* Ref.set(activeTurnIdRef, undefined);
                  yield* Ref.set(runActiveRef, false);
                  yield* Ref.set(dropUntilAgentStartRef, true);
                  yield* Deferred.fail(
                    pending.deferred,
                    piError(
                      "Pi accepted the prompt but FT3 could not activate its turn.",
                      activation.cause,
                    ),
                  ).pipe(Effect.ignore);
                  return;
                }
                yield* Ref.set(activeTurnIdRef, activation.value);
              }
              yield* Deferred.succeed(pending.deferred, response.data ?? {});
            } else {
              yield* Deferred.fail(
                pending.deferred,
                piError(
                  `Pi command ${response.command} failed: ${piPayloadSnippet(response.error ?? response.data)}`,
                ),
              );
            }
          }
          if (response && !response.success && response.command === "get_state") {
            yield* Queue.offer(events, {
              record: { type: "pi_get_state_failed", error: response.error ?? response.data },
            });
          }
          return;
        }
        if (kind === "extensionUiRequest") {
          const record = value as Record<string, unknown>;
          const id = typeof record.id === "string" ? record.id : "";
          const method = typeof record.method === "string" ? record.method : "";
          // The adapter drains this queue and always answers (FT3 approval
          // or auto-decline); when the adapter is gone the scope finalizer
          // kills the child, so no runtime-level backstop is needed here.
          if (id && method) {
            const turnId = yield* Ref.get(activeTurnIdRef);
            if (method === "notify" && record.message === PI_TOOL_GUARD_READY_MESSAGE) {
              yield* Deferred.succeed(guardReadyDeferred, undefined).pipe(Effect.ignore);
              // This notification is the runtime's private startup handshake,
              // not a UI request or session event for the adapter to process.
              return;
            }
            yield* Queue.offer(events, {
              record: { ...record, type: "pi_extension_ui_request", id, method },
              ...(turnId ? { turnId } : {}),
            });
            yield* Queue.offer(extensionUiRequests, {
              id,
              method,
              record,
              ...(turnId ? { turnId } : {}),
            });
          }
          return;
        }
        // Session event.
        const record = value as Record<string, unknown>;
        if (typeof record.type === "string") {
          if (record.type === "agent_start") {
            yield* Ref.set(dropUntilAgentStartRef, false);
            yield* Ref.set(runActiveRef, true);
          } else if (yield* Ref.get(dropUntilAgentStartRef)) {
            return;
          }
          const turnId = yield* Ref.get(activeTurnIdRef);
          yield* Queue.offer(events, { record: value, ...(turnId ? { turnId } : {}) });
          if (isPiSettledEvent(value)) {
            yield* Ref.set(runActiveRef, false);
            if ((yield* Ref.get(activeTurnIdRef)) === turnId) {
              yield* Ref.set(activeTurnIdRef, undefined);
            }
            const settled = yield* Ref.get(settledDeferredRef);
            if (settled) {
              yield* Deferred.succeed(settled, undefined).pipe(Effect.ignore);
              yield* Ref.set(settledDeferredRef, undefined);
            }
          }
        }
      });

    // Stdout framing and JSON parsing run in plain callback code (matching
    // the `opencodeRuntime` CLI parsers); only the parsed records cross
    // into Effect for queue/deferred delivery.
    let stdoutRemainder = "";
    // Child stdout can split one Pi write across chunks. Keep a single chain
    // so prompt acceptance and subsequent session events retain wire order.
    let stdoutRecordChain: Promise<void> = Promise.resolve();
    let childExitCode: number | null | undefined;
    const deliverChunk = (chunk: string): void => {
      const { records, remainder } = splitPiJsonl(stdoutRemainder + chunk);
      stdoutRemainder = remainder;
      const values: Array<unknown> = [];
      for (const line of records) {
        try {
          values.push(JSON.parse(line) as unknown);
        } catch {
          continue;
        }
      }
      if (values.length > 0) {
        stdoutRecordChain = stdoutRecordChain
          .then(() => Effect.runPromise(Effect.forEach(values, handleRecord, { discard: true })))
          .catch(() => undefined);
      }
    };
    yield* Effect.sync(() => {
      child.onStdout(deliverChunk);
      child.onStderr((chunk) => {
        void Effect.runPromise(
          Queue.offer(events, { record: { type: "pi_stderr", text: String(chunk).slice(-4_000) } }),
        );
      });
      child.onExit((code) => {
        childExitCode = code;
      });
      child.onClose((code) => {
        const finalCode = code ?? childExitCode ?? null;
        // Node's `exit` may precede the final stdout data. `close` guarantees
        // the stdio streams have ended; drain the serialized JSONL handler
        // before publishing exit or rejecting any outstanding RPC response.
        void stdoutRecordChain.then(() =>
          Effect.runPromise(
            Effect.gen(function* () {
              yield* Ref.set(closedRef, true);
              yield* Queue.offer(events, { record: { type: "pi_exit", code: finalCode } });
              yield* failPending(piError(`Pi process exited (code ${String(finalCode)}).`));
            }),
          ),
        );
      });
      child.onError((cause) => {
        void Effect.runPromise(failPending(piError("Pi process error.", cause)));
      });
    });

    const sendCommand = <A>(
      command: PiCommand,
      onPromptAccepted?: PiPromptAcceptedHandler | undefined,
    ): Effect.Effect<A, Error> =>
      Effect.gen(function* () {
        if (yield* Ref.get(closedRef)) {
          return yield* Effect.fail(piError("Pi session is closed."));
        }
        const id = typeof command.id === "string" ? command.id : nextPiCommandId();
        const withId: PiCommand = { ...command, id };
        const deferred = yield* Deferred.make<A, Error>();
        pendingResponses.set(id, {
          deferred: deferred as Deferred.Deferred<unknown, Error>,
          ...(onPromptAccepted ? { onPromptAccepted } : {}),
        });
        yield* Effect.sync(() => child.writeStdin(encodePiCommand(withId)));
        const accepted = yield* Deferred.await(deferred).pipe(
          Effect.timeoutOption(PI_RPC_ACCEPT_TIMEOUT_MS),
        );
        if (Option.isNone(accepted)) {
          pendingResponses.delete(id);
          return yield* Effect.fail(piError(`Pi command ${withId.type} timed out after 30s.`));
        }
        return accepted.value;
      });

    const start = (): Effect.Effect<{ readonly sessionId: string | undefined }, Error> =>
      Effect.gen(function* () {
        const data = yield* sendCommand<unknown>(buildPiGetStateCommand(nextPiCommandId("state")));
        const ready = yield* Deferred.await(guardReadyDeferred).pipe(
          Effect.timeoutOption(options.guardReadyTimeoutMs ?? PI_RPC_GUARD_READY_TIMEOUT_MS),
        );
        if (Option.isNone(ready)) {
          return yield* Effect.fail(
            piError("FT3 tool guard extension did not complete its RPC startup handshake."),
          );
        }
        const sessionId = readPiSessionIdFromState(data);
        if (sessionId) yield* Ref.set(sessionIdRef, sessionId);
        return { sessionId: sessionId ?? (yield* Ref.get(sessionIdRef)) };
      });

    const waitForSettled = (): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<void, Error>();
        yield* Ref.set(settledDeferredRef, deferred);
        const settled = yield* Deferred.await(deferred).pipe(
          Effect.timeoutOption(settledTimeoutMs),
        );
        if (Option.isNone(settled)) {
          yield* Ref.set(settledDeferredRef, undefined);
          return yield* Effect.fail(
            piError(`Pi turn did not settle within ${Math.round(settledTimeoutMs / 1000)}s.`),
          );
        }
      });

    const sendPrompt = (
      message: string,
      streamingBehavior?: PiPromptStreamingBehavior | undefined,
      onAccepted?: PiPromptAcceptedHandler | undefined,
    ): Effect.Effect<
      { readonly disposition: string; readonly acceptedTurnId?: string | undefined },
      Error
    > =>
      Effect.gen(function* () {
        let acceptedTurnId: string | undefined;
        const response = yield* sendCommand<unknown>(
          buildPiPromptCommand({
            id: nextPiCommandId("prompt"),
            message,
            ...(streamingBehavior ? { streamingBehavior } : {}),
          }),
          onAccepted
            ? (state) =>
                Effect.gen(function* () {
                  acceptedTurnId = yield* onAccepted(state);
                  return acceptedTurnId;
                })
            : undefined,
        );
        const disposition = readPiPromptDisposition(
          parsePiResponseRecord({
            type: "response",
            command: "prompt",
            success: true,
            data: response,
          }) ?? {
            command: "prompt",
            success: true,
          },
        );
        // Prompt accept responses carry no disposition; report what was
        // asked: a queued follow-up/steer stays on the active turn, a plain
        // prompt starts a new run.
        return {
          disposition: disposition ?? (streamingBehavior ? "queued" : "started"),
          ...(acceptedTurnId ? { acceptedTurnId } : {}),
        };
      });

    const interrupt = (): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        // `abort` waits for the session to become idle before responding, and
        // Pi emits `agent_settled` before that response — so the waiter must
        // be registered BEFORE either command goes out, or the settled event
        // is missed and the interrupt degrades to a kill after 15s.
        const waiter = yield* Deferred.make<void, Error>();
        yield* Ref.set(settledDeferredRef, waiter);
        // Documented Esc recipe: drop queued steering/follow-ups first so
        // `abort` cannot continue them, then abort and wait for idle.
        yield* sendCommand<unknown>(buildPiClearQueueCommand(nextPiCommandId("clear-queue"))).pipe(
          Effect.ignore,
        );
        yield* sendCommand<unknown>(buildPiAbortCommand(nextPiCommandId("abort"))).pipe(
          Effect.ignore,
        );
        // An idle abort answers immediately and no `agent_settled` follows:
        // waiting here would always time out and SIGTERM a healthy session.
        if (yield* Ref.get(runActiveRef)) {
          const settled = yield* Deferred.await(waiter).pipe(
            Effect.timeoutOption(PI_RPC_INTERRUPT_SETTLED_TIMEOUT_MS),
          );
          if (Option.isNone(settled)) {
            yield* Effect.sync(() => child.kill("SIGTERM"));
          }
        }
        // Clear only our own waiter: a newer waiter registered concurrently
        // (e.g. a test driving `waitForSettled`) must survive.
        const current = yield* Ref.get(settledDeferredRef);
        if (current === waiter) {
          yield* Ref.set(settledDeferredRef, undefined);
        }
      });

    const answerExtensionUi = (id: string, payload: Record<string, unknown>) =>
      Effect.sync(() =>
        child.writeStdin(encodePiCommand(buildPiExtensionUiResponse({ id, payload }))),
      );

    const close = Effect.gen(function* () {
      yield* Ref.set(closedRef, true);
      yield* Effect.sync(() => {
        try {
          child.endStdin();
        } catch {
          // Already closed.
        }
        try {
          child.kill("SIGTERM");
        } catch {
          // Already exited.
        }
      });
      yield* failPending(piError("Pi session closed."));
    });

    return {
      start,
      sendPrompt,
      interrupt,
      getSessionId: Ref.get(sessionIdRef),
      events,
      extensionUiRequests,
      answerExtensionUi,
      waitForSettled,
      close,
    };
  });

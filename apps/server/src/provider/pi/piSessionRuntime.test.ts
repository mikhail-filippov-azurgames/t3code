import * as NodeAssert from "node:assert/strict";

import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import {
  makePiSessionRuntime,
  type PiProcessFactory,
  type PiSessionRuntimeOptions,
  type PiSpawnedProcess,
} from "./piSessionRuntime.ts";

function makeMockFactory(overrides?: {
  /** Prompt messages containing this marker never settle on their own. */
  readonly hangMarker?: string | undefined;
  /** When false, `abort` answers without an `agent_settled` (stuck run). */
  readonly abortSettles?: boolean | undefined;
  readonly guardReady?: boolean | undefined;
  readonly rejectPrompt?: boolean | undefined;
  readonly deferPromptResponse?: boolean | undefined;
}) {
  const hangMarker = overrides?.hangMarker ?? "HANG";
  const abortSettles = overrides?.abortSettles ?? true;
  const guardReady = overrides?.guardReady ?? true;
  const rejectPrompt = overrides?.rejectPrompt ?? false;
  const deferPromptResponse = overrides?.deferPromptResponse ?? false;
  const state: {
    written: Array<string>;
    stdout: Array<(chunk: string) => void>;
    exit: Array<(code: number | null) => void>;
    close: Array<(code: number | null) => void>;
    killed: Array<string>;
    launch: Array<{
      command: string;
      args: ReadonlyArray<string>;
      cwd: string;
      env: NodeJS.ProcessEnv;
    }>;
  } = { written: [], stdout: [], exit: [], close: [], killed: [], launch: [] };
  const emit = (record: unknown): void => {
    queueMicrotask(() =>
      state.stdout.forEach((listener) => listener(`${JSON.stringify(record)}\n`)),
    );
  };
  const emitRecords = (...records: ReadonlyArray<unknown>): void => {
    const chunk = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    state.stdout.forEach((listener) => listener(chunk));
  };
  const process: PiSpawnedProcess = {
    pid: 4242,
    writeStdin: (line) => {
      state.written.push(line);
      const command = JSON.parse(line) as { id?: string; type: string; message?: string };
      if (command.type === "get_state") {
        emit({
          type: "response",
          id: command.id,
          command: "get_state",
          success: true,
          data: { sessionId: "sess-1" },
        });
        if (guardReady) {
          emit({
            type: "extension_ui_request",
            id: "guard-ready",
            method: "notify",
            message: "FT3_PI_TOOL_GUARD_READY_V1",
          });
        }
      }
      if (command.type === "prompt") {
        if (deferPromptResponse) return;
        if (rejectPrompt) {
          emit({
            type: "response",
            id: command.id,
            command: "prompt",
            success: false,
            error: "preflight rejected",
          });
          return;
        }
        // Real accept responses carry no data (disposition is only known
        // from the streamingBehavior the client sent).
        emit({ type: "response", id: command.id, command: "prompt", success: true });
        emit({ type: "agent_start" });
        if (!command.message?.includes(hangMarker)) {
          emit({ type: "agent_settled" });
        }
      }
      if (command.type === "clear_queue") {
        emit({
          type: "response",
          id: command.id,
          command: "clear_queue",
          success: true,
          data: { steering: [], followUp: [] },
        });
      }
      if (command.type === "abort") {
        // Real Pi emits `agent_settled` BEFORE the abort response (`abort`
        // waits for idle before responding), so the mock does the same: a
        // waiter registered after the response would miss the event.
        if (abortSettles) {
          emit({ type: "agent_settled" });
        }
        emit({ type: "response", id: command.id, command: "abort", success: true });
      }
    },
    endStdin: () => {},
    kill: (signal) => {
      state.killed.push(signal ?? "SIGTERM");
    },
    onStdout: (listener) => {
      state.stdout.push(listener);
    },
    onStderr: () => {},
    onExit: (listener) => {
      state.exit.push(listener);
    },
    onClose: (listener) => {
      state.close.push(listener);
    },
    onError: () => {},
  };
  const factory = (input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  }) => {
    state.launch.push({ ...input });
    return process;
  };
  return {
    state,
    emit,
    emitRecords,
    emitExit: (code: number | null) => state.exit.forEach((listener) => listener(code)),
    emitClose: (code: number | null) => state.close.forEach((listener) => listener(code)),
    factory,
  };
}

const baseOptions = (factory: PiProcessFactory): PiSessionRuntimeOptions => ({
  threadId: "thread-1",
  launchCommand: "pi",
  launchPrefixArgs: [],
  launchOrigin: "test",
  runtimeMode: "approval-required",
  cwd: "/tmp",
  env: {},
  agentDir: "/tmp/pi-agent",
  guardExtensionPath: "/tmp/pi-agent/sessions/thread-1/extensions/ft3-guard/index.js",
  processFactory: factory,
});

describe("makePiSessionRuntime", () => {
  it.effect("uses a stable Pi-safe session ID for delegated threads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mock = makeMockFactory();
        const runtime = yield* makePiSessionRuntime({
          ...baseOptions(mock.factory),
          threadId: "delegated-task:child-1",
        });
        yield* runtime.start();
        const args = mock.state.launch[0]?.args ?? [];
        const sessionId = args[args.indexOf("--session-id") + 1];
        NodeAssert.match(sessionId ?? "", /^ft3-[a-f0-9]{64}$/);
        NodeAssert.ok(!sessionId?.includes(":"));

        const nextMock = makeMockFactory();
        const nextRuntime = yield* makePiSessionRuntime({
          ...baseOptions(nextMock.factory),
          threadId: "delegated-task:child-1",
        });
        yield* nextRuntime.start();
        const nextArgs = nextMock.state.launch[0]?.args ?? [];
        NodeAssert.equal(nextArgs[nextArgs.indexOf("--session-id") + 1], sessionId);
      }),
    ),
  );

  it.effect("starts, prompts, and settles through agent_settled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mock = makeMockFactory();
        const runtime = yield* makePiSessionRuntime(baseOptions(mock.factory));
        const started = yield* runtime.start();
        NodeAssert.equal(started.sessionId, "sess-1");
        const args = mock.state.launch[0]?.args ?? [];
        NodeAssert.equal(args[args.indexOf("--session-id") + 1], "thread-1");
        const prompt = yield* runtime.sendPrompt("hello");
        NodeAssert.equal(prompt.disposition, "started");
        yield* runtime.waitForSettled();
        NodeAssert.ok(mock.state.written.some((line) => line.includes('"type":"prompt"')));
      }),
    ),
  );

  it.effect("waits for the explicit FT3 guard and disables ambient extensions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mock = makeMockFactory();
        const runtime = yield* makePiSessionRuntime(baseOptions(mock.factory));
        yield* runtime.start();
        const args = mock.state.launch[0]?.args ?? [];
        NodeAssert.ok(args.includes("--no-extensions"));
        NodeAssert.ok(args.includes("--no-tools"));
        NodeAssert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls");
        NodeAssert.ok(args.includes("--extension"));
        NodeAssert.ok(
          args.includes("/tmp/pi-agent/sessions/thread-1/extensions/ft3-guard/index.js"),
        );
      }),
    ),
  );

  it.effect("pins the full-access built-in tool set in the Pi launch arguments", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mock = makeMockFactory();
        const runtime = yield* makePiSessionRuntime({
          ...baseOptions(mock.factory),
          runtimeMode: "full-access",
        });
        yield* runtime.start();
        const args = mock.state.launch[0]?.args ?? [];
        NodeAssert.equal(
          args[args.indexOf("--tools") + 1],
          "read,bash,powershell,edit,write,grep,find,ls",
        );
        NodeAssert.ok(args.includes("--no-extensions"));
      }),
    ),
  );

  it.effect("rejects inherited loader and runtime hooks before spawning Pi", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mock = makeMockFactory();
        const result = yield* Effect.result(
          makePiSessionRuntime({
            ...baseOptions(mock.factory),
            env: {
              PATH: "/usr/bin",
              LD_PRELOAD: "/tmp/pi-hook.so",
              NODE_OPTIONS: "--require /tmp/pi-hook.cjs",
              HTTPS_PROXY: "http://proxy.example:8080",
              OPENAI_BASE_URL: "https://remote.example/v1",
              PI_BUNDLED_PI_BIN: "/tmp/custom-pi",
              PI_CODING_AGENT_DIR: "/tmp/ambient-pi",
            },
          }),
        );

        NodeAssert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          NodeAssert.match(result.failure.message, /unsafe environment variable LD_PRELOAD/i);
        }
        NodeAssert.equal(mock.state.launch.length, 0);
      }),
    ),
  );

  it.effect(
    "keeps worktree cwd and isolated agent dir while native context and skills remain enabled",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const mock = makeMockFactory();
          const runtime = yield* makePiSessionRuntime({
            ...baseOptions(mock.factory),
            cwd: "C:\\worktrees\\thread-7",
            agentDir: "C:\\ft3-state\\pi\\pi-default\\agent",
            projectSkillPaths: [
              "C:\\worktrees\\thread-7\\.agents\\skills\\worktree-skill\\SKILL.md",
              "C:\\main\\.agents\\skills\\repo-skill\\SKILL.md",
            ],
          });
          yield* runtime.start();
          const launch = mock.state.launch[0]!;
          NodeAssert.equal(launch.cwd, "C:\\worktrees\\thread-7");
          NodeAssert.equal(launch.env.PI_CODING_AGENT_DIR, "C:\\ft3-state\\pi\\pi-default\\agent");
          NodeAssert.ok(launch.args.includes("--no-extensions"));
          NodeAssert.equal(launch.args.filter((arg) => arg === "--skill").length, 2);
          NodeAssert.ok(
            launch.args.includes(
              "C:\\worktrees\\thread-7\\.agents\\skills\\worktree-skill\\SKILL.md",
            ),
          );
          NodeAssert.ok(launch.args.includes("--no-skills"));
          NodeAssert.ok(!launch.args.includes("--no-context-files"));
        }),
      ),
  );

  it.effect("passes Electron Node-mode env through to the Pi child", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mock = makeMockFactory();
        const runtime = yield* makePiSessionRuntime({
          ...baseOptions(mock.factory),
          launchCommand: "C:\\Program Files\\T3 Code\\T3 Code.exe",
          env: { ELECTRON_RUN_AS_NODE: "1" },
        });
        yield* runtime.start();
        NodeAssert.equal(mock.state.launch[0]?.command, "C:\\Program Files\\T3 Code\\T3 Code.exe");
        NodeAssert.equal(mock.state.launch[0]?.env.ELECTRON_RUN_AS_NODE, "1");
      }),
    ),
  );

  it.effect("fails startup if the FT3 guard never signals readiness", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mock = makeMockFactory({ guardReady: false });
        const runtime = yield* makePiSessionRuntime({
          ...baseOptions(mock.factory),
          guardReadyTimeoutMs: 50,
        });
        const start = yield* runtime.start().pipe(Effect.result, Effect.forkChild);
        yield* TestClock.adjust("51 millis");
        const result = yield* Fiber.join(start);
        NodeAssert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          NodeAssert.match(String(result.failure), /guard extension did not complete/);
        }
      }),
    ),
  );

  it.effect("interrupts with clear_queue before abort", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mock = makeMockFactory();
        const runtime = yield* makePiSessionRuntime(baseOptions(mock.factory));
        yield* runtime.start();
        yield* runtime.sendPrompt("hello");
        yield* runtime.interrupt();
        const types = mock.state.written.map((line) => (JSON.parse(line) as { type: string }).type);
        const clearIndex = types.indexOf("clear_queue");
        const abortIndex = types.indexOf("abort");
        NodeAssert.ok(clearIndex >= 0 && abortIndex >= 0 && clearIndex < abortIndex);
      }),
    ),
  );

  it.effect("interrupt resolves when settled precedes the abort response", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mock = makeMockFactory();
        const runtime = yield* makePiSessionRuntime(baseOptions(mock.factory));
        yield* runtime.start();
        yield* runtime.sendPrompt("HANG please");
        // Deterministic sync point: the run is provably active before the
        // interrupt goes out. No sleeps.
        const startEvent = yield* Queue.take(runtime.events);
        NodeAssert.equal((startEvent.record as { type: string }).type, "agent_start");
        yield* runtime.interrupt();
        NodeAssert.deepEqual(mock.state.killed, []);
      }),
    ),
  );

  it.effect("interrupt on idle never waits for settled nor kills", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mock = makeMockFactory();
        const runtime = yield* makePiSessionRuntime(baseOptions(mock.factory));
        yield* runtime.start();
        // No prompt: nothing is streaming, so no `agent_settled` will ever
        // arrive. The old code waited here and SIGTERMed the healthy child.
        yield* runtime.interrupt();
        NodeAssert.deepEqual(mock.state.killed, []);
        const types = new Set(
          mock.state.written.map((line) => (JSON.parse(line) as { type: string }).type),
        );
        NodeAssert.ok(types.has("clear_queue") && types.has("abort"));
      }),
    ),
  );

  it.effect("interrupt kills a run that never settles", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mock = makeMockFactory({ abortSettles: false });
        const runtime = yield* makePiSessionRuntime(baseOptions(mock.factory));
        yield* runtime.start();
        yield* runtime.sendPrompt("HANG please");
        const startEvent = yield* Queue.take(runtime.events);
        NodeAssert.equal((startEvent.record as { type: string }).type, "agent_start");
        const interrupter = yield* runtime.interrupt().pipe(Effect.forkChild);
        yield* TestClock.adjust("16 seconds");
        yield* Fiber.join(interrupter);
        NodeAssert.deepEqual(mock.state.killed, ["SIGTERM"]);
      }),
    ),
  );

  it.effect("sendPrompt forwards streamingBehavior and reports queued", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mock = makeMockFactory();
        const runtime = yield* makePiSessionRuntime(baseOptions(mock.factory));
        yield* runtime.start();
        const queued = yield* runtime.sendPrompt("later", "followUp");
        NodeAssert.equal(queued.disposition, "queued");
        const promptLine = mock.state.written.find((line) => line.includes('"type":"prompt"'));
        NodeAssert.ok(promptLine?.includes('"streamingBehavior":"followUp"'));
        const started = yield* runtime.sendPrompt("now");
        NodeAssert.equal(started.disposition, "started");
      }),
    ),
  );

  it.effect("accepts each FT3 turn before tagging later Pi events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mock = makeMockFactory();
        const runtime = yield* makePiSessionRuntime(baseOptions(mock.factory));
        yield* runtime.start();
        const acceptanceStates: Array<boolean> = [];
        const first = yield* runtime.sendPrompt("first", undefined, ({ runActive }) => {
          acceptanceStates.push(runActive);
          return Effect.succeed("old-turn");
        });
        NodeAssert.equal(first.acceptedTurnId, "old-turn");
        const firstStart = yield* Queue.take(runtime.events);
        NodeAssert.equal((firstStart.record as { type: string }).type, "agent_start");
        NodeAssert.equal(firstStart.turnId, "old-turn");
        const firstSettled = yield* Queue.take(runtime.events);
        NodeAssert.equal((firstSettled.record as { type: string }).type, "agent_settled");
        NodeAssert.equal(firstSettled.turnId, "old-turn");

        const next = yield* runtime.sendPrompt("second", "followUp", ({ runActive }) => {
          acceptanceStates.push(runActive);
          return Effect.succeed(runActive ? "old-turn" : "new-turn");
        });
        NodeAssert.equal(next.acceptedTurnId, "new-turn");
        const secondStart = yield* Queue.take(runtime.events);
        NodeAssert.equal((secondStart.record as { type: string }).type, "agent_start");
        NodeAssert.equal(secondStart.turnId, "new-turn");
        NodeAssert.deepEqual(acceptanceStates, [false, false]);
      }),
    ),
  );

  it.effect("does not activate a turn when Pi rejects prompt preflight", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mock = makeMockFactory({ rejectPrompt: true });
        const runtime = yield* makePiSessionRuntime(baseOptions(mock.factory));
        yield* runtime.start();
        let activated = false;
        const result = yield* runtime
          .sendPrompt("rejected", undefined, () => {
            activated = true;
            return Effect.succeed("phantom-turn");
          })
          .pipe(Effect.result);
        NodeAssert.equal(result._tag, "Failure");
        NodeAssert.equal(activated, false);
      }),
    ),
  );

  it.effect("fails promptly and leaves events untagged if FT3 turn activation fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mock = makeMockFactory();
        const runtime = yield* makePiSessionRuntime(baseOptions(mock.factory));
        yield* runtime.start();
        const result = yield* runtime
          .sendPrompt("accepted but not activated", undefined, () =>
            Effect.die(new Error("activation failed")),
          )
          .pipe(Effect.result);
        NodeAssert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          NodeAssert.match(result.failure.message, /could not activate its turn/);
        }
        const startEvent = yield* Queue.take(runtime.events);
        NodeAssert.equal((startEvent.record as { type: string }).type, "agent_start");
        NodeAssert.equal(startEvent.turnId, undefined);
      }),
    ),
  );

  it.effect("fails fast after the child closes (no accept-timeout hang)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mock = makeMockFactory();
        const runtime = yield* makePiSessionRuntime({
          ...baseOptions(mock.factory),
          settledTimeoutMs: 50,
        });
        yield* runtime.start();
        mock.emitExit(1);
        mock.emitClose(1);
        // `close` is the deterministic settlement point after stdout drain.
        const exitEvent = yield* Queue.take(runtime.events);
        NodeAssert.equal((exitEvent.record as { type: string }).type, "pi_exit");
        const promptResult = yield* runtime.sendPrompt("hello").pipe(Effect.result);
        NodeAssert.ok(promptResult._tag === "Failure");
        const waiter = yield* runtime.waitForSettled().pipe(Effect.result, Effect.forkChild);
        yield* TestClock.adjust("100 millis");
        const settledResult = yield* Fiber.join(waiter);
        NodeAssert.ok(settledResult._tag === "Failure");
      }),
    ),
  );

  it.effect(
    "drains prompt and terminal stdout records after exit before rejecting pending work",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const mock = makeMockFactory({ deferPromptResponse: true });
          const runtime = yield* makePiSessionRuntime(baseOptions(mock.factory));
          yield* runtime.start();
          const promptFiber = yield* runtime
            .sendPrompt("accepted after exit", undefined, () => Effect.succeed("late-turn"))
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          const promptLine = mock.state.written.find((line) => line.includes('"type":"prompt"'));
          NodeAssert.ok(promptLine);
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          const promptCommand = JSON.parse(promptLine!) as { id: string };

          mock.emitExit(0);
          mock.emitRecords(
            { type: "response", id: promptCommand.id, command: "prompt", success: true },
            { type: "agent_start" },
            { type: "agent_settled" },
          );
          mock.emitClose(0);

          const prompt = yield* Fiber.join(promptFiber);
          NodeAssert.equal(prompt.acceptedTurnId, "late-turn");
          const startEvent = yield* Queue.take(runtime.events);
          const settledEvent = yield* Queue.take(runtime.events);
          const exitEvent = yield* Queue.take(runtime.events);
          NodeAssert.equal((startEvent.record as { type: string }).type, "agent_start");
          NodeAssert.equal(startEvent.turnId, "late-turn");
          NodeAssert.equal((settledEvent.record as { type: string }).type, "agent_settled");
          NodeAssert.equal(settledEvent.turnId, "late-turn");
          NodeAssert.equal((exitEvent.record as { type: string }).type, "pi_exit");
        }),
      ),
  );

  it.effect("kills the child on close (no orphan processes)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mock = makeMockFactory();
        const runtime = yield* makePiSessionRuntime(baseOptions(mock.factory));
        yield* runtime.close;
        NodeAssert.deepEqual(mock.state.killed, ["SIGTERM"]);
        NodeAssert.ok(yield* Queue.size(runtime.events).pipe(Effect.map((size) => size >= 0)));
      }),
    ),
  );
});

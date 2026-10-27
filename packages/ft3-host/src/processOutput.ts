import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export interface ProcessOutput {
  stdout: string;
  stderr: string;
}

/**
 * Codex can leave helpers holding the inherited pipes after it exits, so EOF is not a
 * reliable completion signal: wait for the exit code, then drain for a bounded time.
 */
/**
 * Codex can leave helpers holding the inherited pipes after it exits, so EOF is not a
 * reliable completion signal: collect in the background, wait for the exit code, then
 * drain for a bounded time.
 */
export const drainProcessOutput = <E, X>(input: {
  readonly output: ProcessOutput;
  readonly stdout: Stream.Stream<Uint8Array, E>;
  readonly stderr: Stream.Stream<Uint8Array, E>;
  readonly exitCode: Effect.Effect<number, X>;
  readonly onStreamError: (cause: E) => X;
  readonly drainMs: number;
}): Effect.Effect<number, X, Scope.Scope> => {
  const collect = (stream: Stream.Stream<Uint8Array, E>, append: (chunk: string) => void) =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) => Effect.sync(() => append(chunk))),
      Effect.mapError(input.onStreamError),
    );
  return Effect.gen(function* () {
    const collecting = yield* Effect.all(
      [
        collect(input.stdout, (chunk) => {
          input.output.stdout += chunk;
        }),
        collect(input.stderr, (chunk) => {
          input.output.stderr += chunk;
        }),
      ],
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.forkScoped);
    const exitCode = yield* input.exitCode;
    yield* Fiber.join(collecting).pipe(Effect.timeoutOption(input.drainMs));
    return exitCode;
  });
};

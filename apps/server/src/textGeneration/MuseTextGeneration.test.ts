import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { TextGenerationError } from "@t3tools/contracts";

import { decodeMuseJsonOutput, makeMuseTextGeneration } from "./MuseTextGeneration.ts";

const TitleSchema = Schema.Struct({ title: Schema.String });

describe("decodeMuseJsonOutput", () => {
  it.effect("decodes a plain JSON object", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeMuseJsonOutput(
        "generateThreadTitle",
        TitleSchema,
        `{"title": "Fix login race"}`,
      );

      expect(decoded).toEqual({ title: "Fix login race" });
    }),
  );

  it.effect("unwraps fenced output", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeMuseJsonOutput(
        "generateThreadTitle",
        TitleSchema,
        '```json\n{"title": "Fix login race"}\n```',
      );

      expect(decoded).toEqual({ title: "Fix login race" });
    }),
  );

  it.effect("fails closed on non-JSON output", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        decodeMuseJsonOutput("generateThreadTitle", TitleSchema, "no json here"),
      );

      expect(failure).toBeInstanceOf(TextGenerationError);
    }),
  );
});

it.layer(NodeServices.layer)("Muse text-generation launch flags", (it) => {
  it.effect("disables workspace writes and shell execution", () =>
    Effect.gen(function* () {
      let receivedArgs: ReadonlyArray<string> = [];
      const spawner = ChildProcessSpawner.make((command) => {
        if (!ChildProcess.isStandardCommand(command)) {
          return Effect.die(new Error("expected a standard Muse command"));
        }
        receivedArgs = command.args;
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make('{"title":"Safe title"}')),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      });
      const textGeneration = yield* makeMuseTextGeneration({ museBin: process.execPath }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const result = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Describe this change",
        modelSelection: {
          instanceId: ProviderInstanceId.make("muse"),
          model: "fixture-model",
        },
      });

      expect(result.title).toBe("Safe title");
      expect(receivedArgs).toContain("--disable-write");
      expect(receivedArgs).toContain("--disable-shell");
    }),
  );
});

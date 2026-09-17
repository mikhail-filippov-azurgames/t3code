import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { makeAntigravityAcpRuntime } from "./AntigravityAcpSupport.ts";

it.layer(NodeServices.layer)("Antigravity runtime storage", (it) => {
  for (const outcome of ["success", "spawn failure", "interruption"] as const) {
    it.effect(`removes only its extraction directory after ${outcome}`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runtime-storage-test-" });
        const sentinel = path.join(cwd, "unrelated.txt");
        yield* fs.writeFileString(sentinel, "keep");
        const initialized = yield* Deferred.make<void>();
        const directories: string[] = [];
        const handles: ChildProcessSpawner.ChildProcessHandle[] = [];
        const observedSpawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipeline");
            const env = command.options.env ?? {};
            const directory = env.TEMP;
            expect(directory).toBeDefined();
            if (!directory) return yield* Effect.die("Missing private temp directory");
            directories.push(directory);
            expect(env.TMP).toBe(directory);
            expect(env.TMPDIR).toBe(directory);
            expect(env.Temp).toBeUndefined();
            expect(env.T3_STORAGE_SENTINEL).toBe("preserved");
            // Stand in for a bootloader leaving extracted files behind.
            yield* fs.makeDirectory(path.join(directory, "_MEI_fixture"));
            yield* fs.writeFileString(path.join(directory, "_MEI_fixture", "payload"), "fixture");
            const handle = yield* spawner.spawn(command);
            handles.push(handle);
            return handle;
          }),
        );
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const run = Effect.gen(function* () {
          const runtime = yield* makeAntigravityAcpRuntime({
            cwd,
            clientInfo: { name: "storage-test", version: "1" },
            mcpServers: [],
            childProcessSpawner: observedSpawner,
            spawn: {
              command:
                outcome === "spawn failure" ? path.join(cwd, "missing.exe") : process.execPath,
              args: [mockAgentPath],
              cwd,
              env: {
                ...process.env,
                Temp: cwd,
                TMP: cwd,
                TMPDIR: cwd,
                T3_STORAGE_SENTINEL: "preserved",
              },
              extendEnv: false,
            },
          });
          yield* runtime.initialize();
          yield* Deferred.succeed(initialized, undefined);
          if (outcome === "interruption") return yield* Effect.never;
        }).pipe(Effect.scoped);
        if (outcome === "interruption") {
          const fiber = yield* run.pipe(Effect.forkScoped);
          yield* Deferred.await(initialized);
          yield* Fiber.interrupt(fiber);
        } else {
          const exit = yield* Effect.exit(run);
          expect(Exit.isSuccess(exit)).toBe(outcome === "success");
        }
        expect(directories).toHaveLength(1);
        for (const handle of handles) expect(yield* handle.isRunning).toBe(false);
        for (const directory of directories) expect(yield* fs.exists(directory)).toBe(false);
        expect(yield* fs.readFileString(sentinel)).toBe("keep");
      }).pipe(Effect.scoped),
    );
  }
});

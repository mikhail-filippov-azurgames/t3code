import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessExecutablePath } from "@t3tools/shared/hostProcess";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

import { ensurePiAgentFiles, piManagedModelsFromConfig } from "./piAgentDir.ts";
import {
  findBundledPiCliJs,
  PI_RUNTIME_CLI,
  PI_RUNTIME_ENV_VAR,
  PI_RUNTIME_PACKAGE,
  PI_RUNTIME_PIN,
  resolvePiRuntime,
} from "./piRuntime.ts";

const testLayer = Layer.mergeAll(NodeServices.layer);

describe("findBundledPiCliJs", () => {
  const exists = (present: ReadonlyArray<string>) => (candidate: string) =>
    present.includes(candidate);

  it("walks up to the bundled cli.js", () => {
    const cli = "/pkg/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
    NodeAssert.equal(findBundledPiCliJs("/pkg/apps/server/src", exists([cli])), cli);
  });

  it("returns undefined when no bundle is installed", () => {
    NodeAssert.equal(findBundledPiCliJs("/pkg/apps/server/src", exists([])), undefined);
  });

  it("matches the pinned package layout", () => {
    NodeAssert.equal(
      `${"node_modules"}/${PI_RUNTIME_PACKAGE}/${PI_RUNTIME_CLI}`,
      "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    );
    NodeAssert.match(PI_RUNTIME_PIN, /^\d+\.\d+\.\d+$/);
  });
});

describe("resolvePiRuntime", () => {
  it.layer(testLayer)("prefers the workspace-bundled cli.js over PATH", (it) => {
    it.effect("bundled", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-runtime-" });
        const cliJs = path.join(
          root,
          "node_modules",
          PI_RUNTIME_PACKAGE,
          "dist",
          "bundle",
          "cli.js",
        );
        yield* fs.makeDirectory(path.dirname(cliJs), { recursive: true });
        yield* fs.writeFileString(cliJs, "bundled");
        const launch = yield* resolvePiRuntime({
          binaryPath: "pi",
          fromDir: path.join(root, "apps", "server"),
        });
        NodeAssert.equal(launch.kind, "bundled");
        NodeAssert.equal(launch.cliJs, cliJs);
        NodeAssert.ok(launch.command.length > 0);
        NodeAssert.deepEqual(launch.prefixArgs, [cliJs]);
      }),
    );

    it.effect("rejects a custom binary even when a pinned bundle is present", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-runtime-" });
        const cliJs = path.join(
          root,
          "node_modules",
          PI_RUNTIME_PACKAGE,
          "dist",
          "bundle",
          "cli.js",
        );
        yield* fs.makeDirectory(path.dirname(cliJs), { recursive: true });
        yield* fs.writeFileString(cliJs, "bundled");
        const result = yield* resolvePiRuntime({
          binaryPath: "pi-custom",
          env: { PATH: root },
          fromDir: root,
        }).pipe(Effect.result);
        NodeAssert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          NodeAssert.match(String(result.failure), /custom Pi binaries are not permitted/);
        }
      }),
    );

    it.effect("rejects the bundled runtime environment override", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-env-override-" });
        const result = yield* resolvePiRuntime({
          binaryPath: "pi",
          env: { [PI_RUNTIME_ENV_VAR]: "C:/custom/pi.exe" },
          fromDir: root,
        }).pipe(Effect.result);
        NodeAssert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          NodeAssert.match(String(result.failure), /cannot override the pinned bundled runtime/);
        }
        const ambientBinaryExists = yield* fs.exists(path.join(root, "pi"));
        NodeAssert.equal(ambientBinaryExists, false);
      }),
    );

    it.effect("fails closed instead of falling back to an ambient PATH Pi", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-no-path-fallback-" });
        const result = yield* resolvePiRuntime({
          binaryPath: "pi",
          env: { PATH: root },
          fromDir: root,
        }).pipe(Effect.result);
        NodeAssert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          NodeAssert.match(String(result.failure), /bundled Pi 0\.87\.1 not found/);
        }
        NodeAssert.ok((yield* fs.exists(path.join(root, "pi"))) === false);
      }),
    );

    it.effect(
      "resolves Pi from the packaged Windows server.asar sidecar with Node or Electron",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-sidecar-" });
          const serverAsar = path.join(root, "resources", "server.asar");
          const serverModuleDir = path.join(serverAsar, "apps", "server", "dist", "provider", "pi");
          const cliJs = path.join(
            serverAsar,
            "node_modules",
            PI_RUNTIME_PACKAGE,
            ...PI_RUNTIME_CLI.split("/"),
          );
          yield* fs.makeDirectory(path.dirname(cliJs), { recursive: true });
          yield* fs.makeDirectory(serverModuleDir, { recursive: true });
          yield* fs.writeFileString(cliJs, "pinned bundled Pi CLI");

          for (const hostExecutable of [
            "C:\\Program Files\\T3 Code\\node.exe",
            "C:\\Program Files\\T3 Code\\T3 Code.exe",
          ]) {
            const launch = yield* resolvePiRuntime({
              binaryPath: "pi",
              fromDir: serverModuleDir,
              env: { PATH: "" },
            }).pipe(Effect.provideService(HostProcessExecutablePath, hostExecutable));
            NodeAssert.equal(launch.kind, "bundled");
            NodeAssert.equal(launch.command, hostExecutable);
            NodeAssert.equal(launch.cliJs, cliJs);
            NodeAssert.deepEqual(launch.prefixArgs, [cliJs]);
          }
        }),
    );
  });
});

describe("ensurePiAgentFiles", () => {
  it.layer(testLayer)("writes the managed endpoint files", (it) => {
    it.effect("models+settings", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-agent-" });
        const models = piManagedModelsFromConfig({
          configuredModel: "qwen2.5-coder:7b",
          customModels: [],
        });
        yield* ensurePiAgentFiles(path.join(agentDir, "agent"), {
          baseUrl: "http://127.0.0.1:11434/v1",
          apiKey: "",
          models,
          runtimeMode: "approval-required",
          defaultModel: "qwen2.5-coder:7b",
        });
        const modelsJson = (yield* decodeJson(
          yield* fs.readFileString(path.join(agentDir, "agent", "models.json")),
        )) as { providers: Record<string, { baseUrl: string; models: Array<{ id: string }> }> };
        NodeAssert.equal(modelsJson.providers["ft3-local"]?.baseUrl, "http://127.0.0.1:11434/v1");
        NodeAssert.deepEqual(modelsJson.providers["ft3-local"]?.models, [
          { id: "qwen2.5-coder:7b" },
        ]);
        const settingsJson = (yield* decodeJson(
          yield* fs.readFileString(path.join(agentDir, "agent", "settings.json")),
        )) as { defaultTools: Array<string>; defaultProjectTrust: string };
        NodeAssert.equal(settingsJson.defaultProjectTrust, "never");
        NodeAssert.ok(!settingsJson.defaultTools.includes("bash"));
      }),
    );
  });
});

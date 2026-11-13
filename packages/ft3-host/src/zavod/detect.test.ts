// @effect-diagnostics nodeBuiltinImport:off - Spies guard every Node subprocess entry point.
import * as NodeChildProcess from "node:child_process";

import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { vi } from "vite-plus/test";

import { DEFAULT_ZAVOD_BASE_URL, detectZavod, type DetectZavodOptions } from "./detect.ts";

vi.mock("node:child_process", () => {
  const denied = vi.fn(() => {
    throw new Error("Detector attempted to spawn a process");
  });
  return {
    spawn: denied,
    spawnSync: denied,
    exec: denied,
    execSync: denied,
    execFile: denied,
    execFileSync: denied,
    fork: denied,
  };
});

const gateway = "https://gateway.example:8443";
const fileInfo: FileSystem.File.Info = {
  type: "File",
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0n,
  ino: Option.none(),
  mode: 0o755,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: ByteSize.bytes(0),
  blksize: Option.none(),
  blocks: Option.none(),
};

interface Fixture {
  readonly claude?: string;
  readonly codex?: string;
  readonly state?: string;
  readonly helper?: boolean;
  readonly helperType?: "File" | "Directory";
  readonly unreadable?: boolean;
  readonly options?: DetectZavodOptions;
  readonly configHomes?: { readonly claude: string; readonly codex: string };
}

const fixture = Effect.fn("test.fixture")(function* (input: Fixture = {}, windows = false) {
  const path = yield* Path.Path;
  const home = windows ? "C:\\Users\\user" : "/home/user";
  const helperPath = path.join(home, ".zavod", "bin", windows ? "zavod-key.exe" : "zavod-key");
  const statePath = path.join(home, ".zavod", "desktop", "state.json");
  const claudeHome = input.configHomes?.claude ?? path.join(home, ".claude");
  const codexHome = input.configHomes?.codex ?? path.join(home, ".codex");
  const files = new Map<string, string>();
  if (input.state !== undefined) files.set(statePath, input.state);
  if (input.claude !== undefined) files.set(path.join(claudeHome, "settings.json"), input.claude);
  if (input.codex !== undefined) files.set(path.join(codexHome, "config.toml"), input.codex);
  const reads: string[] = [];
  const error = (tag: "NotFound" | "PermissionDenied") =>
    PlatformError.systemError({
      _tag: tag,
      module: "FileSystem",
      method: "readFileString",
    });
  const fs = FileSystem.makeNoop({
    stat: (file) =>
      file === helperPath && input.helper !== false
        ? Effect.succeed({ ...fileInfo, type: input.helperType ?? "File" })
        : Effect.fail(error("NotFound")),
    readFileString: (file) => {
      reads.push(file);
      if (input.unreadable && file !== statePath) return Effect.fail(error("PermissionDenied"));
      const text = files.get(file);
      return text === undefined ? Effect.fail(error("NotFound")) : Effect.succeed(text);
    },
  });
  const result = yield* detectZavod({ environment: {}, ...input.options }).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(HostProcess.HomeDirectory, home),
    Effect.provideService(HostProcess.Platform, windows ? "win32" : "linux"),
  );
  return { result, reads, helperPath };
});

const throughGateway = (url = gateway, helper = "~/.zavod/bin/zavod-key") => ({
  state: JSON.stringify({ version: 1, base_url: gateway, ignored: "private-state-value" }),
  claude: JSON.stringify({ env: { ANTHROPIC_BASE_URL: url }, apiKeyHelper: helper }),
  codex: `model_provider = "corp"
[model_providers.corp]
base_url = "${url}/v1"
auth.command = 'zavod-key'
`,
});

describe("detectZavod", () => {
  it.effect("classifies all five states and only reads configuration", () =>
    Effect.gen(function* () {
      for (const [input, expected] of [
        [throughGateway(), "on"],
        [{}, "off"],
        [{ ...throughGateway(), codex: "" }, "mixed"],
        [{ ...throughGateway(), claude: "{" }, "unsupported"],
        [{ ...throughGateway(), helper: false }, "absent"],
      ] as const) {
        const { result, reads } = yield* fixture(input);
        assert.equal(result.state, expected);
        if (expected === "absent") {
          assert.deepEqual(reads, []);
          assert.isNull(result.helperPath);
        } else {
          assert.isNotNull(result.helperPath);
        }
        assert.notInclude(JSON.stringify(result), "private-state-value");
      }
      assert.equal((yield* fixture({ helperType: "Directory" })).result.state, "absent");
    }).pipe(Effect.provide(NodePath.layerPosix)),
  );

  it.effect("uses only the active Codex provider, including TOML quoted keys and inline auth", () =>
    Effect.gen(function* () {
      for (const [selection, expected] of [
        ['model_provider = "other"', "off"],
        ["", "off"],
        ['model_provider = "corp.name"', "mixed"],
      ] as const) {
        const { result } = yield* fixture({
          state: throughGateway().state,
          codex: `${selection}
[model_providers."corp.name"]
base_url = '${gateway}/v1'
auth = { command = "zavod-key", args = [] }
[model_providers.other]
base_url = "https://api.openai.com/v1"
`,
        });
        assert.equal(result.state, expected);
      }
    }).pipe(Effect.provide(NodePath.layerPosix)),
  );

  it.effect("honors homePath before environment homes and host home references", () =>
    Effect.gen(function* () {
      for (const windows of [false, true]) {
        const pathLayer = windows ? NodePath.layerWin32 : NodePath.layerPosix;
        yield* Effect.gen(function* () {
          const path = yield* Path.Path;
          const home = windows ? "C:\\Users\\user" : "/home/user";
          const homes = {
            claude: path.join(home, "Claude Settings"),
            codex: path.join(home, "Codex Settings"),
          };
          for (const options of [
            { environment: { CLAUDE_CONFIG_DIR: homes.claude, CODEX_HOME: homes.codex } },
            {
              claudeHomePath: homes.claude,
              codexHomePath: homes.codex,
              environment: {
                CLAUDE_CONFIG_DIR: path.join(home, "ignored"),
                CODEX_HOME: path.join(home, "ignored"),
              },
            },
            {
              claudeHomePath: "~/Claude Settings",
              codexHomePath: "~/Codex Settings",
              homeDirectory: home,
            },
          ]) {
            const { result, helperPath } = yield* fixture(
              {
                ...throughGateway(),
                configHomes: homes,
                options,
              },
              windows,
            );
            assert.equal(result.state, "on");
            assert.equal(result.helperPath, helperPath);
          }
        }).pipe(Effect.provide(pathLayer));
      }
    }),
  );

  it.effect("parses POSIX and Windows helper paths without interpreting shell commands", () =>
    Effect.gen(function* () {
      for (const [windows, helper] of [
        [false, "/opt/zavod/bin/zavod-key"],
        [false, "'/opt/Zavod Tools/zavod-key'"],
        [true, '"C:\\Program Files\\Zavod\\zavod-key.exe"'],
      ] as const) {
        const { result } = yield* fixture(throughGateway(gateway, helper), windows).pipe(
          Effect.provide(windows ? NodePath.layerWin32 : NodePath.layerPosix),
        );
        assert.equal(result.state, "on");
      }
      for (const helper of [
        "zavod-key; echo secret",
        "$(zavod-key)",
        "`zavod-key`",
        "/tmp/key | cat",
        "/tmp/key && echo x",
        "/tmp/key > /tmp/out",
        "%USERPROFILE%\\zavod-key.exe",
        "/tmp/key\nwhoami",
        "/tmp/key --flag",
      ]) {
        const { result } = yield* fixture(throughGateway(gateway, helper)).pipe(
          Effect.provide(NodePath.layerPosix),
        );
        assert.equal(result.state, "unsupported");
      }
      const config = {
        ...throughGateway(),
        codex: throughGateway().codex.replace("'zavod-key'", "'zavod-key; echo x'"),
      };
      assert.equal(
        (yield* fixture(config).pipe(Effect.provide(NodePath.layerPosix))).result.state,
        "unsupported",
      );
    }),
  );

  it.effect("normalizes origins and /v1 and reports the state/default source", () =>
    Effect.gen(function* () {
      for (const url of [
        gateway,
        `${gateway}/v1`,
        `${gateway}/v1/`,
        "https://GATEWAY.EXAMPLE:8443/another/path",
      ]) {
        const { result } = yield* fixture(throughGateway(url));
        assert.equal(result.state, "on");
        assert.equal(result.baseUrl, `${gateway}/v1`);
        assert.equal(result.baseUrlSource, "state");
      }
      for (const state of [
        undefined,
        "{",
        "{}",
        '{"base_url":12}',
        '{"base_url":"http://unsafe.example"}',
        '{"base_url":"https://user:secret@gateway.example"}',
      ]) {
        const { claude, codex } = throughGateway(DEFAULT_ZAVOD_BASE_URL);
        const { result } = yield* fixture({
          claude,
          codex,
          ...(state === undefined ? {} : { state }),
        });
        assert.equal(result.state, "on");
        assert.equal(result.baseUrl, `${DEFAULT_ZAVOD_BASE_URL}/v1`);
        assert.equal(result.baseUrlSource, "default");
      }
      assert.equal((yield* fixture()).result.baseUrlSource, "default");
      assert.equal(
        (yield* fixture({
          ...throughGateway(),
          state: JSON.stringify({ base_url: `${gateway}/v1` }),
        })).result.baseUrl,
        `${gateway}/v1`,
      );
    }).pipe(Effect.provide(NodePath.layerPosix)),
  );

  it.effect("reads Claude's effective endpoint and preserves unsupported diagnostics", () =>
    Effect.gen(function* () {
      const input = throughGateway();
      assert.equal(
        (yield* fixture({
          ...input,
          claude: "{}",
          options: { environment: { ANTHROPIC_BASE_URL: gateway } },
        })).result.state,
        "on",
      );
      assert.equal(
        (yield* fixture({
          ...input,
          options: { environment: { ANTHROPIC_BASE_URL: "https://other.example" } },
        })).result.state,
        "on",
      );
      for (const override of [
        { codex: 'profile = "work"' },
        { codex: '[profiles.work]\nmodel_provider = "zavod"' },
        { codex: 'openai_base_url = "https://gateway.example/v1"' },
        { options: { environment: { OPENAI_BASE_URL: "https://gateway.example/v1" } } },
        { codex: "model_provider = [" },
        { codex: 'model_provider = "missing"' },
        { codex: "model_provider = 5" },
        { codex: 'model_provider = "corp"\n[model_providers.corp]\nbase_url = 5' },
        { claude: '{"env":{"ANTHROPIC_BASE_URL":5}}' },
        { claude: "[]" },
        { claude: '{"env":{"ANTHROPIC_BASE_URL":"invalid"}}' },
        { unreadable: true },
      ]) {
        const { result } = yield* fixture({ ...input, ...override });
        assert.equal(result.state, "unsupported");
        assert.isNotEmpty(result.reason);
      }
    }).pipe(Effect.provide(NodePath.layerPosix)),
  );

  it.effect("never spawns processes or executes a helper", () =>
    Effect.gen(function* () {
      const methods = [
        "spawn",
        "spawnSync",
        "exec",
        "execSync",
        "execFile",
        "execFileSync",
        "fork",
      ] as const;
      for (const method of methods) vi.mocked(NodeChildProcess[method]).mockClear();
      const { result } = yield* fixture(throughGateway()).pipe(Effect.provide(NodePath.layerPosix));
      assert.equal(result.state, "on");
      for (const method of methods)
        assert.equal(vi.mocked(NodeChildProcess[method]).mock.calls.length, 0);
    }),
  );

  it.effect(
    "reads real fixture files without executing the helper or modifying configurations",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const platform = yield* HostProcess.Platform;
        const home = yield* fs.makeTempDirectoryScoped();
        const helper = path.join(
          home,
          ".zavod",
          "bin",
          platform === "win32" ? "zavod-key.exe" : "zavod-key",
        );
        const input = throughGateway();
        const files = new Map([
          [helper, "This fixture is not executable."],
          [path.join(home, ".zavod", "desktop", "state.json"), input.state],
          [path.join(home, ".claude", "settings.json"), input.claude],
          [path.join(home, ".codex", "config.toml"), input.codex],
        ]);
        for (const [file, contents] of files) {
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* fs.writeFileString(file, contents);
        }
        const result = yield* detectZavod({ homeDirectory: home, environment: {} });
        assert.equal(result.state, "on");
        assert.equal(result.helperPath, helper);
        for (const [file, contents] of files)
          assert.equal(yield* fs.readFileString(file), contents);
      }).pipe(Effect.scoped, Effect.provide([NodeFileSystem.layer, NodePath.layer])),
  );
});

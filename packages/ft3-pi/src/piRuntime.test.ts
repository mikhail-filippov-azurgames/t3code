import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  buildPiLauncherScript,
  findBundledPiCliJs,
  PI_RUNTIME_CLI,
  PI_RUNTIME_ENV_VAR,
  PI_RUNTIME_PACKAGE,
  PI_RUNTIME_PIN,
  resolvePiBinaryPath,
} from "./piRuntime.ts";

it("walks up to the bundled cli.js", () => {
  const cli = "/pkg/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
  const exists = (present: ReadonlyArray<string>) => (candidate: string) =>
    present.includes(candidate);
  assert.equal(findBundledPiCliJs("/pkg/apps/server/src", exists([cli])), cli);
  assert.equal(findBundledPiCliJs("/pkg/apps/server/src", exists([])), undefined);
});

it("matches the pinned package layout", () => {
  assert.equal(
    `node_modules/${PI_RUNTIME_PACKAGE}/${PI_RUNTIME_CLI}`,
    "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
  );
  assert.match(PI_RUNTIME_PIN, /^\d+\.\d+\.\d+$/);
});

const writeFakeBundle = (root: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cliJs = path.join(root, "node_modules", PI_RUNTIME_PACKAGE, ...PI_RUNTIME_CLI.split("/"));
    yield* fileSystem.makeDirectory(path.dirname(cliJs), { recursive: true });
    yield* fileSystem.writeFileString(cliJs, "// fake bundled Pi");
    return cliJs;
  });

it.effect("keeps an explicit binary path untouched", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ft3-pi-runtime-" });
    const resolved = yield* resolvePiBinaryPath({
      binaryPath: "C:/tools/pi.exe",
      launcherDir: path.join(root, "runtime"),
      fromDir: root,
    });
    assert.equal(resolved.binaryPath, "C:/tools/pi.exe");
    assert.isFalse(resolved.bundled);
    assert.isFalse(yield* fileSystem.exists(path.join(root, "runtime")));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("materializes a Windows launcher for the sentinel", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ft3-pi-runtime-" });
    const cliJs = yield* writeFakeBundle(root);
    const executablePath = "C:\\Program Files\\nodejs\\node.exe";

    const resolved = yield* resolvePiBinaryPath({
      binaryPath: "pi",
      environment: { PATH: "" },
      launcherDir: path.join(root, "runtime"),
      fromDir: path.join(root, "apps", "server", "src"),
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.ExecutablePath, executablePath),
    );

    assert.isTrue(resolved.bundled);
    assert.equal(resolved.cliJs, cliJs);
    assert.equal(resolved.binaryPath, path.join(root, "runtime", "pi.cmd"));
    const script = yield* fileSystem.readFileString(resolved.binaryPath);
    assert.equal(script, buildPiLauncherScript({ platform: "win32", executablePath, cliJs }));
    assert.include(script, "%*");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("treats an empty binary path as the sentinel", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ft3-pi-runtime-" });
    const cliJs = yield* writeFakeBundle(root);

    const resolved = yield* resolvePiBinaryPath({
      binaryPath: "",
      launcherDir: path.join(root, "runtime"),
      fromDir: root,
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.ExecutablePath, "/usr/bin/node"),
    );

    assert.isTrue(resolved.bundled);
    assert.equal(resolved.binaryPath, path.join(root, "runtime", "pi"));
    const script = yield* fileSystem.readFileString(resolved.binaryPath);
    assert.include(script, `exec "/usr/bin/node" "${cliJs}" "$@"`);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("rewrites a stale launcher but keeps the same path", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ft3-pi-runtime-" });
    const cliJs = yield* writeFakeBundle(root);
    const executablePath = "C:\\node\\node.exe";
    const input = {
      binaryPath: "pi",
      launcherDir: path.join(root, "runtime"),
      fromDir: root,
    };
    const withHost = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.ExecutablePath, executablePath),
      );

    const first = yield* withHost(resolvePiBinaryPath(input));
    yield* fileSystem.writeFileString(first.binaryPath, "stale");
    const second = yield* withHost(resolvePiBinaryPath(input));

    assert.equal(second.binaryPath, first.binaryPath);
    const script = yield* fileSystem.readFileString(second.binaryPath);
    assert.equal(script, buildPiLauncherScript({ platform: "win32", executablePath, cliJs }));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("fails closed instead of falling back to an ambient Pi", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ft3-pi-runtime-" });
    const result = yield* resolvePiBinaryPath({
      binaryPath: "pi",
      launcherDir: path.join(root, "runtime"),
      fromDir: root,
    }).pipe(Effect.result);

    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.match(String(result.failure), /bundled Pi 0\.87\.1 not found/);
    }
    assert.isFalse(yield* fileSystem.exists(path.join(root, "runtime")));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("rejects the bundled runtime environment override", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ft3-pi-runtime-" });
    yield* writeFakeBundle(root);

    const result = yield* resolvePiBinaryPath({
      binaryPath: "pi",
      environment: { [PI_RUNTIME_ENV_VAR]: "C:/custom/pi.exe" },
      launcherDir: path.join(root, "runtime"),
      fromDir: root,
    }).pipe(Effect.result);

    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.match(String(result.failure), /cannot override the pinned bundled runtime/);
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

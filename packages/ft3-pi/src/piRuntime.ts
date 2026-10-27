import * as NodeURL from "node:url";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Pinned Pi runtime bundled with FT3: empty `binaryPath` or `"pi"` runs the
 * package's `dist/bundle/cli.js` through a generated launcher; anything else
 * stays an explicit user binary. The V2 adapter accepts only one command.
 */

export const PI_RUNTIME_PIN = "0.87.1";
export const PI_RUNTIME_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_RUNTIME_CLI = "dist/bundle/cli.js";
export const PI_RUNTIME_SENTINEL = "pi";
/** Environment override name; the pinned resolver rejects any non-empty value. */
export const PI_RUNTIME_ENV_VAR = "PI_BUNDLED_PI_BIN";

function piRuntimeError(detail: string, cause?: unknown): Error {
  return new Error(`Pi: ${detail}`, cause === undefined ? undefined : { cause });
}

function parentDir(dir: string): string | undefined {
  const normalized = dir.replace(/[/\\]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (index <= 0) return undefined;
  return normalized.slice(0, index);
}

const posixJoin = (...parts: ReadonlyArray<string>): string => parts.join("/");

/** Empty and `"pi"` both select the pinned bundle. */
export function isBundledPiBinaryPath(binaryPath: string | undefined): boolean {
  const configured = binaryPath?.trim() ?? "";
  return configured.length === 0 || configured === PI_RUNTIME_SENTINEL;
}

/**
 * Candidate bundle paths from `startDir` upward (nearest first). Pure so
 * tests can assert the layout without touching the filesystem.
 */
export function bundledPiCliCandidates(
  startDir: string,
  join: (...parts: ReadonlyArray<string>) => string = posixJoin,
): ReadonlyArray<string> {
  const segments = ["node_modules", PI_RUNTIME_PACKAGE, ...PI_RUNTIME_CLI.split("/")];
  const candidates: Array<string> = [];
  let current: string | undefined = startDir.replace(/[/\\]+$/, "");
  while (current !== undefined) {
    candidates.push(join(current, ...segments));
    current = parentDir(current);
  }
  return candidates;
}

/** Pure lookup with an injected `exists` so tests can use a fake filesystem. */
export function findBundledPiCliJs(
  startDir: string,
  exists: (candidate: string) => boolean,
  join: (...parts: ReadonlyArray<string>) => string = posixJoin,
): string | undefined {
  return bundledPiCliCandidates(startDir, join).find((candidate) => exists(candidate));
}

/** Directory of this module file (anchor for the upward bundle search). */
export function piModuleDir(path: Path.Path): string {
  return path.dirname(NodeURL.fileURLToPath(import.meta.url));
}

export function piLauncherFileName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "pi.cmd" : "pi";
}

export function buildPiLauncherScript(input: {
  readonly platform: NodeJS.Platform;
  readonly executablePath: string;
  readonly cliJs: string;
}): string {
  if (input.platform === "win32") {
    return `@echo off\r\n"${input.executablePath}" "${input.cliJs}" %*\r\n`;
  }
  return `#!/bin/sh\nexec "${input.executablePath}" "${input.cliJs}" "$@"\n`;
}

export const findBundledPiCliJsEffect = Effect.fn("PiRuntime.findBundledCli")(function* (
  startDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const join = (...parts: ReadonlyArray<string>): string => path.join(...parts);
  for (const candidate of bundledPiCliCandidates(startDir, join)) {
    const found = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (found) return candidate;
  }
  return undefined;
});

export const ensurePiLauncher = Effect.fn("PiRuntime.ensureLauncher")(function* (input: {
  readonly launcherDir: string;
  readonly platform: NodeJS.Platform;
  readonly executablePath: string;
  readonly cliJs: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(input.launcherDir, { recursive: true });
  const launcherPath = path.join(input.launcherDir, piLauncherFileName(input.platform));
  const script = buildPiLauncherScript(input);
  const existing = yield* fileSystem
    .readFileString(launcherPath)
    .pipe(Effect.orElseSucceed(() => ""));
  if (existing !== script) {
    yield* fileSystem.writeFileString(launcherPath, script);
  }
  if (input.platform !== "win32") {
    yield* fileSystem.chmod(launcherPath, 0o755);
  }
  return launcherPath;
});

export interface ResolvePiBinaryPathInput {
  readonly binaryPath?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly launcherDir: string;
  /** Anchor for the bundled search. Defaults to this module's directory. */
  readonly fromDir?: string | undefined;
}

export interface PiBinaryPathResolution {
  readonly binaryPath: string;
  readonly bundled: boolean;
  /** Workspace-bundled `cli.js` path when `bundled` is true. */
  readonly cliJs?: string | undefined;
  /** Human-readable origin for status messages. */
  readonly origin: string;
}

/**
 * Map the Pi settings binary to a spawnable command: an explicit path is kept
 * verbatim, while the sentinel resolves the pinned bundle and materializes a
 * launcher beside the instance state.
 */
export const resolvePiBinaryPath = Effect.fn("PiRuntime.resolveBinaryPath")(function* (
  input: ResolvePiBinaryPathInput,
) {
  const path = yield* Path.Path;
  const configured = input.binaryPath?.trim() ?? "";
  if (!isBundledPiBinaryPath(configured)) {
    return {
      binaryPath: configured,
      bundled: false,
      origin: `configured Pi binary (${configured})`,
    } satisfies PiBinaryPathResolution;
  }

  const env = input.environment ?? process.env;
  const envOverride = env[PI_RUNTIME_ENV_VAR]?.trim() ?? "";
  if (envOverride.length > 0) {
    return yield* Effect.fail(
      piRuntimeError(`${PI_RUNTIME_ENV_VAR} cannot override the pinned bundled runtime.`),
    );
  }

  const fromDir = input.fromDir ?? piModuleDir(path);
  const cliJs = yield* findBundledPiCliJsEffect(fromDir);
  if (cliJs === undefined) {
    return yield* Effect.fail(
      piRuntimeError(
        `bundled Pi ${PI_RUNTIME_PIN} not found in this package. Is ${PI_RUNTIME_PACKAGE} installed?`,
      ),
    );
  }

  const binaryPath = yield* ensurePiLauncher({
    launcherDir: input.launcherDir,
    platform: yield* HostProcess.Platform,
    executablePath: yield* HostProcess.ExecutablePath,
    cliJs,
  });
  return {
    binaryPath,
    bundled: true,
    cliJs,
    origin: `bundled Pi ${PI_RUNTIME_PIN} (${PI_RUNTIME_PACKAGE})`,
  } satisfies PiBinaryPathResolution;
});

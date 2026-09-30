import * as NodeURL from "node:url";

import { HostProcessExecutablePath } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Pinned Pi runtime bundled with FT3.
 *
 * `@earendil-works/pi-coding-agent` ships the `pi` CLI as a plain Node
 * bundle (`dist/bundle/cli.js`, MIT). Depending on it (pinned, exact) puts
 * Pi inside FT3's own package graph: no OpenCode and no separate user Pi
 * installation is required, and offline/package launches resolve the
 * bundled file instead of PATH-only lookup.
 *
 * Verified against the pinned binary: `--mode rpc`, `--session-id`,
 * `--no-session`, `--no-tools`, `--tools`, `--list-models`, `--print`.
 *
 * @module provider/pi/piRuntime
 */

export const PI_RUNTIME_PIN = "0.87.1";
export const PI_RUNTIME_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_RUNTIME_CLI = "dist/bundle/cli.js";
/** Environment override name; the pinned resolver rejects any non-empty value. */
export const PI_RUNTIME_ENV_VAR = "PI_BUNDLED_PI_BIN";

function piRuntimeError(detail: string, cause?: unknown): Error {
  return new Error(`Pi: ${detail}`, cause === undefined ? undefined : { cause });
}

export type PiRuntimeKind = "bundled";

export interface PiRuntimeLaunch {
  readonly kind: PiRuntimeKind;
  readonly command: string;
  /** Prefix args the caller extends with Pi CLI args (e.g. `[cliJs]`). */
  readonly prefixArgs: ReadonlyArray<string>;
  /** Workspace-bundled `cli.js` path when `kind` is `"bundled"`. */
  readonly cliJs?: string | undefined;
  /** Human-readable origin for status messages and transparent errors. */
  readonly origin: string;
}

function parentDir(dir: string): string | undefined {
  const normalized = dir.replace(/[/\\]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (index <= 0) return undefined;
  return normalized.slice(0, index);
}

const posixJoin = (...parts: ReadonlyArray<string>): string => parts.join("/");

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

/**
 * Pure lookup of the workspace-bundled Pi CLI by walking up from `startDir`.
 * `exists` is injected so tests can use a fake filesystem; `join` defaults
 * to posix segments (callers pass the platform `Path.join` for probing).
 */
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

export interface ResolvePiRuntimeInput {
  /** Empty or `"pi"` selects the exact package-bundled runtime. */
  readonly binaryPath?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Anchor for the bundled search. Defaults to this module's directory. */
  readonly fromDir?: string | undefined;
}

/**
 * Resolve only the pinned package-bundled `cli.js` via the current Node
 * executable. Custom binaries and environment overrides cannot change the
 * runtime after permission verification.
 */
export const resolvePiRuntime = (
  input: ResolvePiRuntimeInput,
): Effect.Effect<PiRuntimeLaunch, Error, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const env = input.env ?? process.env;
    const configured = input.binaryPath?.trim() ?? "";

    if (configured.length > 0 && configured !== "pi") {
      return yield* Effect.fail(
        piRuntimeError("custom Pi binaries are not permitted; use the pinned bundled runtime."),
      );
    }

    const envOverride = env[PI_RUNTIME_ENV_VAR]?.trim() ?? "";
    if (envOverride.length > 0) {
      return yield* Effect.fail(
        piRuntimeError(`${PI_RUNTIME_ENV_VAR} cannot override the pinned bundled runtime.`),
      );
    }

    const fromDir = input.fromDir ?? piModuleDir(path);
    const join = (...parts: ReadonlyArray<string>): string => path.join(...parts);
    const cliJs = yield* Effect.forEach(
      bundledPiCliCandidates(fromDir, join),
      (candidate) =>
        fileSystem.exists(candidate).pipe(
          Effect.mapError((cause) => piRuntimeError(`cannot probe ${candidate}.`, cause)),
          Effect.map((found) => (found ? candidate : undefined)),
        ),
      { discard: false },
    ).pipe(Effect.map((hits) => hits.find((hit) => hit !== undefined)));
    if (cliJs !== undefined) {
      const nodeExec = yield* HostProcessExecutablePath;
      return {
        kind: "bundled",
        command: nodeExec,
        prefixArgs: [cliJs],
        cliJs,
        origin: `bundled Pi ${PI_RUNTIME_PIN} (${PI_RUNTIME_PACKAGE})`,
      } satisfies PiRuntimeLaunch;
    }

    return yield* Effect.fail(
      piRuntimeError(
        `bundled Pi ${PI_RUNTIME_PIN} not found in this package. See packaging/pi-runtime.json.`,
      ),
    );
  });

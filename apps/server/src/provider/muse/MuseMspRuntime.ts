/**
 * MuseMspRuntime — native MSP host spawn for the Muse Code subscription driver.
 *
 * Owns two facts: the child environment never carries API keys (an API key
 * takes priority over the account login, so its presence means non-subscription
 * billing), and on Windows the spawn target is the real `muse-bin-*.exe`
 * (node spawns without a shell, so the `.cmd` launcher is not runnable).
 *
 * @module provider/muse/MuseMspRuntime
 */
import { MuseClient } from "@muse-code/sdk";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ProviderAdapterRequestError } from "../Errors.ts";

const DRIVER = "museCode";

/** Env names that switch the CLI from subscription login to API-key billing. */
export const MUSE_API_KEY_ENV_VARS = ["META_API_KEY", "MODEL_API_KEY"] as const;

/** Client identity forwarded into the MSP `initialize` handshake. */
export const MUSE_CLIENT_INFO = { name: "t3-code-muse", version: "0.0.0" } as const;

/**
 * Copy `base` without API-key entries. Reports stripped names so the driver
 * fails closed before model work when subscription provenance is unclear.
 */
export function stripMuseApiKeys(base: NodeJS.ProcessEnv): {
  readonly env: NodeJS.ProcessEnv;
  readonly stripped: ReadonlyArray<string>;
} {
  const env: NodeJS.ProcessEnv = { ...base };
  const stripped: Array<string> = [];
  for (const name of MUSE_API_KEY_ENV_VARS) {
    if (env[name] !== undefined) {
      delete env[name];
      stripped.push(name);
    }
  }
  return { env, stripped };
}

function hasExeExtension(candidate: string): boolean {
  return candidate.toLowerCase().endsWith(".exe");
}

/**
 * Resolve a runnable `muse serve` binary. Prefers the configured path when it
 * is an `.exe`; on Windows otherwise looks for the version-pinned
 * `muse-bin-*.exe` beside a launcher script.
 */
export function resolveMuseServeBinary(input: {
  readonly binaryPath: string;
  readonly platform: NodeJS.Platform;
  readonly pinnedVersion?: string;
}): Effect.Effect<string, ProviderAdapterRequestError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directHit =
      hasExeExtension(input.binaryPath) &&
      (yield* Effect.orElseSucceed(fileSystem.exists(input.binaryPath), () => false));
    if (directHit) {
      return input.binaryPath;
    }
    if (input.platform === "win32") {
      const resolved = yield* resolveWindowsMuseExe({
        binaryPath: input.binaryPath,
        fileSystem,
        path,
        ...(input.pinnedVersion === undefined ? {} : { pinnedVersion: input.pinnedVersion }),
      });
      if (resolved !== undefined) {
        return resolved;
      }
    }
    return yield* new ProviderAdapterRequestError({
      provider: DRIVER,
      method: "msp/resolveBinary",
      detail:
        `No runnable Muse binary at '${input.binaryPath}'. ` +
        `Point binaryPath at the native muse .exe; launcher scripts are not spawnable.`,
    });
  });
}

function resolveWindowsMuseExe(input: {
  readonly binaryPath: string;
  readonly pinnedVersion?: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}): Effect.Effect<string | undefined, never, never> {
  return Effect.gen(function* () {
    const dir = input.path.dirname(input.binaryPath);
    const entries = yield* Effect.orElseSucceed(input.fileSystem.readDirectory(dir), () => []);
    const candidates = entries.filter(
      (name) => name.toLowerCase().startsWith("muse-bin-") && hasExeExtension(name),
    );
    if (candidates.length === 0) {
      return undefined;
    }
    if (input.pinnedVersion !== undefined) {
      const pinned = candidates.find((name) => name.includes(input.pinnedVersion as string));
      if (pinned !== undefined) {
        return input.path.join(dir, pinned);
      }
    }
    const [latest] = [...candidates].sort().reverse();
    return latest === undefined ? undefined : input.path.join(dir, latest);
  });
}

/**
 * Read the installer's version pin (`.muse-version` next to the binary).
 * Absent or unreadable means unpinned, not a failure.
 */
export function readMuseVersionPin(input: {
  readonly binaryPath: string;
}): Effect.Effect<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const pinPath = path.join(path.dirname(input.binaryPath), ".muse-version");
    const content = yield* Effect.orElseSucceed(fileSystem.readFileString(pinPath), () => undefined);
    if (content === undefined) {
      return undefined;
    }
    const trimmed = content.trim();
    return trimmed === "" ? undefined : trimmed;
  });
}

/** Spawn one owned `muse serve` host with a sanitized environment. */
export function spawnMuseClient(input: {
  readonly museBin: string;
  readonly env: NodeJS.ProcessEnv;
  readonly clientInfo?: typeof MUSE_CLIENT_INFO;
  readonly onStderr?: (chunk: string) => void;
}): Effect.Effect<MuseClient, ProviderAdapterRequestError> {
  return Effect.tryPromise({
    try: () =>
      MuseClient.spawn({
        museBin: input.museBin,
        args: ["serve"],
        env: input.env,
        clientInfo: input.clientInfo ?? MUSE_CLIENT_INFO,
        ...(input.onStderr === undefined ? {} : { onStderr: input.onStderr }),
      }),
    catch: (cause) =>
      new ProviderAdapterRequestError({
        provider: DRIVER,
        method: "msp/spawn",
        detail: `Could not start 'muse serve': ${cause instanceof Error ? cause.message : String(cause)}`,
        ...(cause instanceof Error ? { cause } : {}),
      }),
  });
}

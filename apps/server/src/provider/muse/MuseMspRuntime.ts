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
import {
  MuseClient,
  readSessionDurability,
  spawnMspConnection,
  type Connection,
  type NotificationHandler,
  type SpawnedMspConnection,
} from "@muse-code/sdk";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ProviderAdapterRequestError } from "../Errors.ts";

const DRIVER = "museCode";

/**
 * Serve args for the full-access posture. Sandbox and trust are fixed for
 * the host's lifetime and are not negotiable over the wire, so a session
 * that needs them must live on a host started with these flags.
 */
export const MUSE_FULL_ACCESS_SERVE_ARGS = [
  "serve",
  "--disable-sandbox",
  "--trust-workspace",
] as const;

/** Env names that switch the CLI from subscription login to API-key billing. */
export const MUSE_API_KEY_ENV_VARS = ["META_API_KEY", "MODEL_API_KEY"] as const;

/** Client identity forwarded into the MSP `initialize` handshake. */
export const MUSE_CLIENT_INFO = { name: "t3_code_muse", version: "0.0.0" } as const;

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
  readonly pathEnv?: string;
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
      if (!input.binaryPath.includes("\\") && !input.binaryPath.includes("/")) {
        const viaPath = yield* resolveWindowsMuseOnPath({
          command: input.binaryPath,
          pathEnv: input.pathEnv ?? process.env.PATH,
          fileSystem,
          path,
          ...(input.pinnedVersion === undefined ? {} : { pinnedVersion: input.pinnedVersion }),
        });
        if (viaPath !== undefined) {
          return viaPath;
        }
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

/** Resolve a bare command through PATH, then reuse the launcher scan. */
function resolveWindowsMuseOnPath(input: {
  readonly command: string;
  readonly pathEnv: string | undefined;
  readonly pinnedVersion?: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}): Effect.Effect<string | undefined, never, never> {
  return Effect.gen(function* () {
    if (input.pathEnv === undefined || input.pathEnv === "") {
      return undefined;
    }
    for (const dir of input.pathEnv.split(";")) {
      const trimmed = dir.trim().replace(/^"|"$/g, "");
      if (trimmed === "") {
        continue;
      }
      const direct = input.path.join(trimmed, `${input.command}.exe`);
      if (yield* Effect.orElseSucceed(input.fileSystem.exists(direct), () => false)) {
        return direct;
      }
      for (const extension of [".cmd", ".bat"]) {
        const launcher = input.path.join(trimmed, `${input.command}${extension}`);
        if (yield* Effect.orElseSucceed(input.fileSystem.exists(launcher), () => false)) {
          const resolved = yield* resolveWindowsMuseExe({
            binaryPath: launcher,
            fileSystem: input.fileSystem,
            path: input.path,
            ...(input.pinnedVersion === undefined ? {} : { pinnedVersion: input.pinnedVersion }),
          });
          if (resolved !== undefined) {
            return resolved;
          }
        }
      }
    }
    return undefined;
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
    const content = yield* Effect.orElseSucceed(
      fileSystem.readFileString(pinPath),
      () => undefined,
    );
    if (content === undefined) {
      return undefined;
    }
    const trimmed = content.trim();
    return trimmed === "" ? undefined : trimmed;
  });
}

/** One owned `muse serve` host with the raw command seam retained. */
export interface MuseHost {
  readonly client: MuseClient;
  readonly connection: Connection;
  readonly initializeResult: SpawnedMspConnection["initializeResult"];
  readonly fingerprintWarning: SpawnedMspConnection["fingerprintWarning"];
  /** Extra notification listeners. The connection owns a single handler
   * slot that the facade router occupies, so listeners must fan out here
   * instead of calling connection.onNotification directly. */
  readonly addNotificationHandler: (handler: NotificationHandler) => void;
  readonly close: () => Promise<void>;
}

/**
 * Share one single-slot connection across listeners. The SDK router and any
 * adapter bridges all receive every notification; late listeners still get
 * everything from the moment they subscribe.
 */
export function installNotificationFanout(target: {
  onNotification(handler: NotificationHandler): void;
}): (handler: NotificationHandler) => void {
  const handlers = new Set<NotificationHandler>();
  const original = target.onNotification.bind(target);
  target.onNotification = (handler: NotificationHandler) => {
    handlers.add(handler);
  };
  original((notification) => {
    for (const handler of [...handlers]) handler(notification);
  });
  return (handler: NotificationHandler) => {
    handlers.add(handler);
  };
}

/** Spawn one owned `muse serve` host with a sanitized environment. */
export function spawnMuseHost(input: {
  readonly museBin: string;
  readonly env: NodeJS.ProcessEnv;
  readonly args?: ReadonlyArray<string>;
  readonly clientInfo?: typeof MUSE_CLIENT_INFO;
  readonly onStderr?: (chunk: string) => void;
}): Effect.Effect<MuseHost, ProviderAdapterRequestError> {
  return Effect.tryPromise({
    try: async () => {
      const handshake = spawnMspConnection({
        command: input.museBin,
        args: [...(input.args ?? ["serve"])],
        env: input.env,
        ...(input.onStderr === undefined ? {} : { onStderr: input.onStderr }),
      });
      const spawned = await handshake.initialize({
        clientInfo: input.clientInfo ?? MUSE_CLIENT_INFO,
      });
      const addNotificationHandler = installNotificationFanout(spawned.connection);
      // A host observes subscription usage only after it serves model traffic,
      // so a freshly spawned probe host always reports nothing. Cache every
      // host's `usage/changed` so the provider probe can publish the last
      // observation the account's live hosts actually saw.
      addNotificationHandler((notification) => {
        const observed = museUsageChangedFrom(notification);
        if (observed !== undefined) {
          lastObservedUsage = observed;
        }
      });
      const client = new MuseClient(spawned.connection, {
        durability: readSessionDurability(spawned.initializeResult),
        host: spawned,
      });
      return {
        client,
        connection: spawned.connection,
        initializeResult: spawned.initializeResult,
        fingerprintWarning: spawned.fingerprintWarning,
        addNotificationHandler,
        close: () => spawned.close().then(() => undefined),
      } satisfies MuseHost;
    },
    catch: (cause) =>
      new ProviderAdapterRequestError({
        provider: DRIVER,
        method: "msp/spawn",
        detail: `Could not start 'muse serve': ${cause instanceof Error ? cause.message : String(cause)}`,
        ...(cause instanceof Error ? { cause } : {}),
      }),
  });
}

/**
 * Resolve the user's muse config dir: $XDG_CONFIG_HOME/muse, else
 * $HOME/.config/muse (the host's own convention, verified against 1.3.0).
 */
export function resolveMuseConfigDir(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
}): string {
  const xdg = input.env["XDG_CONFIG_HOME"]?.trim();
  return xdg ? `${xdg}/muse` : `${input.homeDir}/.config/muse`;
}

/**
 * Scoped settings document: the user's own settings with the t3-code MCP
 * entry added. Merging (not rewriting) keeps provider/model selection, so a
 * scoped host behaves like the user's normal host. Written to
 * `<scopeDir>/muse/settings.json` with `XDG_CONFIG_HOME=<scopeDir>` so the
 * credential never touches the user's global muse config.
 */
export function museScopedMcpSettingsDocument(input: {
  readonly existingSettingsJson: string | undefined;
  readonly endpoint: string;
  readonly authorizationHeader: string;
}): string {
  const entry = {
    url: input.endpoint,
    headers: { Authorization: input.authorizationHeader },
  };
  try {
    const parsed: unknown =
      input.existingSettingsJson === undefined ? {} : JSON.parse(input.existingSettingsJson);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const servers: Record<string, unknown> =
        "mcpServers" in parsed &&
        parsed.mcpServers !== null &&
        typeof parsed.mcpServers === "object" &&
        !Array.isArray(parsed.mcpServers)
          ? { ...(parsed.mcpServers as Record<string, unknown>) }
          : {};
      servers["t3-code"] = entry;
      return JSON.stringify({ schema_version: 1, ...parsed, mcpServers: servers });
    }
  } catch {
    // Corrupt user settings fall through to the minimal document below.
  }
  return JSON.stringify({ schema_version: 1, mcpServers: { "t3-code": entry } });
}

/** Narrow catalog row composed from the wire shape, never restated. */
export interface MuseModelRow {
  readonly modelId: string;
  readonly displayLabel: string;
  readonly isDefault: boolean;
  readonly providerId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep well-formed catalog rows; malformed rows are dropped, not guessed. */
export function decodeMuseModelRows(value: unknown): ReadonlyArray<MuseModelRow> {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    return [];
  }
  const rows: Array<MuseModelRow> = [];
  for (const entry of value.models) {
    if (!isRecord(entry) || typeof entry.modelId !== "string" || entry.modelId === "") {
      continue;
    }
    rows.push({
      modelId: entry.modelId,
      displayLabel: typeof entry.displayLabel === "string" ? entry.displayLabel : entry.modelId,
      isDefault: entry.isDefault === true,
      providerId: typeof entry.providerId === "string" ? entry.providerId : "",
    });
  }
  return rows;
}

/**
 * A host that answers nothing — neither rejection nor terminal — wedges Stop,
 * steer, and the turn forever: the SDK `command()` has no timeout of its own.
 * Control commands therefore carry their own deadlines; on expiry callers
 * settle locally instead of parking forever.
 */
export const MSP_INTERRUPT_TIMEOUT = "30 seconds" as const;
export const MSP_RESUME_TIMEOUT = "60 seconds" as const;
export const MSP_HOST_CLOSE_TIMEOUT = "10 seconds" as const;

/** Stable token marking an interrupt that outlived its deadline. */
export function isMspInterruptTimeoutText(text: string): boolean {
  return text.includes("msp_interrupt_timeout");
}

/**
 * Interrupt a turn on the host. Partial output stays where it streamed;
 * the host settles the turn with its own terminal, which the adapter folds
 * into `turn.completed`. Used by manual Stop and by follow-up steers.
 * A silent host fails with `msp_interrupt_timeout` instead of hanging.
 */
export function interruptMspTurn(
  host: Pick<MuseHost, "connection">,
  input: { readonly sessionId: string; readonly turnId?: string | undefined },
  timeout: Duration.Input = MSP_INTERRUPT_TIMEOUT,
): Effect.Effect<void, ProviderAdapterRequestError> {
  const command = Effect.tryPromise({
    try: () =>
      host.connection.command("turn/interrupt", {
        sessionId: input.sessionId,
        ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      }),
    catch: (cause) =>
      new ProviderAdapterRequestError({
        provider: DRIVER,
        method: "turn/interrupt",
        detail: `Could not interrupt Muse turn${input.turnId ? ` ${input.turnId}` : ""}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        ...(cause instanceof Error ? { cause } : {}),
      }),
  }).pipe(Effect.asVoid);
  return Effect.gen(function* () {
    const answered = yield* Effect.timeoutOption(command, timeout);
    if (Option.isSome(answered)) {
      return;
    }
    return yield* new ProviderAdapterRequestError({
      provider: DRIVER,
      method: "turn/interrupt",
      detail: `Muse host did not answer turn/interrupt in time (msp_interrupt_timeout).`,
    });
  });
}

/**
 * Close a host, abandoning it when even teardown hangs. A wedged host must
 * not wedge shutdown, respawn, or the stop path with it — the OS process may
 * linger as an orphan, but the thread moves on.
 */
export function closeMspHostWithTimeout(
  host: Pick<MuseHost, "close">,
  timeout: Duration.Input = MSP_HOST_CLOSE_TIMEOUT,
): Effect.Effect<boolean> {
  return Effect.timeoutOption(
    Effect.promise(() => host.close()),
    timeout,
  ).pipe(Effect.map(Option.isSome));
}

/**
 * The host answers `turn/interrupt` for a run it never knew with a
 * `missing_run` rejection. The run is gone host-side, so callers must settle
 * the turn locally instead of failing: keeping it "running" wedges Stop,
 * steer, and every later turn on the thread.
 */
export function isMspMissingRunText(text: string): boolean {
  return text.includes("missing_run");
}

/**
 * `session/resume` against a session still attached to another (usually
 * orphaned, pre-restart) host fails with "already in use". Resuming is
 * impossible, so callers must start a fresh host session rather than fail
 * the thread into an infinite thinking state.
 */
export function isMspSessionInUseText(text: string): boolean {
  return text.toLowerCase().includes("already in use");
}

/** Raw `model/list` query proving the host's catalog identity. */
export function listMuseModels(
  host: Pick<MuseHost, "connection">,
): Effect.Effect<ReadonlyArray<MuseModelRow>, ProviderAdapterRequestError> {
  return Effect.tryPromise({
    try: async () => decodeMuseModelRows(await host.connection.command("model/list", {})),
    catch: (cause) =>
      new ProviderAdapterRequestError({
        provider: DRIVER,
        method: "model/list",
        detail: `Could not list Muse models: ${cause instanceof Error ? cause.message : String(cause)}`,
        ...(cause instanceof Error ? { cause } : {}),
      }),
  });
}

/** The host's last-observed subscription usage, with no model call. */
export const MUSE_USAGE_READ_METHOD = "usage/read" as const;

/**
 * The notification a host emits when it observes fresh subscription usage. Its
 * params are the same payload `usage/read` returns under its `usage` member.
 */
export const MUSE_USAGE_CHANGED_METHOD = "usage/changed" as const;

/**
 * A host observes subscription usage only after it serves model traffic, so a
 * freshly spawned probe host answers `usage/read` with no usage at all. The
 * adapter's long-lived hosts observe it during turns; this keeps the latest
 * observation any of them reported so the probe can publish real windows
 * without a model call. Absent until some host has observed usage.
 */
let lastObservedUsage: Record<string, unknown> | undefined;

/** The latest usage any spawned host reported, or undefined when none has. */
export function lastObservedMuseUsage(): Record<string, unknown> | undefined {
  return lastObservedUsage;
}

/** The usage payload a `usage/changed` notification carries, if it is one. */
export function museUsageChangedFrom(notification: {
  readonly method: string;
  readonly params?: Record<string, unknown> | undefined;
}): Record<string, unknown> | undefined {
  if (notification.method !== MUSE_USAGE_CHANGED_METHOD) {
    return undefined;
  }
  return isRecord(notification.params) ? notification.params : undefined;
}

/**
 * Raw `usage/read` query. The pinned SDK typings predate the method, but
 * `Connection.request` takes a plain method string, so it is called
 * generically without adding a commandId. The result is the documented
 * `{ usage? }` envelope: `usage` is omitted until the host has observed usage.
 */
export function readMuseUsage(
  host: Pick<MuseHost, "connection">,
): Effect.Effect<Record<string, unknown> | undefined, ProviderAdapterRequestError> {
  return Effect.tryPromise({
    try: async () => {
      const result = await host.connection.request(MUSE_USAGE_READ_METHOD, {});
      return isRecord(result["usage"]) ? result["usage"] : undefined;
    },
    catch: (cause) =>
      new ProviderAdapterRequestError({
        provider: DRIVER,
        method: MUSE_USAGE_READ_METHOD,
        detail: `Could not read Muse usage: ${cause instanceof Error ? cause.message : String(cause)}`,
        ...(cause instanceof Error ? { cause } : {}),
      }),
  });
}

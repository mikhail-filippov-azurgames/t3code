import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { isZavodKeyHelper } from "./detect.ts";

// The Zavod app's gateway switch rewrites ~/.codex and ~/.claude; personal instances stay on the subscription.

const ZAVOD_CODEX_PROVIDER_ID = "zavod";
const CODEX_PERSONAL_PROVIDER_ARG = `-c ${JSON.stringify('model_provider="openai"')}`;
const ANTHROPIC_API_URL = "https://api.anthropic.com";

const isUserConfigDir = Effect.fnUntraced(function* (directory: string, name: string) {
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(directory) === normalize(path.join(yield* HostProcess.HomeDirectory, name));
});

function rootModelProvider(configToml: string): string | undefined {
  for (const line of configToml.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) return undefined;
    const match = /^\s*model_provider\s*=\s*(["'])([^"']*)\1\s*(?:#.*)?$/.exec(line);
    if (match) return match[2];
  }
  return undefined;
}

/** Launch args for a Codex instance whose shared home is ~/.codex, read at each launch. */
export const codexPersonalLaunchArgs = Effect.fn("Ft3Zavod.codexPersonalLaunchArgs")(function* (
  sharedHomePath: string,
  launchArgs: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* isUserConfigDir(sharedHomePath, ".codex"))) return launchArgs;
  const configToml = yield* fileSystem
    .readFileString(path.join(sharedHomePath, "config.toml"))
    .pipe(Effect.orElseSucceed(() => ""));
  if (rootModelProvider(configToml) !== ZAVOD_CODEX_PROVIDER_ID) return launchArgs;
  return [CODEX_PERSONAL_PROVIDER_ARG, launchArgs.trim()].filter(Boolean).join(" ");
});

const decodeClaudeGatewaySettings = Schema.decodeUnknownOption(
  fromLenientJson(
    Schema.Struct({
      env: Schema.optionalKey(
        Schema.Struct({ ANTHROPIC_BASE_URL: Schema.optionalKey(Schema.Unknown) }),
      ),
      apiKeyHelper: Schema.optionalKey(Schema.Unknown),
    }),
  ),
);

export interface ClaudePersonalRouteSettings {
  readonly apiKeyHelper: "";
  readonly env?: { readonly ANTHROPIC_BASE_URL: string };
}

/** Flag settings that outrank a Zavod gateway written into ~/.claude/settings.json. */
export const claudePersonalRouteSettings = Effect.fn("Ft3Zavod.claudePersonalRouteSettings")(
  function* (
    configDir: string,
  ): Effect.fn.Return<
    ClaudePersonalRouteSettings | undefined,
    never,
    FileSystem.FileSystem | Path.Path
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* isUserConfigDir(configDir, ".claude"))) return undefined;
    const contents = yield* fileSystem
      .readFileString(path.join(configDir, "settings.json"))
      .pipe(Effect.orElseSucceed(() => "{}"));
    const settings = decodeClaudeGatewaySettings(contents);
    if (settings._tag === "None" || typeof settings.value.apiKeyHelper !== "string") {
      return undefined;
    }
    if (!isZavodKeyHelper(settings.value.apiKeyHelper)) return undefined;
    return settings.value.env?.ANTHROPIC_BASE_URL === undefined
      ? { apiKeyHelper: "" }
      : { apiKeyHelper: "", env: { ANTHROPIC_BASE_URL: ANTHROPIC_API_URL } };
  },
);

export function withClaudePersonalRoute<T extends object>(
  settings: T,
  route: ClaudePersonalRouteSettings | undefined,
): T;
export function withClaudePersonalRoute<T extends object>(
  settings: T | undefined,
  route: ClaudePersonalRouteSettings | undefined,
): T | undefined;
export function withClaudePersonalRoute<T extends object>(
  settings: T | undefined,
  route: ClaudePersonalRouteSettings | undefined,
): T | undefined {
  if (route === undefined) return settings;
  const current = (settings ?? {}) as { readonly env?: unknown };
  const env = typeof current.env === "object" && current.env !== null ? current.env : {};
  return {
    ...settings,
    apiKeyHelper: route.apiKeyHelper,
    ...(route.env === undefined ? {} : { env: { ...env, ...route.env } }),
  } as unknown as T;
}

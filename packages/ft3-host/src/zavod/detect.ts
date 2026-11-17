import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse } from "smol-toml";

export const DEFAULT_ZAVOD_BASE_URL =
  "https://zavod-litellm.infra.prod.aws.eu-central-1.azurgames.dev";

export interface ZavodDetection {
  readonly state: "on" | "off" | "mixed" | "unsupported" | "absent";
  readonly baseUrl: string | null;
  readonly baseUrlSource: "state" | "default" | null;
  readonly helperPath: string | null;
  readonly reason: string | null;
}

export interface DetectZavodOptions {
  readonly claudeHomePath?: string;
  readonly codexHomePath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly claudeEnvironment?: NodeJS.ProcessEnv;
  readonly codexEnvironment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
}

const decodeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ version: Schema.optionalKey(Schema.Unknown), base_url: Schema.String }),
  ),
);
export const decodeClaude = Schema.decodeUnknownEffect(
  fromLenientJson(
    Schema.Struct({
      env: Schema.optionalKey(
        Schema.Struct({ ANTHROPIC_BASE_URL: Schema.optionalKey(Schema.String) }),
      ),
      apiKeyHelper: Schema.optionalKey(Schema.String),
    }),
  ),
);
export const decodeCodex = Schema.decodeUnknownEffect(
  Schema.Struct({
    model_provider: Schema.optionalKey(Schema.String),
    model_providers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    profile: Schema.optionalKey(Schema.Unknown),
    profiles: Schema.optionalKey(
      Schema.Record(
        Schema.String,
        Schema.Struct({
          model_provider: Schema.optionalKey(Schema.Unknown),
        }),
      ),
    ),
    openai_base_url: Schema.optionalKey(Schema.Unknown),
  }),
);
export const decodeProvider = Schema.decodeUnknownEffect(
  Schema.Struct({
    base_url: Schema.String,
    auth: Schema.optionalKey(Schema.Struct({ command: Schema.optionalKey(Schema.String) })),
  }),
);

export function endpointOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

export function expandHome(value: string, home: string, path: Path.Path): string {
  if (value === "~") return home;
  if (/^~[/\\]/.test(value)) return path.join(home, value.slice(2));
  return value;
}

export function helperIsPath(
  value: string,
  home: string,
  path: Path.Path,
  shellCommand = true,
): boolean {
  const trimmed = value.trim();
  if (!trimmed || /[\x00-\x1f\x7f$`;&|<>(){}%!^*?[\]]/.test(trimmed)) return false;
  const unquoted = trimmed.replace(/^(["'])(.*)\1$/, "$2");
  if (/["']/.test(unquoted)) return false;
  if (shellCommand && unquoted === trimmed && /\s/.test(unquoted)) return false;
  if (unquoted === "zavod-key" || unquoted === "zavod-key.exe") return true;
  return path.isAbsolute(expandHome(unquoted, home, path));
}

const readOptional = Effect.fn("Zavod.readOptional")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.undefined,
    ),
  );
});

export const detectZavod = Effect.fn("Zavod.detect")(function* (
  options: DetectZavodOptions = {},
): Effect.fn.Return<ZavodDetection, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = options.homeDirectory ?? (yield* HostProcess.HomeDirectory);
  const environment = options.environment ?? (yield* HostProcess.Environment);
  const claudeEnvironment = options.claudeEnvironment ?? environment;
  const codexEnvironment = options.codexEnvironment ?? environment;
  const platform = yield* HostProcess.Platform;
  const helperPath = path.join(
    home,
    ".zavod",
    "bin",
    platform === "win32" ? "zavod-key.exe" : "zavod-key",
  );
  const helper = yield* fs.stat(helperPath).pipe(
    Effect.map((info) => info.type === "File"),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(false),
    ),
    Effect.orElseSucceed(() => undefined),
  );
  if (helper !== true) {
    return {
      state: helper === false ? "absent" : "unsupported",
      baseUrl: null,
      baseUrlSource: null,
      helperPath: null,
      reason: helper === false ? "Zavod helper is absent." : "Cannot inspect Zavod helper.",
    };
  }

  const stateOrigin = yield* readOptional(path.join(home, ".zavod", "desktop", "state.json")).pipe(
    Effect.flatMap((text) => (text === undefined ? Effect.undefined : decodeState(text))),
    Effect.map((state) => (state === undefined ? undefined : endpointOrigin(state.base_url))),
    Effect.orElseSucceed(() => undefined),
  );
  const origin = stateOrigin ?? DEFAULT_ZAVOD_BASE_URL;
  const common = {
    baseUrl: `${origin}/v1`,
    baseUrlSource: stateOrigin === undefined ? ("default" as const) : ("state" as const),
    helperPath,
  };

  return yield* Effect.gen(function* () {
    const claudeHome = path.resolve(
      expandHome(
        options.claudeHomePath?.trim() ||
          claudeEnvironment.CLAUDE_CONFIG_DIR?.trim() ||
          path.join(home, ".claude"),
        home,
        path,
      ),
    );
    const codexHome = path.resolve(
      expandHome(
        options.codexHomePath?.trim() ||
          codexEnvironment.CODEX_HOME?.trim() ||
          path.join(home, ".codex"),
        home,
        path,
      ),
    );
    const claudeText = yield* readOptional(path.join(claudeHome, "settings.json"));
    const claude = yield* decodeClaude(claudeText ?? "{}").pipe(
      Effect.mapError(() => "Claude settings format is unsupported."),
    );
    if (claude.apiKeyHelper !== undefined && !helperIsPath(claude.apiKeyHelper, home, path)) {
      return {
        ...common,
        state: "unsupported",
        reason: "Claude apiKeyHelper must be a path.",
      } as const;
    }
    const claudeUrl = claude.env?.ANTHROPIC_BASE_URL ?? claudeEnvironment.ANTHROPIC_BASE_URL;
    const claudeOrigin = claudeUrl?.trim() ? endpointOrigin(claudeUrl) : undefined;
    if (claudeUrl?.trim() && claudeOrigin === undefined) {
      return {
        ...common,
        state: "unsupported",
        reason: "Claude endpoint is unsupported.",
      } as const;
    }

    const codexText = yield* readOptional(path.join(codexHome, "config.toml"));
    const toml = yield* Effect.try({
      try: () => parse(codexText ?? ""),
      catch: () => "Codex TOML format is unsupported.",
    });
    const codex = yield* decodeCodex(toml).pipe(
      Effect.mapError(() => "Codex provider selection is unsupported."),
    );
    if (
      codex.profile !== undefined ||
      Object.values(codex.profiles ?? {}).some((profile) => profile.model_provider !== undefined) ||
      codex.openai_base_url !== undefined ||
      codexEnvironment.OPENAI_BASE_URL !== undefined
    ) {
      return {
        ...common,
        state: "unsupported",
        reason: "Codex profile or endpoint overrides are unsupported.",
      } as const;
    }
    const active = codex.model_provider ?? "openai";
    const provider = codex.model_providers?.[active];
    let codexOrigin: string | undefined;
    if (provider !== undefined) {
      const config = yield* decodeProvider(provider).pipe(
        Effect.mapError(() => "Active Codex provider format is unsupported."),
      );
      if (
        config.auth?.command !== undefined &&
        !helperIsPath(config.auth.command, home, path, false)
      ) {
        return {
          ...common,
          state: "unsupported",
          reason: "Codex auth.command must be a path.",
        } as const;
      }
      codexOrigin = endpointOrigin(config.base_url);
      if (codexOrigin === undefined) {
        return {
          ...common,
          state: "unsupported",
          reason: "Codex endpoint is unsupported.",
        } as const;
      }
    } else if (active !== "openai") {
      return {
        ...common,
        state: "unsupported",
        reason: "Active Codex provider is missing.",
      } as const;
    }
    const claudeOn = claudeOrigin === origin;
    const codexOn = codexOrigin === origin;
    if (claudeOn !== codexOn) {
      return {
        ...common,
        state: "mixed",
        reason: "Claude and Codex use different gateways.",
      } as const;
    }
    return { ...common, state: claudeOn ? "on" : "off", reason: null } as const;
  }).pipe(
    Effect.orElseSucceed((error) => ({
      ...common,
      state: "unsupported" as const,
      reason: typeof error === "string" ? error : "Cannot read provider configuration.",
    })),
  );
});

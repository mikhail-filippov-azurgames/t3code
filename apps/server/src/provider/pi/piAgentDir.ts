import type { CustomModelSetting, RuntimeMode } from "@t3tools/contracts";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolvePiLaunchProfile } from "./piPermissionBridge.ts";

export const PI_BUNDLED_PROVIDER_ID = "ft3-local";
/** Convert an endpoint model ID into Pi's provider/model slug. */
export function normalizePiModelSlug(model: string | undefined): string | undefined {
  const normalized = model?.trim() ?? "";
  if (normalized.length === 0) return undefined;
  const providerPrefix = `${PI_BUNDLED_PROVIDER_ID}/`;
  return normalized.startsWith(providerPrefix) ? normalized : `${providerPrefix}${normalized}`;
}
/** Pi's provider catalog stores bare endpoint IDs; selection slugs add the provider prefix. */
export function piModelIdFromSlug(model: string | undefined): string | undefined {
  const slug = normalizePiModelSlug(model);
  return slug?.startsWith(`${PI_BUNDLED_PROVIDER_ID}/`)
    ? slug.slice(PI_BUNDLED_PROVIDER_ID.length + 1)
    : undefined;
}
export const PI_DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";

export interface PiAgentDirInput {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly runtimeMode: RuntimeMode;
}

/** Normalize user endpoint input; empty base URL falls back to the local default. */
export function normalizePiBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : PI_DEFAULT_BASE_URL;
}

/** Dummy key for keyless local servers (Ollama ignores it). */
export function normalizePiApiKey(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : "ollama";
}

/** Parse the loopback-only HTTP endpoint supported by FT3's local Pi profile. */
export function parsePiLocalEndpoint(baseUrl: string): URL | undefined {
  try {
    const url = new URL(baseUrl.trim());
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "http:" ||
      (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return undefined;
    }
    url.pathname = url.pathname.replace(/\/+$/, "") || "/v1";
    return url;
  } catch {
    return undefined;
  }
}

/**
 * FT3-managed Pi `models.json` for one instance. Uses a single
 * `ft3-local` OpenAI-compatible provider so Pi never reads the user's
 * personal Pi catalog and project extensions stay out of scope.
 */
export function buildPiModelsJson(input: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly models: ReadonlyArray<string>;
}): string {
  const baseUrl = normalizePiBaseUrl(input.baseUrl);
  const apiKey = normalizePiApiKey(input.apiKey);
  const seen = new Set<string>();
  const models: Array<{ readonly id: string }> = [];
  for (const raw of input.models) {
    const id = raw.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    models.push({ id });
  }
  return `${JSON.stringify({ providers: { [PI_BUNDLED_PROVIDER_ID]: { baseUrl, api: "openai-completions", apiKey, models } } }, null, 2)}\n`;
}

/** FT3-managed Pi `settings.json`: pinned tools + never trust project resources. */
export function buildPiSettingsJson(input: {
  readonly runtimeMode: RuntimeMode;
  readonly defaultModel?: string | undefined;
}): string {
  const profile = resolvePiLaunchProfile(input.runtimeMode);
  const document: Record<string, unknown> = {
    defaultTools: [...profile.tools],
    defaultProjectTrust: profile.projectTrust,
  };
  const model = normalizePiModelSlug(input.defaultModel);
  if (model !== undefined) document.defaultModel = model;
  return `${JSON.stringify(document, null, 2)}\n`;
}

export interface PiAgentFilesInput {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly models: ReadonlyArray<string>;
  readonly runtimeMode: RuntimeMode;
  readonly defaultModel?: string | undefined;
  /** Sessions append FT3 runtime instructions; probes and one-shots skip it. */
  readonly systemNote?: string | undefined;
}

/**
 * Write the FT3-managed Pi agent dir (`models.json`, `settings.json`, and
 * optionally `APPEND_SYSTEM.md`). Chat sessions use their per-instance
 * directory; one-shot text generation passes a disposable per-call
 * directory. Pi never reads the ambient user catalog.
 */
export const ensurePiAgentFiles = (
  agentDir: string,
  input: PiAgentFilesInput,
): Effect.Effect<void, Error, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(agentDir, { recursive: true });
    const writes: Array<readonly [string, string]> = [
      [
        path.join(agentDir, "models.json"),
        buildPiModelsJson({ baseUrl: input.baseUrl, apiKey: input.apiKey, models: input.models }),
      ],
      [
        path.join(agentDir, "settings.json"),
        buildPiSettingsJson({ runtimeMode: input.runtimeMode, defaultModel: input.defaultModel }),
      ],
    ];
    if (input.systemNote !== undefined) {
      writes.push([path.join(agentDir, "APPEND_SYSTEM.md"), input.systemNote]);
    }
    for (const [filePath, content] of writes) {
      yield* fileSystem.writeFileString(filePath, content);
    }
  });

/** Managed `models.json` entries from instance settings (deduped). */
export function piManagedModelsFromConfig(input: {
  readonly configuredModel: string | undefined;
  readonly customModels: ReadonlyArray<CustomModelSetting> | undefined;
}): ReadonlyArray<string> {
  return resolvePiManagedModels({
    configuredModel: input.configuredModel,
    customModels: (input.customModels ?? []).flatMap((entry) =>
      typeof entry === "string" ? [entry] : entry.slug ? [entry.slug] : [],
    ),
  });
}

/** Resolve the model list written into the managed `models.json`. */
export function resolvePiManagedModels(input: {
  readonly configuredModel: string | undefined;
  readonly customModels: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  const ordered: Array<string> = [];
  const seen = new Set<string>();
  const push = (value: string | undefined) => {
    const trimmed = piModelIdFromSlug(value) ?? value?.trim() ?? "";
    if (trimmed.length === 0 || seen.has(trimmed)) return;
    seen.add(trimmed);
    ordered.push(trimmed);
  };
  push(input.configuredModel);
  for (const entry of input.customModels) push(entry);
  return ordered;
}

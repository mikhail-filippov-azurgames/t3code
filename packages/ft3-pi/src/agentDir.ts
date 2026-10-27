import type { CustomModelSetting, RuntimeMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const PI_BUNDLED_PROVIDER_ID = "ft3-local";
const PI_DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";
const PI_DEFAULT_API_KEY = "ollama";

const PI_BUILT_IN_TOOLS = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;
type PiBuiltInTool = (typeof PI_BUILT_IN_TOOLS)[number];

const READ_TOOLS: ReadonlyArray<PiBuiltInTool> = ["read", "grep", "find", "ls"];
const WRITE_TOOLS: ReadonlyArray<PiBuiltInTool> = ["edit", "write"];
const SHELL_TOOLS: ReadonlyArray<PiBuiltInTool> = ["bash", "powershell"];

/** Fail-closed tool set for one runtime mode. */
function resolvePiToolsForRuntimeMode(runtimeMode: RuntimeMode): ReadonlyArray<PiBuiltInTool> {
  switch (runtimeMode) {
    case "approval-required":
      return [...READ_TOOLS];
    case "auto-accept-edits":
    case "auto":
      return [...READ_TOOLS, ...WRITE_TOOLS];
    case "full-access":
      return [...PI_BUILT_IN_TOOLS];
    default:
      return [...READ_TOOLS, ...SHELL_TOOLS];
  }
}

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

export function normalizePiBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : PI_DEFAULT_BASE_URL;
}

/** Dummy key for keyless local servers (llama-server ignores it). */
export function normalizePiApiKey(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : PI_DEFAULT_API_KEY;
}

/** One managed model; `baseUrl` overrides the provider endpoint for this model only. */
export interface PiManagedModel {
  readonly id: string;
  readonly baseUrl?: string | undefined;
}

/** Managed `models.json` for one instance; Pi never reads the ambient user catalog. */
export function buildPiModelsJson(input: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly models: ReadonlyArray<PiManagedModel>;
}): string {
  const baseUrl = normalizePiBaseUrl(input.baseUrl);
  const apiKey = normalizePiApiKey(input.apiKey);
  const seen = new Set<string>();
  const models: Array<PiManagedModel> = [];
  for (const raw of input.models) {
    const id = piModelIdFromSlug(raw.id) ?? raw.id.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    const modelBaseUrl = raw.baseUrl?.trim() ?? "";
    models.push(
      modelBaseUrl.length > 0 && modelBaseUrl !== baseUrl ? { id, baseUrl: modelBaseUrl } : { id },
    );
  }
  return `${JSON.stringify({ providers: { [PI_BUNDLED_PROVIDER_ID]: { baseUrl, api: "openai-completions", apiKey, models } } }, null, 2)}\n`;
}

/** Managed `settings.json`: pinned tools and no project trust. */
function buildPiSettingsJson(input: {
  readonly runtimeMode: RuntimeMode;
  readonly defaultModel?: string | undefined;
}): string {
  const document: Record<string, unknown> = {
    defaultTools: [...resolvePiToolsForRuntimeMode(input.runtimeMode)],
    defaultProjectTrust: "never",
  };
  const model = normalizePiModelSlug(input.defaultModel);
  if (model !== undefined) document.defaultModel = model;
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Resolve the model list written into the managed `models.json`. */
export function resolvePiManagedModels(input: {
  readonly configuredModel: string | undefined;
  readonly profileModels: ReadonlyArray<{ readonly model: string; readonly baseUrl?: string }>;
  readonly customModels: ReadonlyArray<CustomModelSetting> | undefined;
}): ReadonlyArray<PiManagedModel> {
  const ordered: Array<PiManagedModel> = [];
  const seen = new Set<string>();
  const push = (value: string | undefined, baseUrl?: string | undefined) => {
    const id = piModelIdFromSlug(value) ?? value?.trim() ?? "";
    if (id.length === 0 || seen.has(id)) return;
    seen.add(id);
    const modelBaseUrl = baseUrl?.trim() ?? "";
    ordered.push(modelBaseUrl.length > 0 ? { id, baseUrl: modelBaseUrl } : { id });
  };
  push(input.configuredModel);
  for (const profile of input.profileModels) push(profile.model, profile.baseUrl);
  for (const entry of input.customModels ?? []) {
    push(typeof entry === "string" ? entry : entry.slug);
  }
  return ordered;
}

export interface PiAgentFilesInput {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly models: ReadonlyArray<PiManagedModel>;
  readonly runtimeMode: RuntimeMode;
  readonly defaultModel?: string | undefined;
}

/** Write only the files whose content changed, so repeated turns do not touch the agent dir. */
export const ensurePiAgentFiles = Effect.fn("Ft3Pi.ensurePiAgentFiles")(function* (
  agentDir: string,
  input: PiAgentFilesInput,
) {
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
  for (const [filePath, content] of writes) {
    const existing = yield* fileSystem.readFileString(filePath).pipe(Effect.option);
    if (existing._tag === "Some" && existing.value === content) continue;
    yield* fileSystem.writeFileString(filePath, content);
  }
});

/** Add the managed agent dir to an instance environment without duplicating the variable. */
export function withPiAgentDir(
  environment: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
    readonly sensitive?: boolean;
  }>,
  agentDir: string,
): ReadonlyArray<{ readonly name: string; readonly value: string; readonly sensitive: boolean }> {
  return [
    ...environment
      .filter((entry) => entry.name.toUpperCase() !== "PI_CODING_AGENT_DIR")
      .map((entry) => ({
        name: entry.name,
        value: entry.value,
        sensitive: entry.sensitive ?? false,
      })),
    { name: "PI_CODING_AGENT_DIR", value: agentDir, sensitive: false },
  ];
}

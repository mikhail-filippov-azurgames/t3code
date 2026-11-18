export type PersonalFamily = "claude" | "codex";

type Table = Record<string, unknown>;

export type PersonalSkipReason = "secret" | "invalid";

export interface SkippedMcpServer {
  readonly name: string;
  readonly reason: PersonalSkipReason;
}

export interface FilteredMcpServers {
  readonly servers: Table;
  readonly skipped: ReadonlyArray<SkippedMcpServer>;
}

// Anything not listed here is never copied.
export const personalCopySpec = {
  claude: {
    entries: ["CLAUDE.md", "skills", "agents", "commands", "output-styles", "rules"],
    config: "settings.json",
    mcpFile: ".claude.json",
  },
  codex: {
    entries: ["AGENTS.md", "AGENTS.override.md", "skills", "prompts", "rules", "hooks.json"],
    config: "config.toml",
  },
} as const;

export function isPersonalEntry(family: PersonalFamily, name: string): boolean {
  return (personalCopySpec[family].entries as readonly string[]).includes(name);
}

const SECRET_NAME = /key|token|secret|password/i;
const SECRET_HEADER_NAME = /key|token|secret|password|auth|cookie|credential/i;

export const isSecretName = (name: string): boolean => SECRET_NAME.test(name);

const isTable = (value: unknown): value is Table =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);

const pick = (table: Table, keep: (key: string) => boolean): Table =>
  Object.fromEntries(Object.entries(table).filter(([key]) => keep(key)));

// A `${NAME}` expansion (optionally behind an auth scheme) carries no secret itself.
function isReference(value: string): boolean {
  if (!value.includes("${")) return false;
  return (
    value
      .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, "")
      .replace(/\b(?:Bearer|Basic|Token)\b/gi, "")
      .trim() === ""
  );
}

const isLiteralSecret = (value: unknown): boolean =>
  typeof value === "string" && value.trim() !== "" && !isReference(value);

const tableHasLiteralSecret = (table: unknown, isSecretKey: (key: string) => boolean): boolean =>
  isTable(table) &&
  Object.entries(table).some(([key, value]) => isSecretKey(key) && isLiteralSecret(value));

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function urlCarriesSecret(url: unknown): boolean {
  if (typeof url !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (isLiteralSecret(safeDecode(parsed.username))) return true;
  if (isLiteralSecret(safeDecode(parsed.password))) return true;
  return [...parsed.searchParams].some(
    ([key, value]) => SECRET_HEADER_NAME.test(key) && isLiteralSecret(value),
  );
}

const claudeServerHasSecret = (server: Table): boolean =>
  tableHasLiteralSecret(server.env, isSecretName) ||
  tableHasLiteralSecret(server.headers, (key) => SECRET_HEADER_NAME.test(key)) ||
  urlCarriesSecret(server.url);

const codexServerHasSecret = (server: Table): boolean =>
  tableHasLiteralSecret(server.env, isSecretName) ||
  tableHasLiteralSecret(server.http_headers, (key) => SECRET_HEADER_NAME.test(key)) ||
  isLiteralSecret(server.bearer_token) ||
  urlCarriesSecret(server.url);

function filterServers(
  servers: unknown,
  hasSecret: (server: Table) => boolean,
): FilteredMcpServers {
  if (!isTable(servers)) return { servers: {}, skipped: [] };
  const kept: Table = {};
  const skipped: SkippedMcpServer[] = [];
  for (const [name, server] of Object.entries(servers)) {
    if (!isTable(server)) skipped.push({ name, reason: "invalid" });
    else if (hasSecret(server)) skipped.push({ name, reason: "secret" });
    else kept[name] = server;
  }
  return { servers: kept, skipped };
}

/** Filters the `mcpServers` table of a Claude `.claude.json`. */
export const filterClaudeMcpServers = (servers: unknown): FilteredMcpServers =>
  filterServers(servers, claudeServerHasSecret);

const CLAUDE_SETTINGS_DROPPED = new Set([
  "apiKeyHelper",
  "awsAuthRefresh",
  "awsCredentialExport",
  "otelHeadersHelper",
  "model",
  "availableModels",
]);
const CLAUDE_ENV_ROUTE =
  /^(?:ANTHROPIC_|AWS_|CLAUDE_CODE_USE_)|^CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY$/i;

/** Drops the route, credential helpers and secret env from a personal Claude `settings.json`. */
export function filterClaudeSettings(settings: Table): Table {
  const result = pick(settings, (key) => key !== "env" && !CLAUDE_SETTINGS_DROPPED.has(key));
  if (isTable(settings.env)) {
    const env = pick(settings.env, (key) => !CLAUDE_ENV_ROUTE.test(key) && !isSecretName(key));
    if (Object.keys(env).length > 0) result.env = env;
  }
  return result;
}

const CODEX_CONFIG_DROPPED = new Set([
  "model_provider",
  "model_providers",
  "model",
  "model_catalog_json",
  "openai_base_url",
  "chatgpt_base_url",
  "otel",
  "profiles",
  "shell_environment_policy",
  "mcp_servers",
]);

/** Drops the route, secret env and secret MCP servers from a personal Codex `config.toml`. */
export function filterCodexConfig(config: Table): {
  readonly config: Table;
  readonly skipped: ReadonlyArray<SkippedMcpServer>;
} {
  const result = pick(config, (key) => !CODEX_CONFIG_DROPPED.has(key));
  if (isTable(config.profiles)) {
    result.profiles = Object.fromEntries(
      Object.entries(config.profiles).map(([name, profile]) => [
        name,
        isTable(profile)
          ? pick(profile, (key) => key !== "model_provider" && key !== "model")
          : profile,
      ]),
    );
  }
  if (isTable(config.shell_environment_policy)) {
    const { set, ...policy } = config.shell_environment_policy;
    const safeSet = isTable(set) ? pick(set, (key) => !isSecretName(key)) : undefined;
    result.shell_environment_policy =
      safeSet === undefined || Object.keys(safeSet).length === 0
        ? policy
        : { ...policy, set: safeSet };
  }
  const { servers, skipped } = filterServers(config.mcp_servers, codexServerHasSecret);
  if (Object.keys(servers).length > 0) result.mcp_servers = servers;
  return { config: result, skipped };
}

// Personal wins at the top level and, for the named tables, per key.
function mergeTables(existing: Table, personal: Table, nested: readonly string[]): Table {
  const result = { ...existing, ...personal };
  for (const key of nested) {
    const before = existing[key];
    const after = personal[key];
    if (isTable(before) && isTable(after)) result[key] = { ...before, ...after };
  }
  return result;
}

export const mergeClaudeSettings = (existing: Table, personal: Table): Table =>
  mergeTables(existing, personal, ["env"]);

export const mergeClaudeMcpServers = (existingClaudeJson: Table, servers: Table): Table =>
  Object.keys(servers).length === 0
    ? existingClaudeJson
    : mergeTables(existingClaudeJson, { mcpServers: servers }, ["mcpServers"]);

export const mergeCodexConfig = (existing: Table, personal: Table): Table =>
  mergeTables(existing, personal, ["mcp_servers"]);

import { assert, describe, it } from "@effect/vitest";
import { parse, stringify } from "smol-toml";

import { configContents } from "./instances.ts";
import {
  filterClaudeMcpServers,
  filterClaudeSettings,
  filterCodexConfig,
  isPersonalEntry,
  isSecretName,
  mergeClaudeMcpServers,
  mergeClaudeSettings,
  mergeCodexConfig,
  personalCopySpec,
} from "./personalCopy.ts";

const baseUrl = "https://zavod.example/v1";
const helperPath = "/opt/zavod/zavod-key";
const secrets = [
  "sk-ant-fixture-personal-key",
  "ghp_fixtureMcpToken",
  "fixture-helper-secret",
  "fixture-bearer-secret",
  "fixture-header-secret",
  "fixture-url-secret",
  "fixture-codex-env-secret",
  "fixture-policy-secret",
];

const personalSettings = {
  apiKeyHelper: "/home/me/.claude/fixture-helper-secret.sh",
  awsAuthRefresh: "aws sso login",
  awsCredentialExport: "aws-export",
  otelHeadersHelper: "otel-helper",
  model: "claude-opus",
  availableModels: ["claude-opus"],
  theme: "dark",
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo" }] }] },
  permissions: { allow: ["Bash(ls)"] },
  enabledPlugins: { "tool@market": true },
  env: {
    ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    ANTHROPIC_API_KEY: "sk-ant-fixture-personal-key",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    AWS_PROFILE: "work",
    MY_SERVICE_TOKEN: "fixture-helper-secret",
    GITHUB_PASSWORD: "fixture-helper-secret",
    EDITOR: "vim",
  },
};

describe("personal copy allowlist", () => {
  it("lists exactly the instruction, skill and rule entries", () => {
    assert.deepStrictEqual(personalCopySpec.claude.entries, [
      "CLAUDE.md",
      "skills",
      "agents",
      "commands",
      "output-styles",
      "rules",
    ]);
    assert.deepStrictEqual(personalCopySpec.codex.entries, [
      "AGENTS.md",
      "AGENTS.override.md",
      "skills",
      "prompts",
      "rules",
      "hooks.json",
    ]);
  });

  it("rejects credentials, history, sessions, caches and path tricks", () => {
    const forbidden = [
      ".credentials.json",
      "auth.json",
      ".claude.json",
      "settings.json",
      "config.toml",
      "history.jsonl",
      "sessions",
      "archived_sessions",
      "projects",
      "cache",
      "plugins",
      "state.sqlite",
      "logs",
      "shell-snapshots",
      "session-env",
      "ide",
      ".sandbox",
      "backups",
      "tmp",
      "skills/../auth.json",
      "../skills",
      "skills/",
      "SKILLS",
      "",
    ];
    for (const family of ["claude", "codex"] as const) {
      for (const name of forbidden) {
        assert.isFalse(isPersonalEntry(family, name), `${family}:${name}`);
      }
    }
    assert.isTrue(isPersonalEntry("claude", "CLAUDE.md"));
    assert.isFalse(isPersonalEntry("claude", "AGENTS.md"));
    assert.isTrue(isPersonalEntry("codex", "AGENTS.md"));
    assert.isFalse(isPersonalEntry("codex", "CLAUDE.md"));
  });
});

describe("secret names", () => {
  it("matches key, token, secret and password in any case", () => {
    for (const name of ["API_KEY", "githubToken", "client_secret", "DB_PASSWORD", "apikey"]) {
      assert.isTrue(isSecretName(name), name);
    }
    for (const name of ["EDITOR", "AWS_PROFILE", "LOG_LEVEL"]) {
      assert.isFalse(isSecretName(name), name);
    }
  });
});

describe("Claude settings filter", () => {
  const filtered = filterClaudeSettings(personalSettings);

  it("drops the route, credential helpers, model choice and secret env", () => {
    assert.deepStrictEqual(filtered, {
      theme: "dark",
      hooks: personalSettings.hooks,
      permissions: personalSettings.permissions,
      enabledPlugins: personalSettings.enabledPlugins,
      env: { EDITOR: "vim" },
    });
  });

  it("omits env when nothing survives and ignores a non-object env", () => {
    assert.deepStrictEqual(filterClaudeSettings({ env: { ANTHROPIC_API_KEY: "x" } }), {});
    assert.deepStrictEqual(filterClaudeSettings({ env: "oops", theme: "dark" }), {
      theme: "dark",
    });
  });

  it("matches env names case-insensitively", () => {
    assert.deepStrictEqual(
      filterClaudeSettings({ env: { anthropic_base_url: "x", aws_region: "y" } }),
      {},
    );
  });
});

describe("Claude MCP servers", () => {
  it("keeps variable references and plain env, skips literal secrets by name", () => {
    const result = filterClaudeMcpServers({
      plain: { command: "node", args: ["server.js"], env: { LOG_LEVEL: "debug" } },
      reference: {
        type: "http",
        url: "https://mcp.example/api",
        headers: { Authorization: "Bearer ${MCP_TOKEN}" },
        env: { API_KEY: "${MCP_KEY}" },
      },
      literalEnv: { command: "gh-mcp", env: { GITHUB_TOKEN: "ghp_fixtureMcpToken" } },
      literalHeader: {
        type: "http",
        url: "https://mcp.example/api",
        headers: { Authorization: "Bearer fixture-bearer-secret" },
      },
      literalApiKeyHeader: {
        type: "sse",
        url: "https://mcp.example/sse",
        headers: { "X-Api-Key": "fixture-header-secret" },
      },
      urlQuery: { type: "http", url: "https://mcp.example/api?token=fixture-url-secret" },
      urlUser: { type: "http", url: "https://fixture-url-secret@mcp.example/api" },
      emptySecret: { command: "x", env: { API_KEY: "" } },
      broken: "not-an-object",
    });
    assert.deepStrictEqual(Object.keys(result.servers), ["plain", "reference", "emptySecret"]);
    assert.deepStrictEqual(result.skipped, [
      { name: "literalEnv", reason: "secret" },
      { name: "literalHeader", reason: "secret" },
      { name: "literalApiKeyHeader", reason: "secret" },
      { name: "urlQuery", reason: "secret" },
      { name: "urlUser", reason: "secret" },
      { name: "broken", reason: "invalid" },
    ]);
  });

  it("treats a missing table as empty", () => {
    assert.deepStrictEqual(filterClaudeMcpServers(undefined), { servers: {}, skipped: [] });
  });
});

describe("Codex config filter", () => {
  const personal = parse(`
model_provider = "openai"
model = "gpt-fixture"
model_catalog_json = "catalog.json"
openai_base_url = "https://api.openai.com/v1"
chatgpt_base_url = "https://chatgpt.com"
model_reasoning_effort = "high"
notify = ["notify-send"]

[otel]
exporter = "none"

[model_providers.zavod]
base_url = "https://personal.example/v1"

[profiles.fast]
model_provider = "openai"
model = "gpt-fixture-fast"
model_reasoning_effort = "low"

[shell_environment_policy]
inherit = "core"

[shell_environment_policy.set]
EDITOR = "vim"
SERVICE_TOKEN = "fixture-policy-secret"

[projects.'/work']
trust_level = "trusted"

[mcp_servers.plain]
command = "node"
args = ["server.js"]
env_vars = ["HOME"]

[mcp_servers.plain.env]
LOG_LEVEL = "debug"

[mcp_servers.byVariable]
url = "https://mcp.example/api"
bearer_token_env_var = "MCP_TOKEN"

[mcp_servers.byVariable.env_http_headers]
X-Api-Key = "MCP_API_KEY"

[mcp_servers.literalBearer]
url = "https://mcp.example/api"
bearer_token = "fixture-bearer-secret"

[mcp_servers.literalHeader]
url = "https://mcp.example/api"

[mcp_servers.literalHeader.http_headers]
Authorization = "Bearer fixture-header-secret"

[mcp_servers.literalEnv]
command = "tool"

[mcp_servers.literalEnv.env]
API_KEY = "fixture-codex-env-secret"
`);
  const { config, skipped } = filterCodexConfig(personal);

  it("drops the route and model choice and keeps the rest", () => {
    for (const key of [
      "model_provider",
      "model_providers",
      "model",
      "model_catalog_json",
      "openai_base_url",
      "chatgpt_base_url",
      "otel",
    ]) {
      assert.isFalse(key in config, key);
    }
    assert.strictEqual(config.model_reasoning_effort, "high");
    assert.deepStrictEqual(config.notify, ["notify-send"]);
    assert.deepStrictEqual(config.projects, { "/work": { trust_level: "trusted" } });
  });

  it("drops model and model_provider from profiles and secret keys from the shell policy", () => {
    assert.deepStrictEqual(config.profiles, { fast: { model_reasoning_effort: "low" } });
    assert.deepStrictEqual(config.shell_environment_policy, {
      inherit: "core",
      set: { EDITOR: "vim" },
    });
  });

  it("skips MCP servers with literal secrets and keeps variable references", () => {
    assert.deepStrictEqual(Object.keys(config.mcp_servers as object), ["plain", "byVariable"]);
    assert.deepStrictEqual(skipped, [
      { name: "literalBearer", reason: "secret" },
      { name: "literalHeader", reason: "secret" },
      { name: "literalEnv", reason: "secret" },
    ]);
  });

  it("drops a shell policy set table that holds only secrets", () => {
    const result = filterCodexConfig({
      shell_environment_policy: { set: { API_TOKEN: "fixture-policy-secret" } },
    });
    assert.deepStrictEqual(result.config, { shell_environment_policy: {} });
  });
});

describe("merge and route", () => {
  const zavodSettings = {
    env: { ANTHROPIC_BASE_URL: "https://zavod.example", KEEP_ME: "1" },
    apiKeyHelper: JSON.stringify(helperPath),
    onlyInZavod: true,
    theme: "light",
  };

  it("keeps Zavod-only Claude keys, lets personal win and merges env and servers", () => {
    const merged = mergeClaudeSettings(zavodSettings, filterClaudeSettings(personalSettings));
    assert.strictEqual(merged.onlyInZavod, true);
    assert.strictEqual(merged.theme, "dark");
    assert.deepStrictEqual(merged.env, {
      ANTHROPIC_BASE_URL: "https://zavod.example",
      KEEP_ME: "1",
      EDITOR: "vim",
    });
    const servers = mergeClaudeMcpServers(
      { numStartups: 3, mcpServers: { shared: { command: "old" }, zavodOnly: { command: "z" } } },
      { shared: { command: "new" }, added: { command: "a" } },
    );
    assert.deepStrictEqual(servers, {
      numStartups: 3,
      mcpServers: {
        shared: { command: "new" },
        zavodOnly: { command: "z" },
        added: { command: "a" },
      },
    });
    assert.deepStrictEqual(mergeClaudeMcpServers({ numStartups: 3 }, {}), { numStartups: 3 });
  });

  it("keeps Zavod-only Codex keys and merges MCP servers by name", () => {
    const existing = parse(configContents(undefined, false, baseUrl, helperPath, false));
    existing.only_in_zavod = "yes";
    existing.mcp_servers = { shared: { command: "old" }, zavodOnly: { command: "z" } };
    const merged = mergeCodexConfig(existing, {
      model_reasoning_effort: "high",
      mcp_servers: { shared: { command: "new" } },
    });
    assert.strictEqual(merged.only_in_zavod, "yes");
    assert.strictEqual(merged.model_reasoning_effort, "high");
    assert.deepStrictEqual(merged.mcp_servers, {
      shared: { command: "new" },
      zavodOnly: { command: "z" },
    });
    assert.isTrue("model_providers" in merged);
  });

  it("lets the Zavod route win over a personal Claude route", () => {
    const merged = mergeClaudeSettings(zavodSettings, filterClaudeSettings(personalSettings));
    const out = JSON.parse(
      configContents(JSON.stringify(merged), true, baseUrl, helperPath, false),
    );
    assert.strictEqual(out.env.ANTHROPIC_BASE_URL, "https://zavod.example");
    assert.strictEqual(out.apiKeyHelper, JSON.stringify(helperPath));
    assert.isFalse("model" in out);
    assert.isFalse("ANTHROPIC_API_KEY" in out.env);
  });

  it("lets the Zavod route win over a personal Codex model_provider", () => {
    const personal = parse(`
model_provider = "openai"
openai_base_url = "https://api.openai.com/v1"
[model_providers.zavod]
base_url = "https://personal.example/v1"
`);
    const existing = parse(configContents(undefined, false, baseUrl, helperPath, false));
    const merged = mergeCodexConfig(existing, filterCodexConfig(personal).config);
    const out = parse(configContents(stringify(merged), false, baseUrl, helperPath, false));
    assert.strictEqual(out.model_provider, "zavod");
    assert.isFalse("openai_base_url" in out);
    assert.strictEqual(
      (out.model_providers as { zavod: { base_url: string } }).zavod.base_url,
      baseUrl,
    );
  });

  it("keeps every fixture secret out of the final output", () => {
    const claudeServers = filterClaudeMcpServers({
      leaked: { command: "gh-mcp", env: { GITHUB_TOKEN: "ghp_fixtureMcpToken" } },
      header: {
        url: "https://mcp.example",
        headers: { Authorization: "Bearer fixture-bearer-secret" },
      },
    });
    const claude = configContents(
      JSON.stringify(mergeClaudeSettings(zavodSettings, filterClaudeSettings(personalSettings))),
      true,
      baseUrl,
      helperPath,
      false,
    );
    const claudeJson = JSON.stringify(mergeClaudeMcpServers({}, claudeServers.servers));
    const codexFiltered = filterCodexConfig({
      shell_environment_policy: { set: { SERVICE_TOKEN: "fixture-policy-secret" } },
      mcp_servers: {
        literal: {
          url: "https://mcp.example",
          http_headers: { "X-Api-Key": "fixture-header-secret" },
        },
        bearer: { url: "https://mcp.example", bearer_token: "fixture-bearer-secret" },
        env: { command: "t", env: { API_KEY: "fixture-codex-env-secret" } },
        urlQuery: { url: "https://mcp.example?api_key=fixture-url-secret" },
      },
    });
    const codex = configContents(
      stringify(mergeCodexConfig({}, codexFiltered.config)),
      false,
      baseUrl,
      helperPath,
      false,
    );
    for (const output of [claude, claudeJson, codex]) {
      for (const secret of secrets) {
        assert.isFalse(output.includes(secret), secret);
      }
    }
  });
});

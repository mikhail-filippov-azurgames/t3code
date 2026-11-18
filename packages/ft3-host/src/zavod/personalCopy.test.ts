// @effect-diagnostics nodeBuiltinImport:off - Directory junctions need Node's symlink API.
import * as NodeFSP from "node:fs/promises";

import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { parse, stringify } from "smol-toml";

import * as ServerConfig from "../../../../apps/server/src/config.ts";
import * as ServerSettings from "../../../../apps/server/src/serverSettings.ts";
import * as Instances from "./instances.ts";
import * as Service from "./service.ts";
import {
  copyPersonalSettings,
  filterClaudeMcpServers,
  filterClaudeSettings,
  filterCodexConfig,
  isPersonalEntry,
  isSecretName,
  mergeClaudeMcpServers,
  mergeClaudeSettings,
  mergeCodexConfig,
  personalCopySpec,
  ZavodPersonalCopyError,
} from "./personalCopy.ts";

const configContents = Instances.configContents;
const isCopyError = Schema.is(ZavodPersonalCopyError);
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

const fsLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
const leakMarkers = [
  "fixture-credential-secret",
  "fixture-history-secret",
  "fixture-session-secret",
  "fixture-oauth-secret",
  "fixture-codex-auth-secret",
  "ghp_fixtureMcpToken",
  "sk-ant-fixture-personal-key",
  "fixture-helper-secret",
  "fixture-codex-env-secret",
];

const copyFixture = Effect.fn("test.personalCopyFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const windows = path.sep === "\\";
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-personal-copy-" });
  const put = Effect.fn("test.put")(function* (file: string, text: string) {
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, text);
  });
  const homes = {
    claudeSource: path.join(root, "personal-claude"),
    codexSource: path.join(root, "personal-codex"),
    claudeJson: path.join(root, "personal-claude.json"),
    claudeTarget: path.join(root, "zavod", "zavod-claude"),
    codexTarget: path.join(root, "zavod", "zavod-codex"),
  };
  const s = (name: string) => path.join(homes.claudeSource, name);
  const c = (name: string) => path.join(homes.codexSource, name);

  yield* put(s("CLAUDE.md"), "personal claude notes");
  yield* put(s("skills/alpha/SKILL.md"), "alpha v1");
  yield* put(s("skills/alpha/bin/run.sh"), "#!/bin/sh\necho alpha");
  yield* put(s("agents/reviewer.md"), "reviewer");
  yield* put(s("settings.json"), JSON.stringify(personalSettings));
  yield* put(s(".credentials.json"), "fixture-credential-secret");
  yield* put(s("history.jsonl"), "fixture-history-secret");
  yield* put(s("sessions/one.jsonl"), "fixture-session-secret");
  yield* put(s("projects/p/memory.md"), "fixture-session-secret");
  yield* put(s("cache/blob"), "fixture-session-secret");
  yield* put(s("plugins/p/index.js"), "fixture-session-secret");
  yield* put(
    homes.claudeJson,
    JSON.stringify({
      numStartups: 7,
      oauthAccount: { emailAddress: "fixture-oauth-secret" },
      projects: { "/work": { history: ["fixture-history-secret"] } },
      mcpServers: {
        ok: { command: "node", args: ["server.js"] },
        leaky: { command: "gh-mcp", env: { GITHUB_TOKEN: "ghp_fixtureMcpToken" } },
      },
    }),
  );
  yield* put(c("AGENTS.md"), "personal codex notes");
  yield* put(c("skills/s/SKILL.md"), "codex skill");
  yield* put(c("prompts/p.md"), "prompt");
  yield* put(c("hooks.json"), "{}");
  yield* put(c("auth.json"), "fixture-codex-auth-secret");
  yield* put(c("history.jsonl"), "fixture-history-secret");
  yield* put(c("sessions/one.jsonl"), "fixture-session-secret");
  yield* put(
    c("config.toml"),
    [
      'model_provider = "openai"',
      'model_reasoning_effort = "high"',
      "[mcp_servers.ok]",
      'command = "node"',
      "[mcp_servers.leaky]",
      'command = "tool"',
      "[mcp_servers.leaky.env]",
      'API_KEY = "fixture-codex-env-secret"',
    ].join("\n"),
  );
  yield* put(
    path.join(homes.claudeTarget, "settings.json"),
    configContents(undefined, true, baseUrl, helperPath, windows),
  );
  yield* put(path.join(homes.claudeTarget, "skills/zavod-only/SKILL.md"), "zavod only");
  yield* put(
    path.join(homes.codexTarget, "config.toml"),
    configContents(undefined, false, baseUrl, helperPath, windows),
  );

  const families = [
    {
      family: "claude" as const,
      sourceHome: homes.claudeSource,
      targetHome: homes.claudeTarget,
      claudeJson: homes.claudeJson,
    },
    { family: "codex" as const, sourceHome: homes.codexSource, targetHome: homes.codexTarget },
  ];
  const run = (dryRun: boolean, limits?: { maxFiles: number; maxBytes: number }) =>
    copyPersonalSettings({
      families,
      baseUrl,
      helperPath,
      dryRun,
      ...(limits === undefined ? {} : { limits }),
    });
  const listing = Effect.fn("test.listing")(function* (dir: string) {
    return (yield* fs.readDirectory(dir, { recursive: true }))
      .map((entry) => entry.replaceAll("\\", "/"))
      .toSorted();
  });
  const snapshot = Effect.fn("test.snapshot")(function* (dir: string) {
    const entries: Array<[string, string]> = [];
    for (const entry of yield* listing(dir)) {
      const info = yield* fs.stat(path.join(dir, entry));
      const text = info.type === "File" ? yield* fs.readFileString(path.join(dir, entry)) : "";
      entries.push([entry, text]);
    }
    return entries;
  });
  return { fs, path, root, homes, put, s, c, run, listing, snapshot };
});

const denyReads = (
  fs: FileSystem.FileSystem,
  denied: ReadonlySet<string>,
): FileSystem.FileSystem => {
  const refuse = (method: string, file: string) =>
    PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method,
      pathOrDescriptor: file,
      description: "fixture access denied",
    });
  return {
    ...fs,
    readFileString: (file, encoding) =>
      denied.has(file)
        ? Effect.fail(refuse("readFileString", file))
        : fs.readFileString(file, encoding),
    readFile: (file) =>
      denied.has(file) ? Effect.fail(refuse("readFile", file)) : fs.readFile(file),
  };
};

const failPaths = (
  fs: FileSystem.FileSystem,
  broken: ReadonlyArray<{
    readonly method: "realPath" | "stat" | "lstat";
    readonly file: string;
    readonly tag: "PermissionDenied" | "NotFound" | "Unknown";
    readonly code?: string;
  }>,
): FileSystem.FileSystem => {
  const wrap =
    <A>(
      method: "realPath" | "stat" | "lstat",
      call: (file: string) => Effect.Effect<A, PlatformError.PlatformError>,
    ) =>
    (file: string) => {
      const rule = broken.find((entry) => entry.method === method && entry.file === file);
      return rule === undefined
        ? call(file)
        : Effect.fail(
            PlatformError.systemError({
              _tag: rule.tag,
              module: "FileSystem",
              method,
              pathOrDescriptor: file,
              description: "fixture failure",
              ...(rule.code === undefined
                ? {}
                : { cause: Object.assign(new Error(rule.code), { code: rule.code }) }),
            }),
          );
    };
  return {
    ...fs,
    realPath: wrap("realPath", fs.realPath),
    stat: wrap("stat", fs.stat),
    lstat: wrap("lstat", fs.lstat),
  };
};

const junction = (target: string, link: string) =>
  Effect.promise(() => NodeFSP.symlink(target, link, "junction"));

describe("personal copy on disk", () => {
  it.effect("copies only allowlisted entries and leaves no credential or secret behind", () =>
    Effect.gen(function* () {
      const f = yield* copyFixture();
      const report = yield* f.run(false);

      assert.deepStrictEqual(report.items, [
        { family: "claude", path: "CLAUDE.md", action: "create" },
        { family: "claude", path: "skills/alpha", action: "create" },
        { family: "claude", path: "agents/reviewer.md", action: "create" },
        { family: "claude", path: "settings.json", action: "merge" },
        { family: "claude", path: ".claude.json", action: "create" },
        { family: "codex", path: "AGENTS.md", action: "create" },
        { family: "codex", path: "skills/s", action: "create" },
        { family: "codex", path: "prompts/p.md", action: "create" },
        { family: "codex", path: "hooks.json", action: "create" },
        { family: "codex", path: "config.toml", action: "merge" },
      ]);
      assert.deepStrictEqual(report.skipped, [
        { family: "claude", path: ".claude.json:mcpServers.leaky", reason: "secret" },
        { family: "codex", path: "config.toml:mcp_servers.leaky", reason: "secret" },
      ]);

      assert.deepStrictEqual(yield* f.listing(f.homes.claudeTarget), [
        ".claude.json",
        "CLAUDE.md",
        "agents",
        "agents/reviewer.md",
        "settings.json",
        "skills",
        "skills/alpha",
        "skills/alpha/SKILL.md",
        "skills/alpha/bin",
        "skills/alpha/bin/run.sh",
        "skills/zavod-only",
        "skills/zavod-only/SKILL.md",
      ]);
      assert.deepStrictEqual(yield* f.listing(f.homes.codexTarget), [
        "AGENTS.md",
        "config.toml",
        "hooks.json",
        "prompts",
        "prompts/p.md",
        "skills",
        "skills/s",
        "skills/s/SKILL.md",
      ]);

      const everything = [
        ...(yield* f.snapshot(f.homes.claudeTarget)),
        ...(yield* f.snapshot(f.homes.codexTarget)),
      ]
        .map(([, text]) => text)
        .join("\n");
      for (const marker of leakMarkers) assert.isFalse(everything.includes(marker), marker);

      assert.strictEqual(
        yield* f.fs.readFileString(f.path.join(f.homes.claudeTarget, "skills/zavod-only/SKILL.md")),
        "zavod only",
      );
      const settings = JSON.parse(
        yield* f.fs.readFileString(f.path.join(f.homes.claudeTarget, "settings.json")),
      );
      assert.strictEqual(settings.theme, "dark");
      assert.strictEqual(settings.env.ANTHROPIC_BASE_URL, "https://zavod.example");
      assert.strictEqual(settings.env.EDITOR, "vim");
      assert.isFalse("model" in settings);
      assert.deepStrictEqual(
        JSON.parse(yield* f.fs.readFileString(f.path.join(f.homes.claudeTarget, ".claude.json"))),
        { mcpServers: { ok: { command: "node", args: ["server.js"] } } },
      );
      const codex = parse(
        yield* f.fs.readFileString(f.path.join(f.homes.codexTarget, "config.toml")),
      );
      assert.strictEqual(codex.model_provider, "zavod");
      assert.strictEqual(codex.model_reasoning_effort, "high");
      assert.deepStrictEqual(codex.mcp_servers, { ok: { command: "node" } });
    }).pipe(Effect.scoped, Effect.provide(fsLayer)),
  );

  it.effect("keeps executable bits on skill scripts", () =>
    Effect.gen(function* () {
      const f = yield* copyFixture();
      if (f.path.sep === "\\") return;
      yield* f.fs.chmod(f.path.join(f.homes.claudeSource, "skills/alpha/bin/run.sh"), 0o755);
      yield* f.run(false);
      const info = yield* f.fs.stat(f.path.join(f.homes.claudeTarget, "skills/alpha/bin/run.sh"));
      assert.strictEqual(info.mode & 0o111, 0o111);
    }).pipe(Effect.scoped, Effect.provide(fsLayer)),
  );

  it.effect("a dry run reports the apply plan and writes nothing", () =>
    Effect.gen(function* () {
      const f = yield* copyFixture();
      const before = [
        ...(yield* f.snapshot(f.homes.claudeTarget)),
        ...(yield* f.snapshot(f.homes.codexTarget)),
      ];
      const planned = yield* f.run(true);
      assert.deepStrictEqual(
        [...(yield* f.snapshot(f.homes.claudeTarget)), ...(yield* f.snapshot(f.homes.codexTarget))],
        before,
      );
      assert.isFalse(yield* f.fs.exists(f.path.join(f.homes.claudeTarget, ".claude.json")));
      assert.deepStrictEqual(yield* f.run(false), planned);
    }).pipe(Effect.scoped, Effect.provide(fsLayer)),
  );

  it.effect("a repeat replaces a skill whole and leaves Zavod-only skills alone", () =>
    Effect.gen(function* () {
      const f = yield* copyFixture();
      yield* f.run(false);
      yield* f.fs.remove(f.path.join(f.homes.claudeSource, "skills/alpha/bin"), {
        recursive: true,
      });
      yield* f.put(f.s("skills/alpha/SKILL.md"), "alpha v2");
      yield* f.put(f.s("skills/alpha/notes.md"), "new");
      yield* f.put(f.path.join(f.homes.claudeTarget, "skills/alpha/stale.md"), "stale");

      const report = yield* f.run(false);
      assert.deepStrictEqual(
        report.items.filter((item) => item.family === "claude" && item.path.startsWith("skills")),
        [{ family: "claude", path: "skills/alpha", action: "overwrite" }],
      );
      assert.deepStrictEqual(yield* f.listing(f.path.join(f.homes.claudeTarget, "skills")), [
        "alpha",
        "alpha/SKILL.md",
        "alpha/notes.md",
        "zavod-only",
        "zavod-only/SKILL.md",
      ]);
      assert.strictEqual(
        yield* f.fs.readFileString(f.path.join(f.homes.claudeTarget, "skills/alpha/SKILL.md")),
        "alpha v2",
      );
      assert.deepStrictEqual(
        (yield* f.listing(f.homes.claudeTarget)).filter((entry) => entry.startsWith(".zavod")),
        [],
      );
    }).pipe(Effect.scoped, Effect.provide(fsLayer)),
  );

  it.effect("follows links as copies and skips cycles, links home and broken links", () =>
    Effect.gen(function* () {
      const f = yield* copyFixture();
      yield* f.put(f.path.join(f.root, "shared-skill/SKILL.md"), "shared");
      yield* f.put(f.s("skills/loop/SKILL.md"), "loop");
      yield* junction(f.path.join(f.root, "shared-skill"), f.s("skills/linked"));
      yield* junction(f.s("skills/loop"), f.s("skills/loop/self"));
      yield* junction(f.homes.claudeSource, f.s("skills/home"));
      yield* junction(f.path.join(f.root, "missing"), f.s("skills/broken"));

      const report = yield* f.run(false);
      assert.deepStrictEqual(
        report.skipped
          .filter((entry) => entry.reason === "link")
          .map((entry) => entry.path)
          .toSorted(),
        ["skills/broken", "skills/home", "skills/loop/self"],
      );
      const linked = yield* f.fs.lstat(f.path.join(f.homes.claudeTarget, "skills/linked"));
      assert.strictEqual(linked.type, "Directory");
      assert.strictEqual(
        yield* f.fs.readFileString(f.path.join(f.homes.claudeTarget, "skills/linked/SKILL.md")),
        "shared",
      );
      const everything = (yield* f.snapshot(f.homes.claudeTarget))
        .map(([, text]) => text)
        .join("\n");
      for (const marker of leakMarkers) assert.isFalse(everything.includes(marker), marker);
    }).pipe(Effect.scoped, Effect.provide(fsLayer)),
  );

  it.effect("fails over the file or byte limit before writing anything", () =>
    Effect.gen(function* () {
      const f = yield* copyFixture();
      const before = yield* f.snapshot(f.homes.claudeTarget);
      for (const limits of [
        { maxFiles: 2, maxBytes: 1_000_000 },
        { maxFiles: 100, maxBytes: 10 },
      ]) {
        for (const dryRun of [true, false]) {
          const error = yield* f.run(dryRun, limits).pipe(Effect.flip);
          assert.isTrue(isCopyError(error));
          assert.strictEqual(error.stage, "limit");
        }
      }
      assert.deepStrictEqual(yield* f.snapshot(f.homes.claudeTarget), before);
      assert.isFalse(yield* f.fs.exists(f.path.join(f.homes.codexTarget, "AGENTS.md")));
    }).pipe(Effect.scoped, Effect.provide(fsLayer)),
  );

  it.effect("counts merged configs against the byte limit before writing", () =>
    Effect.gen(function* () {
      const f = yield* copyFixture();
      yield* f.put(f.s("settings.json"), JSON.stringify({ theme: "x".repeat(2000) }));
      const before = yield* f.snapshot(f.homes.claudeTarget);
      for (const dryRun of [true, false]) {
        const error = yield* f.run(dryRun, { maxFiles: 100, maxBytes: 1500 }).pipe(Effect.flip);
        assert.strictEqual(error.stage, "limit");
      }
      assert.deepStrictEqual(yield* f.snapshot(f.homes.claudeTarget), before);
    }).pipe(Effect.scoped, Effect.provide(fsLayer)),
  );

  it.effect("counts configs together with copied files against the file limit", () =>
    Effect.gen(function* () {
      const f = yield* copyFixture();
      // Eight copied files plus settings.json, .claude.json and config.toml.
      const exact = { maxFiles: 11, maxBytes: 1_000_000 };
      assert.strictEqual((yield* f.run(true, exact)).items.length, 10);
      const tight = { ...exact, maxFiles: 10 };
      for (const dryRun of [true, false]) {
        const error = yield* f.run(dryRun, tight).pipe(Effect.flip);
        assert.strictEqual(error.stage, "limit");
      }
      assert.isFalse(yield* f.fs.exists(f.path.join(f.homes.codexTarget, "AGENTS.md")));
    }).pipe(Effect.scoped, Effect.provide(fsLayer)),
  );

  it.effect("skips a personal config it may not read and keeps copying", () =>
    Effect.gen(function* () {
      for (const [family, file] of [
        ["claude", "settings.json"],
        ["claude", ".claude.json"],
        ["codex", "config.toml"],
      ] as const) {
        const f = yield* copyFixture();
        const blocked =
          file === ".claude.json"
            ? f.homes.claudeJson
            : f.path.join(family === "claude" ? f.homes.claudeSource : f.homes.codexSource, file);
        const report = yield* f
          .run(false)
          .pipe(Effect.provideService(FileSystem.FileSystem, denyReads(f.fs, new Set([blocked]))));
        assert.includeDeepMembers([...report.skipped], [{ family, path: file, reason: "invalid" }]);
        assert.strictEqual(
          yield* f.fs.readFileString(f.path.join(f.homes.codexTarget, "AGENTS.md")),
          "personal codex notes",
          file,
        );
        assert.isTrue(
          yield* f.fs.exists(f.path.join(f.homes.claudeTarget, "skills/alpha/SKILL.md")),
        );
      }
    }).pipe(Effect.scoped, Effect.provide(fsLayer)),
  );

  it.effect("skips a copied file it may not read and keeps copying the rest", () =>
    Effect.gen(function* () {
      const f = yield* copyFixture();
      const denied = new Set([f.s("CLAUDE.md"), f.s("skills/alpha/bin/run.sh")]);
      const report = yield* f
        .run(false)
        .pipe(Effect.provideService(FileSystem.FileSystem, denyReads(f.fs, denied)));
      assert.includeDeepMembers(
        [...report.skipped],
        [
          { family: "claude", path: "CLAUDE.md", reason: "invalid" },
          { family: "claude", path: "skills/alpha/bin/run.sh", reason: "invalid" },
        ],
      );
      assert.isFalse(report.items.some((item) => item.path === "CLAUDE.md"));
      assert.isFalse(yield* f.fs.exists(f.path.join(f.homes.claudeTarget, "CLAUDE.md")));
      assert.isFalse(
        yield* f.fs.exists(f.path.join(f.homes.claudeTarget, "skills/alpha/bin/run.sh")),
      );
      assert.strictEqual(
        yield* f.fs.readFileString(f.path.join(f.homes.claudeTarget, "skills/alpha/SKILL.md")),
        "alpha v1",
      );
      assert.isTrue(yield* f.fs.exists(f.path.join(f.homes.codexTarget, "AGENTS.md")));
    }).pipe(Effect.scoped, Effect.provide(fsLayer)),
  );

  it.effect("still fails when the existing Zavod config cannot be read", () =>
    Effect.gen(function* () {
      const f = yield* copyFixture();
      const blocked = f.path.join(f.homes.claudeTarget, "settings.json");
      const error = yield* f
        .run(false)
        .pipe(
          Effect.provideService(FileSystem.FileSystem, denyReads(f.fs, new Set([blocked]))),
          Effect.flip,
        );
      assert.strictEqual(error.stage, "copy");
    }).pipe(Effect.scoped, Effect.provide(fsLayer)),
  );

  it.effect("skips a personal folder whose real path cannot be resolved and keeps copying", () =>
    Effect.gen(function* () {
      const f = yield* copyFixture();
      yield* f.put(f.s("skills/beta/SKILL.md"), "beta");
      yield* f.put(f.s("skills/gamma/SKILL.md"), "gamma");
      yield* f.put(f.s("skills/delta/SKILL.md"), "delta");
      const broken = failPaths(f.fs, [
        { method: "realPath", file: f.s("skills/alpha"), tag: "Unknown", code: "ELOOP" },
        { method: "realPath", file: f.s("skills/beta"), tag: "PermissionDenied" },
        { method: "realPath", file: f.s("skills/gamma"), tag: "NotFound" },
      ]);
      const report = yield* f.run(false).pipe(Effect.provideService(FileSystem.FileSystem, broken));
      assert.includeDeepMembers(
        [...report.skipped],
        [
          { family: "claude", path: "skills/alpha", reason: "link" },
          { family: "claude", path: "skills/beta", reason: "invalid" },
          { family: "claude", path: "skills/gamma", reason: "link" },
        ],
      );
      assert.strictEqual(
        yield* f.fs.readFileString(f.path.join(f.homes.claudeTarget, "skills/delta/SKILL.md")),
        "delta",
      );
      assert.isFalse(yield* f.fs.exists(f.path.join(f.homes.claudeTarget, "skills/alpha")));
      assert.isTrue(yield* f.fs.exists(f.path.join(f.homes.codexTarget, "AGENTS.md")));
    }).pipe(Effect.scoped, Effect.provide(fsLayer)),
  );

  it.effect("skips a personal entry it may not stat and keeps copying", () =>
    Effect.gen(function* () {
      const f = yield* copyFixture();
      yield* f.put(f.s("skills/beta/SKILL.md"), "beta");
      const broken = failPaths(f.fs, [
        { method: "stat", file: f.s("skills/beta"), tag: "PermissionDenied" },
        { method: "lstat", file: f.s("skills/beta"), tag: "PermissionDenied" },
        { method: "stat", file: f.s("agents/reviewer.md"), tag: "PermissionDenied" },
        { method: "lstat", file: f.s("agents/reviewer.md"), tag: "PermissionDenied" },
      ]);
      const report = yield* f.run(false).pipe(Effect.provideService(FileSystem.FileSystem, broken));
      assert.includeDeepMembers(
        [...report.skipped],
        [
          { family: "claude", path: "skills/beta", reason: "invalid" },
          { family: "claude", path: "agents/reviewer.md", reason: "invalid" },
        ],
      );
      assert.isTrue(yield* f.fs.exists(f.path.join(f.homes.claudeTarget, "skills/alpha/SKILL.md")));
    }).pipe(Effect.scoped, Effect.provide(fsLayer)),
  );

  it.effect("still fails when the Zavod side cannot be inspected", () =>
    Effect.gen(function* () {
      const f = yield* copyFixture();
      const broken = failPaths(f.fs, [
        {
          method: "lstat",
          file: f.path.join(f.homes.claudeTarget, "CLAUDE.md"),
          tag: "PermissionDenied",
        },
      ]);
      const error = yield* f
        .run(false)
        .pipe(Effect.provideService(FileSystem.FileSystem, broken), Effect.flip);
      assert.strictEqual(error.stage, "copy");
    }).pipe(Effect.scoped, Effect.provide(fsLayer)),
  );

  it.effect("counts the bytes actually read when a file grows after its size was checked", () =>
    Effect.gen(function* () {
      for (const file of ["CLAUDE.md", "skills/a/SKILL.md"]) {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-personal-copy-grow-" });
        const sourceHome = path.join(root, "personal");
        const targetHome = path.join(root, "zavod");
        const grown = path.join(sourceHome, ...file.split("/"));
        yield* fs.makeDirectory(path.dirname(grown), { recursive: true });
        yield* fs.writeFileString(grown, "tiny");
        const growing: FileSystem.FileSystem = {
          ...fs,
          readFile: (target) =>
            target === grown ? Effect.succeed(new Uint8Array(500).fill(120)) : fs.readFile(target),
        };
        for (const dryRun of [true, false]) {
          const error = yield* copyPersonalSettings({
            families: [{ family: "claude", sourceHome, targetHome }],
            baseUrl,
            helperPath,
            dryRun,
            limits: { maxFiles: 10, maxBytes: 100 },
          }).pipe(Effect.provideService(FileSystem.FileSystem, growing), Effect.flip);
          assert.strictEqual(error.stage, "limit", file);
        }
        assert.isFalse(yield* fs.exists(targetHome), file);
      }
    }).pipe(Effect.scoped, Effect.provide(fsLayer)),
  );

  it.effect("refuses a personal home that is the Zavod home", () =>
    Effect.gen(function* () {
      const f = yield* copyFixture();
      const error = yield* copyPersonalSettings({
        families: [
          { family: "codex", sourceHome: f.homes.codexTarget, targetHome: f.homes.codexTarget },
        ],
        baseUrl,
        helperPath,
        dryRun: false,
      }).pipe(Effect.flip);
      assert.strictEqual(error.stage, "state");
    }).pipe(Effect.scoped, Effect.provide(fsLayer)),
  );

  it.effect("never writes through a linked folder in the Zavod home", () =>
    Effect.gen(function* () {
      const f = yield* copyFixture();
      const outside = f.path.join(f.root, "outside");
      yield* f.put(f.path.join(outside, "keep.md"), "keep");
      yield* f.fs.remove(f.path.join(f.homes.claudeTarget, "skills"), { recursive: true });
      yield* junction(outside, f.path.join(f.homes.claudeTarget, "skills"));
      const error = yield* f.run(false).pipe(Effect.flip);
      assert.strictEqual(error.stage, "copy");
      assert.deepStrictEqual(yield* f.listing(outside), ["keep.md"]);
    }).pipe(Effect.scoped, Effect.provide(fsLayer)),
  );

  it.effect("never writes a merged config through a dangling link out of the Zavod home", () =>
    Effect.gen(function* () {
      for (const [family, file] of [
        ["claude", "settings.json"],
        ["claude", ".claude.json"],
        ["codex", "config.toml"],
      ] as const) {
        const f = yield* copyFixture();
        const home = family === "claude" ? f.homes.claudeTarget : f.homes.codexTarget;
        const target = f.path.join(home, file);
        const outside = f.path.join(f.root, "outside", `created-${file}`);
        yield* f.fs.remove(target, { force: true });
        const linked = yield* Effect.promise(() => NodeFSP.symlink(outside, target, "file")).pipe(
          Effect.as(true),
          // Windows without the symlink privilege cannot build this fixture.
          Effect.catchCause(() => Effect.succeed(false)),
        );
        if (!linked) return;
        const error = yield* f.run(false).pipe(Effect.flip);
        assert.strictEqual(error.stage, "copy", file);
        assert.isFalse(yield* f.fs.exists(outside), file);
        assert.isFalse(yield* f.fs.exists(f.path.dirname(outside)), file);
      }
    }).pipe(Effect.scoped, Effect.provide(fsLayer)),
  );

  it.effect("resolves a relative link from the real folder of the link", () =>
    Effect.gen(function* () {
      const f = yield* copyFixture();
      const home = f.homes.claudeTarget;
      const outside = f.path.join(f.path.dirname(home), "outside", "escaped-settings.json");
      yield* f.fs.makeDirectory(f.path.join(home, "sub"));
      yield* junction(home, f.path.join(home, "sub", "alias"));
      yield* f.fs.remove(f.path.join(home, "settings.json"));
      const linked = yield* Effect.promise(async () => {
        await NodeFSP.symlink(
          "../outside/escaped-settings.json",
          f.path.join(home, "link.json"),
          "file",
        );
        await NodeFSP.symlink("sub/alias/link.json", f.path.join(home, "settings.json"), "file");
      }).pipe(
        Effect.as(true),
        // Windows without the symlink privilege cannot build this fixture.
        Effect.catchCause(() => Effect.succeed(false)),
      );
      if (!linked) return;
      const error = yield* f.run(false).pipe(Effect.flip);
      assert.strictEqual(error.stage, "copy");
      assert.isFalse(yield* f.fs.exists(outside));
    }).pipe(Effect.scoped, Effect.provide(fsLayer)),
  );

  it.effect("follows a chain of links to its end before writing a config", () =>
    Effect.gen(function* () {
      const f = yield* copyFixture();
      const target = f.path.join(f.homes.claudeTarget, "settings.json");
      const hop = f.path.join(f.homes.claudeTarget, "hop.json");
      const outside = f.path.join(f.root, "outside", "chain-settings.json");
      yield* f.fs.remove(target, { force: true });
      const linked = yield* Effect.promise(async () => {
        await NodeFSP.symlink(outside, hop, "file");
        await NodeFSP.symlink(hop, target, "file");
      }).pipe(
        Effect.as(true),
        Effect.catchCause(() => Effect.succeed(false)),
      );
      if (!linked) return;
      const error = yield* f.run(false).pipe(Effect.flip);
      assert.strictEqual(error.stage, "copy");
      assert.isFalse(yield* f.fs.exists(outside));
    }).pipe(Effect.scoped, Effect.provide(fsLayer)),
  );

  it.effect("skips unreadable personal configs instead of failing", () =>
    Effect.gen(function* () {
      const f = yield* copyFixture();
      yield* f.put(f.s("settings.json"), "[1, 2");
      yield* f.put(f.c("config.toml"), "this is = = not toml");
      const report = yield* f.run(false);
      assert.deepStrictEqual(
        report.skipped.filter((entry) => entry.reason === "invalid"),
        [
          { family: "claude", path: "settings.json", reason: "invalid" },
          { family: "codex", path: "config.toml", reason: "invalid" },
        ],
      );
      assert.isTrue(report.items.some((item) => item.path === "skills/alpha"));
    }).pipe(Effect.scoped, Effect.provide(fsLayer)),
  );
});

describe("ZavodService", () => {
  const layer = ServerSettings.layerTest({}).pipe(
    Layer.provideMerge(ServerConfig.layerTest(".", { prefix: "t3-zavod-copy-service-" })),
    Layer.provideMerge(fsLayer),
  );

  const serviceFixture = Effect.fn("test.zavodServiceFixture")(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const settings = yield* ServerSettings.ServerSettingsService;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-zavod-copy-home-" });
    const put = Effect.fn("test.servicePut")(function* (file: string, text: string) {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, text);
    });
    const helper = path.join(
      home,
      ".zavod",
      "bin",
      path.sep === "\\" ? "zavod-key.exe" : "zavod-key",
    );
    yield* put(helper, "fixture helper");
    yield* put(
      path.join(home, ".zavod", "desktop", "state.json"),
      JSON.stringify({ version: 1, base_url: "https://zavod.example:8443" }),
    );
    yield* put(path.join(home, ".claude", "CLAUDE.md"), "personal notes");
    yield* put(path.join(home, ".claude", "skills", "alpha", "SKILL.md"), "alpha");
    yield* put(path.join(home, ".claude", ".credentials.json"), "fixture-credential-secret");
    yield* put(
      path.join(home, ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "fixture-oauth-secret" },
        mcpServers: { ok: { command: "node" } },
      }),
    );
    yield* put(path.join(home, ".codex", "AGENTS.md"), "codex notes");
    yield* put(path.join(home, ".codex", "auth.json"), "fixture-codex-auth-secret");

    const observed: Array<boolean> = [];
    const watched: FileSystem.FileSystem = {
      ...fs,
      readDirectory: (directory, options) =>
        Instances.connectSemaphore
          .withPermitsIfAvailable(1)(Effect.void)
          .pipe(
            Effect.tap((permit) => Effect.sync(() => observed.push(Option.isNone(permit)))),
            Effect.andThen(fs.readDirectory(directory, options)),
          ),
    };
    const context = yield* Layer.build(
      Service.layer.pipe(Layer.provideMerge(Instances.layer)),
    ).pipe(
      Effect.provideService(HostProcess.HomeDirectory, home),
      Effect.provideService(HostProcess.Environment, {}),
      Effect.provideService(FileSystem.FileSystem, watched),
    );
    return {
      fs,
      path,
      settings,
      home,
      put,
      observed,
      service: Context.get(context, Service.ZavodService),
      instances: Context.get(context, Instances.ZavodInstances),
      claudeTarget: path.join(config.stateDir, "zavod", "zavod-claude"),
      codexTarget: path.join(config.stateDir, "zavod", "zavod-codex"),
    };
  });

  it.effect(
    "copyPersonal copies from the resolved personal homes, holds the connect lock and needs Zavod instances",
    () =>
      Effect.gen(function* () {
        const f = yield* serviceFixture();
        const early = yield* f.service.copyPersonal({ dryRun: false }).pipe(Effect.flip);
        assert.isTrue(isCopyError(early) && early.stage === "state");

        yield* f.service.connect();
        // Undo the first-connect copy so the explicit one starts from the bare homes.
        yield* f.fs.remove(f.path.join(f.claudeTarget, "CLAUDE.md"));
        yield* f.fs.remove(f.path.join(f.claudeTarget, "skills"), { recursive: true });
        yield* f.fs.remove(f.path.join(f.claudeTarget, ".claude.json"));
        yield* f.fs.remove(f.path.join(f.codexTarget, "AGENTS.md"));
        f.observed.length = 0;

        const planned = yield* f.service.copyPersonal({ dryRun: true });
        assert.isFalse(yield* f.fs.exists(f.path.join(f.claudeTarget, "CLAUDE.md")));
        const copied = yield* f.service.copyPersonal({ dryRun: false });
        assert.deepStrictEqual(copied, planned);
        assert.deepStrictEqual(
          copied.items.map((item) => `${item.family}:${item.path}:${item.action}`),
          [
            "claude:CLAUDE.md:create",
            "claude:skills/alpha:create",
            "claude:.claude.json:create",
            "codex:AGENTS.md:create",
          ],
        );
        assert.deepStrictEqual(
          JSON.parse(yield* f.fs.readFileString(f.path.join(f.claudeTarget, ".claude.json"))),
          { mcpServers: { ok: { command: "node" } } },
        );
        assert.isFalse(yield* f.fs.exists(f.path.join(f.claudeTarget, ".credentials.json")));
        assert.isFalse(yield* f.fs.exists(f.path.join(f.codexTarget, "auth.json")));
        assert.isTrue(f.observed.length > 0 && f.observed.every(Boolean));
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("the first connect copies personal settings and a reconnect does not", () =>
    Effect.gen(function* () {
      const f = yield* serviceFixture();
      const first = yield* f.service.connect();
      assert.strictEqual(first.personalCopy, "copied");
      assert.strictEqual(
        yield* f.fs.readFileString(f.path.join(f.claudeTarget, "CLAUDE.md")),
        "personal notes",
      );
      assert.strictEqual(
        yield* f.fs.readFileString(f.path.join(f.claudeTarget, "skills/alpha/SKILL.md")),
        "alpha",
      );
      assert.strictEqual(
        yield* f.fs.readFileString(f.path.join(f.codexTarget, "AGENTS.md")),
        "codex notes",
      );
      assert.isFalse(yield* f.fs.exists(f.path.join(f.claudeTarget, ".credentials.json")));
      assert.isFalse(yield* f.fs.exists(f.path.join(f.codexTarget, "auth.json")));

      yield* f.put(f.path.join(f.home, ".claude", "CLAUDE.md"), "edited later");
      const second = yield* f.service.connect();
      assert.isFalse("personalCopy" in second);
      assert.strictEqual(
        yield* f.fs.readFileString(f.path.join(f.claudeTarget, "CLAUDE.md")),
        "personal notes",
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("a failed first copy keeps the connection", () =>
    Effect.gen(function* () {
      const f = yield* serviceFixture();
      const outside = f.path.join(f.home, "outside");
      yield* f.put(f.path.join(outside, "keep.md"), "keep");
      yield* f.fs.makeDirectory(f.claudeTarget, { recursive: true });
      yield* junction(outside, f.path.join(f.claudeTarget, "skills"));

      const connected = yield* f.service.connect();
      assert.strictEqual(connected.personalCopy, "failed");
      const providers = (yield* f.settings.getSettings).providerInstances;
      assert.isDefined(providers[connected.claudeInstanceId]);
      assert.isDefined(providers[connected.codexInstanceId]);
      assert.deepStrictEqual(yield* f.fs.readDirectory(outside, { recursive: true }), ["keep.md"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("an overlapping connect that creates nothing keeps local Zavod edits", () =>
    Effect.gen(function* () {
      const f = yield* serviceFixture();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const delayed = Instances.ZavodInstances.of({
        connect: (detected) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return yield* f.instances.connect(detected);
          }),
      });
      const context = yield* Layer.build(Service.layer).pipe(
        Effect.provideService(Instances.ZavodInstances, delayed),
        Effect.provideService(HostProcess.HomeDirectory, f.home),
        Effect.provideService(HostProcess.Environment, {}),
      );
      const slow = Context.get(context, Service.ZavodService);
      const pending = yield* slow.connect().pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* f.service.connect();
      const target = f.path.join(f.claudeTarget, "CLAUDE.md");
      yield* f.put(target, "Zavod local edits");
      yield* f.put(f.path.join(f.home, ".claude", "CLAUDE.md"), "changed personal notes");
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(pending);
      assert.strictEqual(yield* f.fs.readFileString(target), "Zavod local edits");
      assert.isFalse("personalCopy" in result);
      assert.isFalse("created" in result);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("copyPersonal skips unreadable personal configs and still copies skills", () =>
    Effect.gen(function* () {
      const f = yield* serviceFixture();
      yield* f.service.connect();
      yield* f.put(f.path.join(f.home, ".claude", "settings.json"), "[broken json");
      yield* f.put(f.path.join(f.home, ".codex", "config.toml"), "not = = toml");
      yield* f.put(f.path.join(f.home, ".claude", "skills", "alpha", "SKILL.md"), "updated alpha");
      const report = yield* f.service.copyPersonal({ dryRun: false });
      assert.deepStrictEqual(
        report.skipped.filter((entry) => entry.reason === "invalid"),
        [
          { family: "claude", path: "settings.json", reason: "invalid" },
          { family: "codex", path: "config.toml", reason: "invalid" },
        ],
      );
      assert.strictEqual(
        yield* f.fs.readFileString(f.path.join(f.claudeTarget, "skills/alpha/SKILL.md")),
        "updated alpha",
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("copyPersonal still needs a usable Zavod route", () =>
    Effect.gen(function* () {
      const f = yield* serviceFixture();
      yield* f.service.connect();
      yield* f.fs.remove(f.path.join(f.home, ".zavod", "bin"), { recursive: true });
      const error = yield* f.service.copyPersonal({ dryRun: true }).pipe(Effect.flip);
      assert.isTrue(isCopyError(error) && error.stage === "state");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("copyPersonal refuses secret provider environment overrides", () =>
    Effect.gen(function* () {
      const f = yield* serviceFixture();
      yield* f.service.connect();
      yield* f.settings.updateProviderInstance({
        operation: "upsert",
        instanceId: ProviderInstanceId.make("claudeAgent"),
        instance: {
          driver: ProviderDriverKind.make("claudeAgent"),
          environment: [{ name: "CLAUDE_CONFIG_DIR", value: "hidden", sensitive: true }],
        },
      });
      const error = yield* f.service.copyPersonal({ dryRun: true }).pipe(Effect.flip);
      assert.isTrue(isCopyError(error) && error.stage === "state");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("only a family whose instance is created gets the first copy", () =>
    Effect.gen(function* () {
      const f = yield* serviceFixture();
      yield* f.settings.updateProviderInstance({
        operation: "create",
        instanceId: ProviderInstanceId.make("zavod-claude"),
        instance: {
          driver: ProviderDriverKind.make("claudeAgent"),
          displayName: "Claude (Zavod)",
          enabled: true,
          config: { homePath: f.claudeTarget },
        },
      });
      const connected = yield* f.service.connect();
      assert.strictEqual(connected.personalCopy, "copied");
      assert.isFalse(yield* f.fs.exists(f.path.join(f.claudeTarget, "CLAUDE.md")));
      assert.strictEqual(
        yield* f.fs.readFileString(f.path.join(f.codexTarget, "AGENTS.md")),
        "codex notes",
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});

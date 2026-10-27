import { assert, describe, it } from "@effect/vitest";

import { importProviderSettings } from "./importProviderSettings.ts";

const resolveExecutable = (command: string) =>
  command === "kimi" ? "C:\\Tools\\kimi.exe" : command;

const sourceSettings = () => ({
  continueThreadsAfterServerUpdate: true,
  providers: { grok: { enabled: false } },
  providerInstances: {
    antigravity: {
      driver: "antigravity",
      enabled: true,
      config: { authMethod: "oauth-personal", binaryPath: "agy.exe", customModels: [] },
    },
    grok: { driver: "grok", enabled: true, config: { binaryPath: "grok", customModels: [] } },
    museCode: {
      driver: "museCode",
      enabled: true,
      config: { binaryPath: "muse", homePath: "", customModels: [] },
    },
    pi: {
      driver: "pi",
      accentColor: "#3de469",
      enabled: true,
      config: { binaryPath: "pi", baseUrl: "http://127.0.0.1:8081/v1", customModels: [] },
    },
    claudeAgent: {
      driver: "claudeAgent",
      enabled: true,
      config: { binaryPath: "claude", homePath: "C:\\fork\\claude-home", customModels: [] },
    },
    opencode: { driver: "opencode", enabled: true, config: { binaryPath: "opencode" } },
    kimi: { driver: "kimi", enabled: true, config: { binaryPath: "kimi", customModels: [] } },
  },
});

const targetSettings = () => ({
  projectSettingsFolded: true,
  providerInstances: {
    // An instance the user created in V2 under an id the source does not use.
    "claudeAgent-work": { driver: "claudeAgent", enabled: true, config: { homePath: "D:\\work" } },
  },
});

describe("importProviderSettings", () => {
  it("maps the fork's driver kinds onto V2 drivers", () => {
    const { settings, report, changed } = importProviderSettings({
      source: sourceSettings(),
      target: targetSettings(),
      resolveExecutable,
    });

    assert.isTrue(changed);
    assert.deepStrictEqual(report.imported, [
      "antigravity",
      "grok",
      "museCode",
      "pi",
      "claudeAgent",
      "opencode",
      "kimi",
    ]);
    assert.deepStrictEqual(report.skipped, []);
    assert.deepStrictEqual(report.unrecognizedDrivers, []);

    const instances = settings.providerInstances as Record<string, Record<string, unknown>>;
    assert.strictEqual(instances.museCode?.driver, "muse");
    assert.deepStrictEqual(instances.museCode?.config, {
      binaryPath: "muse",
      customModels: [],
    });
    assert.strictEqual(instances.kimi?.driver, "acpRegistry");
    assert.deepStrictEqual(instances.kimi?.config, {
      source: "local",
      agentId: "kimi",
      commandPath: "C:\\Tools\\kimi.exe",
      commandArgs: ["acp"],
      customModels: [],
    });
    assert.deepStrictEqual(instances.claudeAgent?.config, {
      binaryPath: "claude",
      homePath: "C:\\fork\\claude-home",
      customModels: [],
    });
    assert.strictEqual(instances.pi?.accentColor, "#3de469");
    assert.deepStrictEqual(instances["claudeAgent-work"], {
      driver: "claudeAgent",
      enabled: true,
      config: { homePath: "D:\\work" },
    });
    // Target-only settings survive the merge.
    assert.isTrue(settings.projectSettingsFolded);
  });

  it("is idempotent across repeated runs", () => {
    const first = importProviderSettings({
      source: sourceSettings(),
      target: targetSettings(),
      resolveExecutable,
    });
    const second = importProviderSettings({
      source: sourceSettings(),
      target: first.settings,
      resolveExecutable,
    });
    const overwrite = importProviderSettings({
      source: sourceSettings(),
      target: first.settings,
      overwrite: true,
      resolveExecutable,
    });

    assert.isFalse(second.changed);
    assert.deepStrictEqual(second.settings, first.settings);
    assert.deepStrictEqual(second.report.imported, []);
    assert.deepStrictEqual(second.report.retained, [
      "antigravity",
      "grok",
      "museCode",
      "pi",
      "claudeAgent",
      "opencode",
      "kimi",
    ]);
    assert.isFalse(overwrite.changed);
    assert.deepStrictEqual(overwrite.report.updated, []);
  });

  it("keeps target instances unless overwrite is requested", () => {
    const target = {
      providerInstances: {
        claudeAgent: {
          driver: "claudeAgent",
          enabled: true,
          config: { binaryPath: "claude", homePath: "D:\\v2-home" },
        },
      },
    };
    const kept = importProviderSettings({
      source: sourceSettings(),
      target,
      resolveExecutable,
    });
    assert.deepStrictEqual(kept.report.retained, ["claudeAgent"]);
    assert.deepStrictEqual(
      (kept.settings.providerInstances as Record<string, Record<string, unknown>>).claudeAgent
        ?.config,
      { binaryPath: "claude", homePath: "D:\\v2-home" },
    );

    const replaced = importProviderSettings({
      source: sourceSettings(),
      target,
      overwrite: true,
      resolveExecutable,
    });
    assert.deepStrictEqual(replaced.report.updated, ["claudeAgent"]);
    assert.deepStrictEqual(
      (replaced.settings.providerInstances as Record<string, Record<string, unknown>>).claudeAgent
        ?.config,
      { binaryPath: "claude", homePath: "C:\\fork\\claude-home", customModels: [] },
    );
  });

  it("finishes a half-migrated target in place and then stays unchanged", () => {
    const source = sourceSettings();
    const first = importProviderSettings({ source, target: source, resolveExecutable });
    assert.isTrue(first.changed);
    const instances = first.settings.providerInstances as Record<string, Record<string, unknown>>;
    assert.strictEqual(instances.kimi?.driver, "acpRegistry");
    assert.strictEqual(instances.museCode?.driver, "muse");

    const second = importProviderSettings({
      source: first.settings,
      target: first.settings,
      resolveExecutable,
    });
    assert.isFalse(second.changed);
    assert.deepStrictEqual(second.report.updated, []);
  });

  it("folds an in-config disable and reports malformed entries", () => {
    const { settings, report } = importProviderSettings({
      source: {
        providerInstances: {
          opencode: { driver: "opencode", config: { binaryPath: "opencode", enabled: false } },
          broken: null,
          "bad id": { driver: "grok" },
          odd: { driver: "not-a-v2-driver", config: {} },
        },
      },
      target: {},
      resolveExecutable,
    });

    const instances = settings.providerInstances as Record<string, Record<string, unknown>>;
    assert.isFalse(instances.opencode?.enabled);
    assert.deepStrictEqual(instances.opencode?.config, { binaryPath: "opencode" });
    assert.deepStrictEqual(
      report.skipped.map((item) => item.instanceId),
      ["broken", "bad id"],
    );
    assert.deepStrictEqual(report.unrecognizedDrivers, ["not-a-v2-driver"]);
    assert.strictEqual(instances.odd?.driver, "not-a-v2-driver");
  });
});

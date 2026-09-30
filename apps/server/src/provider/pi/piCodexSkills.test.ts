// @effect-diagnostics nodeBuiltinImport:off - These tests use disposable Codex homes to verify active skill root resolution.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, it } from "vite-plus/test";

import { parsePiCodexEnabledPlugins, resolveCodexPersonalResources } from "./piCodexSkills.ts";

const writeSkill = async (root: string, name: string, description = name): Promise<string> => {
  const directory = NodePath.join(root, name);
  await NodeFSP.mkdir(directory, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nbody`,
  );
  return directory;
};

const writePlugin = async (
  versionDirectory: string,
  manifestDirectory: string,
  pluginName: string,
  skills: string,
): Promise<void> => {
  await NodeFSP.mkdir(versionDirectory, { recursive: true });
  await NodeFSP.mkdir(NodePath.join(manifestDirectory, ".codex-plugin"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(manifestDirectory, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: pluginName, version: "1.0.0", skills }),
  );
};

describe("Pi Codex personal resource resolution", () => {
  it("mirrors the host .agents root, user/system skills, and enabled plugin skills", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-pi-codex-skills-"));
    try {
      const hostHome = NodePath.join(root, "host");
      const codexHome = NodePath.join(root, "codex-home");
      const agentsSkills = NodePath.join(hostHome, ".agents", "skills");
      const userSkills = NodePath.join(codexHome, "skills");
      const systemSkills = NodePath.join(userSkills, ".system");
      await NodeFSP.mkdir(codexHome, { recursive: true });
      await writeSkill(agentsSkills, "agents-skill");
      await writeSkill(userSkills, "user-skill");
      await writeSkill(systemSkills, "system-skill");
      await NodeFSP.writeFile(NodePath.join(codexHome, "AGENTS.md"), "CODEX_AGENTS_MARKER");

      const unityVersion = NodePath.join(
        codexHome,
        "plugins",
        "cache",
        "unity-agent-plugin",
        "unity",
        "0.1.6-beta",
      );
      await writePlugin(unityVersion, unityVersion, "unity", "./skills/");
      await writeSkill(NodePath.join(unityVersion, "skills"), "unity-skill");

      // Caveman keeps its manifest nested under a `plugins/<name>` directory and
      // also ships a decoy root-level `skills/` that must not be selected.
      const cavemanVersion = NodePath.join(
        codexHome,
        "plugins",
        "cache",
        "caveman",
        "caveman",
        "2.7.0",
      );
      const cavemanManifestDir = NodePath.join(cavemanVersion, "plugins", "caveman");
      await writePlugin(cavemanManifestDir, cavemanManifestDir, "caveman", "./skills/");
      await writeSkill(NodePath.join(cavemanManifestDir, "skills"), "caveman-skill");
      await writeSkill(NodePath.join(cavemanVersion, "skills"), "caveman-decoy");

      // Disabled and merely-cached plugins must never contribute skills.
      const disabledVersion = NodePath.join(
        codexHome,
        "plugins",
        "cache",
        "openai-curated",
        "off",
        "1.0.0",
      );
      await writePlugin(disabledVersion, disabledVersion, "off", "./skills/");
      await writeSkill(NodePath.join(disabledVersion, "skills"), "off-skill");
      const cachedVersion = NodePath.join(
        codexHome,
        "plugins",
        "cache",
        "openai-curated-remote",
        "figma",
        "13.0.0",
      );
      await writePlugin(cachedVersion, cachedVersion, "figma", "./skills/");
      await writeSkill(NodePath.join(cachedVersion, "skills"), "figma-skill");

      await NodeFSP.writeFile(
        NodePath.join(codexHome, "config.toml"),
        [
          "[marketplaces.unity-agent-plugin]",
          'source = "https://example.invalid/unity.git"',
          "",
          '[plugins."unity@unity-agent-plugin"]',
          "enabled = true",
          "",
          '[plugins."caveman@caveman"]',
          "enabled = true",
          "",
          '[plugins."off@openai-curated"]',
          "enabled = false",
          "",
        ].join("\n"),
      );

      const resolved = await resolveCodexPersonalResources({ codexHome, hostHome });
      NodeAssert.equal(resolved.partial, false);
      NodeAssert.equal(resolved.instructionsPath, NodePath.join(codexHome, "AGENTS.md"));
      NodeAssert.deepEqual(resolved.warnings, []);
      NodeAssert.deepEqual(
        resolved.skillRoots.map((entry) => [entry.provenance, entry.path]),
        [
          ["agents", agentsSkills],
          ["codex-user", userSkills],
          ["codex-system", systemSkills],
          ["plugin", NodePath.join(unityVersion, "skills")],
          ["plugin", NodePath.join(cavemanManifestDir, "skills")],
        ],
      );
      const pluginPaths = new Set(resolved.skillRoots.map((entry) => entry.path));
      NodeAssert.ok(!pluginPaths.has(NodePath.join(disabledVersion, "skills")));
      NodeAssert.ok(!pluginPaths.has(NodePath.join(cachedVersion, "skills")));
      NodeAssert.ok(!pluginPaths.has(NodePath.join(cavemanVersion, "skills")));
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("reports a partial subset when a plugin has multiple cached versions", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-pi-codex-multi-"));
    try {
      const hostHome = NodePath.join(root, "host");
      const codexHome = NodePath.join(root, "codex-home");
      const pluginRoot = NodePath.join(codexHome, "plugins", "cache", "mkt", "solo");
      const older = NodePath.join(pluginRoot, "0.1.0");
      const newer = NodePath.join(pluginRoot, "0.2.0");
      await writePlugin(older, older, "solo", "./skills/");
      await writeSkill(NodePath.join(older, "skills"), "old-skill");
      await writePlugin(newer, newer, "solo", "./skills/");
      await writeSkill(NodePath.join(newer, "skills"), "new-skill");
      await NodeFSP.utimes(older, 1, 1);
      await NodeFSP.writeFile(
        NodePath.join(codexHome, "config.toml"),
        '[plugins."solo@mkt"]\nenabled = true\n',
      );

      const resolved = await resolveCodexPersonalResources({ codexHome, hostHome });
      NodeAssert.equal(resolved.partial, true);
      NodeAssert.deepEqual(
        resolved.skillRoots.map((entry) => entry.path),
        [NodePath.join(newer, "skills")],
      );
      NodeAssert.ok(
        resolved.warnings.some((warning) => warning.includes("multiple cached versions")),
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps base roots but reports partial coverage when config.toml is absent", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-pi-codex-noconfig-"));
    try {
      const hostHome = NodePath.join(root, "host");
      const codexHome = NodePath.join(root, "codex-home");
      await writeSkill(NodePath.join(codexHome, "skills"), "user-skill");
      const resolved = await resolveCodexPersonalResources({ codexHome, hostHome });
      NodeAssert.equal(resolved.partial, true);
      NodeAssert.deepEqual(
        resolved.skillRoots.map((entry) => entry.provenance),
        ["codex-user"],
      );
      NodeAssert.ok(resolved.warnings.some((warning) => warning.includes("partial subset")));
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("requires an explicit enabled = true and skips plugins with absent or malformed state", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-pi-codex-enabled-"));
    try {
      const hostHome = NodePath.join(root, "host");
      const codexHome = NodePath.join(root, "codex-home");
      const pluginRoot = NodePath.join(codexHome, "plugins", "cache", "mkt", "maybe");
      const version = NodePath.join(pluginRoot, "1.0.0");
      await writePlugin(version, version, "maybe", "./skills/");
      await writeSkill(NodePath.join(version, "skills"), "maybe-skill");
      await NodeFSP.writeFile(
        NodePath.join(codexHome, "config.toml"),
        [
          '[plugins."maybe@mkt"]',
          "enabled = maybe",
          '[plugins."absent@mkt"]',
          'description = "no enabled key"',
        ].join("\n"),
      );

      const resolved = await resolveCodexPersonalResources({ codexHome, hostHome });
      NodeAssert.equal(resolved.partial, true);
      NodeAssert.deepEqual(resolved.skillRoots, []);
      NodeAssert.equal(
        resolved.warnings.filter((warning) => warning.includes("no explicit enabled = true"))
          .length,
        2,
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects plugin names, marketplaces, and manifest skills paths that escape the cache root", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-pi-codex-escape-"));
    try {
      const hostHome = NodePath.join(root, "host");
      const codexHome = NodePath.join(root, "codex-home");
      const outside = NodePath.join(root, "outside");
      await writeSkill(outside, "outside-skill");
      const escapingVersion = NodePath.join(
        codexHome,
        "plugins",
        "cache",
        "mkt",
        "escape",
        "1.0.0",
      );
      await writePlugin(escapingVersion, escapingVersion, "escape", "../../../../outside");
      await NodeFSP.writeFile(
        NodePath.join(codexHome, "config.toml"),
        [
          '[plugins."escape@mkt"]',
          "enabled = true",
          '[plugins."..@.."]',
          "enabled = true",
          '[plugins."a/../b@mkt"]',
          "enabled = true",
        ].join("\n"),
      );

      const resolved = await resolveCodexPersonalResources({ codexHome, hostHome });
      NodeAssert.equal(resolved.partial, true);
      NodeAssert.deepEqual(resolved.skillRoots, []);
      NodeAssert.ok(
        resolved.warnings.some((warning) => warning.includes("unsafe name or marketplace")),
      );
      NodeAssert.ok(
        resolved.warnings.some((warning) => warning.includes("no valid skills directory")),
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a junctioned skills root that points outside the version directory", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-pi-codex-junction-"));
    try {
      const hostHome = NodePath.join(root, "host");
      const codexHome = NodePath.join(root, "codex-home");
      const outside = NodePath.join(root, "outside-skills");
      await writeSkill(outside, "outside-skill");
      const version = NodePath.join(codexHome, "plugins", "cache", "mkt", "linked", "1.0.0");
      await writePlugin(version, version, "linked", "./linked-skills");
      await NodeFSP.symlink(outside, NodePath.join(version, "linked-skills"), "junction");
      await NodeFSP.writeFile(
        NodePath.join(codexHome, "config.toml"),
        '[plugins."linked@mkt"]\nenabled = true\n',
      );

      const resolved = await resolveCodexPersonalResources({ codexHome, hostHome });
      NodeAssert.equal(resolved.partial, true);
      NodeAssert.deepEqual(resolved.skillRoots, []);
      NodeAssert.ok(
        resolved.warnings.some((warning) => warning.includes("no valid skills directory")),
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("includes every valid declared skills root and flags skipped ones", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-pi-codex-multiroot-"));
    try {
      const hostHome = NodePath.join(root, "host");
      const codexHome = NodePath.join(root, "codex-home");
      const version = NodePath.join(codexHome, "plugins", "cache", "mkt", "multi", "1.0.0");
      await NodeFSP.mkdir(version, { recursive: true });
      await NodeFSP.mkdir(NodePath.join(version, ".codex-plugin"), { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(version, ".codex-plugin", "plugin.json"),
        JSON.stringify({ name: "multi", skills: ["./skills-a", "./missing-b", "./skills-c"] }),
      );
      await writeSkill(NodePath.join(version, "skills-a"), "skill-a");
      await writeSkill(NodePath.join(version, "skills-c"), "skill-c");
      await NodeFSP.writeFile(
        NodePath.join(codexHome, "config.toml"),
        '[plugins."multi@mkt"]\nenabled = true\n',
      );

      const resolved = await resolveCodexPersonalResources({ codexHome, hostHome });
      NodeAssert.equal(resolved.partial, true);
      NodeAssert.deepEqual(
        resolved.skillRoots.map((entry) => entry.path),
        [NodePath.join(version, "skills-a"), NodePath.join(version, "skills-c")],
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a plugin version reached through a junctioned marketplace directory", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "ft3-pi-codex-mkt-junction-"),
    );
    try {
      const hostHome = NodePath.join(root, "host");
      const codexHome = NodePath.join(root, "codex-home");
      const outsideMarketplace = NodePath.join(root, "outside-mkt", "sneaky");
      await writePlugin(
        NodePath.join(outsideMarketplace, "1.0.0"),
        NodePath.join(outsideMarketplace, "1.0.0"),
        "sneaky",
        "./skills/",
      );
      await writeSkill(NodePath.join(outsideMarketplace, "1.0.0", "skills"), "sneaky-skill");
      const cacheRoot = NodePath.join(codexHome, "plugins", "cache");
      await NodeFSP.mkdir(cacheRoot, { recursive: true });
      await NodeFSP.symlink(
        NodePath.join(root, "outside-mkt"),
        NodePath.join(cacheRoot, "mkt"),
        "junction",
      );
      await NodeFSP.writeFile(
        NodePath.join(codexHome, "config.toml"),
        '[plugins."sneaky@mkt"]\nenabled = true\n',
      );

      const resolved = await resolveCodexPersonalResources({ codexHome, hostHome });
      NodeAssert.equal(resolved.partial, true);
      NodeAssert.deepEqual(resolved.skillRoots, []);
      NodeAssert.ok(resolved.warnings.some((warning) => warning.includes("symlink or junction")));
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("classifies plugin sections without guessing unparseable ones", () => {
    const parsed = parsePiCodexEnabledPlugins(
      [
        '[plugins."ok@mkt"]',
        "enabled = true",
        '[plugins."off@mkt"]',
        "enabled = false",
        '[plugins."odd@mkt"]',
        "enabled = maybe",
        '[plugins."broken"]',
        "enabled = true",
        "[other]",
        "enabled = true",
      ].join("\n"),
    );
    NodeAssert.deepEqual(parsed.plugins, [
      { name: "ok", marketplace: "mkt", enabled: true },
      { name: "off", marketplace: "mkt", enabled: false },
      { name: "odd", marketplace: "mkt", enabled: undefined },
    ]);
    NodeAssert.equal(parsed.warnings.length, 1);
    NodeAssert.match(parsed.warnings[0]!, /malformed Codex plugin section/);
  });
});

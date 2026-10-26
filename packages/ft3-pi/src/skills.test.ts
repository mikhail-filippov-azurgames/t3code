// @effect-diagnostics nodeBuiltinImport:off - The import writes a disposable agent dir fixture.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  importCodexResourcesIntoAgentDir,
  parsePiCodexEnabledPlugins,
  resolveCodexPersonalResources,
} from "./skills.ts";

async function writeFile(filePath: string, contents: string): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
  await NodeFSP.writeFile(filePath, contents);
}

async function findSkillFiles(root: string): Promise<ReadonlyArray<string>> {
  const found: Array<string> = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        found.push(absolute);
      }
    }
  };
  await walk(root);
  return found.sort();
}

it("imports Codex skills and AGENTS.md into the managed agent dir", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-pi-skills-"));
  try {
    const codexHome = NodePath.join(root, "codex");
    const hostHome = NodePath.join(root, "host");
    const agentDir = NodePath.join(root, "agent");
    await writeFile(NodePath.join(codexHome, "AGENTS.md"), "PERSONAL_CODEX_AGENTS\n");
    await writeFile(
      NodePath.join(codexHome, "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review changes.\n---\nReview body.\n",
    );
    await writeFile(
      NodePath.join(codexHome, "skills", "review", "references", "guide.md"),
      "guide\n",
    );
    await writeFile(
      NodePath.join(hostHome, ".agents", "skills", "global", "SKILL.md"),
      "---\nname: global\ndescription: Global skill.\n---\nGlobal body.\n",
    );
    await writeFile(
      NodePath.join(codexHome, "config.toml"),
      '[plugins."demo@market"]\nenabled = true\n',
    );
    const version = NodePath.join(codexHome, "plugins", "cache", "market", "demo", "1.0.0");
    await writeFile(
      NodePath.join(version, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "demo", skills: "./skills" }),
    );
    await writeFile(
      NodePath.join(version, "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: Deploy the app.\n---\nDeploy body.\n",
    );

    await importCodexResourcesIntoAgentDir({ agentDir, codexHome, hostHome });

    const instructions = await NodeFSP.readFile(NodePath.join(agentDir, "AGENTS.md"), "utf8");
    assert.equal(instructions, "PERSONAL_CODEX_AGENTS\n");
    const skillFiles = await findSkillFiles(NodePath.join(agentDir, "skills"));
    assert.equal(skillFiles.length, 3);
    const bodies = await Promise.all(skillFiles.map((file) => NodeFSP.readFile(file, "utf8")));
    assert.isTrue(bodies.some((body) => body.includes("Review body.")));
    assert.isTrue(bodies.some((body) => body.includes("Global body.")));
    assert.isTrue(bodies.some((body) => body.includes("Deploy body.")));
    const reviewGuide = skillFiles.find((file) => file.includes("review"));
    assert.isDefined(reviewGuide);
    assert.isTrue(
      await NodeFSP.stat(NodePath.join(NodePath.dirname(reviewGuide!), "references", "guide.md"))
        .then((stats) => stats.isFile())
        .catch(() => false),
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("replaces a stale managed skill set and removes absent AGENTS.md", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-pi-skills-"));
  try {
    const codexHome = NodePath.join(root, "codex");
    const hostHome = NodePath.join(root, "host");
    const agentDir = NodePath.join(root, "agent");
    await NodeFSP.mkdir(codexHome, { recursive: true });
    await NodeFSP.mkdir(hostHome, { recursive: true });
    await writeFile(NodePath.join(agentDir, "skills", "stale", "SKILL.md"), "stale\n");
    await writeFile(NodePath.join(agentDir, "AGENTS.md"), "stale\n");

    await importCodexResourcesIntoAgentDir({ agentDir, codexHome, hostHome });

    assert.isFalse(
      await NodeFSP.stat(NodePath.join(agentDir, "skills"))
        .then(() => true)
        .catch(() => false),
    );
    assert.isFalse(
      await NodeFSP.stat(NodePath.join(agentDir, "AGENTS.md"))
        .then(() => true)
        .catch(() => false),
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("parses only explicitly enabled plugin sections", () => {
  const parsed = parsePiCodexEnabledPlugins(
    '[plugins."on@market"]\nenabled = true\n[plugins."off@market"]\nenabled = false\n',
  );
  assert.deepEqual(
    parsed.plugins.map((plugin) => [plugin.name, plugin.enabled]),
    [
      ["on", true],
      ["off", false],
    ],
  );
  assert.deepEqual(parsed.warnings, []);
});

it("reports a partial subset when Codex has no config", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-pi-skills-"));
  try {
    const resolved = await resolveCodexPersonalResources({
      codexHome: NodePath.join(root, "codex"),
      hostHome: NodePath.join(root, "host"),
    });
    assert.isTrue(resolved.partial);
    assert.deepEqual(resolved.skillRoots, []);
    assert.isTrue(resolved.warnings.some((warning) => warning.includes("config.toml")));
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

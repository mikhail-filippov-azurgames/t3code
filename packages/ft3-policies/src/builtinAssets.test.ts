// @effect-diagnostics nodeBuiltinImport:off - assets/ is the readable source the map must match.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";

import { BUILTIN_ASSET_CONTENTS } from "./builtinAssets.ts";
import { parseLeadSkillsDocumentSet } from "./leadSkills.ts";
import { parseRolesDocumentSet } from "./roleDocuments.ts";
import { findAppliedRole } from "./roleResolver.ts";

const packageRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));

const assetFiles = (relativeDirectory: string): ReadonlyArray<string> => {
  const files: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      const relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(NodePath.join(directory, entry.name), relative);
      else files.push(relative);
    }
  };
  walk(NodePath.join(packageRoot, relativeDirectory), relativeDirectory);
  return files.sort();
};

describe("embedded built-in assets", () => {
  it("embed every file of assets/ with identical content", () => {
    const onDisk = assetFiles("assets");
    expect(Object.keys(BUILTIN_ASSET_CONTENTS).sort()).toEqual(onDisk);
    for (const relative of onDisk) {
      expect(BUILTIN_ASSET_CONTENTS[relative]).toBe(
        NodeFS.readFileSync(NodePath.join(packageRoot, relative), "utf8"),
      );
    }
  });

  it("embeds a configured role profile with usable role instructions", () => {
    const prefix = "assets/roles/";
    const files = new Map(
      Object.entries(BUILTIN_ASSET_CONTENTS)
        .filter(([path]) => path.startsWith(prefix) && path.endsWith(".md"))
        .map(([path, content]) => [path.slice(prefix.length), content]),
    );
    const profile = parseRolesDocumentSet({
      manifest: BUILTIN_ASSET_CONTENTS[`${prefix}roles.json`] ?? "",
      files,
      features: { board: true, planning: true },
    });
    expect(profile.issues).toEqual([]);
    expect(profile.configured).toBe(true);
    expect(profile.revision).toBe(1);
    for (const entry of profile.roles) {
      const role = findAppliedRole(profile, entry.id);
      expect(role?.instruction).toContain("Responsibilities");
      expect(role?.instruction).toContain("Allowed addressees");
      expect(profile.files.get(entry.file)?.configured).toBe(true);
    }
    const lead = findAppliedRole(profile, "lead")?.instruction;
    expect(lead).toContain("Claude Opus 5.5 through Zavod");
    expect(lead).toContain("specialization `claude`");
    expect(lead).toContain("specialization `codex`");
    for (const specialization of ["review-claude", "review-codex"]) {
      expect(findAppliedRole(profile, specialization)?.roleId).toBe("review-common");
    }
  });

  it("embeds the configured lead skills required by board and planning", () => {
    const prefix = "assets/lead-skills/";
    const files = new Map(
      Object.entries(BUILTIN_ASSET_CONTENTS)
        .filter(([path]) => path.startsWith(prefix) && path.endsWith("/SKILL.md"))
        .map(([path, content]) => [path.slice(prefix.length), content]),
    );
    const profile = parseLeadSkillsDocumentSet({
      manifest: BUILTIN_ASSET_CONTENTS[`${prefix}lead-skills.json`] ?? "",
      files,
      features: { board: true, planning: true },
    });
    expect(profile.issues).toEqual([]);
    expect(profile.configured).toBe(true);
    expect(profile.requirements.leadSkills).toBe(true);
    expect(profile.requirements.planOrchestratorSkill).toBe(true);
    expect(files.get("t3-orchestrator/SKILL.md")).toContain("Every child gets an explicit role");
    expect(files.get("board-orchestrator/SKILL.md")).toContain(
      "Cards are created before executor threads start",
    );
    expect(files.get("plan-orchestrator/SKILL.md")).toContain("Only the human accepts the plan");
  });
});

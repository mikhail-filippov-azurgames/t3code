// @effect-diagnostics nodeBuiltinImport:off - templates are package resources read from disk once.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";

import { parseLeadSkillsDocumentSet } from "./leadSkills.ts";
import { parseRolesDocumentSet } from "./roleDocuments.ts";

const packageRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));

function readText(relativePath: string): string {
  return NodeFS.readFileSync(NodePath.join(packageRoot, relativePath), "utf8");
}

function readMarkdownFiles(relativeDirectory: string): ReadonlyMap<string, string> {
  const directory = NodePath.join(packageRoot, relativeDirectory);
  const files = new Map<string, string>();
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    files.set(entry.name, NodeFS.readFileSync(NodePath.join(directory, entry.name), "utf8"));
  }
  return files;
}

function readSkillFiles(relativeDirectory: string, skillIds: readonly string[]) {
  const files = new Map<string, string>();
  for (const skillId of skillIds) {
    files.set(`${skillId}/SKILL.md`, readText(`${relativeDirectory}/${skillId}/SKILL.md`));
  }
  return files;
}

const errorIssues = (issues: readonly { severity: string }[]) =>
  issues.filter((issue) => issue.severity === "error");

describe("bundled role templates", () => {
  const manifest = readText("assets/roles/roles.json");
  const files = readMarkdownFiles("assets/roles");

  it("parse clean and only report the template state", () => {
    const parsed = parseRolesDocumentSet({ manifest, files });

    expect(errorIssues(parsed.issues)).toEqual([]);
    expect(parsed.valid).toBe(true);
    expect(parsed.configured).toBe(false);
    expect(parsed.revision).toBe(0);
    expect(parsed.issues.map((issue) => issue.code)).toEqual(["document_unconfigured"]);
    expect(parsed.requirements).toEqual({ rolesManifest: false });
  });

  it("declare the nine design roles with their delegated role ids", () => {
    const parsed = parseRolesDocumentSet({ manifest, files });

    expect(parsed.roles.map((role) => role.id)).toEqual([
      "lead",
      "planner",
      "architect",
      "design",
      "implementation",
      "test",
      "research",
      "general",
      "review",
    ]);
    expect(parsed.roles.map((role) => role.roleId)).toEqual([
      "lead",
      "planner",
      "architect",
      "architect-product",
      "implementation",
      "test",
      "research",
      "general",
      "review-common",
    ]);
    expect(parsed.roles.find((role) => role.id === "design")?.upstreamRole).toBe("design");
    expect(parsed.roles.find((role) => role.id === "architect")?.upstreamRole).toBe("architecture");
    expect(parsed.roles.find((role) => role.id === "planner")?.upstreamRole).toBeNull();
  });

  it("ship a Markdown file for every declared role", () => {
    const parsed = parseRolesDocumentSet({ manifest, files });

    for (const role of parsed.roles) {
      expect(parsed.files.has(role.file)).toBe(true);
    }
    expect(parsed.files.size).toBe(parsed.roles.length);
  });

  it("have no documentsWrite field and no personal paths or document ids", () => {
    expect(manifest).not.toContain("documentsWrite");
    for (const [file, content] of files) {
      expect(content).not.toMatch(/\b[A-Za-z]:[\\/]/);
      expect(content).not.toMatch(/oc:\/\/doc\//i);
      expect(content).not.toContain(".opencontext");
      expect(file.endsWith(".md")).toBe(true);
    }
  });

  it("carry the allowed addressees matrix and the extra section of each role", () => {
    const parsed = parseRolesDocumentSet({ manifest, files });
    const body = (roleId: string) => {
      const role = parsed.roles.find((entry) => entry.roleId === roleId);
      return files.get(role?.file ?? "") ?? "";
    };

    expect(body("lead")).toContain("Allowed addressees");
    expect(body("lead")).toContain("the human, the planner, architects and executors");
    expect(body("lead")).toContain("Needs-plan criteria");
    expect(body("planner")).toContain("Plan file");
    expect(body("planner")).toContain("Edit the plan only with docs_write");
    expect(body("architect")).toContain("Plan review");
    expect(body("architect")).toContain("Do not edit the plan");
    expect(body("architect-product")).toContain("Plan review");
    for (const roleId of ["implementation", "test", "research", "general", "review-common"]) {
      expect(body(roleId)).toContain("Prototype work stays in its worktree and is never merged.");
    }
  });

  it("do not claim a required role before the template is configured", () => {
    const parsed = parseRolesDocumentSet({
      manifest,
      files,
      features: { board: true, planning: true },
    });

    expect(errorIssues(parsed.issues)).toEqual([]);
    expect(parsed.requirements.leadRole).toBe(false);
    expect(parsed.requirements.plannerRole).toBe(false);
    expect(parsed.requirements.architectRole).toBe(false);
  });
});

describe("bundled lead-skill templates", () => {
  const manifest = readText("assets/lead-skills/lead-skills.json");
  const files = readSkillFiles("assets/lead-skills", [
    "t3-orchestrator",
    "board-orchestrator",
    "plan-orchestrator",
  ]);

  it("parse clean and only report the template state", () => {
    const parsed = parseLeadSkillsDocumentSet({ manifest, files });

    expect(errorIssues(parsed.issues)).toEqual([]);
    expect(parsed.valid).toBe(true);
    expect(parsed.configured).toBe(false);
    expect(parsed.issues.map((issue) => issue.code)).toEqual(["document_unconfigured"]);
    expect(parsed.requirements).toEqual({ leadSkills: false });
  });

  it("declare the three lead skills and their files", () => {
    const parsed = parseLeadSkillsDocumentSet({ manifest, files });

    expect(parsed.skills.map((skill) => skill.id)).toEqual([
      "t3-orchestrator",
      "board-orchestrator",
      "plan-orchestrator",
    ]);
    expect([...parsed.files.keys()].sort()).toEqual([
      "board-orchestrator/SKILL.md",
      "plan-orchestrator/SKILL.md",
      "t3-orchestrator/SKILL.md",
    ]);
    expect(manifest).not.toContain("create-orchestrator-architect");
  });

  it("have no personal paths or document ids", () => {
    for (const content of files.values()) {
      expect(content).not.toMatch(/\b[A-Za-z]:[\\/]/);
      expect(content).not.toMatch(/oc:\/\/doc\//i);
      expect(content).not.toContain(".opencontext");
    }
  });

  it("do not claim a required skill before the template is configured", () => {
    const parsed = parseLeadSkillsDocumentSet({
      manifest,
      files,
      features: { board: true, planning: true },
    });

    expect(errorIssues(parsed.issues)).toEqual([]);
    expect(parsed.requirements.leadSkills).toBe(false);
    expect(parsed.requirements.planOrchestratorSkill).toBe(false);
  });
});

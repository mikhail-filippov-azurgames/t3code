import { describe, expect, it } from "@effect/vitest";

import { parseLeadSkillFile, parseLeadSkillsDocumentSet } from "./leadSkills.ts";

interface SkillEntryInput {
  readonly id: string;
  readonly file: string;
}

function skillMarkdown(name: string, overrides: Partial<Record<string, string>> = {}): string {
  const fields = {
    name,
    description: "A short description.",
    ...overrides,
  };
  return [
    "---",
    ...Object.entries(fields)
      .filter(([, value]) => value !== "")
      .map(([key, value]) => `${key}: ${value}`),
    "---",
    "",
    "# Skill",
    "",
  ].join("\n");
}

function leadSkillsManifest(
  skills: readonly SkillEntryInput[],
  overrides: Readonly<Record<string, unknown>> = {},
): string {
  return JSON.stringify(
    {
      schema: "corvis-lead-skills-v1",
      revision: 1,
      configured: true,
      skills,
      ...overrides,
    },
    null,
    2,
  );
}

const baseEntries: readonly SkillEntryInput[] = [
  { id: "t3-orchestrator", file: "t3-orchestrator/SKILL.md" },
  { id: "board-orchestrator", file: "board-orchestrator/SKILL.md" },
  { id: "plan-orchestrator", file: "plan-orchestrator/SKILL.md" },
];

function baseFiles(): Map<string, string> {
  return new Map([
    ["t3-orchestrator/SKILL.md", skillMarkdown("t3-orchestrator")],
    ["board-orchestrator/SKILL.md", skillMarkdown("board-orchestrator")],
    ["plan-orchestrator/SKILL.md", skillMarkdown("plan-orchestrator")],
  ]);
}

describe("lead-skills.json manifest", () => {
  it("parses a configured manifest with the three lead skills", () => {
    const parsed = parseLeadSkillsDocumentSet({
      manifest: leadSkillsManifest(baseEntries),
      files: baseFiles(),
      features: { board: true, planning: true },
    });

    expect(parsed.valid).toBe(true);
    expect(parsed.configured).toBe(true);
    expect(parsed.revision).toBe(1);
    expect(parsed.issues).toEqual([]);
    expect(parsed.skills.map((skill) => skill.id)).toEqual([
      "t3-orchestrator",
      "board-orchestrator",
      "plan-orchestrator",
    ]);
    expect(parsed.requirements).toEqual({
      leadSkills: true,
      planOrchestratorSkill: true,
    });
  });

  it("reports a missing board skill with its expected path and a hint", () => {
    const manifest = leadSkillsManifest(
      baseEntries.filter((entry) => entry.id !== "board-orchestrator"),
    );
    const files = baseFiles();
    files.delete("board-orchestrator/SKILL.md");
    const parsed = parseLeadSkillsDocumentSet({
      manifest,
      files,
      features: { board: true },
    });

    expect(parsed.valid).toBe(false);
    const issue = parsed.issues.find((entry) => entry.code === "lead_skill_missing");
    expect(issue?.message).toBe(
      'Lead skill "board-orchestrator" is missing at "board-orchestrator/SKILL.md". Restore it or choose the lead-skills directory.',
    );
    expect(issue?.hint).toContain("board needs it");
    expect(parsed.requirements.leadSkills).toBe(false);
  });

  it("reports a declared skill whose file is absent", () => {
    const files = baseFiles();
    files.delete("t3-orchestrator/SKILL.md");
    const parsed = parseLeadSkillsDocumentSet({
      manifest: leadSkillsManifest(baseEntries),
      files,
    });

    const issue = parsed.issues.find((entry) => entry.code === "lead_skill_missing");
    expect(issue?.message).toBe(
      'Lead skill "t3-orchestrator" is missing at "t3-orchestrator/SKILL.md". Restore it or choose the lead-skills directory.',
    );
    expect(issue?.line).toBeGreaterThan(1);
    expect(parsed.files.size).toBe(2);
  });

  it("rejects a retired or unknown skill id", () => {
    const manifest = leadSkillsManifest([
      { id: "create-orchestrator-architect", file: "create-orchestrator-architect/SKILL.md" },
    ]);
    const parsed = parseLeadSkillsDocumentSet({
      manifest,
      files: new Map([
        ["create-orchestrator-architect/SKILL.md", skillMarkdown("create-orchestrator-architect")],
      ]),
    });

    const issue = parsed.issues.find((entry) => entry.code === "frontmatter_invalid");
    expect(issue?.message).toContain(
      "expected id: one of t3-orchestrator, board-orchestrator, plan-orchestrator",
    );
    expect(issue?.message).toContain('got "create-orchestrator-architect"');
    expect(parsed.skills).toEqual([]);
    expect(parsed.valid).toBe(false);
  });

  it("rejects a duplicate skill id", () => {
    const manifest = leadSkillsManifest([
      { id: "t3-orchestrator", file: "t3-orchestrator/SKILL.md" },
      { id: "t3-orchestrator", file: "second/SKILL.md" },
    ]);
    const parsed = parseLeadSkillsDocumentSet({
      manifest,
      files: new Map([
        ["t3-orchestrator/SKILL.md", skillMarkdown("t3-orchestrator")],
        ["second/SKILL.md", skillMarkdown("t3-orchestrator")],
      ]),
    });

    const issue = parsed.issues.find((entry) => entry.code === "frontmatter_invalid");
    expect(issue?.message).toContain("expected a unique lead skill id");
    expect(issue?.line).toBe(11);
    expect(parsed.valid).toBe(false);
  });

  it("marks a template manifest with document_unconfigured", () => {
    const parsed = parseLeadSkillsDocumentSet({
      manifest: leadSkillsManifest(baseEntries, { configured: false }),
      files: baseFiles(),
    });

    expect(parsed.valid).toBe(true);
    expect(parsed.configured).toBe(false);
    expect(parsed.issues.map((entry) => entry.code)).toEqual(["document_unconfigured"]);
    expect(parsed.requirements).toEqual({ leadSkills: false });
  });

  it("requires plan-orchestrator for planning", () => {
    const manifest = leadSkillsManifest(
      baseEntries.filter((entry) => entry.id !== "plan-orchestrator"),
    );
    const files = baseFiles();
    files.delete("plan-orchestrator/SKILL.md");
    const parsed = parseLeadSkillsDocumentSet({
      manifest,
      files,
      features: { planning: true },
    });

    const issue = parsed.issues.find((entry) => entry.code === "lead_skill_missing");
    expect(issue?.message).toContain('Lead skill "plan-orchestrator" is missing');
    expect(parsed.requirements.planOrchestratorSkill).toBe(false);
  });
});

describe("SKILL.md frontmatter", () => {
  it("accepts name and description and returns the body", () => {
    const parsed = parseLeadSkillFile(skillMarkdown("t3-orchestrator"), "t3-orchestrator/SKILL.md");

    expect(parsed.issues).toEqual([]);
    expect(parsed.file).toMatchObject({
      name: "t3-orchestrator",
      description: "A short description.",
    });
    expect(parsed.file?.body).toContain("# Skill");
  });

  it("requires the name from the manifest", () => {
    const manifest = leadSkillsManifest([baseEntries[0]!]);
    const parsed = parseLeadSkillsDocumentSet({
      manifest,
      files: new Map([["t3-orchestrator/SKILL.md", skillMarkdown("other-skill")]]),
    });

    const issue = parsed.issues.find((entry) => entry.code === "frontmatter_invalid");
    expect(issue?.message).toBe(
      'Document "leadSkills" line 2: expected name "t3-orchestrator" from lead-skills.json, got "other-skill".',
    );
    expect(issue?.text).toBe("name: other-skill");
    expect(parsed.files.size).toBe(0);
  });

  it("reports a missing description line", () => {
    const parsed = parseLeadSkillFile(
      skillMarkdown("t3-orchestrator", { description: "" }),
      "t3-orchestrator/SKILL.md",
    );

    const issue = parsed.issues.find((entry) => entry.code === "frontmatter_invalid");
    expect(issue?.message).toBe(
      'Document "leadSkills" line 1: expected description: a required field, got "no description field".',
    );
    expect(parsed.file).toBeNull();
  });

  it("requires a closed frontmatter block", () => {
    const parsed = parseLeadSkillFile("---\nname: t3-orchestrator\n", "t3-orchestrator/SKILL.md");

    const issue = parsed.issues.find((entry) => entry.code === "frontmatter_invalid");
    expect(issue?.message).toContain("expected a closing --- line for the frontmatter");
    expect(parsed.file).toBeNull();
  });
});

import { describe, expect, it } from "@effect/vitest";

import { parseRoleFile, parseRolesDocumentSet } from "./roleDocuments.ts";

interface RoleEntryInput {
  readonly id: string;
  readonly roleId: string;
  readonly file: string;
  readonly upstreamRole?: string;
}

function roleMarkdown(roleId: string, overrides: Partial<Record<string, string>> = {}): string {
  const fields = {
    schema: "corvis-role-v1",
    roleId,
    revision: "1",
    configured: "true",
    ...overrides,
  };
  return [
    "---",
    ...Object.entries(fields)
      .filter(([, value]) => value !== "")
      .map(([key, value]) => `${key}: ${value}`),
    "---",
    "",
    `# ${roleId}`,
    "",
    "Role body.",
    "",
  ].join("\n");
}

function rolesManifest(
  roles: readonly RoleEntryInput[],
  overrides: Readonly<Record<string, unknown>> = {},
): string {
  return JSON.stringify(
    {
      schema: "corvis-role-map-v1",
      revision: 1,
      configured: true,
      roles,
      ...overrides,
    },
    null,
    2,
  );
}

const baseEntries: readonly RoleEntryInput[] = [
  { id: "lead", roleId: "lead", file: "lead.md" },
  { id: "planner", roleId: "planner", file: "planner.md" },
  { id: "architect", roleId: "architect", file: "architect.md", upstreamRole: "architecture" },
  {
    id: "implementation",
    roleId: "implementation",
    file: "implementation.md",
    upstreamRole: "implementation",
  },
];

function baseFiles(): Map<string, string> {
  return new Map([
    ["lead.md", roleMarkdown("lead")],
    ["planner.md", roleMarkdown("planner")],
    ["architect.md", roleMarkdown("architect")],
    ["implementation.md", roleMarkdown("implementation")],
  ]);
}

function codes(issues: readonly { code: string }[]): readonly string[] {
  return issues.map((issue) => issue.code);
}

describe("roles.json manifest", () => {
  it("parses a configured manifest and maps ids to delegated role ids", () => {
    const parsed = parseRolesDocumentSet({
      manifest: rolesManifest(baseEntries),
      files: baseFiles(),
      features: { board: true, planning: true },
    });

    expect(parsed.valid).toBe(true);
    expect(parsed.configured).toBe(true);
    expect(parsed.revision).toBe(1);
    expect(parsed.issues).toEqual([]);
    expect(parsed.roles.map((role) => role.roleId)).toEqual([
      "lead",
      "planner",
      "architect",
      "implementation",
    ]);
    expect(parsed.requirements).toEqual({
      rolesManifest: true,
      leadRole: true,
      plannerRole: true,
      architectRole: true,
    });
  });

  it("reports a JSON syntax error with its line and the line text", () => {
    const manifest = `{
  "schema": "corvis-role-map-v1",
  "revision": 1,
  "configured": true,
  "roles": []
  "roles": []
}`;
    const parsed = parseRolesDocumentSet({ manifest, files: new Map() });

    expect(parsed.valid).toBe(false);
    const issue = parsed.issues.find((entry) => entry.code === "frontmatter_invalid");
    expect(issue?.line).toBe(6);
    expect(issue?.text).toBe('"roles": []');
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain('Document "roles" line 6: expected');
  });

  it("rejects a repeated property in the manifest", () => {
    const manifest = `{
  "schema": "corvis-role-map-v1",
  "revision": 1,
  "configured": true,
  "roles": [],
  "roles": []
}`;
    const parsed = parseRolesDocumentSet({ manifest, files: new Map() });

    const issue = parsed.issues.find((entry) => entry.code === "frontmatter_invalid");
    expect(issue?.line).toBe(6);
    expect(issue?.message).toContain('got "duplicate property "roles""');
  });

  it("reports an unknown schema at the schema line", () => {
    const manifest = rolesManifest(baseEntries, { schema: "corvis-role-map-v2" });
    const parsed = parseRolesDocumentSet({ manifest, files: baseFiles() });

    const issue = parsed.issues.find((entry) => entry.code === "frontmatter_invalid");
    expect(issue?.line).toBe(2);
    expect(issue?.text).toBe('"schema": "corvis-role-map-v2",');
    expect(issue?.message).toBe(
      'Document "roles" line 2: expected schema: corvis-role-map-v1, got "corvis-role-map-v2".',
    );
    expect(parsed.valid).toBe(false);
  });

  it("rejects a negative revision", () => {
    const manifest = rolesManifest(baseEntries, { revision: -1 });
    const parsed = parseRolesDocumentSet({ manifest, files: baseFiles() });

    const issue = parsed.issues.find((entry) => entry.code === "frontmatter_invalid");
    expect(issue?.line).toBe(3);
    expect(issue?.message).toContain('expected revision: an integer >= 0, got "-1"');
  });

  it("rejects documentsWrite: document access follows lineage, not a role", () => {
    const manifest = rolesManifest([
      { ...baseEntries[0]!, documentsWrite: true } as RoleEntryInput,
    ]);
    const parsed = parseRolesDocumentSet({ manifest, files: baseFiles() });

    expect(parsed.valid).toBe(false);
    const issue = parsed.issues.find((entry) => entry.code === "frontmatter_invalid");
    expect(issue?.message).toContain("no documentsWrite field");
    expect(issue?.text).toContain('"documentsWrite": true');
  });

  it("maps an unknown roleId to role_unknown with a hint and supported ids", () => {
    const manifest = rolesManifest([{ id: "helper", roleId: "helper", file: "helper.md" }]);
    const parsed = parseRolesDocumentSet({
      manifest,
      files: new Map([["helper.md", roleMarkdown("lead")]]),
    });

    expect(parsed.valid).toBe(false);
    const issue = parsed.issues.find((entry) => entry.code === "role_unknown");
    expect(issue?.message).toBe(
      'Role "helper" cannot be mapped to a Corvis role id. Declare a supported roleId or remove the entry.',
    );
    expect(issue?.hint).toContain("planner");
    expect(issue?.hint).toContain("review-common");
    expect(issue?.line).toBe(8);
    expect(parsed.roles).toEqual([]);
  });

  it("reports duplicate mappings as role_mapping_conflict", () => {
    const manifest = rolesManifest([
      { id: "implementation", roleId: "implementation", file: "implementation.md" },
      { id: "second", roleId: "implementation", file: "second.md" },
    ]);
    const parsed = parseRolesDocumentSet({
      manifest,
      files: new Map([
        ["implementation.md", roleMarkdown("implementation")],
        ["second.md", roleMarkdown("implementation")],
      ]),
    });

    const issue = parsed.issues.find((entry) => entry.code === "role_mapping_conflict");
    expect(issue?.message).toBe(
      'Roles.json entry 2: "implementation" is already assigned; role mappings must be unique.',
    );
    expect(issue?.line).toBe(13);
    expect(parsed.valid).toBe(false);
  });

  it("rejects an upstreamRole on the planner", () => {
    const manifest = rolesManifest([
      { id: "planner", roleId: "planner", file: "planner.md", upstreamRole: "general" },
    ]);
    const parsed = parseRolesDocumentSet({
      manifest,
      files: new Map([["planner.md", roleMarkdown("planner")]]),
    });

    const issue = parsed.issues.find((entry) => entry.code === "frontmatter_invalid");
    expect(issue?.message).toContain("expected no upstreamRole for planner");
    expect(issue?.message).toContain('got "general"');
    expect(parsed.valid).toBe(false);
  });

  it("rejects a file path outside the roles directory", () => {
    const manifest = rolesManifest([{ id: "lead", roleId: "lead", file: "../lead.md" }]);
    const parsed = parseRolesDocumentSet({ manifest, files: new Map() });

    const issue = parsed.issues.find((entry) => entry.code === "frontmatter_invalid");
    expect(issue?.message).toContain(
      "expected file: a path inside the roles directory ending in .md",
    );
    expect(issue?.message).toContain('got "../lead.md"');
  });
});

describe("role document set", () => {
  it("warns about an undeclared Markdown file but keeps the document valid", () => {
    const files = baseFiles();
    files.set("extra.md", roleMarkdown("general"));
    const parsed = parseRolesDocumentSet({
      manifest: rolesManifest(baseEntries),
      files,
    });

    expect(parsed.valid).toBe(true);
    const issue = parsed.issues.find((entry) => entry.code === "role_unknown");
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toBe(
      'Role "extra" cannot be mapped to a Corvis role id. Declare a supported roleId or remove the entry.',
    );
    expect(issue?.file).toBe("extra.md");
    expect(issue?.hint).toContain("lead.md");
  });

  it("reports a declared but missing file for that role only", () => {
    const files = baseFiles();
    files.delete("planner.md");
    const parsed = parseRolesDocumentSet({
      manifest: rolesManifest(baseEntries),
      files,
    });

    expect(parsed.valid).toBe(false);
    const issue = parsed.issues.find((entry) => entry.code === "document_missing");
    expect(issue?.message).toBe(
      'Document "roles" was not found at "planner.md". Choose an existing document or restore the built-in template.',
    );
    expect(issue?.subject).toBe("planner");
    expect(issue?.line).toBeGreaterThan(1);
    expect(parsed.files.size).toBe(3);
    expect(parsed.roles).toHaveLength(4);
  });

  it("requires the lead role for the board with a concrete hint", () => {
    const manifest = rolesManifest(baseEntries.filter((entry) => entry.roleId !== "lead"));
    const files = baseFiles();
    files.delete("lead.md");
    const parsed = parseRolesDocumentSet({
      manifest,
      files,
      features: { board: true },
    });

    expect(parsed.valid).toBe(false);
    const issue = parsed.issues.find((entry) => entry.code === "role_missing");
    expect(issue?.message).toBe(
      'Role "lead" is required by board. Add its roles.json entry and Markdown file.',
    );
    expect(issue?.hint).toContain('"roleId": "lead"');
    expect(parsed.requirements.leadRole).toBe(false);
  });

  it("requires the planner and at least one architect for planning", () => {
    const manifest = rolesManifest([{ id: "lead", roleId: "lead", file: "lead.md" }]);
    const parsed = parseRolesDocumentSet({
      manifest,
      files: new Map([["lead.md", roleMarkdown("lead")]]),
      features: { planning: true },
    });

    const missing = parsed.issues.filter((entry) => entry.code === "role_missing");
    expect(missing.map((issue) => issue.subject)).toEqual(["planner", "architect*"]);
    expect(missing[0]?.message).toBe(
      'Role "planner" is required by planning. Add its roles.json entry and Markdown file.',
    );
    expect(missing[1]?.hint).toContain("architect-<specialization>");
    expect(parsed.requirements).toMatchObject({
      plannerRole: false,
      architectRole: false,
    });
  });

  it("does not treat an unconfigured role file as usable", () => {
    const files = baseFiles();
    files.set("lead.md", roleMarkdown("lead", { configured: "false" }));
    const parsed = parseRolesDocumentSet({
      manifest: rolesManifest(baseEntries),
      files,
      features: { board: true },
    });

    expect(parsed.requirements.leadRole).toBe(false);
    expect(codes(parsed.issues)).toContain("role_missing");
    expect(parsed.valid).toBe(false);
  });

  it("flags a manifest roleId that disagrees with the role file", () => {
    const files = baseFiles();
    files.set("architect.md", roleMarkdown("architect-product"));
    const parsed = parseRolesDocumentSet({
      manifest: rolesManifest(baseEntries),
      files,
    });

    const issue = parsed.issues.find(
      (entry) => entry.code === "frontmatter_invalid" && entry.file === "architect.md",
    );
    expect(issue?.message).toBe(
      'Document "roles" line 3: expected roleId "architect" from roles.json, got "architect-product".',
    );
    expect(issue?.text).toBe("roleId: architect-product");
    expect(parsed.files.has("architect.md")).toBe(false);
  });

  it("marks a template manifest with document_unconfigured", () => {
    const parsed = parseRolesDocumentSet({
      manifest: rolesManifest(baseEntries, { configured: false }),
      files: baseFiles(),
    });

    expect(parsed.valid).toBe(true);
    expect(parsed.configured).toBe(false);
    expect(codes(parsed.issues)).toEqual(["document_unconfigured"]);
    expect(parsed.issues[0]?.message).toBe(
      'Document "roles" is a template. Fill it in (roles and skills: set "configured: true").',
    );
    expect(parsed.requirements.rolesManifest).toBe(false);
  });
});

describe("role file frontmatter", () => {
  it("accepts the role schema and returns the body", () => {
    const parsed = parseRoleFile(roleMarkdown("lead"), "lead.md");

    expect(parsed.issues).toEqual([]);
    expect(parsed.file).toMatchObject({ roleId: "lead", revision: 1, configured: true });
    expect(parsed.file?.body).toContain("Role body.");
  });

  it("accepts the stable_id field added by ft3-docs", () => {
    const content = roleMarkdown("lead", { stable_id: "00000000-0000-4000-8000-000000000000" });
    const parsed = parseRoleFile(content, "lead.md");

    expect(parsed.issues).toEqual([]);
    expect(parsed.file?.roleId).toBe("lead");
  });

  it("reports a missing schema line", () => {
    const parsed = parseRoleFile(roleMarkdown("lead", { schema: "" }), "lead.md");

    const issue = parsed.issues.find((entry) => entry.code === "frontmatter_invalid");
    expect(issue?.message).toBe(
      'Document "roles" line 1: expected schema: a required field, got "no schema field".',
    );
    expect(parsed.file).toBeNull();
  });

  it("reports a revision below one at its line", () => {
    const parsed = parseRoleFile(roleMarkdown("lead", { revision: "0" }), "lead.md");

    const issue = parsed.issues.find((entry) => entry.code === "frontmatter_invalid");
    expect(issue?.line).toBe(4);
    expect(issue?.text).toBe("revision: 0");
    expect(issue?.message).toContain('expected revision: an integer >= 1, got "0"');
  });

  it("reports an unmapped roleId in the file with the supported list", () => {
    const parsed = parseRoleFile(roleMarkdown("helper"), "helper.md");

    const issue = parsed.issues.find((entry) => entry.code === "role_unknown");
    expect(issue?.file).toBe("helper.md");
    expect(issue?.line).toBe(3);
    expect(issue?.hint).toContain("implementation");
  });

  it("requires a closed frontmatter block", () => {
    const parsed = parseRoleFile("---\nschema: corvis-role-v1\nroleId: lead\n", "lead.md");

    const issue = parsed.issues.find((entry) => entry.code === "frontmatter_invalid");
    expect(issue?.message).toContain("expected a closing --- line for the frontmatter");
    expect(parsed.file).toBeNull();
  });
});

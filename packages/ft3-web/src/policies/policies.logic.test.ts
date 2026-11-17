import type {
  PoliciesGetSnapshotResult,
  PolicyDocumentStatusSchema,
  PolicyFeatureStateSchema,
  PolicyIssueSchema,
} from "@t3tools/ft3-policies/rpc-contracts";
import { FEATURE_IDS, type FeatureId } from "@t3tools/ft3-policies/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  featureOffReasonText,
  issueLines,
  lineStartOffset,
  planningOverrideHint,
  policyAttentionCauses,
  policyDocumentActionLabel,
  policyDocumentBadge,
  policyDocumentBadgeHint,
  policyDocumentReadOnlyNote,
  policyDocumentSourceLabel,
  policyFileLabel,
} from "./policies.logic.ts";

const documentStatus = (
  overrides: Partial<PolicyDocumentStatusSchema> = {},
): PolicyDocumentStatusSchema => ({
  key: "routingPolicy",
  source: { kind: "builtin" },
  configured: true,
  applied: { revision: 1, sha256: "sha", appliedAt: "2026-11-03T00:00:00Z" },
  seen: null,
  errors: [],
  warnings: [],
  kept: false,
  pending: false,
  ...overrides,
});

const issue = (overrides: Partial<PolicyIssueSchema> = {}): PolicyIssueSchema => ({
  code: "table_row_invalid",
  severity: "error",
  message: "Bad row",
  document: "routingPolicy",
  ...overrides,
});

const featuresOf = (
  overrides: Partial<Record<FeatureId, Partial<PolicyFeatureStateSchema>>> = {},
): Record<FeatureId, PolicyFeatureStateSchema> =>
  Object.fromEntries(
    FEATURE_IDS.map((id) => [
      id,
      { id, requestedEnabled: false, effectiveEnabled: false, offReason: null, ...overrides[id] },
    ]),
  ) as Record<FeatureId, PolicyFeatureStateSchema>;

const snapshotOf = (
  overrides: Partial<Pick<PoliciesGetSnapshotResult, "features" | "documents">> = {},
): Pick<PoliciesGetSnapshotResult, "features" | "documents"> => ({
  features: featuresOf(),
  documents: [],
  ...overrides,
});

describe("planningOverrideHint", () => {
  const projects = [
    { id: "alpha", title: "Alpha" },
    { id: "beta", title: "Beta" },
    { id: "inherited", title: "Inherited" },
  ];
  const overrides = {
    alpha: { ft3FeatureToggles: { planning: true } },
    beta: { ft3FeatureToggles: { planning: true } },
    inherited: { ft3FeatureToggles: { mail: true } },
    deleted: { ft3FeatureToggles: { planning: true } },
  };
  const snapshotWithIssue = (entry: PolicyIssueSchema) =>
    snapshotOf({ documents: [documentStatus({ key: entry.document, errors: [entry] })] });

  it.each([
    ["role_missing", "planner", "roles", "planner role and its Markdown file"],
    ["role_missing", "planner", "routingPolicy", "planner routing row"],
    ["role_missing", "architect*", "roles", "an architect role and its Markdown file"],
  ] as const)("explains %s for %s in %s", (code, subject, document, missing) => {
    const hint = planningOverrideHint(
      snapshotWithIssue(issue({ code, subject, document })),
      projects,
      overrides,
    );
    expect(hint).toContain("“Alpha”, “Beta”");
    expect(hint).toContain(missing);
    expect(hint).toContain("turn off planning");
    expect(hint).toContain("own policy documents");
    expect(hint).not.toContain("Inherited");
    expect(hint).not.toContain("deleted");
  });

  it("gives a file and manifest fix for a missing lead skill", () => {
    const snapshot = snapshotWithIssue(
      issue({ code: "lead_skill_missing", subject: "plan-orchestrator", document: "leadSkills" }),
    );
    const hint = planningOverrideHint(snapshot, projects, overrides);
    expect(hint).toContain("“Alpha”, “Beta”");
    expect(hint).toContain("Add or restore its entry in lead-skills.json");
    expect(hint).toContain("plan-orchestrator/SKILL.md file");
    expect(hint).not.toContain("turn off planning");
  });

  it("ignores a declared skill with no file when planning is off for every project", () => {
    const snapshot = snapshotWithIssue(
      issue({
        code: "lead_skill_missing",
        subject: "plan-orchestrator",
        document: "leadSkills",
        file: "plan-orchestrator/SKILL.md",
        line: 5,
        text: '{ "id": "plan-orchestrator", "file": "plan-orchestrator/SKILL.md" }',
      }),
    );
    expect(
      planningOverrideHint(snapshot, projects, {
        alpha: { ft3FeatureToggles: { planning: false } },
      }),
    ).toBeNull();
  });

  it("keeps the planning alternatives scoped to role errors when a skill is also missing", () => {
    const snapshot = snapshotOf({
      documents: [
        documentStatus({
          errors: [
            issue({ code: "role_missing", subject: "architect*", document: "roles" }),
            issue({
              code: "lead_skill_missing",
              subject: "plan-orchestrator",
              document: "leadSkills",
            }),
          ],
        }),
      ],
    });
    const hint = planningOverrideHint(snapshot, projects, overrides);
    expect(hint).toContain(
      "missing an architect role and its Markdown file. Add the missing role entries",
    );
    expect(hint).toContain(
      "or give each project its own policy documents. The environment lead skills are missing plan-orchestrator. Add or restore its entry",
    );
  });

  it.each([
    { code: "role_missing", subject: "lead" },
    { code: "lead_skill_missing", subject: "board-orchestrator" },
    { code: "policy_invalid_kept" },
    { code: "role_missing", subject: "planner", severity: "warning" },
    { code: "role_missing", subject: "planner", document: "leadSkills" },
  ] as const)("ignores unrelated diagnostics %j", (entry) => {
    expect(planningOverrideHint(snapshotWithIssue(issue(entry)), projects, overrides)).toBeNull();
  });

  it("requires both a planning error and a project override while the default is off", () => {
    const snapshot = snapshotWithIssue(
      issue({ code: "role_missing", subject: "planner", document: "roles" }),
    );
    expect(planningOverrideHint(snapshotOf(), projects, overrides)).toBeNull();
    expect(planningOverrideHint(snapshot, projects, {})).toBeNull();
    expect(
      planningOverrideHint(snapshot, projects, {
        alpha: { ft3FeatureToggles: { planning: false } },
      }),
    ).toBeNull();
    expect(
      planningOverrideHint(
        { ...snapshot, features: featuresOf({ planning: { requestedEnabled: true } }) },
        projects,
        overrides,
      ),
    ).toBeNull();
  });

  it("lists each missing requirement once across duplicate errors", () => {
    const entry = issue({ code: "role_missing", subject: "planner", document: "roles" });
    const snapshot = snapshotOf({ documents: [documentStatus({ errors: [entry, entry] })] });
    expect(
      planningOverrideHint(snapshot, projects, overrides)?.match(
        /planner role and its Markdown file/g,
      ),
    ).toHaveLength(1);
  });
});

describe("policyDocumentBadge", () => {
  it("reports an applied document", () => {
    expect(policyDocumentBadge(documentStatus())).toBe("applied");
  });

  it("reports an invalid live version that kept the previous one", () => {
    expect(policyDocumentBadge(documentStatus({ kept: true }))).toBe("invalid-kept");
  });

  it("prefers invalid-kept over pending when both are true", () => {
    expect(policyDocumentBadge(documentStatus({ kept: true, pending: true }))).toBe("invalid-kept");
  });

  it("reports a pending external change on an applied document", () => {
    expect(policyDocumentBadge(documentStatus({ pending: true }))).toBe("pending");
  });

  it("reports a document that was never applied", () => {
    expect(policyDocumentBadge(documentStatus({ applied: null }))).toBe("unapplied");
  });
});

describe("policyDocumentSourceLabel", () => {
  it("labels every source kind", () => {
    expect(policyDocumentSourceLabel({ kind: "builtin" })).toBe("Built-in template");
    expect(
      policyDocumentSourceLabel({
        kind: "doc",
        address: { kind: "path", relPath: "policy/routing" },
      }),
    ).toBe("Document store");
    expect(policyDocumentSourceLabel({ kind: "path", path: "/etc/policy.md" })).toBe(
      "File: /etc/policy.md",
    );
  });
});

describe("policy document actions and explanations", () => {
  it("opens a built-in template as View and a store or file document as Edit", () => {
    expect(policyDocumentActionLabel({ kind: "builtin" })).toBe("View");
    expect(policyDocumentActionLabel({ kind: "path", path: "/etc/policy.md" })).toBe("Edit");
  });

  it("labels the main file by the document and tree files by their path", () => {
    expect(policyFileLabel("roles", "")).toBe("roles.json");
    expect(policyFileLabel("roles", "lead.md")).toBe("lead.md");
    expect(policyFileLabel("leadSkills", "")).toBe("lead-skills.json");
    expect(policyFileLabel("routingPolicy", "")).toBe("routing-policy.md");
  });

  it("explains an unapplied built-in template and points at the errors", () => {
    const hint = policyDocumentBadgeHint(documentStatus({ applied: null, errors: [issue()] }));
    expect(hint).toBe(
      "Not applied yet: the built-in template has no valid version, so none is in effect. The errors below say why.",
    );
    expect(policyDocumentBadgeHint(documentStatus())).toBeNull();
  });

  it("explains an unapplied store document without a built-in mention", () => {
    const hint = policyDocumentBadgeHint(
      documentStatus({ source: { kind: "path", path: "/etc/policy.md" }, applied: null }),
    );
    expect(hint).toBe("Not applied yet: no valid version has been applied.");
  });

  it("marks only a built-in template as read-only", () => {
    expect(policyDocumentReadOnlyNote({ kind: "builtin" })).toContain("read-only");
    expect(policyDocumentReadOnlyNote({ kind: "path", path: "/etc/policy.md" })).toBeNull();
  });

  it("names the dependency or the document that keeps a feature off", () => {
    expect(featureOffReasonText(null)).toBeNull();
    expect(featureOffReasonText({ code: "feature_dependency_off", dependency: "roles" })).toBe(
      "Off: it needs the roles feature, which is off.",
    );
    expect(featureOffReasonText({ code: "feature_document_off", requirement: "plannerRole" })).toBe(
      "Off: its Roles document is not valid yet.",
    );
    expect(
      featureOffReasonText({ code: "feature_document_off", requirement: "documentsStore" }),
    ).toBe("Off: a required document is not valid (documentsStore).");
  });
});

describe("policyAttentionCauses", () => {
  it("is empty when every feature is effective and every document is quiet", () => {
    expect(
      policyAttentionCauses(
        snapshotOf({ documents: [documentStatus(), documentStatus({ key: "roles" })] }),
      ),
    ).toEqual([]);
  });

  it("lists an enabled but ineffective feature with its off reason", () => {
    const causes = policyAttentionCauses(
      snapshotOf({
        features: featuresOf({
          board: {
            id: "board",
            requestedEnabled: true,
            effectiveEnabled: false,
            offReason: { code: "feature_document_off", requirement: "rolesManifest" },
          },
        }),
      }),
    );
    expect(causes).toEqual([
      {
        kind: "feature",
        feature: "board",
        text: "Feature board is not effective: Off: its Roles document is not valid yet.",
      },
    ]);
  });

  it("lists document warnings with their count and pending changes with their label", () => {
    const causes = policyAttentionCauses(
      snapshotOf({
        documents: [
          documentStatus({ key: "roles", warnings: [issue({ document: "roles" })] }),
          documentStatus({
            key: "leadSkills",
            pending: true,
            warnings: [issue({ document: "leadSkills" }), issue({ document: "leadSkills" })],
          }),
        ],
      }),
    );
    expect(causes).toEqual([
      { kind: "document", key: "roles", text: "Roles: 1 warning" },
      { kind: "document", key: "leadSkills", text: "Lead skills: 2 warnings" },
      {
        kind: "document",
        key: "leadSkills",
        text: "Lead skills: external change waits for review",
      },
    ]);
  });

  it("ignores off features the user did not enable", () => {
    expect(
      policyAttentionCauses(
        snapshotOf({
          features: featuresOf({
            mail: { id: "mail", requestedEnabled: false, effectiveEnabled: false, offReason: null },
          }),
        }),
      ),
    ).toEqual([]);
  });
});

describe("issue line mapping", () => {
  it("collects unique sorted 1-based lines and drops issues without a line", () => {
    expect(
      issueLines([
        issue({ line: 9 }),
        issue({ line: 3 }),
        issue({ line: 9 }),
        issue(),
        issue({ line: 0 }),
      ]),
    ).toEqual([3, 9]);
  });

  it("maps a 1-based line to the offset of its first character", () => {
    const content = "alpha\nbeta\ngamma\n";
    expect(lineStartOffset(content, 1)).toBe(0);
    expect(lineStartOffset(content, 2)).toBe(6);
    expect(lineStartOffset(content, 3)).toBe(11);
  });

  it("clamps past the end of the content to the end", () => {
    const content = "alpha\nbeta";
    expect(lineStartOffset(content, 3)).toBe(content.length);
    expect(lineStartOffset(content, 99)).toBe(content.length);
  });

  it("treats line numbers below 1 as the start", () => {
    expect(lineStartOffset("abc", 0)).toBe(0);
    expect(lineStartOffset("abc", -4)).toBe(0);
  });
});

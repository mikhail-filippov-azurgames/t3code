// @effect-diagnostics nodeBuiltinImport:off - host tests write the configured policy files to a temporary directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const ROLES_MANIFEST_FILE = "roles/roles.json";
export const LEAD_SKILLS_MANIFEST_FILE = "lead-skills/lead-skills.json";
const LEAD_SKILL_IDS = ["t3-orchestrator", "board-orchestrator", "plan-orchestrator"] as const;

/** Configured roles and lead-skills files, keyed by path under the policies directory. */
export const configuredLeadPolicyFiles = (
  leadBody = "# Lead\n\nOwn the board.",
): ReadonlyMap<string, string> =>
  new Map<string, string>([
    [
      ROLES_MANIFEST_FILE,
      [
        "{",
        '  "schema": "corvis-role-map-v1",',
        '  "revision": 1,',
        '  "configured": true,',
        '  "roles": [ { "id": "lead", "roleId": "lead", "file": "lead.md" } ]',
        "}",
        "",
      ].join("\n"),
    ],
    [
      "roles/lead.md",
      [
        "---",
        "schema: corvis-role-v1",
        "roleId: lead",
        "revision: 1",
        "configured: true",
        "---",
        "",
        leadBody,
        "",
      ].join("\n"),
    ],
    [
      LEAD_SKILLS_MANIFEST_FILE,
      JSON.stringify(
        {
          schema: "corvis-lead-skills-v1",
          revision: 1,
          configured: true,
          skills: LEAD_SKILL_IDS.map((id) => ({ id, file: `${id}/SKILL.md` })),
        },
        null,
        2,
      ),
    ],
    ...LEAD_SKILL_IDS.map(
      (id) =>
        [
          `lead-skills/${id}/SKILL.md`,
          `---\nname: ${id}\ndescription: Test lead skill.\n---\n\n# ${id}\n`,
        ] as const,
    ),
  ]);

const pathUnder = (dir: string, file: string): string => NodePath.join(dir, ...file.split("/"));

/**
 * Server settings whose roles and lead-skills documents are the configured files,
 * written to a fresh temporary directory on each call.
 */
export const configuredLeadPolicySettings = (features: Readonly<Record<string, boolean>> = {}) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ft3-board-policies-"));
  for (const [file, content] of configuredLeadPolicyFiles()) {
    NodeFS.mkdirSync(NodePath.dirname(pathUnder(dir, file)), { recursive: true });
    NodeFS.writeFileSync(pathUnder(dir, file), content);
  }
  return {
    ft3: {
      policies: {
        documents: {
          roles: { kind: "path", path: pathUnder(dir, ROLES_MANIFEST_FILE) },
          leadSkills: { kind: "path", path: pathUnder(dir, LEAD_SKILLS_MANIFEST_FILE) },
        },
        features,
      },
    },
  };
};

/**
 * Policy diagnostics shared by every strict parser: the §5 issue codes, their
 * severity and the exact messages the Policies tab shows. Parsers only build
 * issues; nothing here reads a file or decides whether a version is applied.
 */
import type { PolicyDocumentKey } from "./contracts.ts";

/** Every diagnostic code of the design's §5 table. */
export const POLICY_ISSUE_CODES = [
  "document_missing",
  "document_unconfigured",
  "frontmatter_invalid",
  "table_row_invalid",
  "candidate_alias_unknown",
  "routing_table_missing",
  "routing_table_duplicate",
  "alias_table_provider_missing",
  "alias_duplicate",
  "policy_invalid_kept",
  "role_missing",
  "role_unknown",
  "role_mapping_conflict",
  "lead_skill_missing",
  "model_unavailable",
  "accelerated_candidate",
  "feature_dependency_off",
  "feature_document_off",
  "mail_disabled_notice",
  "plan_invalid",
  "document_changed_externally",
  "document_pending",
  "document_protected",
  "document_changed",
  "document_outside_store",
  "duplicate_stable_id",
  "store_unavailable",
] as const;
export type PolicyIssueCode = (typeof POLICY_ISSUE_CODES)[number];

/**
 * `error` blocks a new version from being applied. `warning` keeps the document
 * usable: an unknown optional role, an unavailable model or a pending change.
 */
export type PolicyIssueSeverity = "error" | "warning";

export interface PolicyIssue {
  readonly code: PolicyIssueCode;
  readonly severity: PolicyIssueSeverity;
  /** The §5 message, filled in with this issue's values. */
  readonly message: string;
  /** The policy document the issue belongs to. */
  readonly document: PolicyDocumentKey;
  /** Short corrective direction shown after the message. */
  readonly hint?: string;
  /** 1-based source line; absent when the issue is not about file content. */
  readonly line?: number;
  /** The source line itself, trimmed; present together with `line`. */
  readonly text?: string;
  /** Manifest-relative file the line belongs to, for tree documents. */
  readonly file?: string;
  /** Role or skill the issue is scoped to, when one is known. */
  readonly subject?: string;
}

export interface PolicyIssueInput {
  readonly document: PolicyDocumentKey;
  readonly hint?: string;
  readonly line?: number;
  readonly text?: string;
  readonly file?: string;
  readonly subject?: string;
}

const issue = (
  code: PolicyIssueCode,
  severity: PolicyIssueSeverity,
  message: string,
  input: PolicyIssueInput,
): PolicyIssue => ({
  code,
  severity,
  message,
  document: input.document,
  ...(input.hint === undefined ? {} : { hint: input.hint }),
  ...(input.line === undefined ? {} : { line: input.line }),
  ...(input.text === undefined ? {} : { text: input.text }),
  ...(input.file === undefined ? {} : { file: input.file }),
  ...(input.subject === undefined ? {} : { subject: input.subject }),
});

/** No file or directory at the configured location. */
export function documentMissingIssue(
  key: PolicyDocumentKey,
  path: string,
  input: Omit<PolicyIssueInput, "document"> = {},
): PolicyIssue {
  return issue(
    "document_missing",
    "error",
    `Document "${key}" was not found at "${path}". Choose an existing document or restore the built-in template.`,
    { ...input, document: key },
  );
}

/** The document is still the bundled template: `configured: false`. */
export function documentUnconfiguredIssue(
  key: PolicyDocumentKey,
  input: Omit<PolicyIssueInput, "document"> = {},
): PolicyIssue {
  return issue(
    "document_unconfigured",
    "warning",
    `Document "${key}" is a template. Fill it in (roles and skills: set "configured: true").`,
    { ...input, document: key },
  );
}

/** An unknown schema, revision, type or field value. */
export function frontmatterInvalidIssue(
  key: PolicyDocumentKey,
  line: number,
  text: string,
  expected: string,
  actual: string,
  input: Omit<PolicyIssueInput, "document" | "line" | "text"> = {},
): PolicyIssue {
  return issue(
    "frontmatter_invalid",
    "error",
    `Document "${key}" line ${line}: expected ${expected}, got "${actual}".`,
    { ...input, document: key, line, text },
  );
}

/** A role the enabled feature needs is not declared or has no file. */
export function roleMissingIssue(
  roleId: string,
  feature: string,
  input: Omit<PolicyIssueInput, "document" | "subject"> = {},
): PolicyIssue {
  return issue(
    "role_missing",
    "error",
    `Role "${roleId}" is required by ${feature}. Add its roles.json entry and Markdown file.`,
    { ...input, document: "roles", subject: roleId },
  );
}

/** A role entry or file that cannot be mapped to a Corvis role id. */
export function roleUnknownIssue(
  id: string,
  severity: PolicyIssueSeverity = "error",
  input: Omit<PolicyIssueInput, "document" | "subject"> = {},
): PolicyIssue {
  return issue(
    "role_unknown",
    severity,
    `Role "${id}" cannot be mapped to a Corvis role id. Declare a supported roleId or remove the entry.`,
    { ...input, document: "roles", subject: id },
  );
}

/** Two entries assign the same id, roleId, upstreamRole or file. */
export function roleMappingConflictIssue(
  index: number,
  value: string,
  input: Omit<PolicyIssueInput, "document"> = {},
): PolicyIssue {
  return issue(
    "role_mapping_conflict",
    "error",
    `Roles.json entry ${index}: "${value}" is already assigned; role mappings must be unique.`,
    { ...input, document: "roles", subject: value },
  );
}

/** A lead skill entry or SKILL.md the manifest or a feature needs. */
export function leadSkillMissingIssue(
  skillId: string,
  path: string,
  input: Omit<PolicyIssueInput, "document" | "subject"> = {},
): PolicyIssue {
  return issue(
    "lead_skill_missing",
    "error",
    `Lead skill "${skillId}" is missing at "${path}". Restore it or choose the lead-skills directory.`,
    { ...input, document: "leadSkills", subject: skillId },
  );
}

/** Error-severity issues block a version from being applied. */
export function hasBlockingIssue(issues: readonly PolicyIssue[]): boolean {
  return issues.some((entry) => entry.severity === "error");
}

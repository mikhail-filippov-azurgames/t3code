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
  "legacy_policy_ref_unresolved",
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
  severity: PolicyIssueSeverity = "warning",
): PolicyIssue {
  return issue(
    "document_unconfigured",
    severity,
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

/** A routing-policy table row that cannot be parsed, on the row's line. */
export function tableRowInvalidIssue(line: number, text: string, reason: string): PolicyIssue {
  return issue(
    "table_row_invalid",
    "error",
    `Routing policy line ${line}: cannot parse "${text}": ${reason}.`,
    { document: "routingPolicy", line, text },
  );
}

/** A cell candidate that no alias table of the document declares. */
export function candidateAliasUnknownIssue(line: number, alias: string): PolicyIssue {
  return issue(
    "candidate_alias_unknown",
    "error",
    `Routing policy line ${line}: candidate alias "${alias}" is not declared in any alias table.`,
    { document: "routingPolicy", line, subject: alias },
  );
}

/** The document has no role × level table at all. */
export function routingTableMissingIssue(): PolicyIssue {
  return issue(
    "routing_table_missing",
    "error",
    "Routing policy has no role × level table (columns low, medium, high, very-high).",
    { document: "routingPolicy" },
  );
}

/** A second role × level table was found; only one is read. */
export function routingTableDuplicateIssue(line: number): PolicyIssue {
  return issue(
    "routing_table_duplicate",
    "error",
    `Routing policy line ${line}: a second role × level table was found; keep exactly one.`,
    { document: "routingPolicy", line },
  );
}

/** An alias table without a provider heading above it. */
export function aliasTableProviderMissingIssue(line: number): PolicyIssue {
  return issue(
    "alias_table_provider_missing",
    "error",
    `Routing policy line ${line}: alias table has no preceding heading ending in (\`<providerInstanceId> / <driverKind>\`).`,
    { document: "routingPolicy", line },
  );
}

/** The same alias is declared twice; the first declaration's line is named. */
export function aliasDuplicateIssue(line: number, alias: string, firstLine: number): PolicyIssue {
  return issue(
    "alias_duplicate",
    "error",
    `Routing policy line ${line}: alias "${alias}" is already declared at line ${firstLine}.`,
    { document: "routingPolicy", line, subject: alias },
  );
}

/** A candidate whose model id asks for an accelerated service tier. */
export function acceleratedCandidateIssue(line: number, alias: string): PolicyIssue {
  return issue(
    "accelerated_candidate",
    "warning",
    `Candidate "${alias}" requests an accelerated service tier and will always be skipped.`,
    { document: "routingPolicy", line, subject: alias },
  );
}

/** A role row the enabled feature needs is absent from the routing table. */
export function routingRoleMissingIssue(roleId: string, feature: string): PolicyIssue {
  return issue(
    "role_missing",
    "error",
    `Role "${roleId}" is required by ${feature}. Add its roles.json entry and Markdown file.`,
    { document: "routingPolicy", subject: roleId },
  );
}

/** A newer version has errors, so the previously applied one keeps serving. */
export function policyInvalidKeptIssue(key: PolicyDocumentKey, revision: number): PolicyIssue {
  return issue(
    "policy_invalid_kept",
    "error",
    `Document "${key}" has errors and was not applied; revision ${revision} stays active.`,
    { document: key },
  );
}

/** A live external edit waits for the human: the applied version keeps serving. */
export function documentPendingIssue(key: PolicyDocumentKey): PolicyIssue {
  return issue(
    "document_pending",
    "warning",
    `Document "${key}" changed outside Corvis and is not applied. Review the difference and apply it.`,
    { document: key },
  );
}

/** An env-provided routing policy reference did not resolve in the store. */
export function legacyPolicyRefUnresolvedIssue(ref: string, reason: string): PolicyIssue {
  return issue(
    "legacy_policy_ref_unresolved",
    "warning",
    `Routing policy reference "${ref}" could not be resolved (${reason}); the built-in template stays active.`,
    { document: "routingPolicy" },
  );
}

/** The store could not be read for a configured policy document. */
export function storeUnavailableIssue(
  key: PolicyDocumentKey,
  label: string,
  reason: string,
): PolicyIssue {
  return issue(
    "store_unavailable",
    "error",
    `The document store at "${label}" is unavailable: ${reason}.`,
    { document: key },
  );
}

/** Error-severity issues block a version from being applied. */
export function hasBlockingIssue(issues: readonly PolicyIssue[]): boolean {
  return issues.some((entry) => entry.severity === "error");
}

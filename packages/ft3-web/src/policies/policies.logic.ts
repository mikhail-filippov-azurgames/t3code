import type {
  PolicyDocumentStatusSchema,
  PoliciesGetSnapshotResult,
  PolicyIssueSchema,
} from "@t3tools/ft3-policies/rpc-contracts";
import {
  FEATURE_IDS,
  type FeatureId,
  type FeatureOffReason,
  type PolicyDocumentKey,
  type PolicyDocumentSource,
  type PolicyRequirementId,
} from "@t3tools/ft3-policies/contracts";

/**
 * Pure presentation logic of the Policies settings tab: the status badge of a
 * document, its source label, and the issue-line mapping the editor's error
 * list jumps through. No RPC and no React here.
 */
export type PolicyDocumentBadge = "invalid-kept" | "pending" | "applied" | "unapplied";

export const POLICY_DOCUMENT_BADGE_LABELS: Readonly<Record<PolicyDocumentBadge, string>> = {
  "invalid-kept": "Invalid: previous version kept",
  pending: "Pending external change",
  applied: "Applied",
  unapplied: "Not applied yet",
};

export const POLICY_DOCUMENT_BADGE_VARIANTS: Readonly<
  Record<PolicyDocumentBadge, "success" | "warning" | "error" | "secondary">
> = {
  applied: "success",
  pending: "warning",
  "invalid-kept": "error",
  unapplied: "secondary",
};

export const POLICY_DOCUMENT_KEY_LABELS: Readonly<Record<PolicyDocumentKey, string>> = {
  routingPolicy: "Routing policy",
  roles: "Roles",
  leadSkills: "Lead skills",
};

/** The main file's name per document; tree files carry their manifest-relative path. */
const POLICY_MAIN_FILE_LABELS: Readonly<Record<PolicyDocumentKey, string>> = {
  routingPolicy: "routing-policy.md",
  roles: "roles.json",
  leadSkills: "lead-skills.json",
};

/** Tab and editor label of one document file; "" is the main file. */
export function policyFileLabel(key: PolicyDocumentKey, file: string): string {
  return file === "" ? POLICY_MAIN_FILE_LABELS[key] : file;
}

/**
 * The badge state of one document. An invalid live version outranks a pending
 * external change, because the kept previous version is what actually runs.
 */
export function policyDocumentBadge(
  document: Pick<PolicyDocumentStatusSchema, "kept" | "pending" | "applied">,
): PolicyDocumentBadge {
  if (document.kept) return "invalid-kept";
  if (document.pending) return "pending";
  if (document.applied !== null) return "applied";
  return "unapplied";
}

/** Built-in templates open read-only, so their row action says View rather than Edit. */
export function policyDocumentActionLabel(source: PolicyDocumentSource): "View" | "Edit" {
  return source.kind === "builtin" ? "View" : "Edit";
}

/** Why a document has no version in effect; null once one is applied. */
export function policyDocumentBadgeHint(
  document: Pick<PolicyDocumentStatusSchema, "source" | "applied" | "errors">,
): string | null {
  if (document.applied !== null) return null;
  const why = document.errors.length > 0 ? " The errors below say why." : "";
  if (document.source.kind === "builtin") {
    return `Not applied yet: the built-in template has no valid version, so none is in effect.${why}`;
  }
  return `Not applied yet: no valid version has been applied.${why}`;
}

export function policyDocumentReadOnlyNote(source: PolicyDocumentSource): string | null {
  return source.kind === "builtin"
    ? "Built-in template: read-only. Switch the source to a store document or a server file to edit it here."
    : null;
}

const REQUIREMENT_DOCUMENT: Readonly<Record<PolicyRequirementId, PolicyDocumentKey | null>> = {
  documentsStore: null,
  rolesManifest: "roles",
  leadRole: "roles",
  plannerRole: "roles",
  architectRole: "roles",
  leadSkills: "leadSkills",
  planOrchestratorSkill: "leadSkills",
  routingPolicy: "routingPolicy",
  requestedRoles: "routingPolicy",
};

/** The reason a requested feature is actually off; null when it has no off reason. */
export function featureOffReasonText(reason: FeatureOffReason | null): string | null {
  if (reason === null) return null;
  if (reason.code === "feature_dependency_off") {
    return `Off: it needs the ${reason.dependency} feature, which is off.`;
  }
  const key = REQUIREMENT_DOCUMENT[reason.requirement];
  return key === null
    ? `Off: a required document is not valid (${reason.requirement}).`
    : `Off: its ${POLICY_DOCUMENT_KEY_LABELS[key]} document is not valid yet.`;
}

export function policyDocumentSourceLabel(source: PolicyDocumentSource): string {
  switch (source.kind) {
    case "builtin":
      return "Built-in template";
    case "doc":
      return "Document store";
    case "path":
      return `File: ${source.path}`;
  }
}

/** The 1-based source line of an issue, or null when it is not about file content. */
export function issueLine(issue: Pick<PolicyIssueSchema, "line">): number | null {
  return typeof issue.line === "number" && issue.line >= 1 ? issue.line : null;
}

/** 1-based lines carrying an issue, unique and sorted, for the error list. */
export function issueLines(
  issues: ReadonlyArray<Pick<PolicyIssueSchema, "line">>,
): ReadonlyArray<number> {
  return [...new Set(issues.map(issueLine).filter((line) => line !== null))].sort(
    (left, right) => left - right,
  );
}

/** Offset of the first character of a 1-based line; the cursor jump target. */
export function lineStartOffset(content: string, line: number): number {
  if (line <= 1) return 0;
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const nextNewline = content.indexOf("\n", offset);
    if (nextNewline === -1) return content.length;
    offset = nextNewline + 1;
  }
  return Math.min(offset, content.length);
}

/**
 * One concrete reason the snapshot needs attention, as the banner lists it.
 * `document` causes select that document's row; `feature` causes scroll to the
 * feature's toggle row.
 */
export type PolicyAttentionCause =
  | { readonly kind: "feature"; readonly feature: FeatureId; readonly text: string }
  | { readonly kind: "document"; readonly key: PolicyDocumentKey; readonly text: string };

/**
 * Every concrete attention cause in a snapshot, in banner order: ineffective
 * enabled features first, then documents with warnings or a pending external
 * change. Empty exactly when the snapshot no longer needs attention.
 */
export function policyAttentionCauses(
  snapshot: Pick<PoliciesGetSnapshotResult, "features" | "documents">,
): PolicyAttentionCause[] {
  const causes: PolicyAttentionCause[] = [];
  for (const feature of FEATURE_IDS) {
    const state = snapshot.features[feature];
    if (state === undefined || !state.requestedEnabled || state.effectiveEnabled) continue;
    const reason = featureOffReasonText(state.offReason) ?? "the reason is unknown.";
    causes.push({
      kind: "feature",
      feature,
      text: `Feature ${feature} is not effective: ${reason}`,
    });
  }
  for (const document of snapshot.documents) {
    const label = POLICY_DOCUMENT_KEY_LABELS[document.key];
    if (document.warnings.length > 0) {
      const count = document.warnings.length;
      causes.push({
        kind: "document",
        key: document.key,
        text: `${label}: ${count} warning${count === 1 ? "" : "s"}`,
      });
    }
    if (document.pending) {
      causes.push({
        kind: "document",
        key: document.key,
        text: `${label}: external change waits for review`,
      });
    }
  }
  return causes;
}

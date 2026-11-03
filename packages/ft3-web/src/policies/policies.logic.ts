import type {
  PolicyDocumentStatusSchema,
  PolicyIssueSchema,
} from "@t3tools/ft3-policies/rpc-contracts";
import type { PolicyDocumentKey, PolicyDocumentSource } from "@t3tools/ft3-policies/contracts";

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

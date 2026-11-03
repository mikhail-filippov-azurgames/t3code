import type {
  PolicyDocumentStatusSchema,
  PolicyIssueSchema,
} from "@t3tools/ft3-policies/rpc-contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  issueLines,
  lineStartOffset,
  policyDocumentBadge,
  policyDocumentSourceLabel,
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

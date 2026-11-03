// @effect-diagnostics nodeBuiltinImport:off - the test reads the bundled template and its fixture.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";

import {
  type RoutingPolicy,
  type RoutingPolicyIssueCode,
  type RoutingPolicyParseResult,
  parseRoutingPolicy,
} from "./routingPolicy.ts";

const readFixture = (relativePath: string): string =>
  NodeFS.readFileSync(new URL(relativePath, import.meta.url), "utf8");

const lineOf = (content: string, needle: string): number => {
  const index = content.split("\n").findIndex((line) => line.includes(needle));
  expect(index, `fixture has a line containing "${needle}"`).toBeGreaterThanOrEqual(0);
  return index + 1;
};

const findIssue = (result: RoutingPolicyParseResult, code: RoutingPolicyIssueCode) =>
  result.issues.find((issue) => issue.code === code);

const requirePolicy = (result: RoutingPolicyParseResult): RoutingPolicy => {
  expect(result.policy).not.toBeNull();
  if (result.policy === null) throw new Error("expected a parsed routing policy");
  return result.policy;
};

const CELL_HEADER = ["| Role | low | medium | high | very-high |", "|---|---|---|---|---|"];

const ALIAS_HEADER = [
  "| Alias | model | low | medium | high | very-high |",
  "|---|---|---|---|---|---|",
];

const DEFAULT_ROLE_ROWS = [
  "| `architect`, `architect-*` | A1 | A1 | A1 | A1 |",
  "| `implementation` | A1 | A1 | A1 | A1 |",
  "| `review-*` | A1 | A1 | A1 | A1 |",
  "| `test` | A1 | A1 | A1 | A1 |",
  "| `research` | A1 | A1 | A1 | A1 |",
  "| `general` | A1 | A1 | A1 | A1 |",
];

const DEFAULT_ALIAS_ROWS = [
  "### Alpha (`alpha / acp`)",
  ...ALIAS_HEADER,
  "| A1 | `alpha-one` | — | — | — | — |",
];

interface DocumentParts {
  readonly revision?: string;
  readonly roleRows?: readonly string[];
  readonly aliasRows?: readonly string[];
}

const buildDocument = (parts: DocumentParts = {}): string =>
  [
    "---",
    `revision: ${parts.revision ?? "1"}`,
    "---",
    "",
    ...CELL_HEADER,
    ...(parts.roleRows ?? DEFAULT_ROLE_ROWS),
    "",
    ...(parts.aliasRows ?? DEFAULT_ALIAS_ROWS),
    "",
  ].join("\n");

describe("routing policy of the live document shape", () => {
  const fixture = readFixture("./fixtures/routing-policy-live-shape.md");

  it("parses the cell table and every provider alias table", () => {
    const policy = requirePolicy(parseRoutingPolicy(fixture));

    expect(policy.revision).toBe(7);
    expect(Object.keys(policy.roles).toSorted()).toEqual([
      "architect",
      "general",
      "implementation",
      "planner",
      "research",
      "review",
      "test",
    ]);
    expect(policy.roles.implementation?.high).toEqual([
      { alias: "I1", level: null },
      { alias: "I2", level: null },
      { alias: "IH", level: null },
    ]);
    expect(policy.roles.review?.["very-high"]).toEqual([
      { alias: "R2", level: null },
      { alias: "R3", level: null },
    ]);
    expect(policy.aliases).toHaveLength(11);
  });

  it("reads both candidate separators", () => {
    const policy = requirePolicy(parseRoutingPolicy(fixture));

    expect(policy.roles.architect?.medium).toEqual([
      { alias: "A1", level: null },
      { alias: "A2", level: null },
      { alias: "A3", level: null },
    ]);
  });

  it("keeps alias@level as a fixed level for that candidate", () => {
    const policy = requirePolicy(parseRoutingPolicy(fixture));

    for (const level of ["low", "medium", "high", "very-high"] as const) {
      expect(policy.roles.planner?.[level]).toEqual([
        { alias: "P", level: "low" },
        { alias: "Q", level: "low" },
      ]);
    }
    expect(policy.roles.architect?.high?.[0]).toEqual({ alias: "A1", level: "high" });
    expect(policy.roles.general?.high).toEqual([
      { alias: "R2", level: null },
      { alias: "R1", level: null },
      { alias: "P", level: "low" },
    ]);
  });

  it("reads model ids, provider headings and per-level options", () => {
    const policy = requirePolicy(parseRoutingPolicy(fixture));
    const alias = (name: string) => policy.aliases.find((entry) => entry.alias === name);

    expect(alias("I1")?.model).toBe("beta-model-one");
    expect(alias("I1")?.provider).toEqual({ instanceId: "beta", driverKind: "codex" });
    expect(alias("A3")?.provider).toEqual({ instanceId: "alpha", driverKind: "acp" });
    expect(alias("A3")?.options).toEqual({
      low: {},
      medium: {},
      high: {},
      "very-high": {},
    });
    expect(alias("I2")?.options.low).toEqual({ reasoningEffort: "medium", stream: false });
    expect(alias("P")?.options["very-high"]).toEqual({ thinking: "max" });
    expect(alias("R3")?.options.low).toEqual({ variant: "none" });
  });

  it("warns about an accelerated model and keeps the policy", () => {
    const result = parseRoutingPolicy(fixture);
    const warning = findIssue(result, "accelerated_candidate");

    expect(result.policy).not.toBeNull();
    expect(result.issues).toHaveLength(1);
    expect(warning?.severity).toBe("warning");
    expect(warning?.line).toBe(lineOf(fixture, "beta-model-two-highspeed"));
    expect(warning?.message).toBe(
      'Candidate "IH" requests an accelerated service tier and will always be skipped.',
    );
  });
});

describe("routing policy row errors", () => {
  it("rejects a cell explanation and names its line", () => {
    const content = buildDocument({
      roleRows: [...DEFAULT_ROLE_ROWS, "| `planner` | A1 (all low) | A1 | A1 | A1 |"],
    });

    const result = parseRoutingPolicy(content);
    const problem = findIssue(result, "table_row_invalid");
    const line = lineOf(content, "(all low)");

    expect(result.policy).toBeNull();
    expect(problem?.line).toBe(line);
    expect(problem?.message).toBe(
      `Routing policy line ${line}: cannot parse "A1 (all low)": "A1 (all low)" is not an alias or alias@level.`,
    );
  });

  it("rejects a row with the wrong column count on its line", () => {
    const content = buildDocument({
      roleRows: [...DEFAULT_ROLE_ROWS, "| `planner` | A1 | A1 | A1 |"],
    });

    const problem = findIssue(parseRoutingPolicy(content), "table_row_invalid");

    expect(problem?.line).toBe(lineOf(content, "| `planner` | A1 | A1 | A1 |"));
    expect(problem?.message).toContain("expected 5 columns, got 4");
  });

  it("rejects lead and an unknown role in the first column", () => {
    const content = buildDocument({
      roleRows: [...DEFAULT_ROLE_ROWS, "| `lead` | A1 | A1 | A1 | A1 |"],
    });
    const unknown = buildDocument({
      roleRows: [...DEFAULT_ROLE_ROWS, "| `designer` | A1 | A1 | A1 | A1 |"],
    });

    expect(findIssue(parseRoutingPolicy(content), "table_row_invalid")?.message).toContain(
      'unknown role "lead"',
    );
    expect(findIssue(parseRoutingPolicy(unknown), "table_row_invalid")?.message).toContain(
      'unknown role "designer"',
    );
  });

  it("rejects an unknown alias@level", () => {
    const content = buildDocument({
      roleRows: [...DEFAULT_ROLE_ROWS, "| `planner` | A1@turbo | A1 | A1 | A1 |"],
    });

    const problem = findIssue(parseRoutingPolicy(content), "table_row_invalid");

    expect(problem?.line).toBe(lineOf(content, "A1@turbo"));
    expect(problem?.message).toContain('unknown level "turbo"');
  });

  it("rejects a candidate alias that no alias table declares", () => {
    const content = buildDocument({
      roleRows: [...DEFAULT_ROLE_ROWS, "| `planner` | Z9 → A1 | A1 | A1 | A1 |"],
    });

    const problem = findIssue(parseRoutingPolicy(content), "candidate_alias_unknown");
    const line = lineOf(content, "Z9 → A1");

    expect(problem?.line).toBe(line);
    expect(problem?.message).toBe(
      `Routing policy line ${line}: candidate alias "Z9" is not declared in any alias table.`,
    );
  });

  it("reports a role that appears in two rows", () => {
    const content = buildDocument({
      roleRows: [
        DEFAULT_ROLE_ROWS[0]!,
        DEFAULT_ROLE_ROWS[1]!,
        "| `implementation` | A1@low | A1 | A1 | A1 |",
        ...DEFAULT_ROLE_ROWS.slice(2),
      ],
    });

    const problem = findIssue(parseRoutingPolicy(content), "role_mapping_conflict");

    expect(problem?.line).toBe(lineOf(content, "A1@low"));
    expect(problem?.message).toContain('"implementation" is already assigned');
  });

  it("treats an empty cell and an em dash as no candidate", () => {
    const content = buildDocument({
      roleRows: [...DEFAULT_ROLE_ROWS, "| `planner` |  | — | A1 | A1 |"],
    });
    const policy = requirePolicy(parseRoutingPolicy(content));

    expect(policy.roles.planner?.low).toEqual([]);
    expect(policy.roles.planner?.medium).toEqual([]);
    expect(policy.roles.planner?.high).toEqual([{ alias: "A1", level: null }]);
  });
});

describe("routing policy table errors", () => {
  const aliasOnly = ["---", "revision: 1", "---", "", ...DEFAULT_ALIAS_ROWS, ""].join("\n");

  it("reports a missing role × level table", () => {
    const result = parseRoutingPolicy(aliasOnly);
    const problem = findIssue(result, "routing_table_missing");

    expect(result.policy).toBeNull();
    expect(problem?.line).toBeNull();
    expect(problem?.message).toBe(
      "Routing policy has no role × level table (columns low, medium, high, very-high).",
    );
  });

  it("reports a second role × level table on its line", () => {
    const content = `${buildDocument()}\n|Role|low|medium|high|very-high|\n|---|---|---|---|---|\n| \`planner\` | A1 | A1 | A1 | A1 |\n`;
    const problem = findIssue(parseRoutingPolicy(content), "routing_table_duplicate");

    expect(problem?.line).toBe(lineOf(content, "|Role|low|medium|high|very-high|"));
    expect(problem?.message).toContain("a second role × level table was found");
  });

  it("reports an alias table without a provider heading", () => {
    const content = buildDocument({
      aliasRows: ["### Notes", ...ALIAS_HEADER, "| A1 | `alpha-one` | — | — | — | — |"],
    });

    const problem = findIssue(parseRoutingPolicy(content), "alias_table_provider_missing");

    expect(problem?.line).toBe(
      lineOf(content, "| Alias | model | low | medium | high | very-high |"),
    );
    expect(problem?.message).toContain(
      "alias table has no preceding heading ending in (`<providerInstanceId> / <driverKind>`).",
    );
  });

  it("reports a duplicate alias with the first declaration line", () => {
    const content = buildDocument({
      aliasRows: [...DEFAULT_ALIAS_ROWS, "| A1 | `alpha-two` | — | — | — | — |"],
    });

    const problem = findIssue(parseRoutingPolicy(content), "alias_duplicate");
    const first = lineOf(content, "| A1 | `alpha-one`");
    const duplicate = lineOf(content, "alpha-two");

    expect(problem?.line).toBe(duplicate);
    expect(problem?.message).toBe(
      `Routing policy line ${duplicate}: alias "A1" is already declared at line ${first}.`,
    );
  });

  it("reports a template with no candidates as unconfigured", () => {
    const result = parseRoutingPolicy(readFixture("../assets/routing-policy.md"));

    expect(result.policy).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toEqual(["document_unconfigured"]);
    expect(result.issues[0]?.message).toBe(
      'Document "routingPolicy" is a template. Fill it in (roles and skills: set "configured: true").',
    );
  });
});

describe("routing policy frontmatter and required roles", () => {
  it("rejects a revision below one on its line", () => {
    const content = buildDocument({ revision: "0" });
    const problem = findIssue(parseRoutingPolicy(content), "frontmatter_invalid");

    expect(problem?.line).toBe(2);
    expect(problem?.message).toBe(
      'Document "routingPolicy" line 2: expected revision >= 1, got "0".',
    );
  });

  it("rejects a document without frontmatter", () => {
    const content = [...CELL_HEADER, ...DEFAULT_ROLE_ROWS, "", ...DEFAULT_ALIAS_ROWS, ""].join(
      "\n",
    );
    const problem = findIssue(parseRoutingPolicy(content), "frontmatter_invalid");

    expect(problem?.line).toBe(1);
    expect(problem?.message).toBe(
      'Document "routingPolicy" line 1: expected revision >= 1, got "missing".',
    );
  });

  it("keeps planner optional until the caller requires it", () => {
    const content = buildDocument();

    expect(parseRoutingPolicy(content).policy).not.toBeNull();

    const result = parseRoutingPolicy(content, { requiredRoles: ["planner"] });
    const problem = findIssue(result, "role_missing");

    expect(result.policy).toBeNull();
    expect(problem?.message).toBe(
      'Role "planner" is required by planning. Add its roles.json entry and Markdown file.',
    );
  });
});

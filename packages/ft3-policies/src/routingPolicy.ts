/**
 * The routing policy is a human-edited markdown document. Only two table shapes
 * are read, by shape, so headings, prose and other tables never matter and a
 * human keeps editing the document he already has.
 */

export const ROUTING_LEVELS = ["low", "medium", "high", "very-high"] as const;
export type RoutingLevel = (typeof ROUTING_LEVELS)[number];

export const ROUTING_ROLES = [
  "architect",
  "implementation",
  "review",
  "test",
  "research",
  "general",
  "planner",
] as const;
export type RoutingRoleId = (typeof ROUTING_ROLES)[number];

/** Rows every policy needs; `planner` is required only by the planning feature. */
export const REQUIRED_ROUTING_ROLES = [
  "architect",
  "implementation",
  "review",
  "test",
  "research",
  "general",
] as const satisfies readonly RoutingRoleId[];

export type RoutingOptionValue = string | boolean;
export type RoutingOptions = Readonly<Record<string, RoutingOptionValue>>;

export interface RoutingCandidate {
  readonly alias: string;
  /** Set by `alias@level`, which pins the model level whatever the task level is. */
  readonly level: RoutingLevel | null;
}

/** Candidates per task level, in fallback order. */
export type RoutingCells = Readonly<Record<RoutingLevel, readonly RoutingCandidate[]>>;

export interface RoutingProvider {
  readonly instanceId: string;
  readonly driverKind: string;
}

export interface RoutingAliasTarget {
  readonly alias: string;
  readonly model: string;
  readonly provider: RoutingProvider;
  readonly options: Readonly<Record<RoutingLevel, RoutingOptions>>;
  readonly line: number;
}

export interface RoutingPolicy {
  readonly revision: number;
  readonly roles: Readonly<Partial<Record<RoutingRoleId, RoutingCells>>>;
  readonly aliases: readonly RoutingAliasTarget[];
}

export const ROUTING_POLICY_ISSUE_CODES = [
  "frontmatter_invalid",
  "table_row_invalid",
  "candidate_alias_unknown",
  "routing_table_missing",
  "routing_table_duplicate",
  "alias_table_provider_missing",
  "alias_duplicate",
  "role_mapping_conflict",
  "role_missing",
  "document_unconfigured",
  "accelerated_candidate",
] as const;
export type RoutingPolicyIssueCode = (typeof ROUTING_POLICY_ISSUE_CODES)[number];

export interface RoutingPolicyIssue {
  readonly code: RoutingPolicyIssueCode;
  readonly severity: "error" | "warning";
  /** 1-based line of the source document, or null when the defect has no line. */
  readonly line: number | null;
  readonly message: string;
}

export interface RoutingPolicyParseOptions {
  /** Role rows the calling feature needs in addition to `REQUIRED_ROUTING_ROLES`. */
  readonly requiredRoles?: readonly RoutingRoleId[];
}

export interface RoutingPolicyParseResult {
  /** Null when any error was recorded; warnings alone keep the policy. */
  readonly policy: RoutingPolicy | null;
  readonly issues: readonly RoutingPolicyIssue[];
}

const ROUTING_POLICY_KEY = "routingPolicy";
const CELL_TABLE_COLUMNS = 5;
const ALIAS_TABLE_COLUMNS = 6;
// The document writes an em dash for an empty cell; comparing its code point
// keeps it out of product copy.
const isEmptyCell = (text: string): boolean =>
  text === "" || (text.length === 1 && text.charCodeAt(0) === 0x2014);
const HEADING_PATTERN = /^\s{0,3}(#{1,4})\s+(.*)$/u;
const PROVIDER_SUFFIX_PATTERN = /\(`([^`]+)`\)\s*$/u;
const DELIMITER_PATTERN = /^:?-+:?$/u;
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const BACKTICKED_PATTERN = /^`([^`]+)`$/u;
const MODEL_PATTERN = /^`([^`]+)`/u;
const OPTION_PATTERN = /^([A-Za-z][A-Za-z0-9_.-]*)=(.+)$/u;
const CANDIDATE_SEPARATOR_PATTERN = /→|>/u;
const ACCELERATED_MODEL_SUFFIX = "-highspeed";

const ROLE_BY_LABEL: Readonly<Record<string, RoutingRoleId>> = {
  architect: "architect",
  implementation: "implementation",
  review: "review",
  test: "test",
  research: "research",
  general: "general",
  planner: "planner",
};

const LEVELS: ReadonlySet<string> = new Set(ROUTING_LEVELS);

interface TableRow {
  readonly line: number;
  readonly text: string;
  readonly cells: readonly string[];
}

interface AliasTable {
  readonly headerLine: number;
  readonly provider: RoutingProvider | null;
  readonly rows: readonly TableRow[];
}

type ParseOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

interface FrontmatterReading {
  readonly revision: number | null;
  readonly line: number;
  readonly actual: string;
  readonly bodyStart: number;
}

const policyIssue = (
  code: RoutingPolicyIssueCode,
  severity: "error" | "warning",
  line: number | null,
  message: string,
): RoutingPolicyIssue => ({ code, severity, line, message });

const rowIssue = (line: number, text: string, reason: string): RoutingPolicyIssue =>
  policyIssue(
    "table_row_invalid",
    "error",
    line,
    `Routing policy line ${line}: cannot parse "${text}": ${reason}.`,
  );

const candidateAliasUnknownIssue = (line: number, alias: string): RoutingPolicyIssue =>
  policyIssue(
    "candidate_alias_unknown",
    "error",
    line,
    `Routing policy line ${line}: candidate alias "${alias}" is not declared in any alias table.`,
  );

const routingTableMissingIssue = (): RoutingPolicyIssue =>
  policyIssue(
    "routing_table_missing",
    "error",
    null,
    "Routing policy has no role × level table (columns low, medium, high, very-high).",
  );

const routingTableDuplicateIssue = (line: number): RoutingPolicyIssue =>
  policyIssue(
    "routing_table_duplicate",
    "error",
    line,
    `Routing policy line ${line}: a second role × level table was found; keep exactly one.`,
  );

const aliasTableProviderMissingIssue = (line: number): RoutingPolicyIssue =>
  policyIssue(
    "alias_table_provider_missing",
    "error",
    line,
    `Routing policy line ${line}: alias table has no preceding heading ending in (\`<providerInstanceId> / <driverKind>\`).`,
  );

const aliasDuplicateIssue = (line: number, alias: string, firstLine: number): RoutingPolicyIssue =>
  policyIssue(
    "alias_duplicate",
    "error",
    line,
    `Routing policy line ${line}: alias "${alias}" is already declared at line ${firstLine}.`,
  );

const roleMappingConflictIssue = (
  entry: number,
  line: number,
  role: RoutingRoleId,
): RoutingPolicyIssue =>
  policyIssue(
    "role_mapping_conflict",
    "error",
    line,
    `Roles.json entry ${entry}: "${role}" is already assigned; role mappings must be unique.`,
  );

const roleMissingIssue = (role: RoutingRoleId): RoutingPolicyIssue => {
  const feature = role === "planner" ? "planning" : "mail";
  return policyIssue(
    "role_missing",
    "error",
    null,
    `Role "${role}" is required by ${feature}. Add its roles.json entry and Markdown file.`,
  );
};

const documentUnconfiguredIssue = (): RoutingPolicyIssue =>
  policyIssue(
    "document_unconfigured",
    "error",
    null,
    `Document "${ROUTING_POLICY_KEY}" is a template. Fill it in (roles and skills: set "configured: true").`,
  );

const frontmatterInvalidIssue = (line: number, actual: string): RoutingPolicyIssue =>
  policyIssue(
    "frontmatter_invalid",
    "error",
    line,
    `Document "${ROUTING_POLICY_KEY}" line ${line}: expected revision >= 1, got "${actual}".`,
  );

const acceleratedCandidateIssue = (line: number, alias: string): RoutingPolicyIssue =>
  policyIssue(
    "accelerated_candidate",
    "warning",
    line,
    `Candidate "${alias}" requests an accelerated service tier and will always be skipped.`,
  );

const isLevel = (value: string): value is RoutingLevel => LEVELS.has(value);

const isTableRow = (line: string): boolean => {
  const trimmed = line.trim();
  if (trimmed === "") return false;
  return trimmed.startsWith("|") || trimmed.split("|").length >= 3;
};

const splitRow = (line: string): readonly string[] => {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text.split("|").map((cell) => cell.trim());
};

const isDelimiterRow = (line: string): boolean => {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => DELIMITER_PATTERN.test(cell));
};

/** Removes backticks that wrap the whole cell, which the document format allows. */
const stripCell = (text: string): string => {
  const trimmed = text.trim();
  const wrapped = BACKTICKED_PATTERN.exec(trimmed);
  return wrapped === null ? trimmed : (wrapped[1] ?? "").trim();
};

const isCellsHeader = (header: readonly string[]): boolean =>
  header.length === CELL_TABLE_COLUMNS &&
  header[1] === "low" &&
  header[2] === "medium" &&
  header[3] === "high" &&
  header[4] === "very-high";

const isAliasHeader = (header: readonly string[]): boolean =>
  header.length === ALIAS_TABLE_COLUMNS &&
  header[1] === "model" &&
  header[2] === "low" &&
  header[3] === "medium" &&
  header[4] === "high" &&
  header[5] === "very-high";

const parseProviderHeading = (
  line: string,
): { readonly isHeading: boolean; readonly provider: RoutingProvider | null } => {
  const heading = HEADING_PATTERN.exec(line);
  if (heading === null) return { isHeading: false, provider: null };
  const suffix = PROVIDER_SUFFIX_PATTERN.exec(heading[2] ?? "");
  if (suffix === null) return { isHeading: true, provider: null };
  const parts = (suffix[1] ?? "").split("/").map((part) => part.trim());
  const instanceId = parts[0] ?? "";
  const driverKind = parts[1] ?? "";
  if (parts.length !== 2 || instanceId === "" || driverKind === "") {
    return { isHeading: true, provider: null };
  }
  return { isHeading: true, provider: { instanceId, driverKind } };
};

const normalizeRole = (label: string): RoutingRoleId | null => {
  const direct = ROLE_BY_LABEL[label];
  if (direct !== undefined) return direct;
  if (label.startsWith("architect-")) return "architect";
  if (label.startsWith("review-")) return "review";
  return null;
};

const parseRoleCell = (cell: string): ParseOutcome<readonly RoutingRoleId[]> => {
  const text = cell.trim();
  if (text === "") return { ok: false, reason: "expected at least one role" };
  const roles: RoutingRoleId[] = [];
  for (const token of text.split(",")) {
    const label = token.trim();
    const wrapped = BACKTICKED_PATTERN.exec(label);
    if (wrapped === null) return { ok: false, reason: `role "${label}" must be in backticks` };
    const raw = wrapped[1] ?? "";
    const role = normalizeRole(raw);
    if (role === null) return { ok: false, reason: `unknown role "${raw}"` };
    if (!roles.includes(role)) roles.push(role);
  }
  return { ok: true, value: roles };
};

const parseCandidateCell = (cell: string): ParseOutcome<readonly RoutingCandidate[]> => {
  const text = stripCell(cell);
  if (isEmptyCell(text)) return { ok: true, value: [] };
  const candidates: RoutingCandidate[] = [];
  for (const part of text.split(CANDIDATE_SEPARATOR_PATTERN)) {
    const token = stripCell(part);
    if (isEmptyCell(token)) return { ok: false, reason: "a candidate is missing" };
    const separator = token.lastIndexOf("@");
    const alias = separator === -1 ? token : token.slice(0, separator);
    const level = separator === -1 ? null : token.slice(separator + 1);
    if (!ALIAS_PATTERN.test(alias)) {
      return { ok: false, reason: `"${token}" is not an alias or alias@level` };
    }
    if (level !== null && !isLevel(level)) return { ok: false, reason: `unknown level "${level}"` };
    candidates.push({ alias, level });
  }
  return { ok: true, value: candidates };
};

const parseOptionsCell = (cell: string): ParseOutcome<RoutingOptions> => {
  const text = stripCell(cell);
  if (isEmptyCell(text)) return { ok: true, value: {} };
  const options: Record<string, RoutingOptionValue> = {};
  for (const part of text.split(",")) {
    const pair = part.trim();
    const match = OPTION_PATTERN.exec(pair);
    if (match === null) return { ok: false, reason: `"${pair}" is not a key=value option` };
    const key = match[1] ?? "";
    const value = (match[2] ?? "").trim();
    if (value === "") return { ok: false, reason: `option "${key}" has no value` };
    options[key] = value === "true" ? true : value === "false" ? false : value;
  }
  return { ok: true, value: options };
};

const readFrontmatter = (lines: readonly string[]): FrontmatterReading => {
  const first = (lines[0] ?? "").replace(/^\uFEFF/u, "");
  if (first.trim() !== "---") {
    return { revision: null, line: 1, actual: "missing", bodyStart: 0 };
  }
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  const end = close === -1 ? lines.length : close;
  for (let index = 1; index < end; index += 1) {
    const match = /^revision:\s*(.*)$/u.exec((lines[index] ?? "").trim());
    if (match === null) continue;
    const raw = (match[1] ?? "").trim();
    const value = /^\d+$/u.test(raw) ? Number(raw) : Number.NaN;
    const revision = Number.isSafeInteger(value) && value >= 1 ? value : null;
    return {
      revision,
      line: index + 1,
      actual: raw === "" ? "missing" : raw,
      bodyStart: close === -1 ? lines.length : close + 1,
    };
  }
  return {
    revision: null,
    line: 1,
    actual: "missing",
    bodyStart: close === -1 ? lines.length : close + 1,
  };
};

const emptyCells = (): Record<RoutingLevel, readonly RoutingCandidate[]> => ({
  low: [],
  medium: [],
  high: [],
  "very-high": [],
});

const emptyOptions = (): Record<RoutingLevel, RoutingOptions> => ({
  low: {},
  medium: {},
  high: {},
  "very-high": {},
});

export const parseRoutingPolicy = (
  content: string,
  options: RoutingPolicyParseOptions = {},
): RoutingPolicyParseResult => {
  const issues: RoutingPolicyIssue[] = [];
  const lines = content.split(/\r?\n/u);
  const frontmatter = readFrontmatter(lines);
  if (frontmatter.revision === null) {
    issues.push(frontmatterInvalidIssue(frontmatter.line, frontmatter.actual));
  }

  let cellsTable: { readonly headerLine: number; readonly rows: readonly TableRow[] } | null = null;
  const aliasTables: AliasTable[] = [];
  let provider: RoutingProvider | null = null;

  for (let index = frontmatter.bodyStart; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const heading = parseProviderHeading(line);
    if (heading.isHeading) {
      provider = heading.provider;
      continue;
    }
    const delimiter = lines[index + 1];
    if (!isTableRow(line) || delimiter === undefined || !isDelimiterRow(delimiter)) continue;

    const header = splitRow(line);
    const rows: TableRow[] = [];
    let cursor = index + 2;
    while (cursor < lines.length) {
      const row = lines[cursor] ?? "";
      if (!isTableRow(row) || isDelimiterRow(row)) break;
      rows.push({ line: cursor + 1, text: row.trim(), cells: splitRow(row) });
      cursor += 1;
    }

    if (isCellsHeader(header)) {
      if (cellsTable === null) cellsTable = { headerLine: index + 1, rows };
      else issues.push(routingTableDuplicateIssue(index + 1));
    } else if (isAliasHeader(header)) {
      aliasTables.push({ headerLine: index + 1, provider, rows });
    }
    index = cursor - 1;
  }

  const aliasLines = new Map<string, number>();
  const declaredAliases = new Set<string>();
  const aliases: RoutingAliasTarget[] = [];

  for (const table of aliasTables) {
    if (table.provider === null) issues.push(aliasTableProviderMissingIssue(table.headerLine));
    for (const row of table.rows) {
      if (row.cells.length !== ALIAS_TABLE_COLUMNS) {
        issues.push(
          rowIssue(
            row.line,
            row.text,
            `expected ${ALIAS_TABLE_COLUMNS} columns, got ${row.cells.length}`,
          ),
        );
        continue;
      }
      const alias = stripCell(row.cells[0] ?? "");
      if (!ALIAS_PATTERN.test(alias)) {
        issues.push(rowIssue(row.line, alias, `"${alias}" is not an alias`));
        continue;
      }
      const firstLine = aliasLines.get(alias);
      if (firstLine !== undefined) {
        issues.push(aliasDuplicateIssue(row.line, alias, firstLine));
        continue;
      }
      aliasLines.set(alias, row.line);
      declaredAliases.add(alias);

      const modelCell = row.cells[1] ?? "";
      const model = MODEL_PATTERN.exec(modelCell.trim())?.[1]?.trim() ?? "";
      if (model === "") {
        issues.push(rowIssue(row.line, modelCell, "expected the model id in backticks"));
        continue;
      }

      const levelOptions = emptyOptions();
      let optionsValid = true;
      for (const [levelIndex, level] of ROUTING_LEVELS.entries()) {
        const cell = row.cells[levelIndex + 2] ?? "";
        const parsed = parseOptionsCell(cell);
        if (!parsed.ok) {
          issues.push(rowIssue(row.line, cell, parsed.reason));
          optionsValid = false;
          break;
        }
        levelOptions[level] = parsed.value;
      }
      const tableProvider = table.provider;
      if (!optionsValid || tableProvider === null) continue;

      aliases.push({
        alias,
        model,
        provider: tableProvider,
        options: levelOptions,
        line: row.line,
      });
      if (model.endsWith(ACCELERATED_MODEL_SUFFIX)) {
        issues.push(acceleratedCandidateIssue(row.line, alias));
      }
    }
  }

  const roles: Partial<Record<RoutingRoleId, RoutingCells>> = {};
  let candidateCount = 0;

  if (cellsTable === null) {
    issues.push(routingTableMissingIssue());
  } else {
    const roleLines = new Set<RoutingRoleId>();
    for (const [rowIndex, row] of cellsTable.rows.entries()) {
      if (row.cells.length !== CELL_TABLE_COLUMNS) {
        issues.push(
          rowIssue(
            row.line,
            row.text,
            `expected ${CELL_TABLE_COLUMNS} columns, got ${row.cells.length}`,
          ),
        );
        continue;
      }
      const parsedRoles = parseRoleCell(row.cells[0] ?? "");
      if (!parsedRoles.ok) {
        issues.push(rowIssue(row.line, row.cells[0] ?? "", parsedRoles.reason));
        continue;
      }

      const cells = emptyCells();
      let cellsValid = true;
      for (const [levelIndex, level] of ROUTING_LEVELS.entries()) {
        const cell = row.cells[levelIndex + 1] ?? "";
        const parsed = parseCandidateCell(cell);
        if (!parsed.ok) {
          issues.push(rowIssue(row.line, cell, parsed.reason));
          cellsValid = false;
          break;
        }
        cells[level] = parsed.value;
      }
      if (!cellsValid) continue;

      let conflict = false;
      for (const role of parsedRoles.value) {
        if (roleLines.has(role)) {
          issues.push(roleMappingConflictIssue(rowIndex + 1, row.line, role));
          conflict = true;
        }
      }
      if (conflict) continue;
      for (const role of parsedRoles.value) {
        roleLines.add(role);
        roles[role] = cells;
      }

      for (const level of ROUTING_LEVELS) {
        for (const candidate of cells[level]) {
          candidateCount += 1;
          if (!declaredAliases.has(candidate.alias)) {
            issues.push(candidateAliasUnknownIssue(row.line, candidate.alias));
          }
        }
      }
    }

    const requiredRoles = new Set<RoutingRoleId>([
      ...REQUIRED_ROUTING_ROLES,
      ...(options.requiredRoles ?? []),
    ]);
    for (const role of ROUTING_ROLES) {
      if (requiredRoles.has(role) && roles[role] === undefined) issues.push(roleMissingIssue(role));
    }

    if (candidateCount === 0) issues.push(documentUnconfiguredIssue());
  }

  issues.sort((left, right) => lineRank(left.line) - lineRank(right.line));
  const revision = frontmatter.revision;
  const failed = issues.some((issue) => issue.severity === "error");
  return {
    policy: failed || revision === null ? null : { revision, roles, aliases },
    issues,
  };
};

const lineRank = (line: number | null): number => line ?? Number.MAX_SAFE_INTEGER;

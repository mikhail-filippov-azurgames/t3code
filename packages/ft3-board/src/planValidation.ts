/**
 * The strict plan check that runs only on acceptance (design §4.4): the
 * frontmatter names this card, and `## Steps` lists unique `P<n>` step ids.
 */
export interface PlanIssue {
  /** 1-based line of the plan file. */
  readonly line: number;
  readonly reason: string;
}

const PLAN_SCHEMA = "corvis-plan-v1";
const STEP_ID_PATTERN = /^P\d+$/;

const splitRow = (line: string): ReadonlyArray<string> =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

const frontmatterIssues = (lines: ReadonlyArray<string>, cardId: string): PlanIssue[] => {
  if (lines[0]?.trim() !== "---") return [{ line: 1, reason: "frontmatter is missing" }];
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return [{ line: 1, reason: "frontmatter is not closed" }];
  const issues: PlanIssue[] = [];
  const fields = new Map<string, { readonly line: number; readonly value: string }>();
  for (let index = 1; index < end; index += 1) {
    const match = /^([A-Za-z]+):\s*(.*?)\s*$/.exec(lines[index] ?? "");
    if (match) fields.set(match[1] ?? "", { line: index + 1, value: match[2] ?? "" });
  }
  const schema = fields.get("schema");
  if (schema === undefined) issues.push({ line: 1, reason: "schema is missing" });
  else if (schema.value !== PLAN_SCHEMA)
    issues.push({ line: schema.line, reason: `expected schema ${PLAN_SCHEMA}` });
  const plannedCard = fields.get("cardId");
  if (plannedCard === undefined) issues.push({ line: 1, reason: "cardId is missing" });
  else if (plannedCard.value !== cardId)
    issues.push({ line: plannedCard.line, reason: `expected cardId ${cardId}` });
  return issues;
};

interface StepsTable {
  /** 0-based line of the table header row. */
  readonly header: number;
  /** Data rows below the header and separator rows. */
  readonly rows: ReadonlyArray<{ line: number; stepId: string }>;
}

/** The `## Steps` table; null when the section or its table is missing. */
const findStepsTable = (lines: ReadonlyArray<string>): StepsTable | null => {
  const heading = lines.findIndex((line) => line.trim() === "## Steps");
  if (heading === -1) return null;
  const header = lines.findIndex((line, index) => index > heading && line.trim().startsWith("|"));
  if (header === -1) return null;
  const rows: Array<{ line: number; stepId: string }> = [];
  for (let index = header + 2; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim().startsWith("|")) break;
    rows.push({ line: index + 1, stepId: splitRow(line)[0] ?? "" });
  }
  return { header, rows };
};

const stepsIssues = (lines: ReadonlyArray<string>): PlanIssue[] => {
  const table = findStepsTable(lines);
  if (table === null) {
    const heading = lines.findIndex((line) => line.trim() === "## Steps");
    if (heading === -1) return [{ line: 1, reason: "## Steps section is missing" }];
    return [{ line: heading + 1, reason: "## Steps has no table" }];
  }
  const issues: PlanIssue[] = [];
  const seen = new Set<string>();
  for (const row of table.rows) {
    if (!STEP_ID_PATTERN.test(row.stepId)) {
      issues.push({ line: row.line, reason: `step id "${row.stepId}" must look like P1` });
    } else if (seen.has(row.stepId)) {
      issues.push({ line: row.line, reason: `step id "${row.stepId}" is repeated` });
    }
    seen.add(row.stepId);
  }
  if (table.rows.length === 0)
    issues.push({ line: table.header + 1, reason: "## Steps lists no steps" });
  return issues;
};

/** Data rows of the `## Steps` table; zero when the section or its table is missing. */
export const countPlanSteps = (content: string): number =>
  findStepsTable(content.split(/\r?\n/))?.rows.length ?? 0;

/** Every problem the strict check finds, in file order; empty when the plan can be accepted. */
export const validatePlan = (content: string, cardId: string): ReadonlyArray<PlanIssue> => {
  const lines = content.split(/\r?\n/);
  return [...frontmatterIssues(lines, cardId), ...stepsIssues(lines)];
};

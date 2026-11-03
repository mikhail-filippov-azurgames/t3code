/**
 * Strict parsers for `lead-skills.json` and each declared `SKILL.md`. The set
 * is fixed: t3-orchestrator and board-orchestrator serve the board,
 * plan-orchestrator serves planning.
 */
import type { PolicyDocumentKey, PolicyRequirementId } from "./contracts.ts";
import {
  documentUnconfiguredIssue,
  frontmatterInvalidIssue,
  hasBlockingIssue,
  leadSkillMissingIssue,
  type PolicyIssue,
} from "./diagnostics.ts";
import {
  documentLines,
  type DocumentFrontmatter,
  frontmatterField,
  frontmatterFields,
  parseDocumentFrontmatter,
} from "./documentFrontmatter.ts";
import {
  describePolicyJsonValue,
  parsePolicyJson,
  policyJsonProperty,
  type PolicyJsonNode,
  SourceLines,
} from "./policyJson.ts";

export const LEAD_SKILLS_DOCUMENT_KEY = "leadSkills" satisfies PolicyDocumentKey;
export const LEAD_SKILLS_MANIFEST_SCHEMA = "corvis-lead-skills-v1";

/** Lead skills the board and planning use; `create-orchestrator-architect` is retired. */
export const LEAD_SKILL_IDS = [
  "t3-orchestrator",
  "board-orchestrator",
  "plan-orchestrator",
] as const;
export type LeadSkillId = (typeof LEAD_SKILL_IDS)[number];

/** Skills a feature cannot work without. */
export const LEAD_SKILL_FEATURE_REQUIREMENTS: Readonly<
  Record<"board" | "planning", readonly LeadSkillId[]>
> = {
  board: ["t3-orchestrator", "board-orchestrator"],
  planning: ["plan-orchestrator"],
};

export type LeadSkillsFeature = keyof typeof LEAD_SKILL_FEATURE_REQUIREMENTS;

export interface LeadSkillsFeatureRequest {
  readonly board?: boolean;
  readonly planning?: boolean;
}

export interface ParsedLeadSkillEntry {
  /** 1-based position in the `skills` array. */
  readonly index: number;
  readonly id: LeadSkillId;
  /** Path relative to the lead-skills directory. */
  readonly file: string;
  /** Line of the entry object inside `lead-skills.json`. */
  readonly line: number;
}

export interface ParsedLeadSkillFile {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

export interface ParsedLeadSkillsDocument {
  readonly key: typeof LEAD_SKILLS_DOCUMENT_KEY;
  readonly valid: boolean;
  readonly configured: boolean;
  readonly revision: number | null;
  readonly skills: readonly ParsedLeadSkillEntry[];
  readonly files: ReadonlyMap<string, ParsedLeadSkillFile>;
  readonly issues: readonly PolicyIssue[];
  readonly requirements: Readonly<Partial<Record<PolicyRequirementId, boolean>>>;
}

export interface LeadSkillsDocumentInput {
  /** The contents of `lead-skills.json`. */
  readonly manifest: string;
  /** `SKILL.md` contents keyed by the manifest-relative `file` value. */
  readonly files: ReadonlyMap<string, string>;
  readonly features?: LeadSkillsFeatureRequest;
}

const supportedLeadSkill = (value: string): value is LeadSkillId =>
  (LEAD_SKILL_IDS as readonly string[]).includes(value);

const isNonEmptyString = (
  node: PolicyJsonNode | undefined,
): node is PolicyJsonNode & {
  kind: "string";
} => node !== undefined && node.kind === "string" && node.value.trim().length > 0;

/** A skill `file` must stay inside the lead-skills directory and name a SKILL.md. */
export function isLeadSkillRelativeFile(value: string): boolean {
  if (value.length === 0 || value.length > 4096) return false;
  if (value !== value.trim()) return false;
  if (value.startsWith("/") || value.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  if (value.includes("\\")) return false;
  if (!value.toLowerCase().endsWith(".md")) return false;
  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

interface ManifestParse {
  readonly entries: readonly ParsedLeadSkillEntry[];
  readonly revision: number | null;
  readonly configured: boolean;
  readonly parsed: boolean;
}

function manifestIssue(
  lines: SourceLines,
  offset: number,
  expected: string,
  actual: string,
): PolicyIssue {
  return frontmatterInvalidIssue(
    LEAD_SKILLS_DOCUMENT_KEY,
    lines.lineOf(offset),
    lines.textOf(offset),
    expected,
    actual,
    { file: "lead-skills.json" },
  );
}

function parseManifest(source: string, issues: PolicyIssue[]): ManifestParse {
  const json = parsePolicyJson(source);
  if (!json.ok) {
    const lines = new SourceLines(source);
    issues.push(
      manifestIssue(lines, json.offset, "a valid JSON lead-skills manifest", json.message),
    );
    return { entries: [], revision: null, configured: false, parsed: false };
  }

  const lines = new SourceLines(source);
  const root = json.value;
  if (root.kind !== "object") {
    issues.push(
      manifestIssue(
        lines,
        root.offset,
        'a lead-skills manifest object with "schema"',
        describePolicyJsonValue(root),
      ),
    );
    return { entries: [], revision: null, configured: false, parsed: false };
  }

  let parsed = true;
  const schema = policyJsonProperty(root, "schema");
  if (schema === undefined) {
    issues.push(
      manifestIssue(
        lines,
        root.offset,
        `schema: ${LEAD_SKILLS_MANIFEST_SCHEMA}`,
        "no schema field",
      ),
    );
    parsed = false;
  } else if (schema.value.kind !== "string" || schema.value.value !== LEAD_SKILLS_MANIFEST_SCHEMA) {
    issues.push(
      manifestIssue(
        lines,
        schema.value.offset,
        `schema: ${LEAD_SKILLS_MANIFEST_SCHEMA}`,
        describePolicyJsonValue(schema.value),
      ),
    );
    parsed = false;
  }

  let revision: number | null = null;
  const revisionProperty = policyJsonProperty(root, "revision");
  if (revisionProperty === undefined) {
    issues.push(
      manifestIssue(lines, root.offset, "revision: an integer >= 0", "no revision field"),
    );
    parsed = false;
  } else if (
    revisionProperty.value.kind !== "number" ||
    !Number.isSafeInteger(revisionProperty.value.value) ||
    revisionProperty.value.value < 0
  ) {
    issues.push(
      manifestIssue(
        lines,
        revisionProperty.value.offset,
        "revision: an integer >= 0",
        describePolicyJsonValue(revisionProperty.value),
      ),
    );
    parsed = false;
  } else {
    revision = revisionProperty.value.value;
  }

  let configured = false;
  const configuredProperty = policyJsonProperty(root, "configured");
  if (configuredProperty === undefined) {
    issues.push(
      manifestIssue(lines, root.offset, "configured: true or false", "no configured field"),
    );
    parsed = false;
  } else if (configuredProperty.value.kind !== "boolean") {
    issues.push(
      manifestIssue(
        lines,
        configuredProperty.value.offset,
        "configured: true or false",
        describePolicyJsonValue(configuredProperty.value),
      ),
    );
    parsed = false;
  } else {
    configured = configuredProperty.value.value;
  }

  const skillsProperty = policyJsonProperty(root, "skills");
  const skillNodes =
    skillsProperty?.value.kind === "array" ? skillsProperty.value.items : undefined;
  if (skillsProperty === undefined) {
    issues.push(
      manifestIssue(lines, root.offset, "skills: an array of entries", "no skills field"),
    );
    parsed = false;
  } else if (skillNodes === undefined) {
    issues.push(
      manifestIssue(
        lines,
        skillsProperty.value.offset,
        "skills: an array of entries",
        describePolicyJsonValue(skillsProperty.value),
      ),
    );
    parsed = false;
  }

  const entries: ParsedLeadSkillEntry[] = [];
  const seenIds = new Set<string>();
  const seenFiles = new Set<string>();

  skillNodes?.forEach((node, zeroBasedIndex) => {
    const index = zeroBasedIndex + 1;
    if (node.kind !== "object") {
      issues.push(
        manifestIssue(
          lines,
          node.offset,
          "a lead skill entry object",
          describePolicyJsonValue(node),
        ),
      );
      parsed = false;
      return;
    }

    const idProperty = policyJsonProperty(node, "id");
    if (!isNonEmptyString(idProperty?.value)) {
      issues.push(
        manifestIssue(
          lines,
          idProperty?.value.offset ?? node.offset,
          `id: one of ${LEAD_SKILL_IDS.join(", ")}`,
          idProperty === undefined ? "no id field" : describePolicyJsonValue(idProperty.value),
        ),
      );
      parsed = false;
      return;
    }
    const idValue = idProperty.value.value;
    if (!supportedLeadSkill(idValue)) {
      issues.push(
        manifestIssue(
          lines,
          idProperty.value.offset,
          `id: one of ${LEAD_SKILL_IDS.join(", ")}`,
          idValue,
        ),
      );
      parsed = false;
      return;
    }
    if (seenIds.has(idValue)) {
      issues.push(
        manifestIssue(
          lines,
          idProperty.value.offset,
          `a unique lead skill id (${idValue} is already declared)`,
          idValue,
        ),
      );
      parsed = false;
    }
    seenIds.add(idValue);

    const fileProperty = policyJsonProperty(node, "file");
    if (
      !isNonEmptyString(fileProperty?.value) ||
      !isLeadSkillRelativeFile(fileProperty.value.value)
    ) {
      issues.push(
        manifestIssue(
          lines,
          fileProperty?.value.offset ?? node.offset,
          "file: a path inside the lead-skills directory ending in .md",
          fileProperty === undefined
            ? "no file field"
            : describePolicyJsonValue(fileProperty.value),
        ),
      );
      parsed = false;
      return;
    }
    const file = fileProperty.value.value;
    if (seenFiles.has(file)) {
      issues.push(
        manifestIssue(
          lines,
          fileProperty.value.offset,
          `a unique lead skill file (${file} is already declared)`,
          file,
        ),
      );
      parsed = false;
    }
    seenFiles.add(file);

    entries.push({ index, id: idValue, file, line: lines.lineOf(node.offset) });
  });

  return { entries, revision, configured, parsed };
}

interface ParsedLeadSkillFileResult {
  readonly file: ParsedLeadSkillFile | null;
  readonly issues: readonly PolicyIssue[];
}

function skillFileIssue(
  lines: readonly string[],
  line: number,
  expected: string,
  actual: string,
  file: string,
): PolicyIssue {
  return frontmatterInvalidIssue(
    LEAD_SKILLS_DOCUMENT_KEY,
    line,
    lines[line - 1] ?? "",
    expected,
    actual,
    { file },
  );
}

function singleField(
  frontmatter: DocumentFrontmatter,
  key: string,
  lines: readonly string[],
  file: string,
  issues: PolicyIssue[],
): string | null {
  const matches = frontmatterFields(frontmatter, key);
  const first = matches[0];
  if (first === undefined) {
    issues.push(skillFileIssue(lines, 1, `${key}: a required field`, `no ${key} field`, file));
    return null;
  }
  if (matches.length > 1) {
    const repeated = matches[1];
    issues.push(
      skillFileIssue(
        lines,
        repeated?.line ?? first.line,
        `a single "${key}" field`,
        repeated === undefined ? key : `${key} is repeated`,
        file,
      ),
    );
    return null;
  }
  if (first.value.length === 0) {
    issues.push(skillFileIssue(lines, first.line, `${key}: a non-empty value`, "", file));
    return null;
  }
  return first.value;
}

/** Reads one `SKILL.md`: `name` and `description` are required, the body is free-form. */
export function parseLeadSkillFile(content: string, file: string): ParsedLeadSkillFileResult {
  const lines = documentLines(content);
  const frontmatter = parseDocumentFrontmatter(content);
  const issues: PolicyIssue[] = [];

  if (!frontmatter.present) {
    issues.push(
      skillFileIssue(lines, 1, "frontmatter with name and description", "no frontmatter", file),
    );
    return { file: null, issues };
  }
  if (!frontmatter.closed) {
    issues.push(
      skillFileIssue(
        lines,
        lines.length,
        "a closing --- line for the frontmatter",
        "no closing ---",
        file,
      ),
    );
    return { file: null, issues };
  }
  for (const malformed of frontmatter.malformed) {
    issues.push(
      skillFileIssue(lines, malformed.line, "a key: value frontmatter field", malformed.text, file),
    );
  }

  const name = singleField(frontmatter, "name", lines, file, issues);
  const description = singleField(frontmatter, "description", lines, file, issues);

  if (name === null || description === null) return { file: null, issues };
  return { file: { name, description, body: frontmatter.body }, issues };
}

/**
 * Parses the whole lead-skills document set, checks `name` against the
 * manifest, and reports the skills the requested features need.
 */
export function parseLeadSkillsDocumentSet(
  input: LeadSkillsDocumentInput,
): ParsedLeadSkillsDocument {
  const issues: PolicyIssue[] = [];
  const manifest = parseManifest(input.manifest, issues);
  const files = new Map<string, ParsedLeadSkillFile>();

  for (const entry of manifest.entries) {
    const content = input.files.get(entry.file);
    if (content === undefined) {
      issues.push(
        leadSkillMissingIssue(entry.id, entry.file, {
          file: entry.file,
          line: entry.line,
          text: documentLines(input.manifest)[entry.line - 1] ?? "",
          hint: `The manifest declares "${entry.file}"; restore it or remove the entry.`,
        }),
      );
      continue;
    }
    const parsed = parseLeadSkillFile(content, entry.file);
    issues.push(...parsed.issues);
    if (parsed.file === null) continue;
    if (parsed.file.name !== entry.id) {
      const line = frontmatterField(parseDocumentFrontmatter(content), "name")?.line ?? 1;
      issues.push(
        frontmatterInvalidIssue(
          LEAD_SKILLS_DOCUMENT_KEY,
          line,
          documentLines(content)[line - 1] ?? "",
          `name "${entry.id}" from lead-skills.json`,
          parsed.file.name,
          { file: entry.file, subject: entry.id },
        ),
      );
      continue;
    }
    files.set(entry.file, parsed.file);
  }

  const usableSkill = (skillId: LeadSkillId): boolean =>
    manifest.entries.some((entry) => entry.id === skillId && files.has(entry.file));

  const requirements: Partial<Record<PolicyRequirementId, boolean>> = {};
  if (manifest.parsed) {
    for (const feature of Object.keys(LEAD_SKILL_FEATURE_REQUIREMENTS) as LeadSkillsFeature[]) {
      if (input.features?.[feature] !== true) continue;
      for (const skillId of LEAD_SKILL_FEATURE_REQUIREMENTS[feature]) {
        if (usableSkill(skillId)) continue;
        if (!manifest.configured) continue;
        const declared = manifest.entries.find((entry) => entry.id === skillId);
        issues.push(
          leadSkillMissingIssue(skillId, declared?.file ?? `${skillId}/SKILL.md`, {
            ...(declared === undefined ? {} : { file: declared.file }),
            hint: `Add ${skillId}/SKILL.md and declare it in lead-skills.json; ${feature} needs it.`,
          }),
        );
      }
    }
    requirements.leadSkills = !hasBlockingIssue(issues) && manifest.configured;
    if (input.features?.planning === true) {
      requirements.planOrchestratorSkill = usableSkill("plan-orchestrator") && manifest.configured;
    }
  }

  if (!manifest.configured) {
    issues.push(documentUnconfiguredIssue(LEAD_SKILLS_DOCUMENT_KEY));
  }

  return {
    key: LEAD_SKILLS_DOCUMENT_KEY,
    valid: !hasBlockingIssue(issues),
    configured: manifest.configured,
    revision: manifest.revision,
    skills: manifest.entries,
    files,
    issues,
    requirements,
  };
}

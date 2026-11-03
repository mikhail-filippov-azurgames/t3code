/**
 * Strict parsers for the roles document set: `roles.json` plus one Markdown
 * file per declared role. Roles carry no `documentsWrite`: write access follows
 * thread lineage and the lead's grant.
 */
import type { PolicyDocumentKey, PolicyRequirementId } from "./contracts.ts";
import {
  documentMissingIssue,
  documentUnconfiguredIssue,
  frontmatterInvalidIssue,
  hasBlockingIssue,
  type PolicyIssue,
  roleMappingConflictIssue,
  roleMissingIssue,
  roleUnknownIssue,
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

export const ROLES_DOCUMENT_KEY = "roles" satisfies PolicyDocumentKey;
export const ROLES_MANIFEST_SCHEMA = "corvis-role-map-v1";
export const ROLE_FILE_SCHEMA = "corvis-role-v1";

/**
 * Corvis delegated role ids a `roles.json` entry may map to. Mirrors
 * `DELEGATED_ROLE_IDS` in `@t3tools/ft3-delegation`; `ft3-delegation` depends on
 * this package, so the list lives here and the resolver will consume it.
 */
export const CORVIS_ROLE_IDS = [
  "lead",
  "architect",
  "architect-boundaries",
  "architect-data",
  "architect-failure",
  "architect-product",
  "planner",
  "implementation",
  "test",
  "research",
  "general",
  "review-common",
  "review-contracts",
  "review-failure-paths",
  "review-architecture",
] as const;
export type CorvisRoleId = (typeof CORVIS_ROLE_IDS)[number];

/** Upstream delegated-task roles; a manifest assigns at most one per entry. */
export const UPSTREAM_DELEGATED_ROLES = [
  "implementation",
  "research",
  "review",
  "design",
  "test",
  "general",
  "architecture",
] as const;
export type UpstreamDelegatedRole = (typeof UPSTREAM_DELEGATED_ROLES)[number];

/** Features whose role set is checked; the design requires them for board and planning. */
export interface RolesFeatureRequest {
  readonly board?: boolean;
  readonly planning?: boolean;
}

export interface ParsedRoleEntry {
  /** 1-based position in the `roles` array, as the conflict message counts it. */
  readonly index: number;
  /** The name the lead uses. */
  readonly id: string;
  readonly roleId: CorvisRoleId;
  /** Path relative to the roles directory. */
  readonly file: string;
  readonly upstreamRole: UpstreamDelegatedRole | null;
  /** Line of the entry object inside `roles.json`. */
  readonly line: number;
}

export interface ParsedRoleFile {
  readonly roleId: CorvisRoleId;
  readonly revision: number;
  readonly configured: boolean;
  readonly body: string;
}

export interface ParsedRolesDocument {
  readonly key: typeof ROLES_DOCUMENT_KEY;
  /** No error-severity issue: the version may be applied. */
  readonly valid: boolean;
  readonly configured: boolean;
  readonly revision: number | null;
  readonly roles: readonly ParsedRoleEntry[];
  readonly files: ReadonlyMap<string, ParsedRoleFile>;
  readonly issues: readonly PolicyIssue[];
  readonly requirements: Readonly<Partial<Record<PolicyRequirementId, boolean>>>;
}

export interface RolesDocumentInput {
  /** The contents of `roles.json`. */
  readonly manifest: string;
  /** Role Markdown contents keyed by the manifest-relative `file` value. */
  readonly files: ReadonlyMap<string, string>;
  readonly features?: RolesFeatureRequest;
}

const roleIdHint = `Supported roleId values: ${CORVIS_ROLE_IDS.join(", ")}. "id" is the name the lead uses; "roleId" must be one of these.`;

const supportedRoleId = (value: string): value is CorvisRoleId =>
  (CORVIS_ROLE_IDS as readonly string[]).includes(value);

const supportedUpstreamRole = (value: string): value is UpstreamDelegatedRole =>
  (UPSTREAM_DELEGATED_ROLES as readonly string[]).includes(value);

const isNonEmptyString = (
  node: PolicyJsonNode | undefined,
): node is PolicyJsonNode & {
  kind: "string";
} => node !== undefined && node.kind === "string" && node.value.trim().length > 0;

/**
 * A manifest `file` must stay inside the roles directory: `/` separators, no
 * absolute root, no `.` or `..` segment, a `.md` name.
 */
export function isRoleRelativeFile(value: string): boolean {
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
  readonly entries: readonly ParsedRoleEntry[];
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
    ROLES_DOCUMENT_KEY,
    lines.lineOf(offset),
    lines.textOf(offset),
    expected,
    actual,
    { file: "roles.json" },
  );
}

function parseManifest(source: string, issues: PolicyIssue[]): ManifestParse {
  const json = parsePolicyJson(source);
  if (!json.ok) {
    const lines = new SourceLines(source);
    issues.push(manifestIssue(lines, json.offset, "a valid JSON roles manifest", json.message));
    return { entries: [], revision: null, configured: false, parsed: false };
  }

  const lines = new SourceLines(source);
  const root = json.value;
  if (root.kind !== "object") {
    issues.push(
      manifestIssue(
        lines,
        root.offset,
        'a roles manifest object with "schema"',
        describePolicyJsonValue(root),
      ),
    );
    return { entries: [], revision: null, configured: false, parsed: false };
  }

  let parsed = true;
  const schema = policyJsonProperty(root, "schema");
  if (schema === undefined) {
    issues.push(
      manifestIssue(lines, root.offset, `schema: ${ROLES_MANIFEST_SCHEMA}`, "no schema field"),
    );
    parsed = false;
  } else if (schema.value.kind !== "string" || schema.value.value !== ROLES_MANIFEST_SCHEMA) {
    issues.push(
      manifestIssue(
        lines,
        schema.value.offset,
        `schema: ${ROLES_MANIFEST_SCHEMA}`,
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

  const rolesProperty = policyJsonProperty(root, "roles");
  const roleNodes = rolesProperty?.value.kind === "array" ? rolesProperty.value.items : undefined;
  if (rolesProperty === undefined) {
    issues.push(manifestIssue(lines, root.offset, "roles: an array of entries", "no roles field"));
    parsed = false;
  } else if (roleNodes === undefined) {
    issues.push(
      manifestIssue(
        lines,
        rolesProperty.value.offset,
        "roles: an array of entries",
        describePolicyJsonValue(rolesProperty.value),
      ),
    );
    parsed = false;
  }

  const entries: ParsedRoleEntry[] = [];
  const seenIds = new Set<string>();
  const seenRoleIds = new Set<string>();
  const seenUpstreamRoles = new Set<string>();
  const seenFiles = new Set<string>();

  roleNodes?.forEach((node, zeroBasedIndex) => {
    const index = zeroBasedIndex + 1;
    if (node.kind !== "object") {
      issues.push(
        manifestIssue(lines, node.offset, "a role entry object", describePolicyJsonValue(node)),
      );
      parsed = false;
      return;
    }

    const documentsWrite = policyJsonProperty(node, "documentsWrite");
    if (documentsWrite !== undefined) {
      issues.push(
        manifestIssue(
          lines,
          documentsWrite.keyOffset,
          "no documentsWrite field: document write access follows thread lineage, not a role",
          "documentsWrite",
        ),
      );
      parsed = false;
    }

    const idProperty = policyJsonProperty(node, "id");
    if (!isNonEmptyString(idProperty?.value)) {
      issues.push(
        manifestIssue(
          lines,
          idProperty?.value.offset ?? node.offset,
          "id: a non-empty role name",
          idProperty === undefined ? "no id field" : describePolicyJsonValue(idProperty.value),
        ),
      );
      parsed = false;
      return;
    }
    const id = idProperty.value.value;
    if (seenIds.has(id)) {
      issues.push(
        roleMappingConflictIssue(index, id, {
          line: lines.lineOf(idProperty.value.offset),
          text: lines.textOf(idProperty.value.offset),
          file: "roles.json",
        }),
      );
      parsed = false;
    }
    seenIds.add(id);

    const roleIdProperty = policyJsonProperty(node, "roleId");
    if (!isNonEmptyString(roleIdProperty?.value)) {
      issues.push(
        manifestIssue(
          lines,
          roleIdProperty?.value.offset ?? node.offset,
          "roleId: a Corvis role id",
          roleIdProperty === undefined
            ? "no roleId field"
            : describePolicyJsonValue(roleIdProperty.value),
        ),
      );
      parsed = false;
      return;
    }
    const roleIdValue = roleIdProperty.value.value;
    if (!supportedRoleId(roleIdValue)) {
      issues.push(
        roleUnknownIssue(id, "error", {
          line: lines.lineOf(roleIdProperty.value.offset),
          text: lines.textOf(roleIdProperty.value.offset),
          file: "roles.json",
          hint: roleIdHint,
        }),
      );
      parsed = false;
      return;
    }
    const roleId = roleIdValue;
    if (seenRoleIds.has(roleId)) {
      issues.push(
        roleMappingConflictIssue(index, roleId, {
          line: lines.lineOf(roleIdProperty.value.offset),
          text: lines.textOf(roleIdProperty.value.offset),
          file: "roles.json",
        }),
      );
      parsed = false;
    }
    seenRoleIds.add(roleId);

    const fileProperty = policyJsonProperty(node, "file");
    if (!isNonEmptyString(fileProperty?.value) || !isRoleRelativeFile(fileProperty.value.value)) {
      issues.push(
        manifestIssue(
          lines,
          fileProperty?.value.offset ?? node.offset,
          "file: a path inside the roles directory ending in .md",
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
        roleMappingConflictIssue(index, file, {
          line: lines.lineOf(fileProperty.value.offset),
          text: lines.textOf(fileProperty.value.offset),
          file: "roles.json",
        }),
      );
      parsed = false;
    }
    seenFiles.add(file);

    let upstreamRole: UpstreamDelegatedRole | null = null;
    const upstreamProperty = policyJsonProperty(node, "upstreamRole");
    if (upstreamProperty !== undefined) {
      if (
        upstreamProperty.value.kind !== "string" ||
        !supportedUpstreamRole(upstreamProperty.value.value)
      ) {
        issues.push(
          manifestIssue(
            lines,
            upstreamProperty.value.offset,
            `upstreamRole: one of ${UPSTREAM_DELEGATED_ROLES.join(", ")}`,
            describePolicyJsonValue(upstreamProperty.value),
          ),
        );
        parsed = false;
        return;
      }
      upstreamRole = upstreamProperty.value.value;
      if (roleId === "planner") {
        issues.push(
          manifestIssue(
            lines,
            upstreamProperty.value.offset,
            "no upstreamRole for planner: the planner is reached by mail only",
            upstreamRole,
          ),
        );
        parsed = false;
        return;
      }
      if (seenUpstreamRoles.has(upstreamRole)) {
        issues.push(
          roleMappingConflictIssue(index, upstreamRole, {
            line: lines.lineOf(upstreamProperty.value.offset),
            text: lines.textOf(upstreamProperty.value.offset),
            file: "roles.json",
          }),
        );
        parsed = false;
      }
      seenUpstreamRoles.add(upstreamRole);
    }

    entries.push({
      index,
      id,
      roleId,
      file,
      upstreamRole,
      line: lines.lineOf(node.offset),
    });
  });

  return { entries, revision, configured, parsed };
}

interface ParsedRoleFileResult {
  readonly file: ParsedRoleFile | null;
  readonly issues: readonly PolicyIssue[];
}

function roleFileIssue(
  lines: readonly string[],
  line: number,
  expected: string,
  actual: string,
  file: string,
): PolicyIssue {
  return frontmatterInvalidIssue(
    ROLES_DOCUMENT_KEY,
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
    issues.push(roleFileIssue(lines, 1, `${key}: a required field`, `no ${key} field`, file));
    return null;
  }
  if (matches.length > 1) {
    const repeated = matches[1];
    issues.push(
      roleFileIssue(
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
    issues.push(roleFileIssue(lines, first.line, `${key}: a non-empty value`, "", file));
    return null;
  }
  return first.value;
}

/** Reads one role Markdown file: strict frontmatter, free-form body. */
export function parseRoleFile(content: string, file: string): ParsedRoleFileResult {
  const lines = documentLines(content);
  const frontmatter = parseDocumentFrontmatter(content);
  const issues: PolicyIssue[] = [];

  if (!frontmatter.present) {
    issues.push(
      roleFileIssue(
        lines,
        1,
        `frontmatter with schema: ${ROLE_FILE_SCHEMA}`,
        "no frontmatter",
        file,
      ),
    );
    return { file: null, issues };
  }
  if (!frontmatter.closed) {
    issues.push(
      roleFileIssue(
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
      roleFileIssue(lines, malformed.line, "a key: value frontmatter field", malformed.text, file),
    );
  }

  const schema = singleField(frontmatter, "schema", lines, file, issues);
  if (schema !== null && schema !== ROLE_FILE_SCHEMA) {
    const line = frontmatterField(frontmatter, "schema")?.line ?? 1;
    issues.push(roleFileIssue(lines, line, `schema: ${ROLE_FILE_SCHEMA}`, schema, file));
  }

  const roleId = singleField(frontmatter, "roleId", lines, file, issues);
  if (roleId !== null && !supportedRoleId(roleId)) {
    const line = frontmatterField(frontmatter, "roleId")?.line ?? 1;
    issues.push(
      roleUnknownIssue(roleId, "error", {
        line,
        text: lines[line - 1] ?? "",
        file,
        hint: roleIdHint,
      }),
    );
  }

  const revisionText = singleField(frontmatter, "revision", lines, file, issues);
  let revision: number | null = null;
  if (revisionText !== null) {
    const value = Number(revisionText);
    if (!Number.isSafeInteger(value) || value < 1) {
      const line = frontmatterField(frontmatter, "revision")?.line ?? 1;
      issues.push(roleFileIssue(lines, line, "revision: an integer >= 1", revisionText, file));
    } else {
      revision = value;
    }
  }

  const configuredText = singleField(frontmatter, "configured", lines, file, issues);
  let configured = false;
  if (configuredText !== null) {
    if (configuredText !== "true" && configuredText !== "false") {
      const line = frontmatterField(frontmatter, "configured")?.line ?? 1;
      issues.push(roleFileIssue(lines, line, "configured: true or false", configuredText, file));
    } else {
      configured = configuredText === "true";
    }
  }

  if (
    roleId === null ||
    !supportedRoleId(roleId) ||
    revision === null ||
    schema !== ROLE_FILE_SCHEMA
  ) {
    return { file: null, issues };
  }

  return {
    file: { roleId, revision, configured, body: frontmatter.body },
    issues,
  };
}

const missingRoleHint = (roleId: string): string =>
  `Add an entry such as { "id": "${roleId}", "roleId": "${roleId}", "file": "${roleId}.md" } to roles.json and create that Markdown file.`;

/**
 * Parses the whole roles document set and checks the role requirements of the
 * requested features. A declared but absent file is reported for that role
 * only; a manifest syntax error invalidates the whole document.
 */
export function parseRolesDocumentSet(input: RolesDocumentInput): ParsedRolesDocument {
  const issues: PolicyIssue[] = [];
  const manifest = parseManifest(input.manifest, issues);
  const manifestLines = documentLines(input.manifest);
  const declaredFiles = new Set(manifest.entries.map((entry) => entry.file));
  const files = new Map<string, ParsedRoleFile>();

  for (const entry of manifest.entries) {
    const content = input.files.get(entry.file);
    if (content === undefined) {
      issues.push(
        documentMissingIssue(ROLES_DOCUMENT_KEY, entry.file, {
          file: entry.file,
          subject: entry.id,
          line: entry.line,
          text: manifestLines[entry.line - 1] ?? "",
          hint: `Role "${entry.id}" (roleId "${entry.roleId}") declares this file; restore it or remove the entry.`,
        }),
      );
      continue;
    }
    const parsed = parseRoleFile(content, entry.file);
    issues.push(...parsed.issues);
    if (parsed.file === null) continue;
    if (parsed.file.roleId !== entry.roleId) {
      const frontmatter = parseDocumentFrontmatter(content);
      const line = frontmatterField(frontmatter, "roleId")?.line ?? 1;
      issues.push(
        frontmatterInvalidIssue(
          ROLES_DOCUMENT_KEY,
          line,
          documentLines(content)[line - 1] ?? "",
          `roleId "${entry.roleId}" from roles.json`,
          parsed.file.roleId,
          { file: entry.file, subject: entry.id },
        ),
      );
      continue;
    }
    files.set(entry.file, parsed.file);
  }

  for (const file of input.files.keys()) {
    if (declaredFiles.has(file)) continue;
    const name = file.replace(/\.md$/i, "").split("/").pop() ?? file;
    issues.push(
      roleUnknownIssue(name, "warning", {
        file,
        hint: `Declared role files: ${[...declaredFiles].join(", ")}. Add an entry for this file or remove it.`,
      }),
    );
  }

  const usableRole = (roleId: string): boolean =>
    manifest.entries.some(
      (entry) => entry.roleId === roleId && files.get(entry.file)?.configured === true,
    );

  const leadRole = usableRole("lead");
  const plannerRole = usableRole("planner");
  const architectRole = CORVIS_ROLE_IDS.filter((roleId) => roleId.startsWith("architect")).some(
    (roleId) => usableRole(roleId),
  );

  const requirements: Partial<Record<PolicyRequirementId, boolean>> = {};
  if (manifest.parsed) {
    const valid = !hasBlockingIssue(issues);
    requirements.rolesManifest = valid && manifest.configured;
    if (input.features?.board === true) {
      requirements.leadRole = leadRole;
      if (!leadRole && manifest.configured) {
        issues.push(roleMissingIssue("lead", "board", { hint: missingRoleHint("lead") }));
      }
    }
    if (input.features?.planning === true) {
      requirements.plannerRole = plannerRole;
      requirements.architectRole = architectRole;
      if (!plannerRole && manifest.configured) {
        issues.push(roleMissingIssue("planner", "planning", { hint: missingRoleHint("planner") }));
      }
      if (!architectRole && manifest.configured) {
        issues.push(
          roleMissingIssue("architect*", "planning", {
            hint: `Add at least one entry whose roleId is "architect" or "architect-<specialization>", with its Markdown file.`,
          }),
        );
      }
    }
  }

  if (!manifest.configured) {
    issues.push(documentUnconfiguredIssue(ROLES_DOCUMENT_KEY));
  }

  return {
    key: ROLES_DOCUMENT_KEY,
    valid: !hasBlockingIssue(issues),
    configured: manifest.configured,
    revision: manifest.revision,
    roles: manifest.entries,
    files,
    issues,
    requirements,
  };
}

/**
 * The `roles` requirement validity for the feature registry. Roles off keeps
 * upstream behavior, so this only reports the requirements of requested
 * features and leaves the others unknown.
 */
export function rolesRequirements(
  parsed: ParsedRolesDocument,
): Readonly<Partial<Record<PolicyRequirementId, boolean>>> {
  return parsed.requirements;
}

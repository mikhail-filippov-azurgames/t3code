// @effect-diagnostics nodeBuiltinImport:off - Codex resource roots are read from bounded local metadata before Pi starts.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const MAX_ENABLED_PLUGINS = 256;
const MAX_MANIFEST_CHILD_DIRECTORIES = 64;
const MAX_MANIFEST_SKILL_ROOTS = 8;
const MAX_SKILLS = 256;
const MAX_SKILL_FILES = 256;
const MAX_SKILL_BYTES = 4 * 1024 * 1024;
const MAX_SKILL_DEPTH = 6;

export type PiCodexSkillProvenance = "agents" | "codex-user" | "codex-system" | "plugin";

export interface PiCodexSkillRoot {
  readonly path: string;
  readonly provenance: PiCodexSkillProvenance;
}

export interface PiCodexPersonalResources {
  readonly instructionsPath: string;
  readonly skillRoots: ReadonlyArray<PiCodexSkillRoot>;
  readonly partial: boolean;
  readonly warnings: ReadonlyArray<string>;
}

export interface PiTomlPluginSection {
  readonly name: string;
  readonly marketplace: string;
  readonly enabled: boolean | undefined;
}

export interface PiManagedSkillFile {
  readonly relativePath: string;
  readonly contents: Uint8Array;
}

export interface PiManagedSkillSnapshot {
  readonly name: string;
  readonly provenance: PiCodexSkillProvenance;
  readonly files: ReadonlyArray<PiManagedSkillFile>;
}

export interface PiManagedResources {
  readonly instructions: Uint8Array | undefined;
  readonly skills: ReadonlyArray<PiManagedSkillSnapshot>;
  readonly warnings: ReadonlyArray<string>;
  readonly partial: boolean;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = NodePath.relative(root, candidate);
  return (
    relative === "" ||
    (!NodePath.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`))
  );
}

/** Plugin names and marketplaces come from config and must be one path segment. */
function isSafePathSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !NodePath.isAbsolute(segment) &&
    NodePath.basename(segment) === segment
  );
}

async function isRealDirectory(candidate: string): Promise<boolean> {
  try {
    const stats = await NodeFSP.lstat(candidate);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    const canonical = await NodeFSP.realpath(candidate);
    return (
      NodePath.relative(candidate, canonical) === "" &&
      NodePath.relative(canonical, candidate) === ""
    );
  } catch {
    return false;
  }
}

export function parsePiCodexEnabledPlugins(configToml: string): {
  readonly plugins: ReadonlyArray<PiTomlPluginSection>;
  readonly warnings: ReadonlyArray<string>;
} {
  const plugins: Array<PiTomlPluginSection> = [];
  const warnings: Array<string> = [];
  let current: PiTomlPluginSection | undefined;
  const headerPattern = /^\s*\[([^\]]*)\]\s*(?:#.*)?$/;
  const pluginHeaderPattern = /^plugins\s*\.\s*"([^"]*)"$/;
  const commit = () => {
    if (current) plugins.push({ ...current });
    current = undefined;
  };
  for (const rawLine of configToml.split(/\r?\n/)) {
    const header = headerPattern.exec(rawLine);
    if (header) {
      commit();
      const pluginHeader = pluginHeaderPattern.exec(header[1]!.trim());
      if (pluginHeader) {
        const key = pluginHeader[1]!;
        const separator = key.lastIndexOf("@");
        if (separator <= 0 || separator === key.length - 1) {
          warnings.push(`Ignored malformed Codex plugin section [plugins."${key}"].`);
        } else {
          current = {
            name: key.slice(0, separator),
            marketplace: key.slice(separator + 1),
            enabled: undefined,
          };
        }
      }
      continue;
    }
    if (!current) continue;
    const assignment = /^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/i.exec(rawLine);
    if (assignment) current = { ...current, enabled: assignment[1]!.toLowerCase() === "true" };
  }
  commit();
  return { plugins, warnings };
}

async function resolvePluginSkillsDirectories(
  versionDirectory: string,
  pluginName: string,
): Promise<{
  readonly directories: ReadonlyArray<string>;
  readonly partial: boolean;
  readonly warnings: ReadonlyArray<string>;
}> {
  const manifestCandidates = [
    NodePath.join(versionDirectory, ".codex-plugin", "plugin.json"),
    NodePath.join(versionDirectory, "plugins", pluginName, ".codex-plugin", "plugin.json"),
  ];
  try {
    const children = await NodeFSP.readdir(versionDirectory, { withFileTypes: true });
    let scanned = 0;
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      if (scanned >= MAX_MANIFEST_CHILD_DIRECTORIES) break;
      if (!child.isDirectory() || child.isSymbolicLink() || child.name.startsWith(".")) continue;
      scanned += 1;
      manifestCandidates.push(
        NodePath.join(versionDirectory, child.name, ".codex-plugin", "plugin.json"),
      );
    }
  } catch {
    // A version directory without a readable manifest is reported below.
  }

  const collectedWarnings: Array<string> = [];
  for (const manifestPath of manifestCandidates) {
    let parsed: { name?: unknown; skills?: unknown };
    try {
      parsed = JSON.parse(await NodeFSP.readFile(manifestPath, "utf8")) as {
        name?: unknown;
        skills?: unknown;
      };
    } catch {
      continue;
    }
    if (typeof parsed.name === "string" && parsed.name !== pluginName) continue;
    const manifestDirectory = NodePath.dirname(NodePath.dirname(manifestPath));
    const declared =
      typeof parsed.skills === "string"
        ? [parsed.skills]
        : Array.isArray(parsed.skills)
          ? parsed.skills.filter((value): value is string => typeof value === "string")
          : ["./skills"];
    const directories: Array<string> = [];
    let manifestPartial = false;
    if (declared.length > MAX_MANIFEST_SKILL_ROOTS) manifestPartial = true;
    for (const relative of declared.slice(0, MAX_MANIFEST_SKILL_ROOTS)) {
      const directory = NodePath.resolve(manifestDirectory, relative);
      if (!isPathWithin(versionDirectory, directory) || !(await isRealDirectory(directory))) {
        manifestPartial = true;
        continue;
      }
      directories.push(directory);
    }
    if (directories.length > 0) {
      return { directories, partial: manifestPartial, warnings: collectedWarnings };
    }
    collectedWarnings.push(
      `Enabled Codex plugin ${pluginName} has no valid skills directory inside ${versionDirectory}.`,
    );
  }
  return { directories: [], partial: true, warnings: collectedWarnings };
}

async function selectPluginVersionDirectory(
  pluginDirectory: string,
): Promise<{ readonly directory: string; readonly ambiguous: boolean } | undefined> {
  let entries: ReadonlyArray<{
    readonly name: string;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }>;
  try {
    entries = await NodeFSP.readdir(pluginDirectory, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const versions: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
    const path = NodePath.join(pluginDirectory, entry.name);
    const stats = await NodeFSP.lstat(path).catch(() => undefined);
    if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) continue;
    versions.push({ path, mtimeMs: stats.mtimeMs });
  }
  if (versions.length === 0) return undefined;
  versions.sort(
    (left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path),
  );
  return { directory: versions[0]!.path, ambiguous: versions.length > 1 };
}

/** Reconstruct the personal resources a Codex instance activates, using only local metadata. */
export async function resolveCodexPersonalResources(input: {
  readonly codexHome: string;
  readonly hostHome: string;
}): Promise<PiCodexPersonalResources> {
  const skillRoots: Array<PiCodexSkillRoot> = [];
  const warnings: Array<string> = [];
  let partial = false;

  const agentsSkills = NodePath.join(input.hostHome, ".agents", "skills");
  if (await isRealDirectory(agentsSkills)) {
    skillRoots.push({ path: agentsSkills, provenance: "agents" });
  }
  const codexUserSkills = NodePath.join(input.codexHome, "skills");
  if (await isRealDirectory(codexUserSkills)) {
    skillRoots.push({ path: codexUserSkills, provenance: "codex-user" });
  }
  const codexSystemSkills = NodePath.join(codexUserSkills, ".system");
  if (await isRealDirectory(codexSystemSkills)) {
    skillRoots.push({ path: codexSystemSkills, provenance: "codex-system" });
  }

  let configToml: string | undefined;
  try {
    configToml = await NodeFSP.readFile(NodePath.join(input.codexHome, "config.toml"), "utf8");
  } catch {
    configToml = undefined;
  }
  if (configToml === undefined) {
    warnings.push(
      `Codex config.toml was not found under ${input.codexHome}; enabled plugin skills were not resolved.`,
    );
    partial = true;
  } else {
    const parsed = parsePiCodexEnabledPlugins(configToml);
    warnings.push(...parsed.warnings);
    if (parsed.warnings.length > 0) partial = true;
    const enabled = parsed.plugins.filter((plugin) => plugin.enabled === true);
    for (const plugin of parsed.plugins) {
      if (plugin.enabled === undefined) {
        warnings.push(
          `Codex plugin ${plugin.name}@${plugin.marketplace} has no explicit enabled = true; its skills were skipped.`,
        );
        partial = true;
      }
    }
    const bounded = enabled.slice(0, MAX_ENABLED_PLUGINS);
    if (enabled.length > MAX_ENABLED_PLUGINS) {
      warnings.push(
        `Only ${bounded.length} of ${enabled.length} enabled Codex plugins were resolved within the bounded limit.`,
      );
      partial = true;
    }
    const cacheRoot = NodePath.join(input.codexHome, "plugins", "cache");
    for (const plugin of bounded) {
      if (!isSafePathSegment(plugin.marketplace) || !isSafePathSegment(plugin.name)) {
        warnings.push(
          `Codex plugin ${plugin.name}@${plugin.marketplace} has an unsafe name or marketplace; its skills were skipped.`,
        );
        partial = true;
        continue;
      }
      const pluginDirectory = NodePath.join(cacheRoot, plugin.marketplace, plugin.name);
      const version = await selectPluginVersionDirectory(pluginDirectory);
      if (!version) {
        warnings.push(
          `Enabled Codex plugin ${plugin.name}@${plugin.marketplace} has no cached version; its skills were not loaded.`,
        );
        partial = true;
        continue;
      }
      if (version.ambiguous) {
        warnings.push(
          `Codex plugin ${plugin.name}@${plugin.marketplace} has multiple cached versions; only the most recent was inspected.`,
        );
        partial = true;
      }
      if (!(await isRealDirectory(version.directory))) {
        warnings.push(
          `Codex plugin ${plugin.name}@${plugin.marketplace} resolves through a symlink or junction; its skills were skipped.`,
        );
        partial = true;
        continue;
      }
      const resolved = await resolvePluginSkillsDirectories(version.directory, plugin.name);
      warnings.push(...resolved.warnings);
      if (resolved.partial || resolved.directories.length === 0) partial = true;
      for (const directory of resolved.directories) {
        skillRoots.push({ path: directory, provenance: "plugin" });
      }
    }
  }

  if (partial) {
    warnings.push(
      "Pi personal Codex skills are a partial subset: some active Codex skills may be missing.",
    );
  }
  return {
    instructionsPath: NodePath.join(input.codexHome, "AGENTS.md"),
    skillRoots,
    partial,
    warnings,
  };
}

function skillNameFromContents(contents: Uint8Array, fallback: string): string {
  const text = Buffer.from(contents).toString("utf8");
  if (!text.startsWith("---")) return fallback;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return fallback;
  for (const line of text.slice(3, end).split(/\r?\n/)) {
    const match = /^\s*name\s*:\s*(.+?)\s*$/.exec(line);
    if (match) return match[1]!.replace(/^["']|["']$/g, "").trim() || fallback;
  }
  return fallback;
}

async function collectSkillFiles(
  root: string,
  skillDirectory: string,
  files: Array<PiManagedSkillFile>,
  budget: { files: number; bytes: number },
): Promise<boolean> {
  let entries: ReadonlyArray<{
    readonly name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }>;
  try {
    entries = await NodeFSP.readdir(skillDirectory, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) return false;
    const absolute = NodePath.join(skillDirectory, entry.name);
    if (entry.isDirectory()) {
      if (!(await collectSkillFiles(root, absolute, files, budget))) return false;
      continue;
    }
    if (!entry.isFile()) return false;
    let stats;
    try {
      stats = await NodeFSP.lstat(absolute);
    } catch {
      return false;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) return false;
    budget.files += 1;
    budget.bytes += stats.size;
    if (budget.files > MAX_SKILL_FILES || budget.bytes > MAX_SKILL_BYTES) return false;
    const contents = await NodeFSP.readFile(absolute);
    files.push({
      relativePath: NodePath.relative(root, absolute).split(NodePath.sep).join("/"),
      contents,
    });
  }
  return true;
}

async function collectSkillTree(
  directory: string,
  depth: number,
  snapshots: Array<PiManagedSkillSnapshot>,
  provenance: PiCodexSkillProvenance,
  warnings: Array<string>,
): Promise<boolean> {
  if (depth > MAX_SKILL_DEPTH || snapshots.length >= MAX_SKILLS) return false;
  const skillFile = NodePath.join(directory, "SKILL.md");
  let skillStats;
  try {
    skillStats = await NodeFSP.lstat(skillFile);
  } catch {
    skillStats = undefined;
  }
  if (skillStats) {
    if (!skillStats.isFile() || skillStats.isSymbolicLink()) {
      warnings.push(`Skipped unsafe Codex skill at ${skillFile}.`);
      return true;
    }
    const files: Array<PiManagedSkillFile> = [];
    const budget = { files: 0, bytes: 0 };
    if (!(await collectSkillFiles(directory, directory, files, budget))) {
      warnings.push(`Skipped unsafe or oversized Codex skill at ${directory}.`);
      return true;
    }
    const contents =
      files.find((file) => file.relativePath === "SKILL.md")?.contents ?? new Uint8Array();
    snapshots.push({
      name: skillNameFromContents(contents, NodePath.basename(directory)),
      provenance,
      files,
    });
    return true;
  }
  let entries;
  try {
    entries = await NodeFSP.readdir(directory, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
    if (
      !(await collectSkillTree(
        NodePath.join(directory, entry.name),
        depth + 1,
        snapshots,
        provenance,
        warnings,
      ))
    ) {
      return false;
    }
  }
  return true;
}

export async function collectCodexSkillSnapshots(resources: PiCodexPersonalResources): Promise<{
  readonly snapshots: ReadonlyArray<PiManagedSkillSnapshot>;
  readonly warnings: ReadonlyArray<string>;
}> {
  const snapshots: Array<PiManagedSkillSnapshot> = [];
  const warnings: Array<string> = [];
  const seenNames = new Set<string>();
  for (const root of resources.skillRoots) {
    const collected: Array<PiManagedSkillSnapshot> = [];
    if (!(await collectSkillTree(root.path, 0, collected, root.provenance, warnings))) {
      warnings.push(`Codex skill root ${root.path} exceeded its bounds or was not readable.`);
    }
    for (const snapshot of collected) {
      if (seenNames.has(snapshot.name)) {
        warnings.push(`Skipped duplicate Codex skill ${snapshot.name} from ${root.path}.`);
        continue;
      }
      seenNames.add(snapshot.name);
      snapshots.push(snapshot);
    }
  }
  return { snapshots, warnings };
}

async function readInstructions(filePath: string): Promise<Uint8Array | undefined> {
  try {
    const stats = await NodeFSP.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) return undefined;
    return await NodeFSP.readFile(filePath);
  } catch {
    return undefined;
  }
}

/** Resolve Codex skills and AGENTS.md, ready for the managed Pi agent dir. */
export async function resolvePiManagedResources(input: {
  readonly codexHome: string;
  readonly hostHome: string;
}): Promise<PiManagedResources> {
  const resources = await resolveCodexPersonalResources(input);
  const instructions = await readInstructions(resources.instructionsPath);
  const collected = await collectCodexSkillSnapshots(resources);
  return {
    instructions,
    skills: collected.snapshots,
    warnings: [...resources.warnings, ...collected.warnings],
    partial: resources.partial,
  };
}

function safeDirectoryName(name: string, index: number): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${String(index).padStart(4, "0")}-${safe.length > 0 ? safe.slice(0, 80) : "skill"}`;
}

/** Materialize imported resources inside the managed agent dir; Pi reads both automatically. */
export async function syncPiManagedResources(
  agentDir: string,
  resources: PiManagedResources,
): Promise<void> {
  await NodeFSP.mkdir(agentDir, { recursive: true });
  const skillsDir = NodePath.join(agentDir, "skills");
  await NodeFSP.rm(skillsDir, { recursive: true, force: true });
  if (resources.skills.length > 0) {
    await NodeFSP.mkdir(skillsDir, { recursive: true });
    for (const [index, snapshot] of resources.skills.entries()) {
      const snapshotDir = NodePath.join(skillsDir, safeDirectoryName(snapshot.name, index));
      await NodeFSP.mkdir(snapshotDir, { recursive: true });
      for (const file of snapshot.files) {
        const segments = file.relativePath.split("/");
        if (
          segments.length === 0 ||
          segments.some((segment) => segment === "" || segment === "." || segment === "..")
        ) {
          throw new Error(`Codex skill ${snapshot.name} contained an unsafe relative path.`);
        }
        const target = NodePath.join(snapshotDir, ...segments);
        await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
        await NodeFSP.writeFile(target, file.contents);
      }
    }
  }
  const instructionsPath = NodePath.join(agentDir, "AGENTS.md");
  if (resources.instructions === undefined) {
    await NodeFSP.rm(instructionsPath, { force: true });
  } else {
    await NodeFSP.writeFile(instructionsPath, resources.instructions);
  }
}

/** Codex home and host home used for the default import. */
export function defaultCodexImportPaths(environment: NodeJS.ProcessEnv = process.env): {
  readonly codexHome: string;
  readonly hostHome: string;
} {
  const hostHome = NodeOS.homedir();
  const configured = environment.CODEX_HOME?.trim();
  return {
    codexHome:
      configured && configured.length > 0
        ? NodePath.resolve(configured)
        : NodePath.join(hostHome, ".codex"),
    hostHome,
  };
}

/** Import Codex resources into an already created agent dir. */
export async function importCodexResourcesIntoAgentDir(input: {
  readonly agentDir: string;
  readonly codexHome: string;
  readonly hostHome: string;
}): Promise<PiManagedResources> {
  const resources = await resolvePiManagedResources({
    codexHome: input.codexHome,
    hostHome: input.hostHome,
  });
  await syncPiManagedResources(input.agentDir, resources);
  return resources;
}

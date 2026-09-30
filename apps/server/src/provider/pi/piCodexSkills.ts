// @effect-diagnostics nodeBuiltinImport:off - Codex resource roots are resolved from bounded local metadata before Pi starts.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const MAX_ENABLED_PLUGINS = 256;
const MAX_MANIFEST_CHILD_DIRECTORIES = 64;
const MAX_MANIFEST_SKILL_ROOTS = 8;

/** Provenance of one resolved personal Codex skill root. */
export type PiCodexSkillProvenance = "agents" | "codex-user" | "codex-system" | "plugin";

export interface PiCodexSkillRoot {
  readonly path: string;
  readonly provenance: PiCodexSkillProvenance;
}

export interface PiCodexPersonalResources {
  /** `<codexHome>/AGENTS.md`; the caller still checks that it exists. */
  readonly instructionsPath: string;
  readonly skillRoots: ReadonlyArray<PiCodexSkillRoot>;
  /**
   * True when the active Codex skill set could not be fully reconstructed from
   * local metadata, so `skillRoots` is a supported subset rather than full
   * unification.
   */
  readonly partial: boolean;
  readonly warnings: ReadonlyArray<string>;
}

export interface PiTomlPluginSection {
  readonly name: string;
  readonly marketplace: string;
  readonly enabled: boolean | undefined;
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

/**
 * Parse only the `[plugins."name@marketplace"]` sections of a Codex
 * `config.toml`. A full TOML parser is out of scope; anything this bounded
 * scanner cannot classify is surfaced as a warning instead of guessed.
 */
export function parsePiCodexEnabledPlugins(configToml: string): {
  readonly plugins: ReadonlyArray<PiTomlPluginSection>;
  readonly warnings: ReadonlyArray<string>;
} {
  const plugins: Array<PiTomlPluginSection> = [];
  const warnings: Array<string> = [];
  let current: { name: string; marketplace: string; enabled: boolean | undefined } | undefined;
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
    if (assignment) current.enabled = assignment[1]!.toLowerCase() === "true";
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
      // A declared skills root must stay inside the plugin's version directory;
      // `../` traversal, junctions, and symlinked components are all rejected.
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

/**
 * Reconstruct the personal resources a Codex instance activates: its
 * `AGENTS.md`, the host-shared `~/.agents/skills`, its own user skills, its
 * `skills/.system` bundle, and the skills of plugins explicitly enabled in its
 * `config.toml`. Only one cached version per plugin is inspected, and anything
 * that cannot be resolved from local metadata downgrades the result to a
 * reported partial subset instead of being silently guessed.
 */
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
    // Only an explicit `enabled = true` activates a plugin. Disabled plugins
    // are skipped silently; an absent or malformed `enabled` is reported.
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

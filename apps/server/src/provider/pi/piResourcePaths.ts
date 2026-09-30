// @effect-diagnostics nodeBuiltinImport:off - Resource paths are resolved before Pi starts and only bounded project paths are inspected.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const MAX_PROJECT_ANCESTORS = 64;
const MAX_PROJECT_SKILL_DIRECTORIES = 2_048;
const MAX_PROJECT_SKILL_ENTRIES_PER_DIRECTORY = 2_048;
const MAX_PROJECT_SKILL_ENTRIES = 8_192;
const MAX_PROJECT_SKILL_FILES = 512;
const MAX_PROJECT_SKILL_FILE_BYTES = 256 * 1024;
const MAX_PROJECT_SKILL_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_PROJECT_SKILL_COMPANION_FILE_BYTES = 1024 * 1024;
const MAX_PROJECT_SKILL_SNAPSHOT_FILES = 256;
const MAX_PROJECT_SKILL_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_PROJECT_SKILL_SNAPSHOT_DEPTH = 16;
const MAX_PROJECT_SKILL_SNAPSHOT_ENTRIES = 2_048;
const MAX_PROJECT_SKILL_SNAPSHOT_TOTAL_FILES = 2_048;
const MAX_PROJECT_SKILL_SNAPSHOT_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_PROJECT_SKILL_SNAPSHOT_TOTAL_ENTRIES = 8_192;

export interface PiProjectSkillSnapshot {
  /** Verified source SKILL.md, used only for diagnostics. */
  readonly sourcePath?: string;
  /** Safe regular files captured while the source tree is verified. */
  readonly files: ReadonlyArray<{
    /** Skill-relative path, including `SKILL.md`. */
    readonly relativePath: string;
    readonly contents: Uint8Array;
    /** Source mode is retained only to preserve whether a file was executable. */
    readonly sourceMode: number;
  }>;
}

export interface PiProjectSkillSnapshotCollection {
  readonly snapshots: ReadonlyArray<PiProjectSkillSnapshot>;
  /** Skills omitted in full because a source tree was unsafe, unstable, or over budget. */
  readonly skippedSkillCount: number;
}

interface PiSkillFileRecord {
  readonly path: string;
  readonly skillDirectory: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly birthtimeMs: number;
}

interface PiSkillDiscovery {
  readonly containmentRoot: string;
  readonly files: ReadonlyArray<PiSkillFileRecord>;
  readonly skippedSkillCount: number;
}

interface PiSkillDirectoryEntry {
  readonly name: string;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

interface PiResourcePathDependencies {
  readonly lstat: (path: string) => Promise<NodeFS.Stats>;
  readonly realpath: (path: string) => Promise<string>;
  readonly openDirectory: (path: string) => Promise<{
    readonly close: () => Promise<void>;
    [Symbol.asyncIterator](): AsyncIterator<PiSkillDirectoryEntry>;
  }>;
}

const defaultDependencies: PiResourcePathDependencies = {
  lstat: (path) => NodeFSP.lstat(path),
  realpath: (path) => NodeFSP.realpath(path),
  openDirectory: NodeFSP.opendir,
};

function isPathWithin(root: string, candidate: string): boolean {
  const relative = NodePath.relative(root, candidate);
  return (
    relative === "" ||
    (!NodePath.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`))
  );
}

function isSamePath(left: string, right: string): boolean {
  return NodePath.relative(left, right) === "" && NodePath.relative(right, left) === "";
}

/** Keep staged resources owner-only and read-only, preserving only executable status. */
export function getPiStagedSkillFileMode(sourceMode: number): number {
  return sourceMode & 0o111 ? 0o500 : 0o400;
}

async function collectSkillFiles(
  skillRoot: string,
  containmentRoot: string,
  dependencies: PiResourcePathDependencies,
  visitedDirectories: Set<string>,
  budget: {
    directories: number;
    entries: number;
    files: number;
    bytes: number;
    skippedSkills: number;
  },
): Promise<ReadonlyArray<PiSkillFileRecord>> {
  const files: Array<PiSkillFileRecord> = [];
  const pending: Array<string> = [skillRoot];

  while (
    pending.length > 0 &&
    budget.directories < MAX_PROJECT_SKILL_DIRECTORIES &&
    budget.entries < MAX_PROJECT_SKILL_ENTRIES &&
    budget.files < MAX_PROJECT_SKILL_FILES
  ) {
    const directory = pending.pop()!;
    let canonicalDirectory: string;
    try {
      const stats = await dependencies.lstat(directory);
      if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
      canonicalDirectory = await dependencies.realpath(directory);
    } catch {
      continue;
    }
    if (
      !isPathWithin(containmentRoot, canonicalDirectory) ||
      !isSamePath(canonicalDirectory, directory) ||
      visitedDirectories.has(canonicalDirectory)
    ) {
      continue;
    }
    visitedDirectories.add(canonicalDirectory);
    budget.directories += 1;

    const candidate = NodePath.join(canonicalDirectory, "SKILL.md");
    let foundSkillFile = false;
    try {
      const stats = await dependencies.lstat(candidate);
      foundSkillFile = true;
      if (stats.isFile() && !stats.isSymbolicLink()) {
        const canonicalFile = await dependencies.realpath(candidate);
        if (isPathWithin(containmentRoot, canonicalFile) && isSamePath(canonicalFile, candidate)) {
          // Pi reads each explicit skill file synchronously during startup. Check
          // both before and after canonicalization so a file replaced or grown
          // during discovery does not bypass either byte budget.
          const confirmed = await dependencies.lstat(canonicalFile);
          const stableIdentity =
            stats.dev === confirmed.dev &&
            stats.ino === confirmed.ino &&
            stats.size === confirmed.size &&
            stats.mode === confirmed.mode &&
            stats.mtimeMs === confirmed.mtimeMs &&
            stats.ctimeMs === confirmed.ctimeMs;
          if (
            confirmed.isFile() &&
            !confirmed.isSymbolicLink() &&
            stableIdentity &&
            confirmed.size <= MAX_PROJECT_SKILL_FILE_BYTES &&
            budget.bytes + confirmed.size <= MAX_PROJECT_SKILL_TOTAL_BYTES
          ) {
            files.push({
              path: canonicalFile,
              skillDirectory: canonicalDirectory,
              dev: confirmed.dev,
              ino: confirmed.ino,
              size: confirmed.size,
              mode: confirmed.mode,
              mtimeMs: confirmed.mtimeMs,
              ctimeMs: confirmed.ctimeMs,
              birthtimeMs: confirmed.birthtimeMs,
            });
            budget.files += 1;
            budget.bytes += confirmed.size;
          } else {
            budget.skippedSkills += 1;
          }
        } else {
          budget.skippedSkills += 1;
        }
      } else {
        budget.skippedSkills += 1;
      }
    } catch {
      // A missing SKILL.md is normal for container directories.
    }
    // Pi treats a directory with SKILL.md as one skill and does not recurse into it.
    if (foundSkillFile) continue;

    let directoryHandle: Awaited<ReturnType<PiResourcePathDependencies["openDirectory"]>>;
    const entries: Array<PiSkillDirectoryEntry> = [];
    try {
      directoryHandle = await dependencies.openDirectory(canonicalDirectory);
      try {
        for await (const entry of directoryHandle) {
          budget.entries += 1;
          entries.push(entry);
          if (
            entries.length >= MAX_PROJECT_SKILL_ENTRIES_PER_DIRECTORY ||
            budget.entries >= MAX_PROJECT_SKILL_ENTRIES
          ) {
            budget.skippedSkills += 1;
            break;
          }
        }
      } finally {
        await directoryHandle.close().catch(() => undefined);
      }
    } catch {
      continue;
    }

    for (const entry of entries
      .filter(
        (candidateEntry) =>
          !candidateEntry.name.startsWith(".") &&
          candidateEntry.name !== "node_modules" &&
          candidateEntry.isDirectory() &&
          !candidateEntry.isSymbolicLink(),
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .toReversed()) {
      if (budget.directories + pending.length >= MAX_PROJECT_SKILL_DIRECTORIES) break;
      pending.push(NodePath.join(canonicalDirectory, entry.name));
    }
  }

  if (pending.length > 0) budget.skippedSkills += 1;

  return files;
}

/**
 * Resolve safe, explicit SKILL.md files visible to a Pi session. We stop at
 * the nearest Git root (including linked worktrees), canonicalize every path,
 * reject all symlinked path components, and bound the shallow skill walk so
 * Pi receives files rather than directories it could recursively follow.
 */
async function discoverPiProjectSkillFiles(
  cwd: string,
  dependencies: PiResourcePathDependencies = defaultDependencies,
): Promise<PiSkillDiscovery> {
  let canonicalCwd: string;
  try {
    canonicalCwd = await dependencies.realpath(NodePath.resolve(cwd));
  } catch {
    return { containmentRoot: "", files: [], skippedSkillCount: 0 };
  }

  const ancestors: Array<string> = [];
  let current = canonicalCwd;
  let gitRoot: string | undefined;
  for (let depth = 0; depth < MAX_PROJECT_ANCESTORS; depth += 1) {
    ancestors.push(current);
    try {
      const gitMarker = await dependencies.lstat(NodePath.join(current, ".git"));
      if (!gitMarker.isSymbolicLink() && (gitMarker.isFile() || gitMarker.isDirectory())) {
        gitRoot = current;
        break;
      }
    } catch {
      // A missing .git marker is normal for a child directory.
    }
    const parent = NodePath.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const scopedAncestors = gitRoot
    ? ancestors.slice(0, ancestors.indexOf(gitRoot) + 1)
    : ancestors.slice(0, 1);
  const containmentRoot = gitRoot ?? canonicalCwd;
  const roots: Array<string> = [];
  for (const directory of scopedAncestors.toReversed()) {
    const agentsDirectory = NodePath.join(directory, ".agents");
    const skillsRoot = NodePath.join(agentsDirectory, "skills");
    try {
      const agentsStats = await dependencies.lstat(agentsDirectory);
      const skillsStats = await dependencies.lstat(skillsRoot);
      if (
        !agentsStats.isDirectory() ||
        agentsStats.isSymbolicLink() ||
        !skillsStats.isDirectory() ||
        skillsStats.isSymbolicLink()
      ) {
        continue;
      }
      const canonicalSkillsRoot = await dependencies.realpath(skillsRoot);
      if (
        isPathWithin(containmentRoot, canonicalSkillsRoot) &&
        isSamePath(canonicalSkillsRoot, skillsRoot)
      ) {
        roots.push(canonicalSkillsRoot);
      }
    } catch {
      // Missing project skills are expected and do not block Pi startup.
    }
  }

  const files: Array<PiSkillFileRecord> = [];
  const visitedDirectories = new Set<string>();
  const budget = { directories: 0, entries: 0, files: 0, bytes: 0, skippedSkills: 0 };
  for (const root of roots) {
    files.push(
      ...(await collectSkillFiles(root, containmentRoot, dependencies, visitedDirectories, budget)),
    );
    if (
      budget.directories >= MAX_PROJECT_SKILL_DIRECTORIES ||
      budget.entries >= MAX_PROJECT_SKILL_ENTRIES ||
      budget.files >= MAX_PROJECT_SKILL_FILES
    ) {
      break;
    }
  }
  return { containmentRoot, files, skippedSkillCount: budget.skippedSkills };
}

/**
 * Resolve safe, explicit SKILL.md paths for diagnostics and tests. Pi session
 * startup uses `collectPiProjectSkillSnapshots` instead, so it never hands a
 * mutable worktree path to the child process.
 */
export async function collectPiProjectSkillFiles(
  cwd: string,
  dependencies: PiResourcePathDependencies = defaultDependencies,
): Promise<ReadonlyArray<string>> {
  const discovery = await discoverPiProjectSkillFiles(cwd, dependencies);
  return discovery.files.map((file) => file.path);
}

function sameIdentity(expected: PiSkillFileRecord, actual: NodeFS.Stats): boolean {
  return (
    actual.isFile() &&
    !actual.isSymbolicLink() &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.size === actual.size &&
    expected.mode === actual.mode &&
    expected.mtimeMs === actual.mtimeMs &&
    expected.ctimeMs === actual.ctimeMs &&
    expected.birthtimeMs === actual.birthtimeMs
  );
}

async function readVerifiedSkillFile(
  file: PiSkillFileRecord,
  containmentRoot: string,
): Promise<Uint8Array | undefined> {
  let handle: Awaited<ReturnType<typeof NodeFSP.open>> | undefined;
  try {
    const maxBytes =
      file.path === NodePath.join(file.skillDirectory, "SKILL.md")
        ? MAX_PROJECT_SKILL_FILE_BYTES
        : MAX_PROJECT_SKILL_COMPANION_FILE_BYTES;
    if (file.size > maxBytes) return undefined;
    const before = await NodeFSP.lstat(file.path);
    const canonicalBefore = await NodeFSP.realpath(file.path);
    if (
      !sameIdentity(file, before) ||
      !isPathWithin(containmentRoot, canonicalBefore) ||
      !isPathWithin(file.skillDirectory, canonicalBefore) ||
      !isSamePath(canonicalBefore, file.path)
    ) {
      return undefined;
    }

    handle = await NodeFSP.open(file.path, "r");
    const opened = await handle.stat();
    if (!sameIdentity(file, opened)) return undefined;

    // Never use readFile here: a raced file can grow after stat and make an
    // unbounded allocation. Read only the validated size plus a one-byte
    // overflow check, then verify the path identity again before accepting it.
    const contents = Buffer.alloc(file.size);
    let offset = 0;
    while (offset < contents.byteLength) {
      const { bytesRead } = await handle.read(
        contents,
        offset,
        contents.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const overflow = Buffer.alloc(1);
    const { bytesRead: overflowBytes } = await handle.read(overflow, 0, 1, file.size);
    const after = await NodeFSP.lstat(file.path);
    const canonicalAfter = await NodeFSP.realpath(file.path);
    if (
      offset !== file.size ||
      overflowBytes !== 0 ||
      !sameIdentity(file, after) ||
      !isPathWithin(containmentRoot, canonicalAfter) ||
      !isPathWithin(file.skillDirectory, canonicalAfter) ||
      !isSamePath(canonicalAfter, file.path)
    ) {
      return undefined;
    }
    return new Uint8Array(contents);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Capture a complete, bounded skill directory before returning. Companion
 * files are staged beside SKILL.md so Pi's skill-relative paths keep working.
 * Any link, special file, unstable path, or resource-limit violation rejects
 * the whole skill; Pi never receives a partial snapshot.
 */
export async function collectPiProjectSkillSnapshots(
  cwd: string,
): Promise<PiProjectSkillSnapshotCollection> {
  const discovery = await discoverPiProjectSkillFiles(cwd);
  return collectPiSkillSnapshots(discovery);
}

async function collectPiSkillSnapshots(
  discovery: PiSkillDiscovery,
): Promise<PiProjectSkillSnapshotCollection> {
  if (!discovery.containmentRoot) return { snapshots: [], skippedSkillCount: 0 };
  const snapshots: Array<PiProjectSkillSnapshot> = [];
  let skippedSkillCount = discovery.skippedSkillCount;
  const budget = { entries: 0, files: 0, bytes: 0 };
  for (const file of discovery.files) {
    const skillRoot = file.skillDirectory;
    const pending: Array<{ readonly path: string; readonly depth: number }> = [
      { path: skillRoot, depth: 0 },
    ];
    const visitedDirectories = new Set<string>();
    const skillFiles: Array<{ readonly record: PiSkillFileRecord; readonly relativePath: string }> =
      [];
    let skillBytes = 0;
    let unsafe = false;

    while (pending.length > 0 && !unsafe) {
      const current = pending.pop()!;
      let canonicalDirectory: string;
      try {
        const directoryStats = await NodeFSP.lstat(current.path);
        if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
          unsafe = true;
          break;
        }
        canonicalDirectory = await NodeFSP.realpath(current.path);
      } catch {
        unsafe = true;
        break;
      }
      if (
        !isPathWithin(discovery.containmentRoot, canonicalDirectory) ||
        !isPathWithin(skillRoot, canonicalDirectory) ||
        !isSamePath(canonicalDirectory, current.path) ||
        visitedDirectories.has(canonicalDirectory)
      ) {
        unsafe = true;
        break;
      }
      visitedDirectories.add(canonicalDirectory);

      let directoryHandle: Awaited<ReturnType<typeof NodeFSP.opendir>>;
      const entries: Array<NodeFS.Dirent> = [];
      try {
        directoryHandle = await NodeFSP.opendir(canonicalDirectory);
        try {
          for await (const entry of directoryHandle) {
            budget.entries += 1;
            if (
              budget.entries > MAX_PROJECT_SKILL_SNAPSHOT_TOTAL_ENTRIES ||
              entries.length >= MAX_PROJECT_SKILL_SNAPSHOT_ENTRIES
            ) {
              unsafe = true;
              break;
            }
            entries.push(entry);
          }
        } finally {
          await directoryHandle.close().catch(() => undefined);
        }
      } catch {
        unsafe = true;
        break;
      }

      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (unsafe) break;
        const entryPath = NodePath.join(canonicalDirectory, entry.name);
        let entryStats: NodeFS.Stats;
        let canonicalEntry: string;
        try {
          entryStats = await NodeFSP.lstat(entryPath);
          if (entryStats.isSymbolicLink()) {
            unsafe = true;
            break;
          }
          canonicalEntry = await NodeFSP.realpath(entryPath);
        } catch {
          unsafe = true;
          break;
        }
        if (
          !isPathWithin(discovery.containmentRoot, canonicalEntry) ||
          !isPathWithin(skillRoot, canonicalEntry) ||
          !isSamePath(canonicalEntry, entryPath)
        ) {
          unsafe = true;
          break;
        }
        if (entryStats.isDirectory()) {
          if (current.depth >= MAX_PROJECT_SKILL_SNAPSHOT_DEPTH) {
            unsafe = true;
            break;
          }
          pending.push({ path: canonicalEntry, depth: current.depth + 1 });
          continue;
        }
        if (!entryStats.isFile()) {
          unsafe = true;
          break;
        }

        const relativePath = NodePath.relative(skillRoot, canonicalEntry);
        const isSkillFile = relativePath === "SKILL.md";
        const record: PiSkillFileRecord = {
          path: canonicalEntry,
          skillDirectory: skillRoot,
          dev: entryStats.dev,
          ino: entryStats.ino,
          size: entryStats.size,
          mode: entryStats.mode,
          mtimeMs: entryStats.mtimeMs,
          ctimeMs: entryStats.ctimeMs,
          birthtimeMs: entryStats.birthtimeMs,
        };
        if (isSkillFile && !sameIdentity(file, entryStats)) {
          unsafe = true;
          break;
        }
        if (
          (isSkillFile && entryStats.size > MAX_PROJECT_SKILL_FILE_BYTES) ||
          (!isSkillFile && entryStats.size > MAX_PROJECT_SKILL_COMPANION_FILE_BYTES)
        ) {
          unsafe = true;
          break;
        }
        skillBytes += entryStats.size;
        if (
          skillBytes > MAX_PROJECT_SKILL_SNAPSHOT_BYTES ||
          skillFiles.length + 1 > MAX_PROJECT_SKILL_SNAPSHOT_FILES
        ) {
          unsafe = true;
          break;
        }
        skillFiles.push({ record, relativePath });
      }
    }

    if (
      unsafe ||
      !skillFiles.some((item) => item.relativePath === "SKILL.md") ||
      budget.files + skillFiles.length > MAX_PROJECT_SKILL_SNAPSHOT_TOTAL_FILES ||
      budget.bytes + skillBytes > MAX_PROJECT_SKILL_SNAPSHOT_TOTAL_BYTES
    ) {
      skippedSkillCount += 1;
      continue;
    }

    const stagedFiles: Array<{
      readonly relativePath: string;
      readonly contents: Uint8Array;
      readonly sourceMode: number;
    }> = [];
    for (const item of skillFiles.sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    )) {
      const contents = await readVerifiedSkillFile(item.record, discovery.containmentRoot);
      if (!contents) {
        unsafe = true;
        break;
      }
      stagedFiles.push({
        relativePath: item.relativePath,
        contents,
        sourceMode: item.record.mode,
      });
    }
    if (unsafe) {
      skippedSkillCount += 1;
      continue;
    }
    budget.files += skillFiles.length;
    budget.bytes += skillBytes;
    snapshots.push({ sourcePath: file.path, files: stagedFiles });
  }
  return { snapshots, skippedSkillCount };
}

/** Capture only an explicitly configured host directory. No ambient home scan. */
export async function collectPiPersonalSkillSnapshots(
  configuredDirectory: string,
): Promise<PiProjectSkillSnapshotCollection> {
  if (!NodePath.isAbsolute(configuredDirectory)) {
    throw new Error("Personal Pi skills directory must be an absolute host path.");
  }
  const root = NodePath.resolve(configuredDirectory);
  const stats = await NodeFSP.lstat(root);
  const canonical = await NodeFSP.realpath(root);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !isSamePath(root, canonical)) {
    throw new Error("Personal Pi skills directory must be a real directory without symlinks.");
  }
  const budget = { directories: 0, entries: 0, files: 0, bytes: 0, skippedSkills: 0 };
  const files = await collectSkillFiles(root, root, defaultDependencies, new Set(), budget);
  return collectPiSkillSnapshots({
    containmentRoot: root,
    files,
    skippedSkillCount: budget.skippedSkills,
  });
}

/** Read a stable, bounded personal AGENTS.md before staging it in a private agentDir. */
export async function collectPiPersonalInstructions(configuredFile: string): Promise<Uint8Array> {
  if (
    !NodePath.isAbsolute(configuredFile) ||
    NodePath.basename(configuredFile).toLowerCase() !== "agents.md"
  ) {
    throw new Error("Personal Pi instructions must be an absolute path to AGENTS.md.");
  }
  const filePath = NodePath.resolve(configuredFile);
  const stats = await NodeFSP.lstat(filePath);
  const canonical = await NodeFSP.realpath(filePath);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    !isSamePath(filePath, canonical) ||
    stats.size > MAX_PROJECT_SKILL_FILE_BYTES
  ) {
    throw new Error("Personal Pi AGENTS.md must be a regular, non-link file under 256 KiB.");
  }
  const record: PiSkillFileRecord = {
    path: filePath,
    skillDirectory: NodePath.dirname(filePath),
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mode: stats.mode,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    birthtimeMs: stats.birthtimeMs,
  };
  const contents = await readVerifiedSkillFile(record, NodePath.dirname(filePath));
  if (!contents) throw new Error("Personal Pi AGENTS.md changed while it was being read.");
  return contents;
}

/**
 * Materialize complete skill snapshots in a fresh private FT3 state directory.
 * Companion files retain their skill-relative paths, while no mutable worktree
 * path is handed to Pi.
 */
export async function stagePiProjectSkillSnapshots(
  snapshots: ReadonlyArray<PiProjectSkillSnapshot>,
  stateDirectory: string,
): Promise<{ readonly directory: string; readonly paths: ReadonlyArray<string> }> {
  let totalBytes = 0;
  let totalFiles = 0;
  for (const snapshot of snapshots) {
    let skillBytes = 0;
    let hasSkillFile = false;
    const paths = new Set<string>();
    if (snapshot.files.length > MAX_PROJECT_SKILL_SNAPSHOT_FILES) {
      throw new Error("Pi project skill snapshot exceeded its file-count limit.");
    }
    for (const file of snapshot.files) {
      const segments = file.relativePath.split(/[\\/]/);
      if (
        !file.relativePath ||
        NodePath.isAbsolute(file.relativePath) ||
        segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
        segments.length - 1 > MAX_PROJECT_SKILL_SNAPSHOT_DEPTH ||
        paths.has(file.relativePath)
      ) {
        throw new Error("Pi project skill snapshot contained an unsafe relative path.");
      }
      paths.add(file.relativePath);
      const isSkillFile = file.relativePath === "SKILL.md";
      hasSkillFile ||= isSkillFile;
      if (
        (isSkillFile && file.contents.byteLength > MAX_PROJECT_SKILL_FILE_BYTES) ||
        (!isSkillFile && file.contents.byteLength > MAX_PROJECT_SKILL_COMPANION_FILE_BYTES)
      ) {
        throw new Error("Pi project skill snapshot exceeded its per-file size limit.");
      }
      skillBytes += file.contents.byteLength;
      totalFiles += 1;
      if (
        skillBytes > MAX_PROJECT_SKILL_SNAPSHOT_BYTES ||
        totalFiles > MAX_PROJECT_SKILL_SNAPSHOT_TOTAL_FILES
      ) {
        throw new Error("Pi project skill snapshots exceeded their file or byte budget.");
      }
    }
    if (!hasSkillFile) {
      throw new Error("Pi project skill snapshot did not contain SKILL.md.");
    }
    totalBytes += skillBytes;
    if (totalBytes > MAX_PROJECT_SKILL_SNAPSHOT_TOTAL_BYTES) {
      throw new Error("Pi project skill snapshots exceeded their aggregate size limit.");
    }
  }

  await NodeFSP.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const directory = await NodeFSP.mkdtemp(NodePath.join(stateDirectory, "project-skills-"));
  const paths: Array<string> = [];
  try {
    for (const [index, snapshot] of snapshots.entries()) {
      const skillDirectory = NodePath.join(directory, `skill-${String(index).padStart(4, "0")}`);
      await NodeFSP.mkdir(skillDirectory, { mode: 0o700 });
      for (const file of snapshot.files) {
        const filePath = NodePath.join(skillDirectory, ...file.relativePath.split(/[\\/]/));
        await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true, mode: 0o700 });
        await NodeFSP.writeFile(filePath, file.contents, {
          flag: "wx",
          mode: getPiStagedSkillFileMode(file.sourceMode),
        });
        if (file.relativePath === "SKILL.md") paths.push(filePath);
      }
    }
    return { directory, paths };
  } catch (cause) {
    await NodeFSP.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  }
}

export async function removeStagedPiProjectSkills(directory: string): Promise<void> {
  await NodeFSP.rm(directory, { recursive: true, force: true });
}

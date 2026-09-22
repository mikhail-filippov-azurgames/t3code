// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type * as NodeSqlite from "node:sqlite";

import type { OpenContextResolveDocResult } from "@t3tools/contracts";

const STORE_DATABASE_FILENAME = "opencontext.db";
const STORE_CONTEXTS_DIRECTORY = "contexts";

/** Frontmatter key the local store writes on every document; the DB mirrors it. */
const FRONTMATTER_STABLE_ID_PATTERN = /^stable_id:\s*["']?([^"'\s]+)["']?\s*$/m;
const FRONTMATTER_SCAN_LIMIT = 4096;

const MAX_SCAN_FILES = 4000;
const MAX_SCAN_DEPTH = 12;

/**
 * A miss refreshes the snapshot at most this often: a document created after
 * the index was built still resolves on a later click, while a genuinely
 * unknown id cannot force a full snapshot on every click.
 */
const INDEX_REFRESH_INTERVAL_MS = 5_000;

const DOCUMENTS_QUERY =
  "SELECT stable_id, name, rel_path, abs_path FROM docs WHERE stable_id IS NOT NULL AND stable_id <> ''";

export interface OpenContextDocRecord {
  readonly stableId: string;
  readonly name: string;
  readonly relativePath: string;
  readonly absolutePath: string;
}

export interface OpenContextDocResolver {
  resolve(stableId: string): Promise<OpenContextResolveDocResult>;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * The store root. `OPENCONTEXT_HOME` is the escape hatch the store's own
 * tooling does not need on Windows, where it defaults to `~/.opencontext`.
 */
export function resolveOpenContextRoot(environment: NodeJS.ProcessEnv, userHome: string): string {
  const configured = environment.OPENCONTEXT_HOME?.trim();
  return configured ? NodePath.resolve(configured) : NodePath.join(userHome, ".opencontext");
}

/** Reads `stable_id:` from a document's YAML frontmatter, ignoring the body. */
export function parseStableIdFromFrontmatter(content: string): string | null {
  const header = content.slice(0, FRONTMATTER_SCAN_LIMIT);
  const match = FRONTMATTER_STABLE_ID_PATTERN.exec(header);
  const stableId = match?.[1]?.trim();
  return stableId && stableId.length > 0 ? stableId : null;
}

function parseDatabaseRow(row: unknown): OpenContextDocRecord | null {
  if (typeof row !== "object" || row === null) return null;
  const record = row as Record<string, unknown>;
  const stableId = nonEmptyString(record.stable_id);
  const name = nonEmptyString(record.name);
  const relativePath = nonEmptyString(record.rel_path);
  const absolutePath = nonEmptyString(record.abs_path);
  if (!stableId || !name || !relativePath || !absolutePath) return null;
  return { stableId, name, relativePath, absolutePath };
}

/**
 * Snapshots `opencontext.db` with `VACUUM INTO` rather than copying the live
 * file: the store's WAL may be mid-checkpoint, and a read-only open of the
 * original could still touch its sidecar files. Returns null when the store is
 * absent or unreadable so the caller can fall back to the markdown tree.
 */
async function readDatabaseIndex(
  databasePath: string,
): Promise<Map<string, OpenContextDocRecord> | null> {
  try {
    const stats = await NodeFSP.stat(databasePath);
    if (!stats.isFile()) return null;
  } catch {
    return null;
  }

  const temporaryDirectory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "opencontext-snapshot-"),
  );
  const snapshotPath = NodePath.join(temporaryDirectory, STORE_DATABASE_FILENAME);
  let snapshot: NodeSqlite.DatabaseSync | null = null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const source = new DatabaseSync(databasePath, { readOnly: true });
    try {
      source.exec(`VACUUM INTO '${snapshotPath.replaceAll("'", "''")}'`);
    } finally {
      source.close();
    }

    snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
    const rows = snapshot.prepare(DOCUMENTS_QUERY).all();
    const index = new Map<string, OpenContextDocRecord>();
    for (const row of rows) {
      const record = parseDatabaseRow(row);
      if (record) index.set(record.stableId, record);
    }
    return index;
  } catch {
    return null;
  } finally {
    try {
      snapshot?.close();
    } catch {
      // A failed read already fell back; a close error adds no signal.
    }
    await NodeFSP.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readFrontmatterRecord(
  filePath: string,
  root: string,
): Promise<OpenContextDocRecord | null> {
  try {
    const content = await NodeFSP.readFile(filePath, "utf8");
    const stableId = parseStableIdFromFrontmatter(content);
    if (!stableId) return null;
    return {
      stableId,
      name: NodePath.basename(filePath),
      relativePath: NodePath.relative(root, filePath).split(NodePath.sep).join("/"),
      absolutePath: filePath,
    };
  } catch {
    return null;
  }
}

/**
 * Bounded frontmatter walk used only when the database cannot be read. It is
 * the store's own source of truth in reverse: every document carries its
 * `stable_id`, so the walk is correct without needing the SQLite schema.
 */
async function scanContextsIndex(
  contextsDirectory: string,
  root: string,
): Promise<Map<string, OpenContextDocRecord> | null> {
  try {
    const stats = await NodeFSP.stat(contextsDirectory);
    if (!stats.isDirectory()) return null;
  } catch {
    return null;
  }

  const index = new Map<string, OpenContextDocRecord>();
  const pending: Array<{ directory: string; depth: number }> = [
    { directory: contextsDirectory, depth: 0 },
  ];
  let visitedFiles = 0;

  while (pending.length > 0 && visitedFiles < MAX_SCAN_FILES) {
    const current = pending.pop();
    if (!current) break;
    let entries;
    try {
      entries = await NodeFSP.readdir(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (visitedFiles >= MAX_SCAN_FILES) break;
      const entryPath = NodePath.join(current.directory, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < MAX_SCAN_DEPTH) {
          pending.push({ directory: entryPath, depth: current.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      visitedFiles += 1;
      const record = await readFrontmatterRecord(entryPath, root);
      if (record && !index.has(record.stableId)) index.set(record.stableId, record);
    }
  }

  return index;
}

async function buildIndex(root: string): Promise<Map<string, OpenContextDocRecord> | null> {
  const databaseIndex = await readDatabaseIndex(NodePath.join(root, STORE_DATABASE_FILENAME));
  if (databaseIndex !== null) return databaseIndex;
  return scanContextsIndex(NodePath.join(root, STORE_CONTEXTS_DIRECTORY), root);
}

export function createOpenContextDocResolver(options: {
  readonly root: string;
}): OpenContextDocResolver {
  const { root } = options;
  let index: Map<string, OpenContextDocRecord> | null = null;
  let indexBuiltAt = 0;

  const loadIndex = async (force: boolean): Promise<Map<string, OpenContextDocRecord> | null> => {
    if (!force && index !== null) return index;
    const built = await buildIndex(root);
    index = built;
    indexBuiltAt = built === null ? 0 : Date.now();
    return built;
  };

  const resolve = async (stableId: string): Promise<OpenContextResolveDocResult> => {
    let current = await loadIndex(false);
    if (current === null) return { status: "store_unavailable" };

    let record = current.get(stableId);
    if (record === undefined && Date.now() - indexBuiltAt > INDEX_REFRESH_INTERVAL_MS) {
      current = await loadIndex(true);
      if (current === null) return { status: "store_unavailable" };
      record = current.get(stableId);
    }

    return record === undefined ? { status: "not_found" } : { status: "found", ...record };
  };

  return { resolve };
}

let defaultResolver: OpenContextDocResolver | null = null;
let defaultResolverRoot: string | null = null;

/** Shared resolver for the server process, rebuilt only when the root changes. */
export function resolveOpenContextDoc(
  stableId: string,
  environment: NodeJS.ProcessEnv = process.env,
  userHome: string = NodeOS.homedir(),
): Promise<OpenContextResolveDocResult> {
  const root = resolveOpenContextRoot(environment, userHome);
  if (defaultResolver === null || defaultResolverRoot !== root) {
    defaultResolver = createOpenContextDocResolver({ root });
    defaultResolverRoot = root;
  }
  return defaultResolver.resolve(stableId);
}

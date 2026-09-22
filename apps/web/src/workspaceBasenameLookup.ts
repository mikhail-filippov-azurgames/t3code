// Enough hits to look past same-named neighbours (`ChatView.test.tsx`) without
// asking for a full listing on a single click.
export const WORKSPACE_BASENAME_LOOKUP_LIMIT = 25;

// A resolution is stable until the workspace changes, so a small cache makes a
// repeated click instant and remembers misses too. Bounded so a long session
// cannot grow it without bound.
const WORKSPACE_MATCH_CACHE_LIMIT = 256;
const workspaceMatchCache = new Map<string, string | null>();

// One counter for every caller: they all open the same panel, so the newest
// click wins regardless of which one started the lookup.
let latestLookupSequence = 0;

/** Call the returned predicate when the search settles; false means a later click superseded it. */
export function claimWorkspaceBasenameLookup(): () => boolean {
  latestLookupSequence += 1;
  const claimed = latestLookupSequence;
  return () => claimed === latestLookupSequence;
}

export interface WorkspaceEntryCandidate {
  readonly path: string;
  readonly kind: "file" | "directory";
}

function normalizeWorkspacePath(path: string): string {
  return path
    .trim()
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "");
}

function isAbsoluteTargetPath(path: string): boolean {
  const trimmed = path.trim();
  return (
    trimmed.startsWith("/") ||
    trimmed.startsWith("~") ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith("\\\\")
  );
}

function basenameOfPath(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  const separatorIndex = normalized.lastIndexOf("/");
  return separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : normalized;
}

/**
 * The index is keyed by the workspace, so absolute host paths and `~` paths
 * never belong to it; relative paths do, bare or nested.
 */
export function needsWorkspaceBasenameLookup(relativePath: string): boolean {
  const trimmed = relativePath.trim();
  return trimmed.length > 0 && !isAbsoluteTargetPath(trimmed);
}

/** What to ask the index for: a path matches only on its final segment. */
export function workspaceLookupQuery(relativePath: string): string {
  return basenameOfPath(relativePath);
}

/** The workspace-relative directory that contains `relativePath` ("" is the root). */
export function workspaceParentDirectory(relativePath: string): string {
  const normalized = normalizeWorkspacePath(relativePath);
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  return segments.slice(0, -1).join("/");
}

export function workspaceMatchCacheKey(cwd: string, relativePath: string): string {
  return `${normalizeWorkspacePath(cwd)}\u0000${normalizeWorkspacePath(relativePath)}`;
}

export function readCachedWorkspaceMatch(key: string): {
  readonly hit: boolean;
  readonly value: string | null;
} {
  return workspaceMatchCache.has(key)
    ? { hit: true, value: workspaceMatchCache.get(key) ?? null }
    : { hit: false, value: null };
}

export function cacheWorkspaceMatch(key: string, value: string | null): void {
  if (workspaceMatchCache.has(key)) workspaceMatchCache.delete(key);
  workspaceMatchCache.set(key, value);
  while (workspaceMatchCache.size > WORKSPACE_MATCH_CACHE_LIMIT) {
    const oldest = workspaceMatchCache.keys().next().value;
    if (oldest === undefined) break;
    workspaceMatchCache.delete(oldest);
  }
}

export function clearWorkspaceMatchCache(): void {
  workspaceMatchCache.clear();
}

/**
 * Picks the single indexed file that a requested relative path names.
 *
 * A bare name matches on its basename; a nested path must also end with the
 * requested suffix (`Tests/Architecture/README.md`), so a same-named file
 * higher in the tree is never substituted. Exact casing wins, a lone
 * case-insensitive match is the fallback, and an ambiguous match is no match.
 */
export function pickWorkspaceRelativeMatch(
  requestedRelativePath: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): string | null {
  const normalizedTarget = normalizeWorkspacePath(requestedRelativePath);
  if (!normalizedTarget) return null;
  const targetSegments = normalizedTarget.split("/").filter((segment) => segment.length > 0);
  const basename = targetSegments.at(-1);
  if (!basename || basename === "." || basename === "..") return null;

  const files = entries.filter((entry) => entry.kind === "file");
  const isBare = targetSegments.length === 1;
  const suffix = `/${targetSegments.join("/")}`;
  const foldedBasename = basename.toLowerCase();
  const foldedSuffix = suffix.toLowerCase();

  const exact = files.filter((entry) => {
    const normalized = normalizeWorkspacePath(entry.path);
    return isBare
      ? basenameOfPath(normalized) === basename
      : normalized === normalizedTarget || normalized.endsWith(suffix);
  });
  if (exact.length === 1) return exact[0]?.path ?? null;
  if (exact.length > 1) return null;

  const folded = files.filter((entry) => {
    const normalized = normalizeWorkspacePath(entry.path).toLowerCase();
    return isBare
      ? basenameOfPath(normalized) === foldedBasename
      : normalized === normalizedTarget.toLowerCase() || normalized.endsWith(foldedSuffix);
  });
  return folded.length === 1 ? (folded[0]?.path ?? null) : null;
}

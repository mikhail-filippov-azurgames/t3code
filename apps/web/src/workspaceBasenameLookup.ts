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
 * What an index lookup concluded: the one file a requested relative path names,
 * several equally good files so nothing can be substituted, or no candidate.
 * Callers must not collapse `ambiguous` and `none` into a single miss, because
 * only `none` followed by a completed parent listing proves absence.
 */
export type WorkspaceRelativeMatchResolution =
  | { readonly kind: "resolved"; readonly path: string }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "none" };

function segmentCount(path: string): number {
  return normalizeWorkspacePath(path)
    .split("/")
    .filter((segment) => segment.length > 0).length;
}

/**
 * `candidates` are the paths that already end with the requested suffix. The
 * shallowest one is the least surprising interpretation of a nested link; a
 * tie between two depths cannot be guessed, so it stays ambiguous.
 */
function pickClosestCandidate(candidates: ReadonlyArray<string>): WorkspaceRelativeMatchResolution {
  const first = candidates[0];
  if (first === undefined) return { kind: "none" };
  let best = first;
  let bestSegments = segmentCount(first);
  let tied = false;
  for (const candidate of candidates.slice(1)) {
    const count = segmentCount(candidate);
    if (count < bestSegments) {
      best = candidate;
      bestSegments = count;
      tied = false;
    } else if (count === bestSegments) {
      tied = true;
    }
  }
  return tied ? { kind: "ambiguous" } : { kind: "resolved", path: best };
}

function pickSingleCandidate(candidates: ReadonlyArray<string>): WorkspaceRelativeMatchResolution {
  const first = candidates[0];
  if (first === undefined) return { kind: "none" };
  return candidates.length === 1 ? { kind: "resolved", path: first } : { kind: "ambiguous" };
}

/**
 * Classifies the single indexed file that a requested relative path names.
 *
 * A bare name matches on its basename; a nested path must also end with the
 * requested suffix (`Tests/Architecture/README.md`), so a same-named file
 * higher in the tree is never substituted. Exact casing wins and a lone
 * case-insensitive match is the fallback. Among nested suffix matches the
 * shallowest wins when it is strictly shallower; otherwise the result is
 * ambiguous, never a miss.
 */
export function resolveWorkspaceRelativeMatch(
  requestedRelativePath: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): WorkspaceRelativeMatchResolution {
  const normalizedTarget = normalizeWorkspacePath(requestedRelativePath);
  if (!normalizedTarget) return { kind: "none" };
  const targetSegments = normalizedTarget.split("/").filter((segment) => segment.length > 0);
  const basename = targetSegments.at(-1);
  if (!basename || basename === "." || basename === "..") return { kind: "none" };

  const files = entries.filter((entry) => entry.kind === "file");
  const isNested = targetSegments.length > 1;
  const suffix = `/${targetSegments.join("/")}`;
  const foldedBasename = basename.toLowerCase();
  const foldedSuffix = suffix.toLowerCase();

  const exact = files
    .map((entry) => ({ path: entry.path, normalized: normalizeWorkspacePath(entry.path) }))
    .filter(({ normalized }) =>
      isNested
        ? normalized === normalizedTarget || normalized.endsWith(suffix)
        : basenameOfPath(normalized) === basename,
    )
    .map(({ path }) => path);
  const exactResult = isNested ? pickClosestCandidate(exact) : pickSingleCandidate(exact);
  if (exactResult.kind !== "none") return exactResult;

  const folded = files
    .map((entry) => ({
      path: entry.path,
      normalized: normalizeWorkspacePath(entry.path).toLowerCase(),
    }))
    .filter(({ normalized }) =>
      isNested
        ? normalized === normalizedTarget.toLowerCase() || normalized.endsWith(foldedSuffix)
        : basenameOfPath(normalized) === foldedBasename,
    )
    .map(({ path }) => path);
  return isNested ? pickClosestCandidate(folded) : pickSingleCandidate(folded);
}

/**
 * Convenience view of {@link resolveWorkspaceRelativeMatch} for callers that
 * only want a path: an ambiguous match reads as no match.
 */
export function pickWorkspaceRelativeMatch(
  requestedRelativePath: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): string | null {
  const resolution = resolveWorkspaceRelativeMatch(requestedRelativePath, entries);
  return resolution.kind === "resolved" ? resolution.path : null;
}

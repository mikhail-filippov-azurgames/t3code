import type { WorkspaceEntryCandidate } from "@t3tools/client-runtime/workspace-basename-lookup";

// A resolution is stable until the workspace changes, so a small cache makes a
// repeated click instant and remembers misses too.
const WORKSPACE_MATCH_CACHE_LIMIT = 256;
const workspaceMatchCache = new Map<string, string | null>();

export function normalizeWorkspaceRelativePath(path: string): string {
  return path
    .trim()
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "");
}

export function workspaceLookupQuery(relativePath: string): string {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  const separatorIndex = normalized.lastIndexOf("/");
  return separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : normalized;
}

/** The workspace-relative directory that contains `relativePath` ("" is the root). */
export function workspaceParentDirectory(relativePath: string): string {
  const segments = normalizeWorkspaceRelativePath(relativePath)
    .split("/")
    .filter((segment) => segment.length > 0);
  return segments.slice(0, -1).join("/");
}

export function workspaceMatchCacheKey(cwd: string, relativePath: string): string {
  return `${normalizeWorkspaceRelativePath(cwd)}\u0000${normalizeWorkspaceRelativePath(relativePath)}`;
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

function basenameOfPath(path: string): string {
  const normalized = normalizeWorkspaceRelativePath(path);
  const separatorIndex = normalized.lastIndexOf("/");
  return separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : normalized;
}

function segmentCount(path: string): number {
  return normalizeWorkspaceRelativePath(path)
    .split("/")
    .filter((segment) => segment.length > 0).length;
}

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
 * Classifies the single indexed file a requested relative path names. A bare
 * name matches on its basename; a nested path must end with the requested
 * suffix, so a same-named file higher in the tree is never substituted.
 */
export function resolveWorkspaceRelativeMatch(
  requestedRelativePath: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): WorkspaceRelativeMatchResolution {
  const normalizedTarget = normalizeWorkspaceRelativePath(requestedRelativePath);
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
    .map((entry) => ({ path: entry.path, normalized: normalizeWorkspaceRelativePath(entry.path) }))
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
      normalized: normalizeWorkspaceRelativePath(entry.path).toLowerCase(),
    }))
    .filter(({ normalized }) =>
      isNested
        ? normalized === normalizedTarget.toLowerCase() || normalized.endsWith(foldedSuffix)
        : basenameOfPath(normalized) === foldedBasename,
    )
    .map(({ path }) => path);
  return isNested ? pickClosestCandidate(folded) : pickSingleCandidate(folded);
}

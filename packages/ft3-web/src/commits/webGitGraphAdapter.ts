import type {
  GitGraphCommit,
  GitGraphPage,
  GitGraphRef,
  GitGraphRefKind,
} from "@web-git-graph/protocol";
import type {
  VcsCommitHistoryCursor,
  VcsCommitHistoryEntry,
  VcsCommitHistoryRef,
  VcsCommitHistoryResult,
} from "@t3tools/ft3-vcs/contracts";
import type { GitGraphProvider } from "@web-git-graph/web";

/**
 * The component asks for up to 200 rows per page; the server contract caps the
 * history at 100, so every request is clamped to that.
 */
export const COMMITS_PAGE_LIMIT = 100;

/** Opaque page token: the component only ever hands back what we gave it. */
export function serializeCommitCursor(
  cursor: VcsCommitHistoryCursor | null | undefined,
): string | undefined {
  return cursor ? JSON.stringify([cursor.id, cursor.offset]) : undefined;
}

export function parseCommitCursor(value: string | undefined): VcsCommitHistoryCursor | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (
    Array.isArray(parsed) &&
    typeof parsed[0] === "string" &&
    typeof parsed[1] === "number" &&
    Number.isInteger(parsed[1]) &&
    parsed[1] > 0
  ) {
    return { id: parsed[0], offset: parsed[1] };
  }
  return undefined;
}

/**
 * `head` in our contract is the literal `HEAD` marker, not the library's local
 * branch kind; the checked-out branch is synthesised as `current` instead.
 * `other` has no library counterpart, so it borrows the generic tag chip.
 */
function commitRefKind(ref: VcsCommitHistoryRef, hasHead: boolean): GitGraphRefKind {
  switch (ref.kind) {
    case "branch":
      return hasHead ? "current" : "head";
    case "remote":
      return "remote";
    default:
      return "tag";
  }
}

export function toGitGraphCommit(entry: VcsCommitHistoryEntry): GitGraphCommit {
  return {
    oid: entry.id,
    parents: entry.parents,
    message: entry.subject,
    kind: "commit",
    author: { name: entry.authorName, email: entry.authorEmail },
    committedAt: entry.committedAt,
  };
}

export function toGitGraphPage(result: VcsCommitHistoryResult): GitGraphPage {
  const commits = result.commits.map(toGitGraphCommit);
  const refs: GitGraphRef[] = [];
  let head: string | undefined;
  for (const entry of result.commits) {
    const hasHead = entry.refs.some((ref) => ref.kind === "head");
    if (hasHead) head = entry.id;
    for (const ref of entry.refs) {
      if (ref.kind === "head") continue;
      refs.push({ name: ref.name, target: entry.id, kind: commitRefKind(ref, hasHead) });
    }
  }
  const cursor = serializeCommitCursor(result.nextCursor);
  return {
    commits,
    refs,
    ...(head === undefined ? {} : { head }),
    ...(cursor === undefined ? {} : { cursor }),
    hasMore: result.nextCursor !== null,
  };
}

export interface CommitHistoryFetcherInput {
  readonly cursor?: VcsCommitHistoryCursor;
  readonly limit: number;
}

export type CommitHistoryFetcher = (
  input: CommitHistoryFetcherInput,
) => Promise<VcsCommitHistoryResult>;

/** Loads pages in order until the requested SHA is present or history ends. */
export async function loadHistoryUntilCommit(
  fetcher: CommitHistoryFetcher,
  commitId: string,
  onPage: (page: GitGraphPage) => void,
): Promise<boolean> {
  let cursor: VcsCommitHistoryCursor | undefined;
  const visitedCursors = new Set<string>();
  do {
    const result = await fetcher({ limit: COMMITS_PAGE_LIMIT, ...(cursor ? { cursor } : {}) });
    onPage(toGitGraphPage(result));
    if (result.commits.some((commit) => commit.id === commitId)) return true;
    cursor = result.nextCursor ?? undefined;
    if (cursor) {
      const key = serializeCommitCursor(cursor)!;
      if (visitedCursors.has(key)) return false;
      visitedCursors.add(key);
    }
  } while (cursor);
  return false;
}

/**
 * Adapts our page-based `vcs.listCommitHistory` to the component's provider.
 * Ref badges come from the decorated `git log` output only; branch refs whose
 * heads sit outside a loaded page are not synthesised in V2.
 */
export function createCommitsGraphProvider(fetcher: CommitHistoryFetcher): GitGraphProvider {
  return {
    async getCapabilities() {
      return {
        protocolVersion: "1",
        history: true,
        details: false,
        compare: false,
        diff: false,
        workingTree: false,
        stashes: false,
        maxPageSize: COMMITS_PAGE_LIMIT,
      };
    },
    async getHistory(request) {
      const limit = Math.max(1, Math.min(request?.limit ?? COMMITS_PAGE_LIMIT, COMMITS_PAGE_LIMIT));
      const cursor = parseCommitCursor(request?.cursor);
      const result = await fetcher({ limit, ...(cursor === undefined ? {} : { cursor }) });
      return toGitGraphPage(result);
    },
  };
}

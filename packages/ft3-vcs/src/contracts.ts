import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const VcsCommitHistoryId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)),
);
export type VcsCommitHistoryId = typeof VcsCommitHistoryId.Type;

export const VCS_COMMIT_HISTORY_DEFAULT_LIMIT = 50;
export const VCS_COMMIT_HISTORY_MAX_LIMIT = 100;

/**
 * Resume point of a history page: the last commit shown, plus how many commits precede and
 * include it. The server tries `offset` first and verifies it against `id`; when refs moved and
 * the two disagree it relocates `id` itself, so a stale `offset` never skips or repeats commits.
 */
export const VcsCommitHistoryCursor = Schema.Struct({
  id: VcsCommitHistoryId,
  offset: PositiveInt,
});
export type VcsCommitHistoryCursor = typeof VcsCommitHistoryCursor.Type;

export const VcsCommitHistoryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  cursor: Schema.optional(VcsCommitHistoryCursor),
  limit: Schema.optional(
    PositiveInt.pipe(Schema.check(Schema.isLessThanOrEqualTo(VCS_COMMIT_HISTORY_MAX_LIMIT))),
  ),
});
export type VcsCommitHistoryInput = typeof VcsCommitHistoryInput.Type;

/** `head` is the literal `HEAD` (attached or detached); `other` is any ref outside heads, remotes and tags. */
export const VcsCommitHistoryRefKind = Schema.Literals([
  "head",
  "branch",
  "remote",
  "tag",
  "other",
]);
export type VcsCommitHistoryRefKind = typeof VcsCommitHistoryRefKind.Type;

export const VcsCommitHistoryRef = Schema.Struct({
  kind: VcsCommitHistoryRefKind,
  /** Short name: `main`, `origin/main`, `v1.0`. */
  name: Schema.String,
});
export type VcsCommitHistoryRef = typeof VcsCommitHistoryRef.Type;

export const VcsCommitHistoryEntry = Schema.Struct({
  id: VcsCommitHistoryId,
  /** In git's order; the first is the first parent. Empty for a root commit. */
  parents: Schema.Array(VcsCommitHistoryId),
  authorName: Schema.String,
  authorEmail: Schema.String,
  /** Committer date, which is what `git log` orders by. */
  committedAt: IsoDateTime,
  refs: Schema.Array(VcsCommitHistoryRef),
  subject: Schema.String,
});
export type VcsCommitHistoryEntry = typeof VcsCommitHistoryEntry.Type;

export const VcsCommitHistoryResult = Schema.Struct({
  /** Topological order across all refs: a commit always follows every commit that has it as a parent. */
  commits: Schema.Array(VcsCommitHistoryEntry),
  isRepo: Schema.Boolean,
  nextCursor: VcsCommitHistoryCursor.pipe(Schema.NullOr),
});
export type VcsCommitHistoryResult = typeof VcsCommitHistoryResult.Type;

/** Every ref in the repository, independent of the loaded history page. */
export const VcsRefEntry = Schema.Struct({
  /** Full ref name, e.g. `refs/heads/main` or `refs/tags/v1`. */
  refName: Schema.String,
  /** Short name: `main`, `origin/main`, `v1`. */
  name: Schema.String,
  kind: VcsCommitHistoryRefKind,
  /** Commit the ref points at; annotated tags are peeled. */
  target: VcsCommitHistoryId,
  current: Schema.Boolean,
});
export type VcsRefEntry = typeof VcsRefEntry.Type;

export const VcsRefsListInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type VcsRefsListInput = typeof VcsRefsListInput.Type;

export const VcsRefsListResult = Schema.Struct({
  refs: Schema.Array(VcsRefEntry),
  isRepo: Schema.Boolean,
});
export type VcsRefsListResult = typeof VcsRefsListResult.Type;

export const VcsCommitDiffInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  commit: VcsCommitHistoryId,
});
export type VcsCommitDiffInput = typeof VcsCommitDiffInput.Type;

export const VcsCommitDiffResult = Schema.Struct({
  commit: VcsCommitHistoryId,
  patch: Schema.String,
  truncated: Schema.Boolean,
});
export type VcsCommitDiffResult = typeof VcsCommitDiffResult.Type;

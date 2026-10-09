import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { GitCommandError, VcsCommitId } from "./git.ts";
import { VcsError } from "./vcs.ts";

export const ReviewDiffPreviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRef: Schema.optional(TrimmedNonEmptyString),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type ReviewDiffPreviewInput = typeof ReviewDiffPreviewInput.Type;

export const ReviewDiffPreviewSourceKind = Schema.Literals(["working-tree", "branch-range"]);
export type ReviewDiffPreviewSourceKind = typeof ReviewDiffPreviewSourceKind.Type;

export const ReviewDiffPreviewSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ReviewDiffPreviewSourceKind,
  title: TrimmedNonEmptyString,
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  diff: Schema.String,
  diffHash: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
});
export type ReviewDiffPreviewSource = typeof ReviewDiffPreviewSource.Type;

export const ReviewDiffFileContentsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  sourceKind: ReviewDiffPreviewSourceKind,
  changeType: Schema.Literals(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  oldPath: TrimmedNonEmptyString,
  newPath: TrimmedNonEmptyString,
});
export type ReviewDiffFileContentsInput = typeof ReviewDiffFileContentsInput.Type;

export const ReviewDiffFileContentsResult = Schema.Struct({
  oldContents: Schema.String,
  newContents: Schema.String,
});
export type ReviewDiffFileContentsResult = typeof ReviewDiffFileContentsResult.Type;

export const ReviewDiffPreviewResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  generatedAt: Schema.DateTimeUtc,
  sources: Schema.Array(ReviewDiffPreviewSource),
});
export type ReviewDiffPreviewResult = typeof ReviewDiffPreviewResult.Type;

export const ReviewDiffPreviewError = Schema.Union([VcsError, GitCommandError]);
export type ReviewDiffPreviewError = typeof ReviewDiffPreviewError.Type;

export const ReviewCommitDiffFilesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  commit: VcsCommitId,
});
export type ReviewCommitDiffFilesInput = typeof ReviewCommitDiffFilesInput.Type;

export const ReviewCommitDiffFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  status: Schema.Literals(["added", "deleted", "modified"]),
  additions: Schema.NullOr(NonNegativeInt),
  deletions: Schema.NullOr(NonNegativeInt),
  binary: Schema.Boolean,
});
export type ReviewCommitDiffFile = typeof ReviewCommitDiffFile.Type;

export const ReviewCommitDiffFilesResult = Schema.Struct({
  files: Schema.Array(ReviewCommitDiffFile),
});
export type ReviewCommitDiffFilesResult = typeof ReviewCommitDiffFilesResult.Type;

export const ReviewCommitFilePatchInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  commit: VcsCommitId,
  path: TrimmedNonEmptyString,
});
export type ReviewCommitFilePatchInput = typeof ReviewCommitFilePatchInput.Type;

export const ReviewCommitFilePatchResult = Schema.Struct({
  patch: Schema.String,
  tooLarge: Schema.Boolean,
});
export type ReviewCommitFilePatchResult = typeof ReviewCommitFilePatchResult.Type;

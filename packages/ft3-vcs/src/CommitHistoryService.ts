import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { VcsProcessExitError, type VcsError } from "@t3tools/contracts";
import * as VcsProcess from "../../../apps/server/src/vcs/VcsProcess.ts";

import * as Contracts from "./contracts.ts";

// Mirrors upstream checkpointing; the prefix is not exported there.
const CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";
const COMMIT_HISTORY_PAGE_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
// One full-history `%H` listing, only read when a cursor's offset went stale.
const COMMIT_HISTORY_LOCATE_MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const COMMIT_HISTORY_LOCATE_TIMEOUT_MS = 120_000;
const COMMIT_HISTORY_FIELD_SEPARATOR = "\x1f";
// `--exclude` only applies to the next `--all`, so it has to stay in front of it.
const COMMIT_HISTORY_REV_ARGS = [
  "--topo-order",
  `--exclude=${CHECKPOINT_REFS_PREFIX}/*`,
  "--all",
] as const;
const COMMIT_HISTORY_LOG_ARGS = [
  "log",
  "--no-color",
  "--no-show-signature",
  "--encoding=UTF-8",
  "--decorate=full",
  `--decorate-refs-exclude=${CHECKPOINT_REFS_PREFIX}/*`,
  "-z",
  `--format=%H%x1f%P%x1f%an%x1f%ae%x1f%ct%x1f%D%x1f%s`,
  ...COMMIT_HISTORY_REV_ARGS,
] as const;

export class CommitHistoryService extends Context.Service<
  CommitHistoryService,
  {
    readonly listCommitHistory: (
      input: Contracts.VcsCommitHistoryInput,
    ) => Effect.Effect<Contracts.VcsCommitHistoryResult, VcsError>;
  }
>()("@t3tools/ft3-vcs/CommitHistoryService") {}
export function classifyCommitHistoryRef(fullName: string): Contracts.VcsCommitHistoryRef {
  if (fullName.startsWith("refs/heads/")) {
    return { kind: "branch", name: fullName.slice("refs/heads/".length) };
  }
  if (fullName.startsWith("refs/remotes/")) {
    return { kind: "remote", name: fullName.slice("refs/remotes/".length) };
  }
  if (fullName.startsWith("refs/tags/")) {
    return { kind: "tag", name: fullName.slice("refs/tags/".length) };
  }
  return { kind: "other", name: fullName };
}

// `%D` under `--decorate=full`: `HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/main`.
export function parseCommitHistoryRefs(decoration: string): Contracts.VcsCommitHistoryRef[] {
  if (decoration.length === 0) return [];
  const refs: Contracts.VcsCommitHistoryRef[] = [];
  for (const item of decoration.split(", ")) {
    if (item === "HEAD") {
      refs.push({ kind: "head", name: "HEAD" });
    } else if (item.startsWith("HEAD -> ")) {
      refs.push({ kind: "head", name: "HEAD" });
      refs.push(classifyCommitHistoryRef(item.slice("HEAD -> ".length)));
    } else if (item.startsWith("tag: ")) {
      refs.push(classifyCommitHistoryRef(item.slice("tag: ".length)));
    } else {
      refs.push(classifyCommitHistoryRef(item));
    }
  }
  return refs;
}

export function parseCommitHistoryRecord(record: string): Contracts.VcsCommitHistoryEntry | null {
  const fields = record.split(COMMIT_HISTORY_FIELD_SEPARATOR);
  if (fields.length < 7) return null;
  const [id, parents, authorName, authorEmail, committedAtSeconds, decoration] = fields;
  const committedAtMs = Number(committedAtSeconds) * 1000;
  if (!id || !Number.isFinite(committedAtMs)) return null;
  return {
    id,
    parents: parents ? parents.split(" ") : [],
    authorName: authorName ?? "",
    authorEmail: authorEmail ?? "",
    committedAt: DateTime.formatIso(DateTime.makeUnsafe(committedAtMs)),
    refs: parseCommitHistoryRefs(decoration ?? ""),
    subject: fields.slice(6).join(COMMIT_HISTORY_FIELD_SEPARATOR),
  };
}

const nonRepositoryResult = (): Contracts.VcsCommitHistoryResult => ({
  commits: [],
  isRepo: false,
  nextCursor: null,
});

export const make = Effect.gen(function* () {
  const vcsProcess = yield* VcsProcess.VcsProcess;

  const runGit = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly allowNonZeroExit?: boolean;
      readonly timeoutMs?: number;
      readonly maxOutputBytes?: number;
    },
  ) =>
    vcsProcess.run({
      operation,
      command: "git",
      args: ["-C", cwd, ...args],
      cwd,
      spawnCwd: globalThis.process.cwd(),
      ...(options?.allowNonZeroExit === true ? { allowNonZeroExit: true } : {}),
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options?.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    });

  const isGitRepository = (cwd: string) =>
    runGit(
      "Ft3Vcs.listCommitHistory.detectRepository",
      cwd,
      ["rev-parse", "--is-inside-work-tree"],
      { allowNonZeroExit: true, timeoutMs: 5_000, maxOutputBytes: 4_096 },
    ).pipe(Effect.map((result) => result.exitCode === 0 && result.stdout.trim() === "true"));

  const readCommits = Effect.fn("Ft3Vcs.readCommits")(function* (
    cwd: string,
    skip: number,
    count: number,
  ) {
    const args = [...COMMIT_HISTORY_LOG_ARGS, "--skip", String(skip), "-n", String(count)];
    const result = yield* runGit("Ft3Vcs.listCommitHistory.log", cwd, args, {
      maxOutputBytes: COMMIT_HISTORY_PAGE_MAX_OUTPUT_BYTES,
    });
    // Records end with NUL, so whatever follows the last NUL is empty.
    const records = result.stdout.split("\0").slice(0, -1);
    return yield* Effect.forEach(
      records,
      (record) => {
        const commit = parseCommitHistoryRecord(record);
        if (commit === null) {
          return Effect.fail(
            new VcsProcessExitError({
              operation: "Ft3Vcs.listCommitHistory.log",
              command: "git log",
              cwd,
              exitCode: 0,
              detail: "git log returned a commit record that could not be parsed.",
            }),
          );
        }
        return Effect.succeed(commit);
      },
      { concurrency: "unbounded" },
    );
  });

  const locateCommit = Effect.fn("Ft3Vcs.locateCommit")(function* (cwd: string, id: string) {
    const args = ["log", "--no-show-signature", "--format=%H", ...COMMIT_HISTORY_REV_ARGS];
    const result = yield* runGit("Ft3Vcs.listCommitHistory.locate", cwd, args, {
      maxOutputBytes: COMMIT_HISTORY_LOCATE_MAX_OUTPUT_BYTES,
      timeoutMs: COMMIT_HISTORY_LOCATE_TIMEOUT_MS,
    });
    // Every line is exactly one id, so a match can only sit on a line boundary.
    const position = result.stdout.indexOf(id);
    if (position < 0) {
      return yield* new VcsProcessExitError({
        operation: "Ft3Vcs.listCommitHistory.locate",
        command: "git log",
        cwd,
        exitCode: 0,
        detail: `Commit ${id} is no longer in the history. Restart from the first page.`,
      });
    }
    return position / (id.length + 1);
  });

  const listCommitHistory: CommitHistoryService["Service"]["listCommitHistory"] = Effect.fn(
    "Ft3Vcs.listCommitHistory",
  )(function* (input) {
    if (!(yield* isGitRepository(input.cwd))) {
      return nonRepositoryResult();
    }

    const limit = input.limit ?? Contracts.VCS_COMMIT_HISTORY_DEFAULT_LIMIT;

    let start = 0;
    let following: ReadonlyArray<Contracts.VcsCommitHistoryEntry>;
    if (input.cursor === undefined) {
      following = yield* readCommits(input.cwd, 0, limit + 1);
    } else {
      const { id, offset } = input.cursor;
      const guess = yield* readCommits(input.cwd, offset - 1, limit + 2);
      if (guess[0]?.id === id) {
        start = offset;
        following = guess.slice(1);
      } else {
        start = (yield* locateCommit(input.cwd, id)) + 1;
        following = yield* readCommits(input.cwd, start, limit + 1);
      }
    }

    const commits = following.slice(0, limit);
    const last = commits.at(-1);
    return {
      commits,
      isRepo: true,
      nextCursor:
        following.length > limit && last !== undefined
          ? { id: last.id, offset: start + commits.length }
          : null,
    };
  });

  return CommitHistoryService.of({ listCommitHistory });
});

export const layer = Layer.effect(CommitHistoryService, make);

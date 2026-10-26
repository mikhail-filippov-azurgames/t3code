import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as CommitHistoryService from "./CommitHistoryService.ts";
import type * as Contracts from "./contracts.ts";
import * as VcsProcess from "../../../apps/server/src/vcs/VcsProcess.ts";

const id = (n: number) => n.toString(16).padStart(40, "0");

function record(index: number, ids: ReadonlyArray<string>, decoration = ""): string {
  const parents = index + 1 < ids.length ? [ids[index + 1]!] : [];
  const fields = [
    ids[index]!,
    parents.join(" "),
    "Author Name",
    "author@example.com",
    String(1700000000 - index * 60),
    decoration,
    `commit ${index}`,
  ];
  return fields.join("\x1f");
}

const ok = (stdout: string, exitCode = 0): VcsProcess.VcsProcessOutput => ({
  exitCode: exitCode as VcsProcess.VcsProcessOutput["exitCode"],
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

/** Newest-first linear history; `git log` honours `--skip`/`-n` over it. */
function makeProcess(ids: ReadonlyArray<string>) {
  return VcsProcess.VcsProcess.of({
    run: (input) => {
      const args = input.args;
      if (args.includes("--is-inside-work-tree")) {
        return Effect.succeed(ok("true\n"));
      }
      if (args.includes("--format=%H")) {
        return Effect.succeed(ok(`${ids.join("\n")}\n`));
      }
      const skipIndex = args.indexOf("--skip");
      const skip = skipIndex >= 0 ? Number(args[skipIndex + 1]) : 0;
      const countIndex = args.indexOf("-n");
      const count = countIndex >= 0 ? Number(args[countIndex + 1]) : ids.length;
      const page = ids.slice(skip, skip + count);
      const stdout =
        page.length === 0 ? "" : page.map((_, i) => record(skip + i, ids)).join("\0") + "\0";
      return Effect.succeed(ok(stdout));
    },
  });
}

const provideProcess = (ids: ReadonlyArray<string>) =>
  Effect.provideService(VcsProcess.VcsProcess, makeProcess(ids));

const run = (ids: ReadonlyArray<string>, input: Contracts.VcsCommitHistoryInput) =>
  Effect.gen(function* () {
    const service = yield* CommitHistoryService.CommitHistoryService;
    return yield* service.listCommitHistory(input);
  }).pipe(Effect.provide(CommitHistoryService.layer), provideProcess(ids));

describe("parseCommitHistoryRecord", () => {
  it("parses a record without parents or refs", () => {
    const parsed = CommitHistoryService.parseCommitHistoryRecord(
      `${id(1)}\x1f\x1fAlice\x1falice@example.com\x1f1700000000\x1f\x1froot commit`,
    );
    expect(parsed).toMatchObject({
      id: id(1),
      parents: [],
      authorName: "Alice",
      authorEmail: "alice@example.com",
      refs: [],
      subject: "root commit",
    });
  });

  it("parses parents and decorated refs", () => {
    const parsed = CommitHistoryService.parseCommitHistoryRecord(
      `${id(2)}\x1f${id(3)}\x1fBob\x1fbob@example.com\x1f1700000060\x1fHEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/main\x1ffix`,
    );
    expect(parsed?.parents).toEqual([id(3)]);
    expect(parsed?.refs).toEqual([
      { kind: "head", name: "HEAD" },
      { kind: "branch", name: "main" },
      { kind: "tag", name: "v1" },
      { kind: "remote", name: "origin/main" },
    ]);
  });

  it("returns null for a short record", () => {
    expect(
      CommitHistoryService.parseCommitHistoryRecord("only-three\x1ffields\x1fhere"),
    ).toBeNull();
  });
});

describe("parseCommitHistoryRefs", () => {
  it("classifies unknown refs as other", () => {
    expect(CommitHistoryService.classifyCommitHistoryRef("refs/notes/x")).toEqual({
      kind: "other",
      name: "refs/notes/x",
    });
  });
});

describe("CommitHistoryService.listCommitHistory", () => {
  const ids = [id(0), id(1), id(2), id(3), id(4)];

  it.effect("returns the first page and a cursor for more", () =>
    Effect.gen(function* () {
      const result = yield* run(ids, { cwd: "/repo", limit: 3 });
      expect(result.isRepo).toBe(true);
      expect(result.commits.map((c) => c.id)).toEqual([id(0), id(1), id(2)]);
      expect(result.nextCursor).toEqual({ id: id(2), offset: 3 });
    }),
  );

  it.effect("follows a cursor to the next page and ends cleanly", () =>
    Effect.gen(function* () {
      const result = yield* run(ids, { cwd: "/repo", limit: 3, cursor: { id: id(2), offset: 3 } });
      expect(result.commits.map((c) => c.id)).toEqual([id(3), id(4)]);
      expect(result.nextCursor).toBeNull();
    }),
  );

  it.effect("relocates a stale cursor offset by commit id", () =>
    Effect.gen(function* () {
      const result = yield* run(ids, {
        cwd: "/repo",
        limit: 2,
        cursor: { id: id(2), offset: 99 },
      });
      // id(2) sits at 0-based index 2, so the relocated page resumes after it.
      expect(result.commits.map((c) => c.id)).toEqual([id(3), id(4)]);
      expect(result.nextCursor).toBeNull();
    }),
  );

  it.effect("reports a non-repository cwd without a git log", () =>
    Effect.gen(function* () {
      const process = VcsProcess.VcsProcess.of({
        run: (input) =>
          Effect.succeed(
            input.args.includes("--is-inside-work-tree") ? ok("false\n", 128) : ok("unexpected"),
          ),
      });
      const result = yield* Effect.gen(function* () {
        const service = yield* CommitHistoryService.CommitHistoryService;
        return yield* service.listCommitHistory({ cwd: "/not-a-repo", limit: 3 });
      }).pipe(
        Effect.provide(CommitHistoryService.layer),
        Effect.provideService(VcsProcess.VcsProcess, process),
      );
      expect(result).toEqual({ commits: [], isRepo: false, nextCursor: null });
    }),
  );
});

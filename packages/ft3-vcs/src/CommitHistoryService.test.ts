// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

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

describe("parseRefsList", () => {
  it("classifies refs, marks the checked-out branch and peels annotated tags", () => {
    const refs = CommitHistoryService.parseRefsList(
      [
        `refs/heads/main\x1f${id(1)}\x1f\x1f*`,
        `refs/heads/feature\x1f${id(1)}\x1f\x1f `,
        `refs/remotes/origin/main\x1f${id(1)}\x1f\x1f `,
        `refs/tags/light\x1f${id(2)}\x1f\x1f `,
        `refs/tags/annotated\x1f${id(3)}\x1f${id(2)}\x1f `,
        `refs/t3/checkpoints/turn\x1f${id(4)}\x1f\x1f `,
        "malformed",
      ].join("\n"),
    );
    expect(refs).toEqual([
      { refName: "refs/heads/main", name: "main", kind: "branch", target: id(1), current: true },
      {
        refName: "refs/heads/feature",
        name: "feature",
        kind: "branch",
        target: id(1),
        current: false,
      },
      {
        refName: "refs/remotes/origin/main",
        name: "origin/main",
        kind: "remote",
        target: id(1),
        current: false,
      },
      {
        refName: "refs/tags/light",
        name: "light",
        kind: "tag",
        target: id(2),
        current: false,
      },
      {
        refName: "refs/tags/annotated",
        name: "annotated",
        kind: "tag",
        target: id(2),
        current: false,
      },
    ]);
  });
});

describe("CommitHistoryService.listRefs", () => {
  it.effect("reads refs from a real temporary repository", () =>
    Effect.gen(function* () {
      const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ft3-vcs-refs-"));
      const git = (...args: ReadonlyArray<string>) =>
        NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
      try {
        git("init", "-b", "main");
        git("config", "user.email", "author@example.com");
        git("config", "user.name", "Author");
        NodeFS.writeFileSync(NodePath.join(cwd, "file.txt"), "one\n");
        git("add", "file.txt");
        git("commit", "-m", "first");
        const commit = git("rev-parse", "HEAD").stdout.trim();
        git("branch", "feature");
        git("tag", "v1");

        const process = VcsProcess.VcsProcess.of({
          run: (input) =>
            Effect.sync(() => {
              const result = NodeChildProcess.spawnSync("git", [...input.args], {
                cwd: input.spawnCwd ?? input.cwd,
                encoding: "utf8",
              });
              return {
                exitCode: (result.status ?? 0) as VcsProcess.VcsProcessOutput["exitCode"],
                stdout: result.stdout,
                stderr: result.stderr,
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        });
        const result = yield* Effect.gen(function* () {
          const service = yield* CommitHistoryService.CommitHistoryService;
          return yield* service.listRefs({ cwd });
        }).pipe(
          Effect.provide(CommitHistoryService.layer),
          Effect.provideService(VcsProcess.VcsProcess, process),
        );

        expect(result.isRepo).toBe(true);
        expect(result.refs).toEqual(
          expect.arrayContaining([
            {
              refName: "refs/heads/main",
              name: "main",
              kind: "branch",
              target: commit,
              current: true,
            },
            {
              refName: "refs/heads/feature",
              name: "feature",
              kind: "branch",
              target: commit,
              current: false,
            },
            {
              refName: "refs/tags/v1",
              name: "v1",
              kind: "tag",
              target: commit,
              current: false,
            },
          ]),
        );
      } finally {
        NodeFS.rmSync(cwd, { recursive: true, force: true });
      }
    }),
  );
});

describe("CommitHistoryService.getCommitDiff", () => {
  it.effect("returns one commit's patch against its first parent, not the branch diff", () =>
    Effect.gen(function* () {
      const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ft3-vcs-diff-"));
      const git = (...args: ReadonlyArray<string>) =>
        NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
      try {
        git("init", "-b", "main");
        git("config", "user.email", "author@example.com");
        git("config", "user.name", "Author");
        NodeFS.writeFileSync(NodePath.join(cwd, "file.txt"), "one\n");
        NodeFS.writeFileSync(NodePath.join(cwd, "extra.txt"), "base\n");
        git("add", ".");
        git("commit", "-m", "first");
        const first = git("rev-parse", "HEAD").stdout.trim();
        NodeFS.writeFileSync(NodePath.join(cwd, "file.txt"), "two\n");
        git("add", "file.txt");
        git("commit", "-m", "second");
        const commit = git("rev-parse", "HEAD").stdout.trim();
        NodeFS.writeFileSync(NodePath.join(cwd, "file.txt"), "three\n");
        git("add", "file.txt");
        git("commit", "-m", "third");
        NodeFS.writeFileSync(NodePath.join(cwd, "extra.txt"), "master-only\n");
        git("add", "extra.txt");
        git("commit", "-m", "master tip");

        const process = VcsProcess.VcsProcess.of({
          run: (input) =>
            Effect.sync(() => {
              const result = NodeChildProcess.spawnSync("git", [...input.args], {
                cwd: input.spawnCwd ?? input.cwd,
                encoding: "utf8",
              });
              return {
                exitCode: (result.status ?? 0) as VcsProcess.VcsProcessOutput["exitCode"],
                stdout: result.stdout,
                stderr: result.stderr,
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        });
        const diffOf = (target: string) =>
          Effect.gen(function* () {
            const service = yield* CommitHistoryService.CommitHistoryService;
            return yield* service.getCommitDiff({ cwd, commit: target });
          }).pipe(
            Effect.provide(CommitHistoryService.layer),
            Effect.provideService(VcsProcess.VcsProcess, process),
          );

        const result = yield* diffOf(commit);
        expect(result).toMatchObject({ commit, truncated: false });
        expect(result.patch).toBe(
          git(
            "diff",
            "--no-ext-diff",
            "--no-renames",
            "--patch",
            "--minimal",
            "--no-color",
            first,
            commit,
          ).stdout,
        );
        expect(result.patch).toContain("-one");
        expect(result.patch).toContain("+two");
        expect(result.patch).not.toContain("+three");
        expect(result.patch).not.toContain("master-only");

        const root = yield* diffOf(first);
        expect(root.patch).toBe(
          git(
            "diff-tree",
            "--root",
            "-r",
            "--no-commit-id",
            "--no-renames",
            "--patch",
            "--minimal",
            "--no-color",
            first,
          ).stdout,
        );
        expect(root.patch).toContain("new file mode");
        expect(root.patch).toContain("+one");
      } finally {
        NodeFS.rmSync(cwd, { recursive: true, force: true });
      }
    }),
  );
});

describe("CommitHistoryService.resolveCommitMentions", () => {
  it.effect("resolves full and unique abbreviated SHAs from one cat-file batch", () =>
    Effect.gen(function* () {
      const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ft3-vcs-mentions-"));
      const git = (...args: ReadonlyArray<string>) =>
        NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
      try {
        git("init", "-b", "main");
        git("config", "user.email", "author@example.com");
        git("config", "user.name", "Author");
        NodeFS.writeFileSync(NodePath.join(cwd, "file.txt"), "one\n");
        git("add", "file.txt");
        git("commit", "-m", "first");
        const commit = git("rev-parse", "HEAD").stdout.trim();
        const short = commit.slice(0, 8);

        const process = VcsProcess.VcsProcess.of({
          run: (input) =>
            Effect.sync(() => {
              const result = NodeChildProcess.spawnSync("git", [...input.args], {
                cwd: input.spawnCwd ?? input.cwd,
                encoding: "utf8",
                ...(input.stdin === undefined ? {} : { input: input.stdin }),
              });
              return {
                exitCode: (result.status ?? 0) as VcsProcess.VcsProcessOutput["exitCode"],
                stdout: result.stdout,
                stderr: result.stderr,
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        });
        const result = yield* Effect.gen(function* () {
          const service = yield* CommitHistoryService.CommitHistoryService;
          return yield* service.resolveCommitMentions({
            cwd,
            candidates: [short, commit, "deadbee"],
          });
        }).pipe(
          Effect.provide(CommitHistoryService.layer),
          Effect.provideService(VcsProcess.VcsProcess, process),
        );

        expect(result.commits).toEqual([{ commit, cwd: NodePath.resolve(cwd) }]);
      } finally {
        NodeFS.rmSync(cwd, { recursive: true, force: true });
      }
    }),
  );

  it.effect("falls back to a nested repository and reports where the commit lives", () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ft3-vcs-mentions-nested-"));
      const nested = NodePath.join(root, "nested");
      const git = (cwd: string, ...args: ReadonlyArray<string>) =>
        NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
      try {
        NodeFS.mkdirSync(nested);
        git(root, "init", "-b", "main");
        git(root, "config", "user.email", "author@example.com");
        git(root, "config", "user.name", "Author");
        NodeFS.writeFileSync(NodePath.join(root, "root.txt"), "root\n");
        git(root, "add", "root.txt");
        git(root, "commit", "-m", "root");

        git(nested, "init", "-b", "main");
        git(nested, "config", "user.email", "author@example.com");
        git(nested, "config", "user.name", "Author");
        NodeFS.writeFileSync(NodePath.join(nested, "file.txt"), "one\n");
        git(nested, "add", "file.txt");
        git(nested, "commit", "-m", "nested");
        const commit = git(nested, "rev-parse", "HEAD").stdout.trim();

        const process = VcsProcess.VcsProcess.of({
          run: (input) =>
            Effect.sync(() => {
              const result = NodeChildProcess.spawnSync("git", [...input.args], {
                cwd: input.spawnCwd ?? input.cwd,
                encoding: "utf8",
                ...(input.stdin === undefined ? {} : { input: input.stdin }),
              });
              return {
                exitCode: (result.status ?? 0) as VcsProcess.VcsProcessOutput["exitCode"],
                stdout: result.stdout,
                stderr: result.stderr,
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        });
        const result = yield* Effect.gen(function* () {
          const service = yield* CommitHistoryService.CommitHistoryService;
          return yield* service.resolveCommitMentions({
            cwd: root,
            candidates: [commit.slice(0, 9)],
          });
        }).pipe(
          Effect.provide(CommitHistoryService.layer),
          Effect.provideService(VcsProcess.VcsProcess, process),
        );

        expect(result.commits).toEqual([{ commit, cwd: NodePath.resolve(nested) }]);
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }),
  );
});

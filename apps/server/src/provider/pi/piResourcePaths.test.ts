// @effect-diagnostics nodeBuiltinImport:off - These tests use disposable directories to verify safe, bounded skill discovery.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, it } from "vite-plus/test";

import {
  collectPiPersonalInstructions,
  collectPiPersonalSkillSnapshots,
  collectPiProjectSkillFiles,
  collectPiProjectSkillSnapshots,
  getPiStagedSkillFileMode,
  removeStagedPiProjectSkills,
  stagePiProjectSkillSnapshots,
} from "./piResourcePaths.ts";

const makeSkill = async (
  directory: string,
  contents = "---\nname: test-skill\ndescription: fixture\n---\n",
): Promise<string> => {
  const skillFile = NodePath.join(directory, "SKILL.md");
  await NodeFSP.mkdir(directory, { recursive: true });
  await NodeFSP.writeFile(skillFile, contents);
  return skillFile;
};

const addDirectoryLink = (target: string, link: string) =>
  NodeFSP.symlink(target, link, "junction");

describe("Pi project skill files", () => {
  it("rejects missing or linked personal resource sources", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-pi-personal-invalid-"));
    try {
      await NodeAssert.rejects(collectPiPersonalInstructions(NodePath.join(root, "AGENTS.md")));
      await NodeAssert.rejects(
        collectPiPersonalSkillSnapshots(NodePath.join(root, "missing-skills")),
      );
      const source = NodePath.join(root, "source");
      await NodeFSP.mkdir(source);
      await NodeFSP.writeFile(NodePath.join(source, "AGENTS.md"), "linked");
      const link = NodePath.join(root, "linked");
      await addDirectoryLink(source, link);
      await NodeAssert.rejects(collectPiPersonalInstructions(NodePath.join(link, "AGENTS.md")));
      await NodeAssert.rejects(collectPiPersonalSkillSnapshots(link));
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
  it("maps source execute bits to owner-only, non-writable staged modes", () => {
    const executableMode = getPiStagedSkillFileMode(0o100755);
    const readOnlyMode = getPiStagedSkillFileMode(0o100644);
    NodeAssert.equal(executableMode, 0o500);
    NodeAssert.equal(readOnlyMode, 0o400);
    NodeAssert.equal(executableMode & 0o222, 0);
    NodeAssert.equal(readOnlyMode & 0o222, 0);
    NodeAssert.equal(executableMode & 0o077, 0);
    NodeAssert.equal(readOnlyMode & 0o077, 0);
  });

  it("walks a nested linked worktree to its .git file and returns only explicit skill files", async () => {
    const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-pi-skill-paths-"));
    try {
      const worktree = NodePath.join(temp, "worktrees", "chat-1");
      const nested = NodePath.join(worktree, "packages", "app");
      const worktreeSkill = await makeSkill(
        NodePath.join(worktree, ".agents", "skills", "worktree-skill"),
      );
      const nestedSkill = await makeSkill(NodePath.join(nested, ".agents", "skills", "app-skill"));
      await NodeFSP.writeFile(
        NodePath.join(worktree, ".git"),
        "gitdir: ../main/.git/worktrees/chat-1",
      );
      NodeAssert.deepEqual(await collectPiProjectSkillFiles(nested), [worktreeSkill, nestedSkill]);
    } finally {
      await NodeFSP.rm(temp, { recursive: true, force: true });
    }
  });

  it("stages the verified skill snapshot so replacement after collection cannot affect Pi", async () => {
    const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-pi-skill-snapshot-"));
    let stagedDirectory: string | undefined;
    try {
      const repo = NodePath.join(temp, "worktree");
      const agentsDirectory = NodePath.join(repo, ".agents");
      const sourceSkill = NodePath.join(agentsDirectory, "skills", "snapshot-skill");
      const originalContents = "---\nname: snapshot-skill\ndescription: captured\n---\nold body";
      await NodeFSP.mkdir(NodePath.join(repo, ".git"), { recursive: true });
      await makeSkill(sourceSkill, originalContents);
      await NodeFSP.mkdir(NodePath.join(sourceSkill, "scripts"), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(sourceSkill, "references"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(sourceSkill, "scripts", "check.js"), "old script");
      await NodeFSP.writeFile(
        NodePath.join(sourceSkill, "references", "guide.md"),
        "old reference",
      );
      await NodeFSP.chmod(NodePath.join(sourceSkill, "SKILL.md"), 0o644);
      await NodeFSP.chmod(NodePath.join(sourceSkill, "scripts", "check.js"), 0o755);
      await NodeFSP.chmod(NodePath.join(sourceSkill, "references", "guide.md"), 0o644);

      const { snapshots, skippedSkillCount } = await collectPiProjectSkillSnapshots(repo);
      NodeAssert.equal(snapshots.length, 1);
      NodeAssert.equal(skippedSkillCount, 0);
      NodeAssert.equal(
        Buffer.from(
          snapshots[0]!.files.find((file) => file.relativePath === "SKILL.md")!.contents,
        ).toString("utf8"),
        originalContents,
      );

      // Simulate a worktree path being replaced after validation returns but
      // before Pi reads its --skill argument.
      const attackerAgents = NodePath.join(temp, "replacement", ".agents");
      const attackerSkill = await makeSkill(
        NodePath.join(attackerAgents, "skills", "replacement-skill"),
        "secret replacement that must never reach Pi",
      );
      await NodeFSP.writeFile(
        NodePath.join(sourceSkill, "scripts", "check.js"),
        "replacement script",
      );
      await NodeFSP.writeFile(
        NodePath.join(sourceSkill, "references", "guide.md"),
        "replacement reference",
      );
      await NodeFSP.rm(agentsDirectory, { recursive: true, force: true });
      await addDirectoryLink(attackerAgents, agentsDirectory);

      const staged = await stagePiProjectSkillSnapshots(
        snapshots,
        NodePath.join(temp, "ft3-state", "pi-session"),
      );
      stagedDirectory = staged.directory;
      NodeAssert.equal(staged.paths.length, 1);
      NodeAssert.equal(await NodeFSP.readFile(staged.paths[0]!, "utf8"), originalContents);
      const stagedSkillDirectory = NodePath.dirname(staged.paths[0]!);
      NodeAssert.equal(
        await NodeFSP.readFile(NodePath.join(stagedSkillDirectory, "scripts", "check.js"), "utf8"),
        "old script",
      );
      NodeAssert.equal(
        await NodeFSP.readFile(
          NodePath.join(stagedSkillDirectory, "references", "guide.md"),
          "utf8",
        ),
        "old reference",
      );
      NodeAssert.ok(!staged.paths[0]!.startsWith(repo));
      NodeAssert.ok(!staged.paths.includes(attackerSkill));
      NodeAssert.deepEqual(await NodeFSP.readdir(stagedSkillDirectory), [
        "references",
        "scripts",
        "SKILL.md",
      ]);
      // oxlint-disable-next-line t3code/no-global-process-runtime -- File mode assertion depends on the test host filesystem.
      if (NodeOS.platform() !== "win32") {
        NodeAssert.equal(
          (await NodeFSP.stat(NodePath.join(stagedSkillDirectory, "SKILL.md"))).mode & 0o777,
          0o400,
        );
        NodeAssert.equal(
          (await NodeFSP.stat(NodePath.join(stagedSkillDirectory, "scripts", "check.js"))).mode &
            0o777,
          0o500,
        );
        NodeAssert.equal(
          (await NodeFSP.stat(NodePath.join(stagedSkillDirectory, "references", "guide.md"))).mode &
            0o777,
          0o400,
        );
      }
    } finally {
      if (stagedDirectory) await removeStagedPiProjectSkills(stagedDirectory);
      await NodeFSP.rm(temp, { recursive: true, force: true });
    }
  });

  it("rejects an intermediate .agents junction that points outside the worktree", async () => {
    const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-pi-skill-junction-"));
    try {
      const repo = NodePath.join(temp, "repo");
      const outside = NodePath.join(temp, "outside", ".agents");
      const cwd = NodePath.join(repo, "src");
      await NodeFSP.mkdir(NodePath.join(repo, ".git"), { recursive: true });
      await NodeFSP.mkdir(cwd, { recursive: true });
      await makeSkill(NodePath.join(outside, "skills", "outside-skill"));
      await addDirectoryLink(outside, NodePath.join(repo, ".agents"));

      NodeAssert.deepEqual(await collectPiProjectSkillFiles(cwd), []);
    } finally {
      await NodeFSP.rm(temp, { recursive: true, force: true });
    }
  });

  it("loads a realistic skill set while skipping nested symlink escapes and cycles", async () => {
    const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-pi-skill-scale-"));
    try {
      const repo = NodePath.join(temp, "repo");
      const skillsRoot = NodePath.join(repo, ".agents", "skills");
      const outside = NodePath.join(temp, "outside");
      await NodeFSP.mkdir(NodePath.join(repo, ".git"), { recursive: true });
      await NodeFSP.mkdir(skillsRoot, { recursive: true });
      await NodeFSP.mkdir(outside, { recursive: true });
      const expected: Array<string> = [];
      for (let index = 0; index < 128; index += 1) {
        expected.push(
          await makeSkill(NodePath.join(skillsRoot, `skill-${String(index).padStart(3, "0")}`)),
        );
      }
      const outsideSkill = await makeSkill(NodePath.join(outside, "outside-skill"));
      await addDirectoryLink(skillsRoot, NodePath.join(skillsRoot, "loop"));
      await addDirectoryLink(outside, NodePath.join(skillsRoot, "escape"));

      const actual = await collectPiProjectSkillFiles(repo);
      NodeAssert.equal(actual.length, expected.length);
      NodeAssert.deepEqual(actual, expected);
      NodeAssert.ok(!actual.includes(outsideSkill));
      NodeAssert.ok(actual.every((path) => NodePath.relative(repo, path).startsWith(".agents")));
      const snapshots = await collectPiProjectSkillSnapshots(repo);
      NodeAssert.equal(snapshots.snapshots.length, expected.length);
      NodeAssert.equal(snapshots.skippedSkillCount, 0);
    } finally {
      await NodeFSP.rm(temp, { recursive: true, force: true });
    }
  });

  it("uses only cwd for standalone workspaces and handles absent files", async () => {
    const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-pi-skill-paths-"));
    try {
      const parent = NodePath.join(temp, "parent");
      const cwd = NodePath.join(parent, "project");
      await NodeFSP.mkdir(NodePath.join(parent, ".agents", "skills"), { recursive: true });
      await NodeFSP.mkdir(cwd, { recursive: true });
      NodeAssert.deepEqual(await collectPiProjectSkillFiles(cwd), []);
      const cwdSkill = await makeSkill(NodePath.join(cwd, ".agents", "skills", "cwd-skill"));
      NodeAssert.deepEqual(await collectPiProjectSkillFiles(cwd), [cwdSkill]);
    } finally {
      await NodeFSP.rm(temp, { recursive: true, force: true });
    }
  });

  it("skips per-file and aggregate oversized skills", async () => {
    const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-pi-skill-bytes-"));
    try {
      const repo = NodePath.join(temp, "repo");
      const skillsRoot = NodePath.join(repo, ".agents", "skills");
      await NodeFSP.mkdir(NodePath.join(repo, ".git"), { recursive: true });
      const smallSkill = await makeSkill(NodePath.join(skillsRoot, "000-small"), "x".repeat(32));
      await makeSkill(NodePath.join(skillsRoot, "001-too-large"), "x".repeat(256 * 1024 + 1));
      // Each file is below the 256 KiB per-file cap, but only ten fit within
      // the 2 MiB aggregate cap.
      for (let index = 0; index < 11; index += 1) {
        await makeSkill(
          NodePath.join(skillsRoot, `aggregate-${String(index).padStart(2, "0")}`),
          "x".repeat(200 * 1024),
        );
      }

      const files = await collectPiProjectSkillFiles(repo);
      NodeAssert.ok(files.includes(smallSkill));
      NodeAssert.ok(!files.includes(NodePath.join(skillsRoot, "001-too-large", "SKILL.md")));
      NodeAssert.equal(files.filter((file) => file.includes("aggregate-")).length, 10);
      const totalBytes = await files.reduce(async (totalPromise, file) => {
        const total = await totalPromise;
        return total + (await NodeFSP.stat(file)).size;
      }, Promise.resolve(0));
      NodeAssert.ok(totalBytes <= 2 * 1024 * 1024);

      const snapshots = await collectPiProjectSkillSnapshots(repo);
      NodeAssert.equal(snapshots.snapshots.length, files.length);
      NodeAssert.equal(snapshots.skippedSkillCount, 2);
      NodeAssert.ok(
        snapshots.snapshots.reduce(
          (total, snapshot) =>
            total +
            snapshot.files.reduce((skillTotal, file) => skillTotal + file.contents.byteLength, 0),
          0,
        ) <=
          2 * 1024 * 1024,
      );
    } finally {
      await NodeFSP.rm(temp, { recursive: true, force: true });
    }
  });

  it("omits a whole skill when a companion is unsafe or over budget", async () => {
    const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-pi-skill-companions-"));
    try {
      const repo = NodePath.join(temp, "repo");
      const skillsRoot = NodePath.join(repo, ".agents", "skills");
      const outside = NodePath.join(temp, "outside");
      await NodeFSP.mkdir(NodePath.join(repo, ".git"), { recursive: true });
      await NodeFSP.mkdir(outside, { recursive: true });
      const validRoot = NodePath.join(skillsRoot, "valid");
      const unsafeRoot = NodePath.join(skillsRoot, "unsafe-link");
      const oversizedRoot = NodePath.join(skillsRoot, "oversized");
      await makeSkill(validRoot, "---\nname: valid\ndescription: fixture\n---\nvalid");
      await makeSkill(unsafeRoot, "---\nname: unsafe\ndescription: fixture\n---\nunsafe");
      await makeSkill(oversizedRoot, "---\nname: oversized\ndescription: fixture\n---\nlarge");
      await NodeFSP.mkdir(NodePath.join(unsafeRoot, "scripts"), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(oversizedRoot, "scripts"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(unsafeRoot, "scripts", "check.js"), "safe partial");
      await NodeFSP.writeFile(NodePath.join(oversizedRoot, "scripts", "check.js"), "safe partial");
      await makeSkill(NodePath.join(outside, "secret"), "outside");
      await addDirectoryLink(
        NodePath.join(outside, "secret"),
        NodePath.join(unsafeRoot, "references"),
      );
      await NodeFSP.writeFile(
        NodePath.join(oversizedRoot, "references.md"),
        Buffer.alloc(1024 * 1024 + 1, 0x61),
      );

      const collection = await collectPiProjectSkillSnapshots(repo);
      NodeAssert.equal(collection.snapshots.length, 1);
      NodeAssert.equal(collection.skippedSkillCount, 2);
      NodeAssert.deepEqual(
        collection.snapshots[0]!.files.map((file) => file.relativePath),
        ["SKILL.md"],
      );
      NodeAssert.equal(
        Buffer.from(collection.snapshots[0]!.files[0]!.contents).toString("utf8"),
        "---\nname: valid\ndescription: fixture\n---\nvalid",
      );
    } finally {
      await NodeFSP.rm(temp, { recursive: true, force: true });
    }
  });

  it("rejects a SKILL.md that grows during path validation", async () => {
    const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-pi-skill-race-"));
    try {
      const repo = NodePath.join(temp, "repo");
      const skillFile = await makeSkill(NodePath.join(repo, ".agents", "skills", "raced"));
      await NodeFSP.mkdir(NodePath.join(repo, ".git"), { recursive: true });
      let fileChecks = 0;
      const dependencies: NonNullable<Parameters<typeof collectPiProjectSkillFiles>[1]> = {
        lstat: async (path) => {
          if (path === skillFile && ++fileChecks === 2) {
            await NodeFSP.writeFile(skillFile, "x".repeat(256 * 1024 + 1));
          }
          return NodeFSP.lstat(path);
        },
        realpath: (path) => NodeFSP.realpath(path),
        openDirectory: (path: string) => NodeFSP.opendir(path),
      };

      NodeAssert.deepEqual(await collectPiProjectSkillFiles(repo, dependencies), []);
      NodeAssert.equal(fileChecks, 2);
    } finally {
      await NodeFSP.rm(temp, { recursive: true, force: true });
    }
  });

  it("caps path inspections for very large roots", async () => {
    const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-pi-skill-bound-"));
    try {
      const repo = NodePath.join(temp, "repo");
      const skillsRoot = NodePath.join(repo, ".agents", "skills");
      await NodeFSP.mkdir(NodePath.join(repo, ".git"), { recursive: true });
      await NodeFSP.mkdir(skillsRoot, { recursive: true });
      let syntheticDirectoryChecks = 0;
      let syntheticEntriesRead = 0;
      const dependencies: NonNullable<Parameters<typeof collectPiProjectSkillFiles>[1]> = {
        lstat: async (path) => {
          const value = String(path);
          if (value.startsWith(`${skillsRoot}${NodePath.sep}synthetic-`)) {
            syntheticDirectoryChecks += 1;
            throw new Error("synthetic entry");
          }
          return NodeFSP.lstat(path);
        },
        realpath: (path) => NodeFSP.realpath(path),
        openDirectory: async (path: string) => ({
          close: async () => undefined,
          async *[Symbol.asyncIterator]() {
            if (path !== skillsRoot) return;
            for (let index = 0; index < 10_000; index += 1) {
              syntheticEntriesRead += 1;
              yield {
                name: `synthetic-${index}`,
                isDirectory: () => true,
                isSymbolicLink: () => false,
              };
            }
          },
        }),
      };

      NodeAssert.deepEqual(await collectPiProjectSkillFiles(repo, dependencies), []);
      NodeAssert.equal(syntheticDirectoryChecks, 2_047);
      NodeAssert.equal(syntheticEntriesRead, 2_048);
    } finally {
      await NodeFSP.rm(temp, { recursive: true, force: true });
    }
  });
});

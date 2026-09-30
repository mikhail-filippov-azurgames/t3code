// @effect-diagnostics nodeBuiltinImport:off - The exact bundled Pi loader is exercised in a child process with a disposable home.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, it } from "vite-plus/test";

import {
  collectPiPersonalInstructions,
  collectPiPersonalSkillSnapshots,
  collectPiProjectSkillSnapshots,
  removeStagedPiProjectSkills,
  stagePiProjectSkillSnapshots,
} from "./piResourcePaths.ts";

const packageRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../node_modules/@earendil-works/pi-coding-agent",
);
const packageEntry = NodePath.join(packageRoot, "dist/index.js");
const systemPromptEntry = NodePath.join(packageRoot, "dist/core/system-prompt.js");

const probe = String.raw`
  const { DefaultResourceLoader, formatSkillsForPrompt } = await import(process.argv[1]);
  const { buildSystemPrompt } = await import(process.argv[2]);
  const options = { cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, noExtensions: true };
  const untrustedLoader = new DefaultResourceLoader(options);
  await untrustedLoader.reload({ resolveProjectTrust: async () => false });
  const loader = new DefaultResourceLoader({ ...options, noSkills: true, additionalSkillPaths: JSON.parse(process.env.FT3_PI_PROJECT_SKILL_PATHS || "[]") });
  await loader.reload({ resolveProjectTrust: async () => false });
  const skills = loader.getSkills().skills;
  console.log(JSON.stringify({
    agents: loader.getAgentsFiles().agentsFiles,
    append: loader.getAppendSystemPrompt(),
    systemPrompt: buildSystemPrompt({
      cwd: process.cwd(),
      contextFiles: loader.getAgentsFiles().agentsFiles,
      appendSystemPrompt: loader.getAppendSystemPrompt().join("\n\n"),
      selectedTools: ["read"],
      skills,
    }),
    cwd: process.cwd(),
    agentDir: process.env.PI_CODING_AGENT_DIR,
    skills: skills.map(({ name, description, filePath }) => ({ name, description, filePath })),
    untrustedSkillNames: untrustedLoader.getSkills().skills.map(({ name }) => name),
    skillPrompt: formatSkillsForPrompt(skills),
    diagnostics: loader.getSkills().diagnostics,
  }));
`;

async function makeFixture(withResources: boolean) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-pi-native-resources-"));
  const home = NodePath.join(root, "isolated-home");
  const repo = NodePath.join(root, "repo");
  const worktreeRoot = NodePath.join(root, "worktrees", "thread-7");
  const cwd = NodePath.join(worktreeRoot, "nested", "package");
  const agentDir = NodePath.join(root, "state", "pi", "pi-default", "agent");
  await NodeFSP.mkdir(repo, { recursive: true });
  await NodeFSP.mkdir(agentDir, { recursive: true });
  await NodeFSP.mkdir(NodePath.join(home, ".agents", "skills", "fake-user-skill"), {
    recursive: true,
  });
  await NodeFSP.mkdir(NodePath.join(home, ".pi", "agent", "skills", "must-not-load"), {
    recursive: true,
  });
  await NodeFSP.writeFile(
    NodePath.join(agentDir, "settings.json"),
    '{"defaultProjectTrust":"never"}',
  );
  await NodeFSP.writeFile(NodePath.join(agentDir, "APPEND_SYSTEM.md"), "FT3_APPEND_MARKER");
  await NodeFSP.writeFile(
    NodePath.join(home, ".pi", "agent", "AGENTS.md"),
    "PRIVATE_PI_HOME_CONTEXT_MUST_NOT_LOAD",
  );
  await NodeFSP.writeFile(
    NodePath.join(home, ".pi", "agent", "skills", "must-not-load", "SKILL.md"),
    "---\nname: private-pi-skill\ndescription: private skill\n---\nprivate body",
  );
  await NodeFSP.writeFile(NodePath.join(repo, "README.md"), "worktree fixture");
  if (withResources) {
    await NodeFSP.writeFile(NodePath.join(repo, "AGENTS.md"), "MAIN_REPO_AGENTS_MARKER");
    await NodeFSP.mkdir(NodePath.join(repo, ".agents", "skills", "project-skill"), {
      recursive: true,
    });
    await NodeFSP.writeFile(
      NodePath.join(repo, ".agents", "skills", "project-skill", "SKILL.md"),
      "---\nname: project-skill\ndescription: project instructions\n---\nproject body",
    );
    await NodeFSP.writeFile(
      NodePath.join(home, ".agents", "skills", "fake-user-skill", "SKILL.md"),
      "---\nname: fake-user-skill\ndescription: isolated user instructions\n---\nuser body",
    );
  }
  const runGit = (args: string[], gitCwd = repo) => {
    const result = NodeChildProcess.spawnSync("git", args, {
      cwd: gitCwd,
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    NodeAssert.equal(result.status, 0, result.stderr || result.error?.message);
  };
  runGit(["init", "--quiet"]);
  runGit(["config", "user.name", "FT3 test"]);
  runGit(["config", "user.email", "ft3-test@example.invalid"]);
  runGit(["add", "."]);
  runGit(["commit", "--quiet", "-m", "fixture"]);
  await NodeFSP.mkdir(NodePath.dirname(worktreeRoot), { recursive: true });
  runGit(["worktree", "add", "--quiet", "-b", "ft3-resource-probe", worktreeRoot]);
  if (withResources) {
    await NodeFSP.writeFile(NodePath.join(worktreeRoot, "AGENTS.md"), "WORKTREE_AGENTS_MARKER");
    await NodeFSP.mkdir(NodePath.join(worktreeRoot, ".agents", "skills", "worktree-skill"), {
      recursive: true,
    });
    await NodeFSP.writeFile(
      NodePath.join(worktreeRoot, ".agents", "skills", "worktree-skill", "SKILL.md"),
      "---\nname: worktree-skill\ndescription: worktree instructions\n---\nworktree body",
    );
    await NodeFSP.mkdir(
      NodePath.join(worktreeRoot, ".agents", "skills", "worktree-skill", "scripts"),
      { recursive: true },
    );
    await NodeFSP.mkdir(
      NodePath.join(worktreeRoot, ".agents", "skills", "worktree-skill", "references"),
      { recursive: true },
    );
    await NodeFSP.writeFile(
      NodePath.join(worktreeRoot, ".agents", "skills", "worktree-skill", "SKILL.md"),
      "---\nname: worktree-skill\ndescription: worktree instructions\n---\nRead scripts/check.js and references/guide.md.",
    );
    await NodeFSP.writeFile(
      NodePath.join(worktreeRoot, ".agents", "skills", "worktree-skill", "scripts", "check.js"),
      "export const check = 'native staged script';",
    );
    await NodeFSP.writeFile(
      NodePath.join(worktreeRoot, ".agents", "skills", "worktree-skill", "references", "guide.md"),
      "Native staged reference contents.",
    );
  } else {
    await NodeFSP.mkdir(NodePath.join(worktreeRoot, "t3code"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(worktreeRoot, "t3code", "AGENTS.md"),
      "NESTED_REPO_AGENTS_MUST_NOT_LOAD",
    );
  }
  await NodeFSP.mkdir(cwd, { recursive: true });
  return { root, cwd, agentDir, home };
}

async function runProbe(
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  projectSkillPaths: ReadonlyArray<string> = [],
) {
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      probe,
      NodeURL.pathToFileURL(packageEntry).href,
      NodeURL.pathToFileURL(systemPromptEntry).href,
    ],
    {
      cwd: fixture.cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        USERPROFILE: fixture.home,
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agentDir,
        FT3_PI_PROJECT_SKILL_PATHS: JSON.stringify(projectSkillPaths),
      },
      timeout: 10_000,
      windowsHide: true,
    },
  );
  NodeAssert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout.trim()) as {
    agents: Array<{ path: string; content: string }>;
    append: string[];
    systemPrompt: string;
    cwd: string;
    agentDir: string;
    skills: Array<{ name: string; description: string; filePath: string }>;
    untrustedSkillNames: string[];
    skillPrompt: string;
    diagnostics: Array<unknown>;
  };
}

describe("bundled Pi native resources", () => {
  it("loads configured personal AGENTS.md before the first prompt outside a project and stages skill companions", async () => {
    const fixture = await makeFixture(false);
    let stagedDirectory: string | undefined;
    try {
      const personalRoot = NodePath.join(fixture.root, "codex-home");
      const instructionsPath = NodePath.join(personalRoot, "AGENTS.md");
      const skillsDirectory = NodePath.join(personalRoot, "skills");
      const skillDirectory = NodePath.join(skillsDirectory, "unified-skill");
      await NodeFSP.mkdir(NodePath.join(skillDirectory, "references"), { recursive: true });
      await NodeFSP.writeFile(instructionsPath, "PERSONAL_CODEX_AGENTS_MARKER");
      await NodeFSP.writeFile(
        NodePath.join(skillDirectory, "SKILL.md"),
        "---\nname: unified-skill\ndescription: Codex and Pi skill\n---\nRead references/guide.md.",
      );
      await NodeFSP.writeFile(
        NodePath.join(skillDirectory, "references", "guide.md"),
        "SHARED_COMPANION_MARKER",
      );
      const personalInstructions = await collectPiPersonalInstructions(instructionsPath);
      await NodeFSP.writeFile(NodePath.join(fixture.agentDir, "AGENTS.md"), personalInstructions);
      const collection = await collectPiPersonalSkillSnapshots(skillsDirectory);
      NodeAssert.equal(collection.skippedSkillCount, 0);
      NodeAssert.equal(collection.snapshots.length, 1);
      const staged = await stagePiProjectSkillSnapshots(collection.snapshots, fixture.agentDir);
      stagedDirectory = staged.directory;
      const resources = await runProbe(fixture, staged.paths);
      NodeAssert.match(
        resources.systemPrompt,
        /<project_context>[\s\S]*PERSONAL_CODEX_AGENTS_MARKER/,
      );
      NodeAssert.match(resources.systemPrompt, /<addendum>\s*FT3_APPEND_MARKER/);
      NodeAssert.deepEqual(
        resources.skills.map((skill) => skill.name),
        ["unified-skill"],
      );
      NodeAssert.equal(
        await NodeFSP.readFile(
          NodePath.join(NodePath.dirname(staged.paths[0]!), "references", "guide.md"),
          "utf8",
        ),
        "SHARED_COMPANION_MARKER",
      );
      NodeAssert.deepEqual(resources.diagnostics, []);
    } finally {
      if (stagedDirectory) await removeStagedPiProjectSkills(stagedDirectory);
      await NodeFSP.rm(fixture.root, { recursive: true, force: true });
    }
  });
  it("loads nested worktree instructions and project/user skills with FT3's isolated agent dir", async () => {
    const fixture = await makeFixture(true);
    let stagedDirectory: string | undefined;
    try {
      const collection = await collectPiProjectSkillSnapshots(fixture.cwd);
      NodeAssert.equal(collection.snapshots.length, 2);
      NodeAssert.equal(collection.skippedSkillCount, 0);
      const staged = await stagePiProjectSkillSnapshots(collection.snapshots, fixture.agentDir);
      stagedDirectory = staged.directory;
      NodeAssert.equal(staged.paths.length, 2);
      NodeAssert.ok(staged.paths.every((path) => path.endsWith("SKILL.md")));
      const resources = await runProbe(fixture, staged.paths);
      const context = resources.agents.map((item) => item.content).join("\n");
      NodeAssert.ok(!context.includes("MAIN_REPO_AGENTS_MARKER"));
      NodeAssert.match(context, /WORKTREE_AGENTS_MARKER/);
      NodeAssert.equal(NodePath.resolve(resources.cwd), NodePath.resolve(fixture.cwd));
      NodeAssert.equal(NodePath.resolve(resources.agentDir), NodePath.resolve(fixture.agentDir));
      NodeAssert.match(resources.systemPrompt, /<project_context>[\s\S]*WORKTREE_AGENTS_MARKER/);
      NodeAssert.match(resources.systemPrompt, /<addendum>\s*FT3_APPEND_MARKER/);
      NodeAssert.ok(!resources.systemPrompt.includes("MAIN_REPO_AGENTS_MARKER"));
      NodeAssert.ok(!context.includes("PRIVATE_PI_HOME_CONTEXT_MUST_NOT_LOAD"));
      NodeAssert.ok(!resources.untrustedSkillNames.includes("project-skill"));
      NodeAssert.ok(!resources.untrustedSkillNames.includes("worktree-skill"));
      NodeAssert.deepEqual(
        new Set(resources.skills.map((skill) => skill.name)),
        new Set(["project-skill", "worktree-skill"]),
      );
      NodeAssert.match(resources.skillPrompt, /project instructions/);
      NodeAssert.match(resources.skillPrompt, /worktree instructions/);
      NodeAssert.ok(!resources.skillPrompt.includes("isolated user instructions"));
      const nativeSkill = resources.skills.find((skill) => skill.name === "worktree-skill");
      NodeAssert.ok(nativeSkill?.filePath.startsWith(stagedDirectory));
      const stagedSkillDirectory = NodePath.dirname(nativeSkill!.filePath);
      NodeAssert.equal(
        await NodeFSP.readFile(NodePath.join(stagedSkillDirectory, "scripts", "check.js"), "utf8"),
        "export const check = 'native staged script';",
      );
      NodeAssert.equal(
        await NodeFSP.readFile(
          NodePath.join(stagedSkillDirectory, "references", "guide.md"),
          "utf8",
        ),
        "Native staged reference contents.",
      );
      NodeAssert.deepEqual(resources.append, ["FT3_APPEND_MARKER"]);
      NodeAssert.deepEqual(resources.diagnostics, []);
    } finally {
      if (stagedDirectory) await removeStagedPiProjectSkills(stagedDirectory);
      await NodeFSP.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("treats missing context and skills as empty without consulting the host home", async () => {
    const fixture = await makeFixture(false);
    try {
      const resources = await runProbe(fixture);
      NodeAssert.deepEqual(
        resources.agents.map((item) => item.content),
        [],
      );
      NodeAssert.ok(!resources.systemPrompt.includes("NESTED_REPO_AGENTS_MUST_NOT_LOAD"));
      NodeAssert.deepEqual(
        resources.skills.map((skill) => skill.name),
        [],
      );
      NodeAssert.deepEqual(resources.append, ["FT3_APPEND_MARKER"]);
    } finally {
      await NodeFSP.rm(fixture.root, { recursive: true, force: true });
    }
  });
});

// @effect-diagnostics nodeBuiltinImport:off - Runs the installer with isolated Git repositories and tool fixtures.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const windows = HostProcess.Platform.defaultValue() === "win32";
const shell = windows ? "C:/Program Files/Git/bin/bash.exe" : "/bin/sh";
const shellAvailable = await NodeFSP.access(shell).then(
  () => true,
  () => false,
);
const installer = NodePath.join(import.meta.dirname, "install-corvis.sh");
const manifest = JSON.parse(
  await NodeFSP.readFile(NodePath.join(import.meta.dirname, "../package.json"), "utf8"),
) as { engines: { node: string } };
const repositoryUrl = "https://github.com/mikhail-filippov-azurgames/t3code";

const bootstrap = `
test_bin=$1
if command -v cygpath >/dev/null 2>&1; then test_bin=$(cygpath -u "$test_bin"); fi
if [ "$4" = missing ]; then PATH=$test_bin; else PATH=$test_bin:/usr/bin:/bin; fi
export PATH
if [ -z "$3" ]; then exec /bin/sh "$2"; fi
exec /bin/sh "$2" "$3"
`;

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "corvis-shell-"));
  const source = NodePath.join(root, "source");
  const bin = NodePath.join(root, "bin");
  const userDirectory = NodePath.join(root, "user");
  const destination = NodePath.join(root, 'José [Corvis] $dollar %percent "quote"');
  // Windows forbids double quotes in filenames. The POSIX lane covers that character.
  const installDirectory = windows ? destination.replaceAll('"', "'") : destination;
  await NodeFSP.mkdir(NodePath.join(source, "apps/desktop/scripts"), { recursive: true });
  await NodeFSP.mkdir(bin);
  await NodeFSP.mkdir(userDirectory);
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { encoding: "utf8" }).trim();
  const gitPath = windows
    ? git("--exec-path").replace(/\/mingw64\/libexec\/git-core$/, "/cmd/git.exe")
    : NodeChildProcess.execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  git("-C", source, "init", "--initial-branch=corvis/main");
  await NodeFSP.writeFile(
    NodePath.join(source, "package.json"),
    JSON.stringify({ engines: manifest.engines }),
  );
  await NodeFSP.writeFile(
    NodePath.join(source, ".gitignore"),
    "node_modules/\napps/desktop/dist-electron/\napps/desktop/.electron-runtime/\n",
  );
  await NodeFSP.writeFile(
    NodePath.join(source, "apps/desktop/scripts/ensure-electron-runtime.mjs"),
    `
import { fileURLToPath } from 'node:url';
export const ensureElectronRuntime = () => fileURLToPath(new URL('../../../node_modules/electron', import.meta.url));
`,
  );
  await NodeFSP.writeFile(
    NodePath.join(source, "apps/desktop/scripts/start-electron.mjs"),
    `
import * as fs from 'node:fs';
fs.writeFileSync(process.env.CORVIS_TEST_LAUNCH, JSON.stringify({ cwd: process.cwd(), electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE }));
`,
  );
  git("-C", source, "add", ".");
  git(
    "-C",
    source,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  const scripts: Record<string, string> = {
    node: `
if [ "$1" = --version ]; then printf '%s\\n' "$CORVIS_TEST_NODE_VERSION"; exit 0; fi
# Git Bash runs a Windows Node executable. Translate the fixture's path arguments.
if command -v cygpath >/dev/null 2>&1; then
  case "$1" in
    -p) exec "$CORVIS_TEST_NODE" "$1" "$2" "$(cygpath -w "$3")" ;;
    --input-type=module) exec "$CORVIS_TEST_NODE" "$1" "$2" "$(cygpath -w "$3")" "$4" "$(cygpath -w "$5")" ;;
  esac
fi
exec "$CORVIS_TEST_NODE" "$@"
`,
    corepack: "printf '0.35.0\\n'\n",
    uname: "printf '%s\\n' \"$CORVIS_TEST_PLATFORM\"\n",
    pnpm: `
printf 'pnpm %s\\n' "$*" >> "$CORVIS_TEST_LOG"
if [ "$1" = --version ]; then printf '12.14.0\\n'; exit 0; fi
if [ "$*" = "$CORVIS_TEST_FAIL_AT" ]; then exit 42; fi
if [ "$1" = run ]; then
  mkdir -p apps/desktop/dist-electron node_modules
  printf '// built fixture\\n' > apps/desktop/dist-electron/main.cjs
  printf '#!/bin/sh\\nexit 0\\n' > node_modules/electron
  chmod +x node_modules/electron
fi
`,
    git: `
printf 'git %s\\n' "$*" >> "$CORVIS_TEST_LOG"
if [ "$1" = -C ] && command -v cygpath >/dev/null 2>&1; then
  test_directory=$(cygpath -w "$2")
  shift 2
  set -- -C "$test_directory" "$@"
fi
if [ "$1" = clone ]; then
  destination=$7
  if command -v cygpath >/dev/null 2>&1; then destination=$(cygpath -w "$destination"); fi
  "$CORVIS_TEST_GIT" clone --branch corvis/main --single-branch -- "$CORVIS_TEST_SOURCE" "$destination" || exit $?
  exec "$CORVIS_TEST_GIT" -C "$destination" remote set-url origin "$CORVIS_TEST_URL"
elif [ "\${3:-}" = fetch ]; then
  [ "$CORVIS_TEST_FAIL_AT" != fetch ] || exit 42
  exec "$CORVIS_TEST_GIT" -C "$2" fetch "$CORVIS_TEST_SOURCE" '+refs/heads/corvis/main:refs/remotes/origin/corvis/main'
elif [ "\${3:-}" = rev-parse ]; then
  result=$("$CORVIS_TEST_GIT" "$@") || exit $?
  if command -v cygpath >/dev/null 2>&1; then cygpath -u "$result"; else printf '%s\\n' "$result"; fi
else
  exec "$CORVIS_TEST_GIT" "$@"
fi
`,
  };
  for (const [name, content] of Object.entries(scripts)) {
    await NodeFSP.writeFile(NodePath.join(bin, name), "#!/bin/sh\nset -eu\n" + content, {
      mode: 0o755,
    });
  }
  await NodeFSP.copyFile(installer, NodePath.join(root, "install-corvis.sh"));
  const environment = {
    ...process.env,
    HOME: userDirectory,
    TMPDIR: NodeOS.tmpdir(),
    CORVIS_TEST_NODE: process.execPath,
    CORVIS_TEST_GIT: gitPath,
    CORVIS_TEST_SOURCE: source,
    CORVIS_TEST_URL: repositoryUrl,
    CORVIS_TEST_LOG: NodePath.join(root, "commands.log"),
    CORVIS_TEST_LAUNCH: NodePath.join(root, "launch.json"),
    CORVIS_TEST_NODE_VERSION: `v${manifest.engines.node}`,
    CORVIS_TEST_PLATFORM: "Linux",
    CORVIS_TEST_FAIL_AT: "",
  };
  return {
    root,
    source,
    userDirectory,
    installDirectory,
    git,
    environment,
    async run(
      options: {
        missingTool?: string;
        nodeVersion?: string;
        failAt?: string;
        platform?: string;
        useDefaultDirectory?: boolean;
      } = {},
    ) {
      if (options.missingTool) await NodeFSP.rm(NodePath.join(bin, options.missingTool));
      await NodeFSP.writeFile(environment.CORVIS_TEST_LOG, "");
      const result = NodeChildProcess.spawnSync(
        shell,
        [
          "-c",
          bootstrap,
          "sh",
          bin,
          NodePath.join(root, "install-corvis.sh"),
          options.useDefaultDirectory ? "" : installDirectory,
          options.missingTool ? "missing" : "available",
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 20_000,
          env: {
            ...environment,
            CORVIS_TEST_NODE_VERSION: options.nodeVersion ?? environment.CORVIS_TEST_NODE_VERSION,
            CORVIS_TEST_FAIL_AT: options.failAt ?? "",
            CORVIS_TEST_PLATFORM: options.platform ?? "Linux",
          },
        },
      );
      return {
        code: result.status,
        output: result.stdout + result.stderr,
        commands: await NodeFSP.readFile(environment.CORVIS_TEST_LOG, "utf8"),
      };
    },
    cleanup: () => NodeFSP.rm(root, { recursive: true, force: true }),
  };
}

it("keeps the standalone shell Node.js requirement aligned with engines.node", async () => {
  expect(await NodeFSP.readFile(installer, "utf8")).toContain(
    `required_node_version=${manifest.engines.node}`,
  );
});

// Git Bash exercises the shell and generated launchers on Windows. Native Unix
// runs use /bin/sh. These tests isolate platform selection and dependency tools.
describe.skipIf(!shellAvailable)("Corvis shell installer", () => {
  it("requires an explicit installation directory when downloaded into temp", async () => {
    const test = await fixture();
    try {
      const result = await test.run({ useDefaultDirectory: true });
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain('"$HOME/Corvis"');
      expect(result.commands).toBe("");
      expect(await NodeFSP.readdir(test.root)).not.toContain("corvis");
    } finally {
      await test.cleanup();
    }
  });

  it.each(["node", "corepack", "pnpm", "git"])(
    "explains missing %s before writing",
    async (missingTool) => {
      const test = await fixture();
      try {
        const result = await test.run({ missingTool });
        expect(result.code, result.output).toBe(1);
        expect(result.output).toContain(`Missing ${missingTool}`);
        expect(result.commands).toBe("");
        expect(await NodeFSP.readdir(test.root)).not.toContain(
          NodePath.basename(test.installDirectory),
        );
      } finally {
        await test.cleanup();
      }
    },
  );

  it.each(["v22.21.0", "v24.19.0", "v25.0.0"])(
    "rejects Node.js %s before cloning",
    async (nodeVersion) => {
      const test = await fixture();
      try {
        const result = await test.run({ nodeVersion });
        expect(result.code, result.output).toBe(1);
        expect(result.output).toContain("Node.js 26 is required");
        expect(result.output).toContain(`engines.node is ${manifest.engines.node}`);
        expect(result.commands).toBe("");
      } finally {
        await test.cleanup();
      }
    },
  );

  it.each(["v26.0.0", "v27.0.0", `v${manifest.engines.node}`])(
    "continues on Node.js %s and warns only on engines.node mismatch",
    async (nodeVersion) => {
      const test = await fixture();
      try {
        const result = await test.run({ nodeVersion });
        expect(result.code, result.output).toBe(0);
        expect(result.commands).toContain("pnpm run build:desktop\n");
        expect(result.output.includes("differs from engines.node")).toBe(
          nodeVersion !== `v${manifest.engines.node}`,
        );
      } finally {
        await test.cleanup();
      }
    },
  );

  it.each(["Linux", "Darwin"])(
    "builds and writes a %s launcher with quoted paths",
    async (platform) => {
      const test = await fixture();
      try {
        const result = await test.run({ platform });
        expect(result.code, result.output).toBe(0);
        expect(result.commands).toContain(
          `clone --branch corvis/main --single-branch -- ${repositoryUrl}`,
        );
        expect(result.commands).toContain("pnpm install\n");
        expect(result.commands).toContain("pnpm run build:desktop\n");
        const launcherPath = NodePath.join(
          test.installDirectory,
          "apps/desktop/.electron-runtime",
          platform === "Linux" ? "corvis.sh" : "corvis.command",
        );
        const launcher = await NodeFSP.readFile(launcherPath, "utf8");
        const launch = NodeChildProcess.spawnSync(shell, [launcherPath], {
          encoding: "utf8",
          env: { ...test.environment, ELECTRON_RUN_AS_NODE: "1" },
        });
        expect(launch.status, launch.stdout + launch.stderr).toBe(0);
        if (platform === "Linux") {
          const recorded = JSON.parse(
            await NodeFSP.readFile(test.environment.CORVIS_TEST_LAUNCH, "utf8"),
          );
          expect(recorded).toEqual({ cwd: test.installDirectory });
          const desktop = await NodeFSP.readFile(
            NodePath.join(test.userDirectory, ".local/share/applications/corvis.desktop"),
            "utf8",
          );
          expect(desktop).toContain('[Desktop Entry]\nType=Application\nName=Corvis\nExec="');
          expect(desktop).toContain("%%percent");
          expect(desktop).toContain("\\\\$dollar");
        } else {
          expect(launcher).toContain("node_modules");
          expect(launcher).not.toContain("start-electron.mjs");
          expect(await NodeFSP.readdir(test.userDirectory)).not.toContain(".local");
        }
      } finally {
        await test.cleanup();
      }
    },
  );

  it("updates a clean checkout to the branch tip", async () => {
    const test = await fixture();
    try {
      const first = await test.run();
      expect(first.code, first.output).toBe(0);
      await NodeFSP.writeFile(NodePath.join(test.source, "update.txt"), "update\n");
      test.git("-C", test.source, "add", ".");
      test.git(
        "-C",
        test.source,
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "update",
      );
      const second = await test.run();
      expect(second.code, second.output).toBe(0);
      expect(second.commands).toContain("reset --hard origin/corvis/main");
      expect(test.git("-C", test.installDirectory, "rev-parse", "HEAD")).toBe(
        test.git("-C", test.source, "rev-parse", "HEAD"),
      );
    } finally {
      await test.cleanup();
    }
  });

  it.each(["branch", "detached", "local-commit"])(
    "preserves a clean checkout with %s history",
    async (kind) => {
      const test = await fixture();
      try {
        const first = await test.run();
        expect(first.code, first.output).toBe(0);
        if (kind === "branch") test.git("-C", test.installDirectory, "checkout", "-b", "work");
        else if (kind === "detached") test.git("-C", test.installDirectory, "checkout", "--detach");
        else
          test.git(
            "-C",
            test.installDirectory,
            "-c",
            "user.name=fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "keep local commit",
          );
        const before = test.git("-C", test.installDirectory, "rev-parse", "HEAD");
        const branchBefore = test.git("-C", test.installDirectory, "branch", "--show-current");
        const result = await test.run();
        expect(result.code, result.output).toBe(1);
        expect(result.output).toContain(
          kind === "local-commit" ? "local commits" : "corvis/main branch",
        );
        expect(test.git("-C", test.installDirectory, "rev-parse", "HEAD")).toBe(before);
        expect(test.git("-C", test.installDirectory, "branch", "--show-current")).toBe(
          branchBefore,
        );
        expect(result.commands).not.toContain("reset --hard");
        expect(result.commands).not.toContain("checkout -B");
        expect(result.commands).not.toContain("pnpm install");
        expect(result.commands).not.toContain(" fetch ");
      } finally {
        await test.cleanup();
      }
    },
  );

  it.each(["tracked", "untracked", "foreign"])("preserves a %s checkout", async (kind) => {
    const test = await fixture();
    try {
      const first = await test.run();
      expect(first.code, first.output).toBe(0);
      if (kind === "foreign")
        test.git(
          "-C",
          test.installDirectory,
          "remote",
          "set-url",
          "origin",
          "https://example.invalid/other",
        );
      else
        await NodeFSP.writeFile(
          NodePath.join(test.installDirectory, kind === "tracked" ? ".gitignore" : "keep.txt"),
          "keep me\n",
        );
      const before = test.git("-C", test.installDirectory, "status", "--porcelain");
      const result = await test.run();
      expect(result.code, result.output).toBe(1);
      expect(result.commands).not.toContain(" fetch ");
      expect(result.commands).not.toContain(" reset ");
      expect(test.git("-C", test.installDirectory, "status", "--porcelain")).toBe(before);
    } finally {
      await test.cleanup();
    }
  });

  it.each(["install", "run build:desktop", "fetch"])("stops after failed %s", async (failAt) => {
    const test = await fixture();
    try {
      if (failAt === "fetch") {
        const first = await test.run();
        expect(first.code, first.output).toBe(0);
      }
      const result = await test.run({ failAt });
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain("exit 42");
      if (failAt === "fetch") expect(result.commands).not.toContain("reset --hard");
      else expect(await NodeFSP.readdir(test.userDirectory)).not.toContain(".local");
    } finally {
      await test.cleanup();
    }
  });
});

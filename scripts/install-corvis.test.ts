// @effect-diagnostics nodeBuiltinImport:off - Exercises the PowerShell installer in isolated checkouts.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const repositoryUrl = "https://github.com/mikhail-filippov-azurgames/t3code";
const installerPath = NodePath.join(import.meta.dirname, "install-corvis.ps1");
const rootManifest = JSON.parse(
  await NodeFSP.readFile(NodePath.join(import.meta.dirname, "../package.json"), "utf8"),
) as { engines: { node: string } };

const harness = String.raw`
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($config.outputCodePage) { [Console]::OutputEncoding = [Text.Encoding]::GetEncoding($config.outputCodePage) }
$gitExecutable = (Get-Command git.exe).Source
function Get-Command {
    param($Name, $ErrorAction)
    if ($Name -eq $config.missingTool) { return }
    Microsoft.PowerShell.Core\Get-Command -Name $Name -ErrorAction $ErrorAction
}
function Write-Invocation {
    param($Tool, $Arguments)
    Add-Content -LiteralPath (Join-Path $PSScriptRoot 'commands.jsonl') -Encoding UTF8 -Value (
        @{ tool = $Tool; arguments = @($Arguments) } | ConvertTo-Json -Compress
    )
}
function node {
    $global:LASTEXITCODE = 0
    Write-Invocation 'node' $args
    if ($args[0] -eq '--version') { return $config.nodeVersion }
    Join-Path $config.installDirectory 'node_modules/electron/electron.exe'
}
function corepack {
    $global:LASTEXITCODE = 0
    Write-Invocation 'corepack' $args
    '0.35.0'
}
function pnpm {
    $global:LASTEXITCODE = 0
    Write-Invocation 'pnpm' $args
    if ($args[0] -eq '--version') { return '12.14.0' }
    if ($args -contains $config.failAt) { $global:LASTEXITCODE = 42; return }
    if ($args[0] -eq 'run') {
        $entry = Join-Path $config.installDirectory 'apps/desktop/dist-electron/main.cjs'
        $runtime = Join-Path $config.installDirectory 'node_modules/electron/electron.exe'
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $entry), (Split-Path -Parent $runtime) | Out-Null
        Set-Content -LiteralPath $entry -Value '// fixture'
        Set-Content -LiteralPath $runtime -Value 'fixture'
    }
}
function git {
    Write-Invocation 'git' $args
    if ($args -contains 'clone') {
        & $gitExecutable -c core.longpaths=true clone --branch corvis/main --single-branch -- $config.fixture $config.installDirectory
        if ($LASTEXITCODE -ne 0) { return }
        & $gitExecutable -C $config.installDirectory remote set-url origin $config.repositoryUrl
    } elseif ($args -contains 'fetch') {
        if ($config.failAt -eq 'fetch') { $global:LASTEXITCODE = 42; return }
        & $gitExecutable -C $config.installDirectory fetch $config.fixture '+refs/heads/corvis/main:refs/remotes/origin/corvis/main'
    } else {
        & $gitExecutable @args
    }
}
$global:vcRuntimePresent = $config.vcRuntime
function Test-Path {
    param([string] $LiteralPath, [string] $PathType)
    if ($LiteralPath -like '*\vcruntime140*.dll') { return $global:vcRuntimePresent }
    Microsoft.PowerShell.Management\Test-Path @PSBoundParameters
}
function Invoke-WebRequest {
    param($Uri, $OutFile, [switch] $UseBasicParsing)
    Write-Invocation 'Invoke-WebRequest' @($Uri)
}
function Start-Process {
    param($FilePath, $ArgumentList, [switch] $Wait, [switch] $PassThru)
    Write-Invocation (Split-Path -Leaf $FilePath) $ArgumentList
    $global:vcRuntimePresent = $config.redistInstalls
    [pscustomobject]@{ ExitCode = $config.redistExitCode }
}
function New-Object {
    param($ComObject)
    if ($ComObject -ne 'WScript.Shell') { throw 'Unexpected COM object' }
    $shell = [pscustomobject]@{}
    $shell | Add-Member ScriptMethod CreateShortcut {
        param($ShortcutPath)
        $shortcut = [pscustomobject]@{
            path = $ShortcutPath; TargetPath = ''; Arguments = ''; WorkingDirectory = ''; Description = ''
        }
        $shortcut | Add-Member ScriptMethod Save {
            $this | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'shortcut.json') -Encoding UTF8
        }
        return $shortcut
    }
    return $shell
}
$originalPath = $env:PATH
if ($config.useDefaultDirectory) {
    & (Join-Path $PSScriptRoot 'install-corvis.ps1')
} else {
    & (Join-Path $PSScriptRoot 'install-corvis.ps1') -InstallDirectory $config.installDirectory
}
$installerExitCode = $LASTEXITCODE
if ($env:PATH -ne $originalPath) { throw 'Installer changed PATH' }
exit $installerExitCode
`;

type Command = { tool: string; arguments: string[] };

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "corvis-install-"));
  const source = NodePath.join(root, "source");
  const installDirectory = NodePath.join(root, "Пользователь [Corvis]");
  await NodeFSP.mkdir(source);
  const git = (directory: string, ...args: string[]) =>
    NodeChildProcess.execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
  git(source, "init", "--initial-branch=corvis/main");
  await NodeFSP.writeFile(
    NodePath.join(source, "package.json"),
    JSON.stringify({ engines: rootManifest.engines }),
  );
  await NodeFSP.writeFile(
    NodePath.join(source, ".gitignore"),
    "node_modules/\napps/desktop/dist-electron/\n",
  );
  git(source, "add", ".");
  git(
    source,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  await NodeFSP.copyFile(installerPath, NodePath.join(root, "install-corvis.ps1"));
  await NodeFSP.writeFile(NodePath.join(root, "harness.ps1"), harness);
  return {
    root,
    source,
    installDirectory,
    git,
    async run(
      options: {
        missingTool?: string;
        nodeVersion?: string;
        failAt?: string;
        outputCodePage?: number;
        useDefaultDirectory?: boolean;
        vcRuntime?: boolean;
        redistInstalls?: boolean;
        redistExitCode?: number;
      } = {},
    ) {
      await NodeFSP.writeFile(
        NodePath.join(root, "config.json"),
        JSON.stringify({
          fixture: source,
          repositoryUrl,
          installDirectory,
          nodeVersion: `v${rootManifest.engines.node}`,
          vcRuntime: true,
          redistInstalls: true,
          redistExitCode: 0,
          ...options,
        }),
      );
      await NodeFSP.rm(NodePath.join(root, "commands.jsonl"), { force: true });
      await NodeFSP.rm(NodePath.join(root, "shortcut.json"), { force: true });
      const result = NodeChildProcess.spawnSync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", NodePath.join(root, "harness.ps1")],
        { cwd: root, encoding: "utf8", timeout: 20_000 },
      );
      const commands: Command[] = await NodeFSP.readFile(
        NodePath.join(root, "commands.jsonl"),
        "utf8",
      )
        .then((text) =>
          text
            .replace(/^\uFEFF/, "")
            .trim()
            .split(/\r?\n/)
            .map((line) => JSON.parse(line) as Command),
        )
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
      return { code: result.status, output: result.stdout + result.stderr, commands };
    },
    cleanup: () => NodeFSP.rm(root, { recursive: true, force: true }),
  };
}

it("keeps the standalone Node.js requirement aligned with engines.node", async () => {
  expect(await NodeFSP.readFile(installerPath, "utf8")).toContain(
    `$requiredNodeVersion = '${rootManifest.engines.node}'`,
  );
});

describe.skipIf(HostProcess.Platform.defaultValue() !== "win32")("Corvis Windows installer", () => {
  it("requires an explicit installation directory when downloaded into temp", async () => {
    const test = await fixture();
    try {
      const result = await test.run({ useDefaultDirectory: true });
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain('-InstallDirectory "C:\\Corvis"');
      expect(result.commands).toEqual([]);
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
        expect(result.commands).toEqual([]);
        expect(await NodeFSP.readdir(test.root)).not.toContain(
          NodePath.basename(test.installDirectory),
        );
      } finally {
        await test.cleanup();
      }
    },
  );

  it.each(["v22.21.0", "v23.11.0"])("rejects Node.js %s before cloning", async (nodeVersion) => {
    const test = await fixture();
    try {
      const result = await test.run({ nodeVersion });
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain("Node.js 24+ LTS is required");
      expect(result.output).toContain(`engines.node is ${rootManifest.engines.node}`);
      expect(result.commands).toEqual([{ tool: "node", arguments: ["--version"] }]);
    } finally {
      await test.cleanup();
    }
  });

  it.each(["v24.19.0", "v25.0.0", "v27.0.0", `v${rootManifest.engines.node}`])(
    "continues on Node.js %s and warns only on engines.node mismatch",
    async (nodeVersion) => {
      const test = await fixture();
      try {
        const result = await test.run({ nodeVersion });
        expect(result.code, result.output).toBe(0);
        expect(result.commands).toContainEqual({
          tool: "pnpm",
          arguments: ["run", "build:desktop"],
        });
        expect(result.output.includes("differs from engines.node")).toBe(
          nodeVersion !== `v${rootManifest.engines.node}`,
        );
      } finally {
        await test.cleanup();
      }
    },
  );

  it("skips the Visual C++ runtime when it is present", async () => {
    const test = await fixture();
    try {
      const result = await test.run();
      expect(result.code, result.output).toBe(0);
      expect(result.commands.map((command) => command.tool)).not.toContain("Invoke-WebRequest");
    } finally {
      await test.cleanup();
    }
  });

  it("installs a missing Visual C++ runtime quietly before dependencies", async () => {
    const test = await fixture();
    try {
      const result = await test.run({ vcRuntime: false, redistExitCode: 3010 });
      expect(result.code, result.output).toBe(0);
      const redist = result.commands.findIndex((command) =>
        command.tool.endsWith("vc_redist.x64.exe"),
      );
      const clone = result.commands.findIndex((command) => command.arguments.includes("clone"));
      expect(result.commands).toContainEqual({
        tool: "Invoke-WebRequest",
        arguments: ["https://aka.ms/vs/17/release/vc_redist.x64.exe"],
      });
      expect(result.commands).toContainEqual({
        tool: "corvis-vc_redist.x64.exe",
        arguments: ["/install", "/quiet", "/norestart"],
      });
      expect(redist).toBeGreaterThanOrEqual(0);
      expect(redist).toBeLessThan(clone);
    } finally {
      await test.cleanup();
    }
  });

  it.each([
    { redistExitCode: 1603, redistInstalls: false },
    { redistExitCode: 0, redistInstalls: false },
  ])("stops when the Visual C++ runtime install fails (%o)", async (options) => {
    const test = await fixture();
    try {
      const result = await test.run({ vcRuntime: false, ...options });
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain("Microsoft Visual C++ Redistributable (x64) is required");
      expect(result.output).toContain("https://aka.ms/vs/17/release/vc_redist.x64.exe");
      expect(result.commands).not.toContainEqual({ tool: "pnpm", arguments: ["install"] });
      expect(await NodeFSP.readdir(test.root)).not.toContain(
        NodePath.basename(test.installDirectory),
      );
    } finally {
      await test.cleanup();
    }
  });

  it("clones, builds and updates a Cyrillic checkout with OEM console encoding", async () => {
    const test = await fixture();
    try {
      const first = await test.run();
      expect(first.code, first.output).toBe(0);
      expect(first.commands).toContainEqual({
        tool: "git",
        arguments: [
          "-c",
          "core.longpaths=true",
          "clone",
          "--branch",
          "corvis/main",
          "--single-branch",
          "--",
          repositoryUrl,
          test.installDirectory,
        ],
      });
      expect(first.commands).toContainEqual({ tool: "pnpm", arguments: ["install"] });
      expect(test.git(test.installDirectory, "config", "--local", "--get", "core.longpaths")).toBe(
        "true",
      );
      expect(first.commands).toContainEqual({ tool: "pnpm", arguments: ["run", "build:desktop"] });
      const shortcut = JSON.parse(
        (await NodeFSP.readFile(NodePath.join(test.root, "shortcut.json"), "utf8")).replace(
          /^\uFEFF/,
          "",
        ),
      );
      expect(shortcut.TargetPath).toBe(
        NodePath.join(test.installDirectory, "node_modules/electron/electron.exe"),
      );
      expect(shortcut.Arguments).toBe(
        `"${NodePath.join(test.installDirectory, "apps/desktop/dist-electron/main.cjs")}"`,
      );
      expect(shortcut.WorkingDirectory).toBe(test.installDirectory);
      expect(NodePath.basename(shortcut.path)).toBe("Corvis.lnk");

      await NodeFSP.writeFile(NodePath.join(test.source, "update.txt"), "new upstream commit\n");
      test.git(test.source, "add", ".");
      test.git(
        test.source,
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "update",
      );
      test.git(test.installDirectory, "config", "--local", "core.longpaths", "false");
      const repeat = await test.run({ outputCodePage: 866 });
      expect(repeat.code, repeat.output).toBe(0);
      expect(repeat.commands).toContainEqual({
        tool: "git",
        arguments: [
          "-c",
          "core.longpaths=true",
          "-C",
          test.installDirectory,
          "fetch",
          "origin",
          "+refs/heads/corvis/main:refs/remotes/origin/corvis/main",
        ],
      });
      expect(test.git(test.installDirectory, "config", "--local", "--get", "core.longpaths")).toBe(
        "true",
      );
      expect(test.git(test.installDirectory, "rev-parse", "HEAD")).toBe(
        test.git(test.source, "rev-parse", "HEAD"),
      );
      expect(repeat.commands.some((command) => command.arguments.includes("reset"))).toBe(true);
      expect(test.git(test.installDirectory, "branch", "--show-current")).toBe("corvis/main");
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
        if (kind === "branch") test.git(test.installDirectory, "checkout", "-b", "work");
        else if (kind === "detached") test.git(test.installDirectory, "checkout", "--detach");
        else
          test.git(
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
        const before = test.git(test.installDirectory, "rev-parse", "HEAD");
        const branchBefore = test.git(test.installDirectory, "branch", "--show-current");
        const result = await test.run();
        expect(result.code, result.output).toBe(1);
        expect(result.output).toContain(
          kind === "local-commit" ? "local commits" : "corvis/main branch",
        );
        expect(test.git(test.installDirectory, "rev-parse", "HEAD")).toBe(before);
        expect(test.git(test.installDirectory, "branch", "--show-current")).toBe(branchBefore);
        expect(
          result.commands.some((command) =>
            command.arguments.some((argument) =>
              ["fetch", "reset", "checkout", "install"].includes(argument),
            ),
          ),
        ).toBe(false);
      } finally {
        await test.cleanup();
      }
    },
  );

  it.each(["tracked", "untracked", "foreign"])(
    "refuses a %s checkout without fetch or reset",
    async (kind) => {
      const test = await fixture();
      try {
        const first = await test.run();
        expect(first.code, first.output).toBe(0);
        if (kind === "foreign")
          test.git(
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
        const before = test.git(test.installDirectory, "status", "--porcelain");
        const result = await test.run();
        expect(result.code, result.output).toBe(1);
        expect(result.output).toContain(
          kind === "foreign" ? "different repository" : "local changes or untracked files",
        );
        expect(
          result.commands.some((command) =>
            command.arguments.some((argument) => ["fetch", "reset", "checkout"].includes(argument)),
          ),
        ).toBe(false);
        expect(test.git(test.installDirectory, "status", "--porcelain")).toBe(before);
      } finally {
        await test.cleanup();
      }
    },
  );

  it.each(["install", "build:desktop", "fetch"])(
    "stops after failed %s without creating a shortcut",
    async (failAt) => {
      const test = await fixture();
      try {
        if (failAt === "fetch") expect((await test.run()).code).toBe(0);
        const result = await test.run({ failAt });
        expect(result.code, result.output).toBe(1);
        expect(result.output).toContain("exit 42");
        expect(await NodeFSP.readdir(test.root)).not.toContain("shortcut.json");
        if (failAt === "fetch")
          expect(result.commands.some((command) => command.arguments.includes("reset"))).toBe(
            false,
          );
      } finally {
        await test.cleanup();
      }
    },
  );
});

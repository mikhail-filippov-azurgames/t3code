#!/bin/sh
# Builds Corvis from ft3/v2. Usage: sh install-corvis.sh [INSTALL_DIRECTORY]
# The default checkout is a corvis directory beside this script.
set -eu

repository_url=https://github.com/mikhail-filippov-azurgames/t3code
branch=ft3/v2
# Kept aligned with root engines.node by the installer test for standalone use.
required_node_version=26.12.1

fail() {
  printf 'Corvis installation failed. %s\n' "$1" >&2
  exit 1
}

run() {
  if "$@"; then
    return 0
  else
    command_exit=$?
    fail "$1 failed (exit $command_exit). Resolve the error above and run the installer again."
  fi
}

assert_node_version() {
  node_major=${node_version#v}
  node_major=${node_major%%.*}
  case "$node_major" in
    ''|*[!0-9]*) fail "Cannot read Node.js version $node_version. Install Node.js 24+ LTS from https://nodejs.org/ and run the installer again." ;;
  esac
  [ "$node_major" -ge 24 ] || fail "Node.js 24+ LTS is required, found $node_version (engines.node is $1). Install Node.js 24+ LTS from https://nodejs.org/ and run the installer again."
  if [ "$node_version" != "v$1" ]; then
    printf 'Warning: Node.js %s differs from engines.node (%s). Continuing with Node.js 24+ support.\n' "$node_version" "$1" >&2
  fi
}

[ "$#" -le 1 ] || fail 'Usage: sh install-corvis.sh [INSTALL_DIRECTORY]'
for tool in node corepack pnpm git; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    case "$tool" in
      node) hint="Install Node.js 24+ LTS from https://nodejs.org/ (engines.node is $required_node_version)." ;;
      corepack) hint='Install Corepack following https://github.com/nodejs/corepack#installation.' ;;
      pnpm) hint='Prepare pnpm using Corepack following https://pnpm.io/installation#using-corepack.' ;;
      git) hint='Install Git using your OS package manager or https://git-scm.com/downloads.' ;;
    esac
    fail "Missing $tool. $hint Open a new terminal and run the installer again."
  fi
done

# The sentinel preserves directory names ending in a newline.
script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P && printf .)
script_directory=${script_directory%??}
if [ "$#" -eq 0 ]; then
  temporary_directory=/tmp
  if [ -d "${TMPDIR:-/tmp}" ]; then
    temporary_directory=$(CDPATH= cd -- "${TMPDIR:-/tmp}" && pwd -P && printf .)
    temporary_directory=${temporary_directory%??}
  fi
  case "$script_directory/" in
    /tmp/*|/var/tmp/*|/private/tmp/*|/private/var/tmp/*|"$temporary_directory/"*)
      fail 'Specify a permanent installation directory, for example sh install-corvis.sh "$HOME/Corvis", when running this script from temp.' ;;
  esac
fi
source_manifest=$script_directory/../package.json
if [ -f "$source_manifest" ]; then
  required_node_version=$(run node -p 'require(process.argv[1]).engines.node' "$source_manifest")
fi
node_version=$(run node --version)
assert_node_version "$required_node_version"
run corepack --version
run pnpm --version
run git --version
printf 'Environment checks passed.\n'
platform=$(uname -s)
case "$platform" in Linux|Darwin) ;; *) fail 'This installer supports macOS and Linux.' ;; esac

install_directory=${1:-$script_directory/corvis}
[ ! -L "$install_directory" ] || fail 'The installation path must be a directory without a symbolic link.'
run mkdir -p -- "$install_directory"
install_directory=$(CDPATH= cd -- "$install_directory" && pwd -P && printf .)
install_directory=${install_directory%??}
contents=$(ls -A "$install_directory" && printf .)
if [ "$contents" != . ]; then
  repository_root=$(run git -C "$install_directory" rev-parse --show-toplevel && printf .)
  repository_root=${repository_root%??}
  [ "$repository_root" = "$install_directory" ] || fail 'The installation directory must be the root of its own Git checkout.'
  origin=$(run git -C "$install_directory" remote get-url origin)
  case "$origin" in
    "$repository_url"|"$repository_url.git") ;;
    *) fail 'The installation directory belongs to a different repository. Choose another installation directory.' ;;
  esac
  changes=$(run git -C "$install_directory" status --porcelain --untracked-files=all)
  [ -z "$changes" ] || fail 'The installation checkout has local changes or untracked files. Commit, stash, or move them before updating.'
  current_branch=$(run git -C "$install_directory" branch --show-current)
  [ "$current_branch" = "$branch" ] || fail 'The installation checkout must be on the ft3/v2 branch. Switch branches before updating.'
  local_commits=$(run git -C "$install_directory" rev-list --count "origin/$branch..HEAD")
  [ "$local_commits" -eq 0 ] || fail 'The installation checkout has local commits. Preserve them before updating.'
  run git -C "$install_directory" fetch origin "+refs/heads/$branch:refs/remotes/origin/$branch"
  run git -C "$install_directory" checkout -B "$branch"
  run git -C "$install_directory" reset --hard "origin/$branch"
else
  printf 'Cloning Corvis into %s\n' "$install_directory"
  run git clone --branch "$branch" --single-branch -- "$repository_url" "$install_directory"
fi

required_node_version=$(run node -p 'require(process.argv[1]).engines.node' "$install_directory/package.json")
assert_node_version "$required_node_version"
cd -- "$install_directory"
printf 'Installing application dependencies...\n'
run pnpm install
printf 'Building the desktop application...\n'
run pnpm run build:desktop

# Node is already required. Use its path handling and explicit escaping when
# writing shell launchers and freedesktop Exec fields containing user paths.
run node --input-type=module - "$install_directory" "$platform" "$HOME" <<'NODE'
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, platform, userDirectory] = process.argv.slice(2);
const { ensureElectronRuntime } = await import(
  pathToFileURL(path.join(root, 'apps/desktop/scripts/ensure-electron-runtime.mjs')).href
);
const electronPath = ensureElectronRuntime();
const entryPath = path.join(root, 'apps/desktop/dist-electron/main.cjs');
fs.accessSync(electronPath, fs.constants.X_OK);
fs.accessSync(entryPath, fs.constants.R_OK);

const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const runtimeDirectory = path.join(root, 'apps/desktop/.electron-runtime');
fs.mkdirSync(runtimeDirectory, { recursive: true });
const launcher = path.join(runtimeDirectory, platform === 'Darwin' ? 'corvis.command' : 'corvis.sh');
// The macOS launcher uses the raw Electron binary, avoiding bundle signing.
// Linux uses the existing launcher, including its sandbox runtime checks.
const command = platform === 'Darwin'
  ? [electronPath, entryPath]
  : [process.execPath, path.join(root, 'apps/desktop/scripts/start-electron.mjs')];
fs.writeFileSync(launcher, [
  '#!/bin/sh',
  'set -eu',
  'unset ELECTRON_RUN_AS_NODE',
  `cd -- ${shellQuote(root)}`,
  `exec ${command.map(shellQuote).join(' ')} "$@"`,
  '',
].join('\n'), { mode: 0o755 });
fs.chmodSync(launcher, 0o755);

if (platform === 'Linux') {
  const applicationsDirectory = path.join(userDirectory, '.local/share/applications');
  fs.mkdirSync(applicationsDirectory, { recursive: true });
  const escapeValue = (value) => value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t');
  const execArgument = launcher.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('`', '\\`').replaceAll('$', '\\$').replaceAll('%', '%%');
  const desktopPath = path.join(applicationsDirectory, 'corvis.desktop');
  fs.writeFileSync(desktopPath, [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Corvis',
    `Exec=${escapeValue('"' + execArgument + '"')}`,
    `Path=${escapeValue(root)}`,
    'Terminal=false',
    '',
  ].join('\n'));
  console.log(`Corvis is ready. Open Corvis in your application menu. Launcher: ${launcher}`);
} else {
  console.log(`Corvis is ready. Open ${launcher} to start.`);
}
NODE

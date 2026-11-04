// @effect-diagnostics nodeBuiltinImport:off - This is a build-time filesystem script.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const EXCLUDED_DIRECTORIES = new Set([".repos", "node_modules", "dist"]);
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const DOCUMENT_ID = /oc:\/\/doc\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
const USER_PATHS = [
  /[A-Za-z]:\\+Users\\+([^\\/\s"'`$(){}<>:,;|*?]+)/g,
  /\/Users\/([^\\/\s"'`$(){}<>:,;|*?]+)\//g,
  /\/home\/([^\\/\s"'`$(){}<>:,;|*?]+)\//g,
];
// Placeholder names and upstream fixture names, plus dotted directories and system
// folders that the path patterns catch. Case-sensitive, so the owner's `User` account
// stays a violation. Reviewed in the task report; add names only with a reason.
const ALLOWED_USER_NAMES = new Set<string>([
  "a",
  "a-twenty-char-person",
  "admin",
  "alice",
  "box",
  "demo",
  "dev",
  "fx-replay",
  "grok-replay",
  "jane",
  "Jane",
  "Jo",
  "Josh",
  "josh",
  "jö",
  "José",
  "julius",
  "Library",
  "linuxbrew",
  "matt",
  "Me",
  "me",
  "replay-user",
  "sebherrerabe",
  "shawn",
  "someone",
  "t3",
  ".t3",
  ".local",
  ".nvm",
  ".opencode",
  "test",
  "tester",
  "testuser",
  "theo",
  "u",
  "user",
  "zen-user",
]);

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
  readonly text: string;
}

const isTestFile = (file: string) => /\.test\./.test(NodePath.basename(file));

export const scanText = (file: string, text: string): ReadonlyArray<Violation> => {
  const violations: Violation[] = [];
  text.split(/\r?\n/).forEach((lineText, index) => {
    const report = (reason: string) =>
      violations.push({ file, line: index + 1, reason, text: lineText.trim().slice(0, 160) });
    for (const pattern of USER_PATHS) {
      for (const match of lineText.matchAll(pattern)) {
        if (!ALLOWED_USER_NAMES.has(match[1]!)) report("user-specific absolute path");
      }
    }
    for (const match of lineText.matchAll(DOCUMENT_ID)) {
      if (match[1] === NIL_UUID && isTestFile(file)) continue;
      report("oc:// document id");
    }
  });
  return violations;
};

const childDirectories = (directory: string): ReadonlyArray<string> => {
  if (!NodeFS.existsSync(directory)) return [];
  return NodeFS.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => NodePath.join(directory, entry.name));
};

const scannedDirectories = (root: string): ReadonlyArray<string> => {
  const packages = childDirectories(NodePath.join(root, "packages"));
  return [
    ...packages
      .filter((directory) => NodePath.basename(directory).startsWith("ft3-"))
      .map((directory) => NodePath.join(directory, "src")),
    NodePath.join(root, "apps", "web", "src"),
    NodePath.join(root, "apps", "server", "src"),
    NodePath.join(root, "apps", "desktop", "src"),
    ...packages.map((directory) => NodePath.join(directory, "assets")),
  ].filter((directory) => NodeFS.existsSync(directory));
};

const filesUnder = (directory: string): ReadonlyArray<string> =>
  NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return EXCLUDED_DIRECTORIES.has(entry.name) ? [] : filesUnder(path);
    return entry.isFile() ? [path] : [];
  });

export const scanRepository = (root: string) => {
  const files = scannedDirectories(root).flatMap(filesUnder);
  const violations = files.flatMap((file) => {
    const buffer = NodeFS.readFileSync(file);
    if (buffer.includes(0)) return [];
    return scanText(NodePath.relative(root, file).replaceAll("\\", "/"), buffer.toString("utf8"));
  });
  return { files: files.length, violations };
};

if (import.meta.main) {
  const root = NodePath.resolve(import.meta.dirname, "..");
  const { files, violations } = scanRepository(root);
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}: ${violation.reason}: ${violation.text}`);
  }
  if (violations.length > 0) {
    console.error(`check-fork-boundary: ${violations.length} violation(s) in ${files} files`);
    process.exitCode = 1;
  } else {
    console.log(`check-fork-boundary: ok, ${files} files scanned`);
  }
}

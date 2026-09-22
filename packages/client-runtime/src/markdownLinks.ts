import { isWindowsAbsolutePath } from "@t3tools/shared/path";

const SLASH_PREFIXED_WINDOWS_DRIVE_PATTERN = /^\/[A-Za-z]:[\\/]/;
// Agents sometimes put a literal `/absolute/path` marker in front of a host
// path (`/absolute/path/C:/Users/...`). The marker is not part of the path, so
// strip it before the drive-slash normalisation reads the target.
const ABSOLUTE_PATH_MARKER_PATTERN = /^\/absolute\/path\/(?=[A-Za-z]:[\\/])/;
const RELATIVE_PATH_PREFIX_PATTERN = /^(~\/|\.{1,2}\/)/;
const RELATIVE_FILE_PATH_PATTERN =
  /^(?:[A-Za-z0-9._-]+(?: +[A-Za-z0-9._-]+)*\/)+[A-Za-z0-9._-]+(?: +[A-Za-z0-9._-]+)*(?::\d+){0,2}$/;
const RELATIVE_FILE_NAME_PATTERN =
  /^[A-Za-z0-9._-]+(?: +[A-Za-z0-9._-]+)*\.[A-Za-z0-9_-]+(?::\d+){0,2}$/;
const EXTERNAL_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/;
const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const POSITION_SUFFIX_CAPTURE_PATTERN = /:(\d+)(?::(\d+))?$/;
const POSITION_HASH_PATTERN = /^#L(\d+)(?:C(\d+))?$/i;
const POSITION_ONLY_PATTERN = /^\d+(?::\d+)?$/;
const INLINE_CODE_DISQUALIFIER_PATTERN = /[\s`]/;
const PATH_SEPARATOR_PATTERN = /[\\/]/;
const NUMERIC_DOTTED_PATTERN = /^\d+(?:\.\d+)+$/;
// Standard OS and dev-container roots; deliberately excludes app-route-ish
// prefixes like /app/ or /chat/ so SPA routes never read as files.
const POSIX_FILE_ROOT_PREFIXES = [
  "/Users/",
  "/home/",
  "/tmp/",
  "/var/",
  "/etc/",
  "/opt/",
  "/mnt/",
  "/Volumes/",
  "/private/",
  "/root/",
  "/usr/",
  "/bin/",
  "/sbin/",
  "/lib/",
  "/lib64/",
  "/srv/",
  "/dev/",
  "/proc/",
  "/sys/",
  "/run/",
  "/boot/",
  "/media/",
  "/workspace/",
  "/workspaces/",
] as const;
// `Name:digits` also matches `error:1`, `port:3000`, and `TODO:12`.
const EXTENSIONLESS_FILE_NAMES = new Set([
  "Makefile",
  "makefile",
  "GNUmakefile",
  "Dockerfile",
  "Containerfile",
  "Justfile",
  "justfile",
  "Rakefile",
  "Gemfile",
  "Procfile",
  "Brewfile",
  "Caddyfile",
  "Vagrantfile",
  "Jenkinsfile",
  "Podfile",
  "Fastfile",
  "BUILD",
  "WORKSPACE",
  "LICENSE",
  "LICENCE",
  "COPYING",
  "NOTICE",
  "AUTHORS",
  "CONTRIBUTORS",
  "CHANGELOG",
  "README",
  "CODEOWNERS",
]);
// Multi-segment relative paths need positive file evidence before they become
// chips. A loose `/\.[A-Za-z0-9_-]+$/` accepts version-ish tails such as the
// `1-flash` in a model id (`opencode-go/deepseek-v4.1-flash`), so a relative
// path without an explicit prefix, a `:line`, or a known extensionless name
// only counts when its extension is on this list.
const KNOWN_FILE_EXTENSIONS = new Set([
  "ai",
  "apk",
  "asm",
  "asp",
  "aspx",
  "astro",
  "avif",
  "bash",
  "bat",
  "bmp",
  "bz2",
  "c",
  "cc",
  "cfg",
  "cjs",
  "class",
  "clj",
  "cljs",
  "cmd",
  "cob",
  "conf",
  "cpp",
  "cr",
  "crt",
  "cs",
  "csh",
  "cshtml",
  "csr",
  "css",
  "csv",
  "cxx",
  "dart",
  "db",
  "der",
  "dll",
  "dmg",
  "doc",
  "docx",
  "dylib",
  "ejs",
  "el",
  "elm",
  "env",
  "erl",
  "ex",
  "exe",
  "exs",
  "fish",
  "flac",
  "flv",
  "f90",
  "f95",
  "gemspec",
  "gif",
  "go",
  "gql",
  "gradle",
  "graphql",
  "groovy",
  "gz",
  "h",
  "hbs",
  "hcl",
  "hh",
  "hpp",
  "hrl",
  "hs",
  "htm",
  "html",
  "hxx",
  "ico",
  "ics",
  "ini",
  "ipa",
  "ipynb",
  "jar",
  "java",
  "jl",
  "jpeg",
  "jpg",
  "js",
  "json",
  "json5",
  "jsonc",
  "jsp",
  "jsx",
  "jks",
  "key",
  "kt",
  "kts",
  "less",
  "lhs",
  "lib",
  "lisp",
  "lock",
  "log",
  "lua",
  "m",
  "m4a",
  "map",
  "markdown",
  "md",
  "mdx",
  "mjs",
  "mkv",
  "mm",
  "mov",
  "mp3",
  "mp4",
  "mpeg",
  "mpg",
  "nim",
  "nix",
  "njk",
  "o",
  "obj",
  "ogg",
  "ogv",
  "opus",
  "org",
  "pas",
  "pdf",
  "pem",
  "php",
  "p12",
  "pl",
  "pm",
  "png",
  "pp",
  "prisma",
  "proto",
  "ps1",
  "psd",
  "psd1",
  "psm1",
  "pt",
  "pub",
  "py",
  "pyi",
  "r",
  "rar",
  "rb",
  "rkt",
  "rmd",
  "rs",
  "rst",
  "s",
  "sass",
  "scala",
  "scm",
  "scss",
  "sh",
  "sig",
  "sql",
  "sqlite",
  "sqlite3",
  "svelte",
  "svg",
  "swift",
  "tar",
  "tex",
  "tf",
  "tfvars",
  "tgz",
  "tif",
  "tiff",
  "toml",
  "ts",
  "tsv",
  "tsx",
  "ttf",
  "txt",
  "vb",
  "vbs",
  "vim",
  "vue",
  "war",
  "wasm",
  "wav",
  "webm",
  "webp",
  "wma",
  "wmv",
  "woff",
  "woff2",
  "xls",
  "xlsx",
  "xml",
  "xz",
  "yaml",
  "yml",
  "zsh",
  "zip",
  "zst",
]);

export function isKnownFileExtension(basename: string): boolean {
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === basename.length - 1) return false;
  return KNOWN_FILE_EXTENSIONS.has(basename.slice(dotIndex + 1).toLowerCase());
}

export function isKnownExtensionlessFileName(path: string): boolean {
  return EXTENSIONLESS_FILE_NAMES.has(fileBasename(path));
}

const SINGLE_LABEL_HOSTNAMES = new Set(["localhost"]);
// These allowlists avoid classifying dotted directories such as `conf.d/`
// or filenames such as `Makefile.in:12` as hosts.
const GENERIC_HOSTNAME_TLDS = new Set([
  "com",
  "net",
  "org",
  "io",
  "dev",
  "app",
  "ai",
  "co",
  "edu",
  "gov",
  "mil",
  "info",
  "biz",
  "xyz",
  "me",
  "tv",
  "cc",
  "gg",
  "chat",
  "cloud",
  "site",
  "online",
  "tech",
  "store",
  "link",
]);
// Country codes also name file extensions. A :line suffix makes `.pl`
// and `.pt` files more likely than hostnames.
const COUNTRY_HOSTNAME_TLDS = new Set([
  "uk",
  "de",
  "fr",
  "nl",
  "se",
  "no",
  "fi",
  "dk",
  "pl",
  "ch",
  "at",
  "be",
  "es",
  "it",
  "pt",
  "eu",
  "us",
  "ca",
  "au",
  "nz",
  "jp",
  "kr",
  "cn",
  "br",
  "ru",
  "mx",
  "ie",
  "cz",
  "tr",
  "sg",
  "hk",
]);

function looksLikeHostname(segment: string, hasPosition: boolean): boolean {
  if (segment.startsWith(".")) return false;
  const lowered = segment.toLowerCase();
  if (SINGLE_LABEL_HOSTNAMES.has(lowered)) return true;
  if (NUMERIC_DOTTED_PATTERN.test(segment)) return true;
  const labels = lowered.split(".");
  const lastLabel = labels.at(-1);
  if (labels.length < 2 || lastLabel === undefined) return false;
  if (GENERIC_HOSTNAME_TLDS.has(lastLabel)) return true;
  return !hasPosition && COUNTRY_HOSTNAME_TLDS.has(lastLabel);
}

/**
 * Picks path-shaped inline code for the client's markdown file-link resolver.
 * It does not resolve paths or turn plain prose and fenced code into links.
 */
export function inlineCodeFilePathCandidate(codeText: string): string | null {
  const trimmed = codeText.trim();
  if (trimmed.length === 0 || INLINE_CODE_DISQUALIFIER_PATTERN.test(trimmed)) return null;

  const candidate = isWindowsAbsolutePath(trimmed) ? trimmed : trimmed.replaceAll("\\", "/");
  const hasPosition = POSITION_SUFFIX_PATTERN.test(candidate);
  const hasSeparator = PATH_SEPARATOR_PATTERN.test(candidate);

  const hasExplicitPathShape =
    RELATIVE_PATH_PREFIX_PATTERN.test(candidate) ||
    candidate.startsWith("/") ||
    isWindowsAbsolutePath(candidate);
  if (!hasExplicitPathShape) {
    // A bare token is only a file reference when it names a conventional
    // extensionless file; everything else (`node.meta`, `origin/main`) is code.
    if (!hasPosition && !hasSeparator) {
      return EXTENSIONLESS_FILE_NAMES.has(candidate) ? candidate : null;
    }
    const withoutPosition = candidate.replace(POSITION_SUFFIX_PATTERN, "");
    const firstSegment = withoutPosition.split("/")[0] ?? withoutPosition;
    if (looksLikeHostname(firstSegment, hasPosition)) return null;
    const basename =
      withoutPosition
        .replace(/[/\\]+$/, "")
        .split(/[\\/]/)
        .at(-1) ?? "";
    const hasFileEvidence =
      hasPosition || isKnownFileExtension(basename) || EXTENSIONLESS_FILE_NAMES.has(basename);
    if (!hasFileEvidence) return null;
  }
  return candidate;
}

export function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizeMarkdownLinkDestination(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
}

/** Browser URL parsers write `C:/foo` as `/C:/foo` for file URLs. */
export function stripSlashPrefixedWindowsDrive(path: string): string {
  return SLASH_PREFIXED_WINDOWS_DRIVE_PATTERN.test(path) ? path.slice(1) : path;
}

export function splitMarkdownLinkSearchAndHash(value: string): {
  readonly path: string;
  readonly hash: string;
} {
  const hashIndex = value.indexOf("#");
  const pathWithSearch = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const hash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  const queryIndex = pathWithSearch.indexOf("?");
  return {
    path: queryIndex >= 0 ? pathWithSearch.slice(0, queryIndex) : pathWithSearch,
    hash,
  };
}

/**
 * Turns a `file:` URL into a host path, still percent-encoded so callers that
 * decode every destination in one place do not decode file URLs twice. A
 * non-localhost authority becomes a UNC share.
 */
export function parseFileUrlHref(
  href: string,
): { readonly path: string; readonly hash: string } | null {
  try {
    const parsed = new URL(href);
    if (parsed.protocol.toLowerCase() !== "file:") return null;

    const uncHostname = parsed.hostname.toLowerCase() === "localhost" ? "" : parsed.hostname;
    const path = uncHostname
      ? `\\\\${uncHostname}${parsed.pathname.replaceAll("/", "\\")}`
      : parsed.pathname;
    if (path.length === 0) return null;
    return { path: stripSlashPrefixedWindowsDrive(path), hash: parsed.hash };
  } catch {
    return null;
  }
}

export interface FilePathPosition {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}

export function splitFilePathPosition(path: string, hash = ""): FilePathPosition {
  const suffixMatch = path.match(POSITION_SUFFIX_CAPTURE_PATTERN);
  const match = suffixMatch ?? hash.match(POSITION_HASH_PATTERN);
  if (!match?.[1]) return { path };

  const line = Number.parseInt(match[1], 10);
  const column = match[2] === undefined ? undefined : Number.parseInt(match[2], 10);
  return {
    path: suffixMatch ? path.slice(0, -suffixMatch[0].length) : path,
    ...(line > 0 ? { line } : {}),
    ...(column !== undefined && column > 0 ? { column } : {}),
  };
}

export function formatFilePathPosition(position: FilePathPosition): string {
  if (!position.line) return position.path;
  return `${position.path}:${position.line}${position.column ? `:${position.column}` : ""}`;
}

export function isRelativeFilePath(path: string): boolean {
  return (
    RELATIVE_PATH_PREFIX_PATTERN.test(path) ||
    (!path.startsWith("/") && !isWindowsAbsolutePath(path))
  );
}

function looksLikePosixFilesystemPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (POSIX_FILE_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (POSITION_SUFFIX_PATTERN.test(path)) return true;
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return EXTENSIONLESS_FILE_NAMES.has(basename) || isKnownFileExtension(basename);
}

/**
 * A relative path with more than one segment must carry file evidence: a
 * conventional extension, a known extensionless name, or an authored `:line`.
 * Without one it is prose or a model/route token, not a file.
 */
function looksLikeRelativeMultiSegmentFilePath(path: string, authoredPath: string): boolean {
  if (!RELATIVE_FILE_PATH_PATTERN.test(path)) return false;
  return (
    isKnownFileExtension(fileBasename(path)) ||
    isKnownExtensionlessFileName(path) ||
    POSITION_SUFFIX_PATTERN.test(authoredPath)
  );
}

/**
 * Decides whether a decoded link destination is a file path rather than a route
 * or prose. Only a `:line` suffix the author wrote counts as evidence; a `#L`
 * anchor never turns `/chat/settings` into a file.
 */
function looksLikeFilePath(path: string, authoredPath: string): boolean {
  if (isWindowsAbsolutePath(path) || RELATIVE_PATH_PREFIX_PATTERN.test(path)) return true;
  if (path.startsWith("/")) return looksLikePosixFilesystemPath(authoredPath);
  if (!PATH_SEPARATOR_PATTERN.test(path)) {
    return isKnownExtensionlessFileName(path) || RELATIVE_FILE_NAME_PATTERN.test(path);
  }
  return looksLikeRelativeMultiSegmentFilePath(path, authoredPath);
}

function hasExternalScheme(path: string): boolean {
  if (isWindowsAbsolutePath(path)) return false;
  const match = path.match(EXTERNAL_SCHEME_PATTERN);
  if (!match) return false;
  const rest = match[2] ?? "";
  if (rest.startsWith("//")) return true;
  return !POSITION_ONLY_PATTERN.test(rest);
}

export function parseMarkdownFileLink(href: string): FilePathPosition | null {
  const normalized = normalizeMarkdownLinkDestination(href);
  if (normalized.length === 0 || normalized.startsWith("#") || normalized.startsWith("//")) {
    return null;
  }

  const source =
    (normalized.toLowerCase().startsWith("file:") ? parseFileUrlHref(normalized) : null) ??
    splitMarkdownLinkSearchAndHash(normalized);
  // A percent-encoded drive colon (`/c%3A/`) only becomes strippable once decoded.
  const decodedPath = safeDecodeURIComponent(source.path.trim()).replace(
    ABSOLUTE_PATH_MARKER_PATTERN,
    "",
  );
  const path = stripSlashPrefixedWindowsDrive(decodedPath);
  const hash = safeDecodeURIComponent(source.hash.trim());
  if (path.length === 0 || hasExternalScheme(path)) return null;

  const position = splitFilePathPosition(path, hash);
  return looksLikeFilePath(position.path, path) ? position : null;
}

export function fileBasename(path: string): string {
  // A trailing separator is a valid way to write a directory. Trim it before
  // taking the final segment so the label is never empty.
  const trimmed = path.replace(/[/\\]+$/, "");
  if (trimmed.length === 0) return path;
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed;
}

export function workspaceRelativeFilePath(
  path: string,
  workspaceRoot: string | null | undefined,
): string | null {
  if (!workspaceRoot) return null;
  const normalizedPath = stripSlashPrefixedWindowsDrive(path.replaceAll("\\", "/"));
  const normalizedRoot = stripSlashPrefixedWindowsDrive(
    workspaceRoot.replaceAll("\\", "/"),
  ).replace(/\/+$/, "");
  const caseInsensitive = isWindowsAbsolutePath(stripSlashPrefixedWindowsDrive(workspaceRoot));
  const pathForCompare = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath;
  const rootForCompare = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
  if (!pathForCompare.startsWith(`${rootForCompare}/`)) return null;
  return normalizedPath.slice(normalizedRoot.length + 1);
}

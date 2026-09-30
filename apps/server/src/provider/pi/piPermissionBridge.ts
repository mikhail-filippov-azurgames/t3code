import type { RuntimeMode } from "@t3tools/contracts";

/**
 * Pi built-in tools documented at https://pi.dev/docs/latest/settings.
 * CLI `--tools` overrides `defaultTools` for one invocation.
 */
export const PI_BUILT_IN_TOOLS = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;
export type PiBuiltInTool = (typeof PI_BUILT_IN_TOOLS)[number];

const READ_TOOLS: ReadonlyArray<PiBuiltInTool> = ["read", "grep", "find", "ls"];
const WRITE_TOOLS: ReadonlyArray<PiBuiltInTool> = ["edit", "write"];
const SHELL_TOOLS: ReadonlyArray<PiBuiltInTool> = ["bash", "powershell"];

export interface PiLaunchProfile {
  readonly tools: ReadonlyArray<PiBuiltInTool>;
  readonly runtime: "pinned-bundle";
  readonly environment: "managed";
  readonly authority: {
    readonly filesystem: "unrestricted";
    readonly externalDirectories: "unrestricted";
    readonly commandExecution: "unrestricted";
    readonly network: "unrestricted";
    readonly approvalBypass: true;
  };
  readonly projectTrust: "never";
  readonly extensions: "ft3-guard-only";
}

/**
 * Fail-closed mapping from the FT3 permission envelope to Pi tools.
 * Unknown tool names are denied. `full-access` is the only mode that
 * enables every built-in tool; every other mode gets the smallest subset
 * that preserves its read/write/shell contract.
 */
export function resolvePiToolsForRuntimeMode(
  runtimeMode: RuntimeMode,
): ReadonlyArray<PiBuiltInTool> {
  switch (runtimeMode) {
    case "approval-required":
      return [...READ_TOOLS];
    case "auto-accept-edits":
      return [...READ_TOOLS, ...WRITE_TOOLS];
    case "auto":
      return [...READ_TOOLS, ...WRITE_TOOLS];
    case "full-access":
      return [...PI_BUILT_IN_TOOLS];
  }
}

/** The extension limits Pi tool calls, while its process retains the OS user's authority. */
export function resolvePiLaunchProfile(runtimeMode: RuntimeMode): PiLaunchProfile {
  return {
    tools: resolvePiToolsForRuntimeMode(runtimeMode),
    runtime: "pinned-bundle",
    environment: "managed",
    authority: {
      filesystem: "unrestricted",
      externalDirectories: "unrestricted",
      commandExecution: "unrestricted",
      network: "unrestricted",
      approvalBypass: true,
    },
    projectTrust: "never",
    extensions: "ft3-guard-only",
  };
}

const PI_BLOCKED_LAUNCH_ENVIRONMENT_KEYS = [
  /^(?:NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_USE_ENV_PROXY)$/i,
  /^(?:HTTP|HTTPS|ALL|NO|FTP|WS|WSS|SOCKS)_PROXY$/i,
  /^(?:LD|DYLD)_.+$/i,
  /^(?:OPENAI|PI)_.+$/i,
  /^T3CODE_PI_.+$/i,
];

/** Variables that can inject code or redirect Pi's runtime, endpoint, trust, or extensions. */
export function isPiBlockedLaunchEnvironmentKey(name: string): boolean {
  return (
    name.toUpperCase() !== "PI_CODING_AGENT_DIR" &&
    PI_BLOCKED_LAUNCH_ENVIRONMENT_KEYS.some((pattern) => pattern.test(name))
  );
}

export type PiLaunchEnvironmentResult =
  | { readonly ok: true; readonly environment: NodeJS.ProcessEnv }
  | { readonly ok: false; readonly reason: string };

/**
 * Verify and prepare the exact environment passed to every Pi child.
 * Values that can inject code before the pinned CLI starts, redirect its
 * network traffic, or change its runtime/configuration fail closed.
 */
export function buildPiLaunchEnvironment(
  profile: PiLaunchProfile,
  environment: NodeJS.ProcessEnv,
  agentDir?: string | undefined,
): PiLaunchEnvironmentResult {
  if (profile.runtime !== "pinned-bundle" || profile.environment !== "managed") {
    return { ok: false, reason: "Pi launch profile is not pinned to the managed runtime." };
  }
  const managed: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    const normalized = name.toUpperCase();
    if (normalized === "PI_CODING_AGENT_DIR") continue;
    if (isPiBlockedLaunchEnvironmentKey(name)) {
      if (value?.trim()) {
        return {
          ok: false,
          reason: `Pi launch blocked by unsafe environment variable ${name}.`,
        };
      }
      continue;
    }
    managed[name] = value;
  }
  if (agentDir !== undefined) managed.PI_CODING_AGENT_DIR = agentDir;
  return { ok: true, environment: managed };
}

/** True when Pi may execute the named tool without an FT3 approval round-trip. */
export function isPiToolAllowedWithoutApproval(
  toolName: string,
  runtimeMode: RuntimeMode,
): boolean {
  const normalized = toolName.trim().toLowerCase();
  if (runtimeMode === "full-access") {
    return (PI_BUILT_IN_TOOLS as ReadonlyArray<string>).includes(normalized);
  }
  if ((SHELL_TOOLS as ReadonlyArray<string>).includes(normalized)) return false;
  if ((WRITE_TOOLS as ReadonlyArray<string>).includes(normalized)) {
    return runtimeMode === "auto-accept-edits" || runtimeMode === "auto";
  }
  return (READ_TOOLS as ReadonlyArray<string>).includes(normalized);
}

export type PiExtensionUiMethod =
  | "select"
  | "confirm"
  | "input"
  | "editor"
  | "notify"
  | "setStatus"
  | "setWidget"
  | "setTitle"
  | "set_editor_text";

/** Dialog methods block the Pi agent until FT3 answers; the rest are fire-and-forget. */
export function isPiExtensionUiDialog(method: string): boolean {
  return method === "select" || method === "confirm" || method === "input" || method === "editor";
}

/**
 * Fail-closed dialog policy: FT3 surfaces the request as an approval item
 * and auto-declines on timeout, close, or unsupported method. Callers must
 * never default a dialog to allow.
 */
export function piExtensionUiDeclinedResponse(method: string): Record<string, unknown> {
  switch (method) {
    case "select":
      return { cancelled: true };
    case "confirm":
      return { confirmed: false, cancelled: true };
    case "input":
    case "editor":
      return { value: "", cancelled: true };
    default:
      return { cancelled: true };
  }
}

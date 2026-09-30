import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import type {
  OrchestratorMcpPermissionEnvelopeSummary,
  OrchestratorMcpPermissionAutomaticity,
  OrchestratorMcpVerifiedPermissionEnvelope,
  ProviderDriverKind,
  ProviderInstanceConfig,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import { parseCliArgs, tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { expandHomePath } from "../pathExpansion.ts";
import { normalizePiBaseUrl, parsePiLocalEndpoint } from "./pi/piAgentDir.ts";
import {
  isPiBlockedLaunchEnvironmentKey,
  resolvePiLaunchProfile,
} from "./pi/piPermissionBridge.ts";
import { PI_RUNTIME_ENV_VAR } from "./pi/piRuntime.ts";

const AUTOMATICITY_RANK: Readonly<Record<OrchestratorMcpPermissionAutomaticity, number>> = {
  none: 0,
  "approval-required": 1,
  automatic: 2,
  unrestricted: 3,
};

const FILESYSTEM_RANK: Readonly<
  Record<OrchestratorMcpVerifiedPermissionEnvelope["filesystem"], number>
> = {
  "read-only": 0,
  "workspace-write": 1,
  unrestricted: 2,
};

const SECURITY_TERM =
  /(?:approv|browser|danger|external|feature|hook|mcp|network|permission|plugin|sandbox|search|shell|tool|trust|web|workspace|yolo|apply[_-]?patch|\bexec\b|\bread\b|\bwrite\b)/i;

const CODEX_PROJECT_TABLE = /^\s*\[\s*projects\.(?:'[^'\r\n]+'|"[^"\r\n]+")\s*\]\s*(?:#.*)?$/i;
const TOML_TABLE = /^\s*\[[^\]\r\n]+\]\s*(?:#.*)?$/;
const CODEX_TRUSTED_PROJECT_SETTING = /^\s*trust_level\s*=\s*(?:"trusted"|'trusted')\s*(?:#.*)?$/i;

const DRIVER_ENV_PREFIXES: Readonly<Record<string, ReadonlyArray<string>>> = {
  codex: ["CODEX_", "T3CODE_CODEX_"],
  claudeAgent: ["ANTHROPIC_", "CLAUDE_"],
  opencode: ["OPENCODE_"],
  pi: ["PI_", "T3CODE_PI_", "OPENAI_"],
  grok: ["GROK_", "XAI_"],
  antigravity: ["ANTIGRAVITY_", "GOOGLE_", "GEMINI_"],
  cursor: ["CURSOR_"],
  museCode: ["MUSE_", "META_"],
};

export const DELEGATION_MCP_CAPABILITY_UNIVERSE: ReadonlyArray<string> = [
  "device",
  "orchestration",
  "preview",
  "pull-requests",
];

/** Every subset of the frozen capability universe, each already sorted. */
export function delegationMcpCapabilitySubsets(): Array<ReadonlyArray<string>> {
  const subsets: Array<ReadonlyArray<string>> = [];
  for (let mask = 0; mask < 1 << DELEGATION_MCP_CAPABILITY_UNIVERSE.length; mask++) {
    subsets.push(
      DELEGATION_MCP_CAPABILITY_UNIVERSE.filter((_, index) => (mask & (1 << index)) !== 0),
    );
  }
  return subsets;
}

/** Accept only a stored snapshot drawn from the frozen universe. */
export function sanitizeDelegationChildCapsSnapshot(
  value: unknown,
): ReadonlySet<string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const universe = new Set(DELEGATION_MCP_CAPABILITY_UNIVERSE);
  const caps = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !universe.has(entry)) return undefined;
    caps.add(entry);
  }
  return caps;
}

export type DelegationChildCapsRecovery =
  | {
      readonly status: "recovered";
      readonly caps: ReadonlySet<string>;
      readonly envelope: OrchestratorMcpPermissionEnvelopeSummary;
    }
  | { readonly status: "no-match" }
  | { readonly status: "ambiguous" };

/**
 * Recover the canonical frozen child caps for an expected fingerprint.
 * The fingerprint algorithm is unchanged (caps stay in the hash), so at most
 * one subset can match; zero or several matches fail closed at the call site.
 */
export function recoverDelegationChildCaps<E>(input: {
  readonly expectedFingerprint: string;
  readonly preferredCaps?: ReadonlySet<string> | undefined;
  readonly loadWithCaps: (
    caps: ReadonlySet<string>,
  ) => Effect.Effect<OrchestratorMcpPermissionEnvelopeSummary, E>;
}): Effect.Effect<DelegationChildCapsRecovery, E> {
  return Effect.gen(function* () {
    const seen = new Set<string>();
    const candidates: Array<ReadonlyArray<string>> = [];
    if (input.preferredCaps !== undefined) {
      const first = [...input.preferredCaps].toSorted();
      seen.add(first.join(","));
      candidates.push(first);
    }
    for (const subset of delegationMcpCapabilitySubsets()) {
      const key = subset.join(",");
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(subset);
      }
    }
    const matches: Array<{
      readonly caps: ReadonlySet<string>;
      readonly envelope: OrchestratorMcpPermissionEnvelopeSummary;
    }> = [];
    for (const subset of candidates) {
      const envelope = yield* input.loadWithCaps(new Set(subset));
      if (envelope.status === "verified" && envelope.fingerprint === input.expectedFingerprint) {
        matches.push({ caps: new Set(subset), envelope });
        if (matches.length > 1) return { status: "ambiguous" } as const;
      }
    }
    const single = matches[0];
    return single === undefined
      ? ({ status: "no-match" } as const)
      : { ...single, status: "recovered" as const };
  });
}

export interface DelegationPermissionEnvelopeInput {
  readonly driverKind: ProviderDriverKind;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly instanceConfig: ProviderInstanceConfig;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly workspaceRoot: string;
  readonly worktreePath: string;
  readonly branch: string | null;
  readonly t3McpCapabilities: ReadonlySet<string>;
  /** Security-relevant provider files captured from the effective runtime locations. */
  readonly providerConfigurationFiles?: ReadonlyArray<{
    readonly path: string;
    readonly content: string | null;
  }>;
}

export interface DelegationPermissionComparisonInput {
  readonly parent: OrchestratorMcpPermissionEnvelopeSummary;
  readonly target: OrchestratorMcpPermissionEnvelopeSummary;
  readonly parentInteractionMode: ProviderInteractionMode;
  readonly targetInteractionMode: ProviderInteractionMode;
  readonly parentWorkspace: {
    readonly projectId: string;
    readonly workspaceRoot: string;
    readonly worktreePath: string;
    readonly branch: string | null;
  };
  readonly targetWorkspace: {
    readonly projectId: string;
    readonly workspaceRoot: string;
    readonly worktreePath: string;
    readonly branch: string | null;
  };
}

export type DelegationPermissionComparison =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly code: "permission_escalation_denied" | "permission_envelope_unverifiable";
      readonly reason: string;
    };

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function fingerprint(value: unknown): string {
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function environmentRecord(
  input: DelegationPermissionEnvelopeInput,
): Readonly<Record<string, string>> {
  const inherited = input.environment ?? process.env;
  const prefixes = DRIVER_ENV_PREFIXES[input.driverKind] ?? [];
  const relevant = Object.fromEntries(
    Object.entries(inherited)
      .filter(
        ([name, value]) =>
          value !== undefined &&
          !(input.driverKind === "pi" && name.toUpperCase() === "PI_CODING_AGENT_DIR") &&
          (prefixes.some((prefix) => name.toUpperCase().startsWith(prefix)) ||
            (input.driverKind === "pi" && isPiBlockedLaunchEnvironmentKey(name))),
      )
      .map(([name, value]) => [name, value ?? ""]),
  );
  for (const variable of input.instanceConfig.environment ?? []) {
    if (input.driverKind === "pi" && variable.name.toUpperCase() === "PI_CODING_AGENT_DIR") {
      continue;
    }
    relevant[variable.name] = variable.value;
  }
  return relevant;
}

function unverifiable(reason: string): OrchestratorMcpPermissionEnvelopeSummary {
  return { status: "unverifiable", reason };
}

function configValue(input: DelegationPermissionEnvelopeInput, name: string): unknown {
  const config = input.instanceConfig.config;
  if (typeof config !== "object" || config === null) return undefined;
  return (config as Readonly<Record<string, unknown>>)[name];
}

function configString(input: DelegationPermissionEnvelopeInput, name: string): string | undefined {
  const value = configValue(input, name);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function piConfigurationReason(input: DelegationPermissionEnvelopeInput): string | undefined {
  const binaryPath = configValue(input, "binaryPath");
  if (binaryPath !== undefined && typeof binaryPath !== "string") {
    return "Pi binary configuration is not comparable.";
  }
  if (typeof binaryPath === "string" && binaryPath.trim() !== "" && binaryPath.trim() !== "pi") {
    return "Pi delegation requires the pinned bundled runtime; custom binaries are not comparable.";
  }

  const configuredBaseUrl = configValue(input, "baseUrl");
  if (configuredBaseUrl !== undefined && typeof configuredBaseUrl !== "string") {
    return "Pi endpoint configuration is not comparable.";
  }
  if (!parsePiLocalEndpoint(normalizePiBaseUrl(configuredBaseUrl as string | undefined))) {
    return "Pi delegation requires a verifiable local HTTP loopback endpoint.";
  }

  for (const [name, value] of Object.entries(environmentRecord(input))) {
    if (value.trim() === "") continue;
    const normalized = name.toUpperCase();
    if (normalized === PI_RUNTIME_ENV_VAR || isPiBlockedLaunchEnvironmentKey(name)) {
      return `Pi launch environment variable ${name} is not comparable.`;
    }
  }
  return undefined;
}

function configurationFilePaths(
  input: DelegationPermissionEnvelopeInput,
  path: Path.Path,
): ReadonlyArray<string> {
  const environment = environmentRecord(input);
  switch (input.driverKind) {
    case "codex": {
      const sharedHome = path.resolve(
        expandHomePath(
          configString(input, "homePath") ??
            environment.CODEX_HOME ??
            path.join(NodeOS.homedir(), ".codex"),
        ),
      );
      return [
        path.join(sharedHome, "config.toml"),
        path.join(input.worktreePath, ".codex", "config.toml"),
      ];
    }
    case "claudeAgent": {
      const configHome = path.resolve(
        expandHomePath(
          configString(input, "homePath") ??
            environment.CLAUDE_CONFIG_DIR ??
            path.join(NodeOS.homedir(), ".claude"),
        ),
      );
      return [
        path.join(configHome, "settings.json"),
        path.join(input.worktreePath, ".claude", "settings.json"),
        path.join(input.worktreePath, ".claude", "settings.local.json"),
        path.join(input.worktreePath, ".mcp.json"),
      ];
    }
    default:
      return [];
  }
}

/** Ignore only Codex's standard project-trusted marker; the raw file is still fingerprinted. */
function codexComparableConfigurationContent(content: string): string {
  let inProjectTable = false;
  return content
    .split(/\r?\n/)
    .map((line) => {
      if (CODEX_PROJECT_TABLE.test(line)) {
        inProjectTable = true;
        return "";
      }
      if (TOML_TABLE.test(line)) inProjectTable = false;
      return inProjectTable && CODEX_TRUSTED_PROJECT_SETTING.test(line) ? "" : line;
    })
    .join("\n");
}

function providerConfigurationReason(input: DelegationPermissionEnvelopeInput): string | undefined {
  const files = input.providerConfigurationFiles;
  if (input.driverKind === "pi") {
    const reason = piConfigurationReason(input);
    if (reason !== undefined) return reason;
  }
  if ((input.driverKind === "codex" || input.driverKind === "claudeAgent") && files === undefined) {
    return `${input.driverKind} provider configuration files were not inspected.`;
  }
  // A full-access Codex runtime is already the top authority envelope. Provider
  // configuration cannot broaden it, while the raw files remain fingerprinted
  // below so a configuration change still invalidates an accepted delegation.
  if (input.driverKind === "codex" && input.runtimeMode === "full-access") return undefined;
  for (const file of files ?? []) {
    const content = file.content?.trim();
    if (!content) continue;
    if (file.path.toLowerCase().endsWith(".json")) {
      try {
        JSON.parse(content);
      } catch {
        return `Provider configuration file ${file.path} is not valid JSON.`;
      }
    }
    const comparableContent =
      input.driverKind === "codex" && file.path.toLowerCase().endsWith("config.toml")
        ? codexComparableConfigurationContent(content)
        : content;
    if (file.path.toLowerCase().endsWith(".mcp.json") || SECURITY_TERM.test(comparableContent)) {
      return `Security-affecting provider configuration in ${file.path} is not comparable.`;
    }
  }
  return undefined;
}

export const loadDelegationPermissionEnvelope = Effect.fn("loadDelegationPermissionEnvelope")(
  function* (input: DelegationPermissionEnvelopeInput) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const snapshots = yield* Effect.forEach(configurationFilePaths(input, path), (filePath) =>
      fileSystem.readFileString(filePath).pipe(
        Effect.map((content) => ({ path: filePath, content }) as const),
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed({ path: filePath, content: null } as const)
              : Effect.fail(error),
        }),
      ),
    ).pipe(
      Effect.match({
        onFailure: (error) =>
          unverifiable(`Provider configuration files could not be read: ${error.message}`),
        onSuccess: (providerConfigurationFiles) =>
          normalizeDelegationPermissionEnvelope({ ...input, providerConfigurationFiles }),
      }),
    );
    return snapshots;
  },
);

function runtimeEnvelope(
  runtimeMode: RuntimeMode,
): Pick<
  OrchestratorMcpVerifiedPermissionEnvelope,
  "filesystem" | "externalDirectories" | "commandExecution" | "network" | "approvalBypass"
> {
  switch (runtimeMode) {
    case "approval-required":
      return {
        filesystem: "read-only",
        externalDirectories: "approval-required",
        commandExecution: "approval-required",
        network: "approval-required",
        approvalBypass: false,
      };
    case "auto-accept-edits":
      return {
        filesystem: "workspace-write",
        externalDirectories: "approval-required",
        commandExecution: "approval-required",
        network: "approval-required",
        approvalBypass: false,
      };
    case "auto":
      return {
        filesystem: "workspace-write",
        externalDirectories: "approval-required",
        commandExecution: "automatic",
        network: "automatic",
        approvalBypass: false,
      };
    case "full-access":
      return {
        filesystem: "unrestricted",
        externalDirectories: "unrestricted",
        commandExecution: "unrestricted",
        network: "unrestricted",
        approvalBypass: true,
      };
  }
}

function codexLaunchArgs(input: DelegationPermissionEnvelopeInput): ReadonlyArray<string> {
  const environment = environmentRecord(input);
  const config = input.instanceConfig.config;
  const configured =
    typeof config === "object" && config !== null && "launchArgs" in config
      ? (config as { readonly launchArgs?: unknown }).launchArgs
      : undefined;
  const effective =
    environment.T3CODE_CODEX_LAUNCH_ARGS ??
    (typeof configured === "string" ? configured : undefined);
  return tokenizeCliArgs(effective);
}

function unverifiedCodexReason(input: DelegationPermissionEnvelopeInput): string | undefined {
  const args = codexLaunchArgs(input);
  for (let index = 0; index < args.length; index++) {
    const token = args[index] ?? "";
    if (
      token === "--enable" ||
      token === "--disable" ||
      token.startsWith("--enable=") ||
      token.startsWith("--disable=")
    ) {
      return "Codex feature overrides can change provider tool authority.";
    }
    if (token === "-c" || token === "--config") {
      const value = args[index + 1];
      if (value === undefined) return "Codex config launch argument is incomplete.";
      if (SECURITY_TERM.test(value)) {
        return "Codex permission, sandbox, tool, network, workspace, or MCP config override is not comparable.";
      }
      index++;
      continue;
    }
    if ((token.startsWith("-c=") || token.startsWith("--config=")) && SECURITY_TERM.test(token)) {
      return "Codex permission, sandbox, tool, network, workspace, or MCP config override is not comparable.";
    }
    if (SECURITY_TERM.test(token)) {
      return "Codex security-affecting launch argument is not comparable.";
    }
  }
  return undefined;
}

type ClaudePermissionMode = "default" | "acceptEdits" | "auto" | "bypassPermissions" | "plan";

function claudeOverrides(input: DelegationPermissionEnvelopeInput):
  | {
      readonly mode: ClaudePermissionMode | undefined;
      readonly allowedTools: ReadonlyArray<string>;
      readonly disallowedTools: ReadonlyArray<string>;
    }
  | { readonly reason: string } {
  const config = input.instanceConfig.config;
  const launchArgs =
    typeof config === "object" && config !== null && "launchArgs" in config
      ? (config as { readonly launchArgs?: unknown }).launchArgs
      : undefined;
  if (launchArgs !== undefined && typeof launchArgs !== "string") {
    return { reason: "Claude launch arguments are not a string." };
  }
  const parsed = parseCliArgs(typeof launchArgs === "string" ? launchArgs : "");
  const flags = parsed.flags;
  const permissionValue = flags["permission-mode"];
  const skip = flags["dangerously-skip-permissions"];
  let mode: ClaudePermissionMode | undefined;
  if (permissionValue !== undefined) {
    if (
      permissionValue !== "default" &&
      permissionValue !== "acceptEdits" &&
      permissionValue !== "auto" &&
      permissionValue !== "bypassPermissions" &&
      permissionValue !== "plan"
    ) {
      return { reason: `Claude permission mode ${String(permissionValue)} is not comparable.` };
    }
    mode = permissionValue;
  } else if (skip === null || skip === "true") {
    mode = "bypassPermissions";
  }

  const splitTools = (value: string | null | undefined): ReadonlyArray<string> =>
    typeof value === "string"
      ? value
          .split(/[ ,]+/)
          .map((tool) => tool.trim())
          .filter(Boolean)
          .toSorted()
      : [];
  const allowedTools = splitTools(flags["allowedTools"] ?? flags["allowed-tools"]);
  const disallowedTools = splitTools(flags["disallowedTools"] ?? flags["disallowed-tools"]);
  const reflected = new Set([
    "permission-mode",
    "dangerously-skip-permissions",
    "allowedTools",
    "allowed-tools",
    "disallowedTools",
    "disallowed-tools",
  ]);
  for (const name of Object.keys(flags)) {
    if (reflected.has(name)) continue;
    if (SECURITY_TERM.test(name) || name === "chrome") {
      return { reason: `Claude security-affecting launch argument --${name} is not comparable.` };
    }
  }
  if (parsed.positionals.some((entry) => SECURITY_TERM.test(entry))) {
    return { reason: "Claude security-affecting positional launch argument is not comparable." };
  }
  return { mode, allowedTools, disallowedTools };
}

function withClaudeMode(
  base: ReturnType<typeof runtimeEnvelope>,
  mode: ClaudePermissionMode | undefined,
): ReturnType<typeof runtimeEnvelope> {
  switch (mode) {
    case undefined:
    case "default":
      return base;
    case "acceptEdits":
      return runtimeEnvelope("auto-accept-edits");
    case "auto":
      return runtimeEnvelope("auto");
    case "bypassPermissions":
      return runtimeEnvelope("full-access");
    case "plan":
      return {
        filesystem: "read-only",
        externalDirectories: "none",
        commandExecution: "none",
        network: "approval-required",
        approvalBypass: false,
      };
  }
}

function openCodeConfigReason(input: DelegationPermissionEnvelopeInput): string | undefined {
  const content = environmentRecord(input).OPENCODE_CONFIG_CONTENT?.trim();
  if (content === undefined || content === "" || content === "{}") return undefined;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return "OpenCode config content is not an object.";
    }
    const keys = Object.keys(parsed as Readonly<Record<string, unknown>>);
    if (keys.some((key) => SECURITY_TERM.test(key))) {
      return "OpenCode configured permission, tool, network, workspace, or MCP authority is not comparable.";
    }
    return undefined;
  } catch {
    return "OpenCode config content is not valid JSON.";
  }
}

function normalizedRuntimeForDriver(input: DelegationPermissionEnvelopeInput):
  | {
      readonly runtime: ReturnType<typeof runtimeEnvelope>;
      readonly externalTools: ReadonlyArray<string>;
    }
  | { readonly reason: string } {
  switch (input.driverKind) {
    case "codex": {
      if (input.runtimeMode === "full-access") {
        return { runtime: runtimeEnvelope("full-access"), externalTools: [] };
      }
      const reason = unverifiedCodexReason(input);
      return reason === undefined
        ? { runtime: runtimeEnvelope(input.runtimeMode), externalTools: [] }
        : { reason };
    }
    case "claudeAgent": {
      const overrides = claudeOverrides(input);
      if ("reason" in overrides) return overrides;
      const denied = new Set(overrides.disallowedTools);
      return {
        runtime: withClaudeMode(runtimeEnvelope(input.runtimeMode), overrides.mode),
        externalTools: overrides.allowedTools.filter((tool) => !denied.has(tool)),
      };
    }
    case "opencode": {
      const reason = openCodeConfigReason(input);
      if (reason !== undefined) return { reason };
      // OpenCode has no automatic reviewer: its `auto` mode intentionally
      // falls back to the supervised permission-rule builder.
      return {
        runtime: runtimeEnvelope(
          input.runtimeMode === "auto" ? "approval-required" : input.runtimeMode,
        ),
        externalTools: [],
      };
    }
    case "pi": {
      const profile = resolvePiLaunchProfile(input.runtimeMode);
      return { runtime: profile.authority, externalTools: [] };
    }
    case "grok":
      return { runtime: runtimeEnvelope(input.runtimeMode), externalTools: [] };
    case "museCode": {
      // A full-access Muse runtime is the top authority envelope: the
      // elevated host disables the shell sandbox and trusts the workspace
      // while the wire carries allowAll, so provider configuration cannot
      // broaden it further.
      if (input.runtimeMode === "full-access") {
        return { runtime: runtimeEnvelope("full-access"), externalTools: [] };
      }
      return { runtime: runtimeEnvelope(input.runtimeMode), externalTools: [] };
    }
    case "antigravity":
      return {
        runtime: runtimeEnvelope(
          input.runtimeMode === "auto" ? "approval-required" : input.runtimeMode,
        ),
        externalTools: [],
      };
    case "cursor":
      return { reason: "Cursor ACP does not expose a complete authoritative permission envelope." };
    default:
      return {
        reason: `Provider driver ${input.driverKind} has no accepted permission normalizer.`,
      };
  }
}

export function normalizeDelegationPermissionEnvelope(
  input: DelegationPermissionEnvelopeInput,
): OrchestratorMcpPermissionEnvelopeSummary {
  if (input.instanceConfig.driver !== input.driverKind) {
    return unverifiable("Provider instance driver does not match the requested driver.");
  }
  const environment = environmentRecord(input);
  const configurationReason = providerConfigurationReason(input);
  if (configurationReason !== undefined) return unverifiable(configurationReason);
  for (const [name] of Object.entries(environment)) {
    if (
      !(input.driverKind === "codex" && input.runtimeMode === "full-access") &&
      SECURITY_TERM.test(name) &&
      name !== "T3CODE_CODEX_LAUNCH_ARGS" &&
      name !== "OPENCODE_CONFIG_CONTENT"
    ) {
      return unverifiable(
        `Security-affecting provider environment variable ${name} is not comparable.`,
      );
    }
  }
  const normalized = normalizedRuntimeForDriver(input);
  if ("reason" in normalized) return unverifiable(normalized.reason);
  const configFingerprint = fingerprint({
    driverKind: input.driverKind,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    instanceConfig: input.instanceConfig,
    environment,
    providerConfigurationFiles: input.providerConfigurationFiles ?? [],
    workspaceRoot: input.workspaceRoot,
    worktreePath: input.worktreePath,
    branch: input.branch,
    t3McpCapabilities: [...input.t3McpCapabilities].toSorted(),
  });
  const providerTools = [
    "filesystem.read",
    ...(normalized.runtime.filesystem === "read-only" ? [] : ["filesystem.write"]),
    ...(AUTOMATICITY_RANK[normalized.runtime.commandExecution] >= AUTOMATICITY_RANK.automatic
      ? ["command.execute"]
      : []),
    ...(AUTOMATICITY_RANK[normalized.runtime.network] >= AUTOMATICITY_RANK.automatic
      ? ["network.access"]
      : []),
  ];
  return {
    status: "verified",
    fingerprint: configFingerprint,
    ...normalized.runtime,
    providerTools,
    externalTools: [...normalized.externalTools].toSorted(),
    t3McpCapabilities: [...input.t3McpCapabilities].toSorted(),
  };
}

function subset(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  const available = new Set(right);
  return left.every((entry) => available.has(entry));
}

export function compareDelegationPermissionEnvelopes(
  input: DelegationPermissionComparisonInput,
): DelegationPermissionComparison {
  if (input.parent.status !== "verified") {
    return {
      allowed: false,
      code: "permission_envelope_unverifiable",
      reason: `Parent permission envelope is unverifiable: ${input.parent.reason}`,
    };
  }
  if (input.target.status !== "verified") {
    return {
      allowed: false,
      code: "permission_envelope_unverifiable",
      reason: `Target permission envelope is unverifiable: ${input.target.reason}`,
    };
  }
  if (
    input.parentWorkspace.projectId !== input.targetWorkspace.projectId ||
    input.parentWorkspace.workspaceRoot !== input.targetWorkspace.workspaceRoot ||
    input.parentWorkspace.worktreePath !== input.targetWorkspace.worktreePath ||
    input.parentWorkspace.branch !== input.targetWorkspace.branch
  ) {
    return {
      allowed: false,
      code: "permission_escalation_denied",
      reason:
        "Delegated tasks must inherit the exact parent project, workspace, worktree, and branch.",
    };
  }
  if (input.parentInteractionMode === "plan" && input.targetInteractionMode === "default") {
    return {
      allowed: false,
      code: "permission_escalation_denied",
      reason: "A planning parent cannot delegate a default interaction-mode task.",
    };
  }
  const broader =
    FILESYSTEM_RANK[input.target.filesystem] > FILESYSTEM_RANK[input.parent.filesystem] ||
    AUTOMATICITY_RANK[input.target.externalDirectories] >
      AUTOMATICITY_RANK[input.parent.externalDirectories] ||
    AUTOMATICITY_RANK[input.target.commandExecution] >
      AUTOMATICITY_RANK[input.parent.commandExecution] ||
    AUTOMATICITY_RANK[input.target.network] > AUTOMATICITY_RANK[input.parent.network] ||
    (input.target.approvalBypass && !input.parent.approvalBypass) ||
    !subset(input.target.providerTools, input.parent.providerTools) ||
    !subset(input.target.externalTools, input.parent.externalTools) ||
    !subset(input.target.t3McpCapabilities, input.parent.t3McpCapabilities);
  return broader
    ? {
        allowed: false,
        code: "permission_escalation_denied",
        reason: "Target automatic authority is broader than the frozen parent permission envelope.",
      }
    : { allowed: true };
}

export type DelegationRuntimeMode =
  | "approval-required"
  | "auto-accept-edits"
  | "auto"
  | "full-access";

export type DelegationInteractionMode = "default" | "plan";

export interface DelegationPermissionEnvelopeInput {
  readonly driverKind: string;
  readonly runtimeMode: DelegationRuntimeMode;
  readonly interactionMode: DelegationInteractionMode;
  readonly instanceConfig: unknown;
  readonly environment?: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
  }>;
}

export type DelegationPermissionEnvelope =
  | {
      readonly status: "verified";
      readonly filesystem: 0 | 1 | 2;
      readonly automaticity: 0 | 1 | 2 | 3;
      readonly allowedTools: ReadonlyArray<string>;
    }
  | { readonly status: "unverifiable"; readonly reason: string };

export type DelegationPermissionDecision =
  | { readonly _tag: "Allowed" }
  | {
      readonly _tag: "Denied";
      readonly code: "permission_escalation_denied" | "permission_envelope_unverifiable";
      readonly reason: string;
    };

export interface DelegationPermissionDenialInput {
  readonly settings?:
    | {
        readonly providerInstances: Readonly<
          Record<
            string,
            | {
                readonly driver: string;
                readonly config?: unknown;
                readonly environment?: ReadonlyArray<{
                  readonly name: string;
                  readonly value: string;
                }>;
              }
            | undefined
          >
        >;
      }
    | undefined;
  readonly providers: ReadonlyArray<{
    readonly instanceId: string;
    readonly driver: string;
  }>;
  readonly parentThread: {
    readonly projectId: string;
    readonly modelSelection: { readonly instanceId: string };
    readonly runtimeMode: DelegationRuntimeMode;
    readonly interactionMode: DelegationInteractionMode;
  };
  readonly targetInstanceId: string;
  readonly runtimeMode: DelegationRuntimeMode;
  readonly interactionMode: DelegationInteractionMode;
}

export interface DelegationPermissionDenial {
  readonly code: "runtime_mode_escalation_denied" | "capability_denied";
  readonly reason: string;
}

const SECURITY_TERM =
  /(?:approv|browser|danger|external|feature|hook|mcp|network|permission|plugin|sandbox|search|shell|tool|trust|web|workspace|yolo|apply[_-]?patch|\bexec\b|\bread\b|\bwrite\b)/i;

const DRIVER_ENV_PREFIXES: Readonly<Record<string, ReadonlyArray<string>>> = {
  codex: ["CODEX_", "T3CODE_CODEX_"],
  claudeAgent: ["ANTHROPIC_", "CLAUDE_"],
  opencode: ["OPENCODE_"],
  pi: ["PI_", "T3CODE_PI_", "OPENAI_"],
  grok: ["GROK_", "XAI_"],
  kimi: ["KIMI_", "MOONSHOT_"],
  antigravity: ["ANTIGRAVITY_", "GOOGLE_", "GEMINI_"],
  cursor: ["CURSOR_"],
  muse: ["MUSE_", "META_"],
};

const CLAUDE_PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "plan",
]);

function unverifiable(reason: string): DelegationPermissionEnvelope {
  return { status: "unverifiable", reason };
}

function configRecord(input: DelegationPermissionEnvelopeInput): Readonly<Record<string, unknown>> {
  const config = input.instanceConfig;
  return typeof config === "object" && config !== null && !Array.isArray(config)
    ? (config as Readonly<Record<string, unknown>>)
    : {};
}

function launchArgs(input: DelegationPermissionEnvelopeInput): string {
  const value = configRecord(input).launchArgs;
  return typeof value === "string" ? value : "";
}

/** Split a CLI string the way the provider CLIs do, keeping quoted values together. */
export function tokenizeLaunchArgs(value: string): ReadonlyArray<string> {
  const tokens: Array<string> = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index] ?? "";
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

function splitTools(value: string): ReadonlyArray<string> {
  return value
    .split(/[ ,]+/)
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0)
    .toSorted();
}

interface ClaudeFlags {
  readonly mode: string | undefined;
  readonly allowedTools: ReadonlyArray<string>;
  readonly disallowedTools: ReadonlyArray<string>;
  readonly reason: string | undefined;
}

function claudeFlags(input: DelegationPermissionEnvelopeInput): ClaudeFlags {
  const tokens = tokenizeLaunchArgs(launchArgs(input));
  let mode: string | undefined;
  let skipPermissions = false;
  let allowed: ReadonlyArray<string> = [];
  let disallowed: ReadonlyArray<string> = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? "";
    if (token === "--dangerously-skip-permissions") {
      skipPermissions = true;
      continue;
    }
    if (!token.startsWith("-")) {
      return {
        mode,
        allowedTools: allowed,
        disallowedTools: disallowed,
        reason:
          `Claude positional launch argument ${token} cannot be compared, so delegation was ` +
          "refused. Remove the positional argument and retry.",
      };
    }
    const separator = token.indexOf("=");
    const name = (separator === -1 ? token.slice(2) : token.slice(2, separator)).replace(/^-/, "");
    const inline = separator === -1 ? undefined : token.slice(separator + 1);
    const takesValue =
      name === "permission-mode" ||
      name === "allowedTools" ||
      name === "allowed-tools" ||
      name === "disallowedTools" ||
      name === "disallowed-tools";
    const value = inline ?? (takesValue ? tokens[index + 1] : undefined);
    if (inline === undefined && takesValue) index++;
    if (name === "permission-mode") {
      if (value === undefined || !CLAUDE_PERMISSION_MODES.has(value)) {
        return {
          mode,
          allowedTools: allowed,
          disallowedTools: disallowed,
          reason:
            `Claude permission mode ${String(value)} is not one of default, acceptEdits, auto, ` +
            "bypassPermissions, or plan, so it cannot be compared and delegation was refused. " +
            "Set a known --permission-mode or remove it, then retry.",
        };
      }
      mode = value;
      continue;
    }
    if (name === "allowedTools" || name === "allowed-tools") {
      allowed = splitTools(value ?? "");
      continue;
    }
    if (name === "disallowedTools" || name === "disallowed-tools") {
      disallowed = splitTools(value ?? "");
      continue;
    }
    if (SECURITY_TERM.test(name) || name === "chrome") {
      return {
        mode,
        allowedTools: allowed,
        disallowedTools: disallowed,
        reason:
          `Claude launch argument --${name} affects security (tools, network, sandbox, or MCP), ` +
          "so it is not comparable and delegation was refused. Remove it from the launch " +
          "arguments and retry.",
      };
    }
  }
  return {
    mode: skipPermissions ? (mode ?? "bypassPermissions") : mode,
    allowedTools: allowed,
    disallowedTools: disallowed,
    reason: undefined,
  };
}

function modeAxes(mode: string): { filesystem: 0 | 1 | 2; automaticity: 0 | 1 | 2 | 3 } {
  switch (mode) {
    case "approval-required":
      return { filesystem: 0, automaticity: 1 };
    case "auto-accept-edits":
      return { filesystem: 1, automaticity: 1 };
    case "auto":
      return { filesystem: 1, automaticity: 2 };
    case "full-access":
      return { filesystem: 2, automaticity: 3 };
    case "acceptEdits":
      return { filesystem: 1, automaticity: 1 };
    case "bypassPermissions":
      return { filesystem: 2, automaticity: 3 };
    case "plan":
      return { filesystem: 0, automaticity: 0 };
    case "default":
    default:
      return { filesystem: 0, automaticity: 1 };
  }
}

function codexLaunchArgsReason(input: DelegationPermissionEnvelopeInput): string | undefined {
  // Full access is already the top authority, so configuration cannot broaden it.
  if (input.runtimeMode === "full-access") return undefined;
  const tokens = tokenizeLaunchArgs(launchArgs(input));
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? "";
    if (
      token === "--enable" ||
      token === "--disable" ||
      token.startsWith("--enable=") ||
      token.startsWith("--disable=")
    ) {
      return (
        `Codex launch argument ${token} enables or disables a feature, which can change provider ` +
        "tool authority, so it is not comparable and delegation was refused."
      );
    }
    if (token === "-c" || token === "--config") {
      const value = tokens[index + 1];
      if (value === undefined) {
        return (
          `Codex launch argument ${token} is missing its configuration value, so the override ` +
          "cannot be compared and delegation was refused."
        );
      }
      if (SECURITY_TERM.test(value)) {
        return (
          `Codex config override ${value} sets permission, sandbox, tool, network, workspace, or ` +
          "MCP authority, so it is not comparable and delegation was refused."
        );
      }
      index++;
      continue;
    }
    if ((token.startsWith("-c=") || token.startsWith("--config=")) && SECURITY_TERM.test(token)) {
      return (
        `Codex config override ${token} sets permission, sandbox, tool, network, workspace, or ` +
        "MCP authority, so it is not comparable and delegation was refused."
      );
    }
    if (SECURITY_TERM.test(token)) {
      return (
        `Codex security-affecting launch argument ${token} can change permission, sandbox, tool, ` +
        "network, workspace, or MCP authority, so it is not comparable and delegation was refused."
      );
    }
  }
  return undefined;
}

function openCodeConfigReason(input: DelegationPermissionEnvelopeInput): string | undefined {
  const content = (input.environment ?? [])
    .find((variable) => variable.name === "OPENCODE_CONFIG_CONTENT")
    ?.value.trim();
  if (content === undefined || content === "" || content === "{}") return undefined;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return "OpenCode config content is not a JSON object, so delegation was refused.";
    }
    const key = Object.keys(parsed as Readonly<Record<string, unknown>>).find((entry) =>
      SECURITY_TERM.test(entry),
    );
    return key === undefined
      ? undefined
      : `OpenCode config content sets the security-affecting key ${key}, so delegation was refused.`;
  } catch {
    return "OpenCode config content is not valid JSON, so delegation was refused.";
  }
}

function environmentReason(input: DelegationPermissionEnvelopeInput): string | undefined {
  const prefixes = DRIVER_ENV_PREFIXES[input.driverKind] ?? [];
  for (const variable of input.environment ?? []) {
    const name = variable.name.toUpperCase();
    if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
    if (SECURITY_TERM.test(variable.name) && variable.value.trim() !== "") {
      return (
        `Security-affecting provider environment variable ${variable.name} is set, which can ` +
        "change permission, tool, network, workspace, or MCP authority, so it is not comparable " +
        "and delegation was refused."
      );
    }
  }
  return undefined;
}

export function normalizeDelegationPermissionEnvelope(
  input: DelegationPermissionEnvelopeInput,
): DelegationPermissionEnvelope {
  if (input.driverKind === "claudeAgent") {
    const flags = claudeFlags(input);
    if (flags.reason !== undefined) return unverifiable(flags.reason);
    const declared = modeAxes(input.runtimeMode);
    // Claude replaces the runtime policy with the launch-argument mode, so a
    // forced plan narrows while every other forced mode can widen.
    const forcedPlan = flags.mode === "plan";
    const derived = flags.mode === undefined || forcedPlan ? declared : modeAxes(flags.mode);
    const denied = new Set(flags.disallowedTools);
    const planned = input.interactionMode === "plan" || forcedPlan;
    return {
      status: "verified",
      filesystem: (planned ? 0 : Math.max(declared.filesystem, derived.filesystem)) as 0 | 1 | 2,
      automaticity: (planned ? 0 : Math.max(declared.automaticity, derived.automaticity)) as
        | 0
        | 1
        | 2
        | 3,
      allowedTools: flags.allowedTools.filter((tool) => !denied.has(tool)),
    };
  }
  if (input.driverKind === "codex") {
    const reason = codexLaunchArgsReason(input);
    if (reason !== undefined) return unverifiable(reason);
  }
  if (input.driverKind === "opencode") {
    const reason = openCodeConfigReason(input);
    if (reason !== undefined) return unverifiable(reason);
  }
  const reason = environmentReason(input);
  if (reason !== undefined) return unverifiable(reason);
  // OpenCode's `auto` mode has no automatic reviewer, and Antigravity's `auto`
  // leaves approval to the provider; the old envelope capped both.
  const capped =
    (input.driverKind === "opencode" || input.driverKind === "antigravity") &&
    input.runtimeMode === "auto"
      ? "approval-required"
      : input.runtimeMode;
  const axes = modeAxes(capped);
  return {
    status: "verified",
    filesystem: axes.filesystem,
    automaticity: input.interactionMode === "plan" ? 0 : axes.automaticity,
    allowedTools: [],
  };
}

function subset(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  const available = new Set(right);
  return left.every((entry) => available.has(entry));
}

export function delegationPermissionDecision(input: {
  readonly parent: {
    readonly projectId: string;
    readonly envelope: DelegationPermissionEnvelopeInput;
  };
  readonly target: {
    readonly projectId: string;
    readonly envelope: DelegationPermissionEnvelopeInput;
  };
}): DelegationPermissionDecision {
  if (input.parent.projectId !== input.target.projectId) {
    return {
      _tag: "Denied",
      code: "permission_escalation_denied",
      reason:
        "Delegated tasks must stay inside the parent's project; the target project is different.",
    };
  }
  const parent = normalizeDelegationPermissionEnvelope(input.parent.envelope);
  if (parent.status !== "verified") {
    return {
      _tag: "Denied",
      code: "permission_envelope_unverifiable",
      reason: `Parent permission envelope is unverifiable: ${parent.reason}`,
    };
  }
  const target = normalizeDelegationPermissionEnvelope(input.target.envelope);
  if (target.status !== "verified") {
    return {
      _tag: "Denied",
      code: "permission_envelope_unverifiable",
      reason: `Target permission envelope is unverifiable: ${target.reason}`,
    };
  }
  if (
    target.filesystem > parent.filesystem ||
    target.automaticity > parent.automaticity ||
    !subset(target.allowedTools, parent.allowedTools)
  ) {
    return {
      _tag: "Denied",
      code: "permission_escalation_denied",
      reason: "Target automatic authority is broader than the parent permission envelope.",
    };
  }
  return { _tag: "Allowed" };
}

export function delegationPermissionDenial(
  input: DelegationPermissionDenialInput,
): DelegationPermissionDenial | undefined {
  if (input.settings === undefined) return undefined;
  const settings = input.settings;
  const envelope = (
    instanceId: string,
  ): Omit<DelegationPermissionEnvelopeInput, "runtimeMode" | "interactionMode"> => {
    const instance = settings.providerInstances[instanceId];
    return {
      driverKind:
        input.providers.find((candidate) => candidate.instanceId === instanceId)?.driver ??
        instance?.driver ??
        instanceId,
      instanceConfig: instance?.config,
      environment: (instance?.environment ?? []).map(({ name, value }) => ({ name, value })),
    };
  };
  const decision = delegationPermissionDecision({
    parent: {
      projectId: input.parentThread.projectId,
      envelope: {
        ...envelope(input.parentThread.modelSelection.instanceId),
        runtimeMode: input.parentThread.runtimeMode,
        interactionMode: input.parentThread.interactionMode,
      },
    },
    target: {
      projectId: input.parentThread.projectId,
      envelope: {
        ...envelope(input.targetInstanceId),
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
      },
    },
  });
  if (decision._tag === "Allowed") return undefined;
  return {
    code:
      decision.code === "permission_escalation_denied"
        ? "runtime_mode_escalation_denied"
        : "capability_denied",
    reason: decision.reason,
  };
}

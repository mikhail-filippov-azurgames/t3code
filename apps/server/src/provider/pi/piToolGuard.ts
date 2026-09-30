import type { RuntimeMode } from "@t3tools/contracts";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * FT3 pre-execution tool guard for the pinned Pi CLI.
 *
 * The generated extension uses Pi's official `tool_call` hook. Every call
 * is schema-checked before it can execute, filesystem targets are resolved
 * through existing symlinks, and anything the FT3 envelope requires approval
 * goes through Pi RPC's confirmation dialog. Pi has no OS sandbox, so shell
 * commands outside full access always require one-time approval.
 */
export const PI_TOOL_GUARD_DIR = "extensions/ft3-guard";
export const PI_TOOL_GUARD_ENTRY = "extensions/ft3-guard/index.js";
export const PI_TOOL_GUARD_POLICY_FILE = "ft3-policy.json";
export const PI_TOOL_GUARD_POLICY_VERSION = 1;
export const PI_TOOL_GUARD_CONFIRM_TIMEOUT_MS = 55_000;
export const PI_TOOL_GUARD_READY_MESSAGE = "FT3_PI_TOOL_GUARD_READY_V1";
export const PI_TOOL_GUARD_CONFIRM_TITLE_PREFIX = "FT3 tool approval: ";
export const PI_TOOL_GUARD_BLOCKED_NOTIFY_PREFIX = "FT3 guard blocked ";
export const PI_TOOL_GUARD_MAX_APPROVAL_MESSAGE_CHARS = 250_000;

const PI_RUNTIME_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;
const PI_TOOLS = ["read", "write", "edit", "grep", "find", "ls", "bash", "powershell"] as const;

export interface PiToolGuardPolicyInput {
  readonly runtimeMode: RuntimeMode;
  readonly workspaceRoot: string;
}

export interface PiGuardToolCall {
  readonly toolName: (typeof PI_TOOLS)[number];
  readonly toolCallId: string;
  readonly input: Record<string, unknown>;
  readonly reason: string;
}

/** Exact shape validation shared by the host's approval bridge and tests. */
export function validatePiToolCallArguments(toolName: string, input: unknown): string | undefined {
  if (!isRecord(input)) return "tool arguments must be an object";
  const schemas: Record<
    string,
    { readonly required: ReadonlyArray<string>; readonly optional: ReadonlyArray<string> }
  > = {
    read: { required: ["path"], optional: ["offset", "limit"] },
    write: { required: ["path", "content"], optional: [] },
    edit: { required: ["path", "edits"], optional: [] },
    grep: {
      required: ["pattern"],
      optional: ["path", "glob", "ignoreCase", "literal", "context", "limit"],
    },
    find: { required: ["pattern"], optional: ["path", "limit"] },
    ls: { required: [], optional: ["path", "limit"] },
    bash: { required: ["command"], optional: ["timeout"] },
    powershell: { required: ["command"], optional: ["timeout"] },
  };
  const schema = schemas[toolName];
  if (!schema) return "tool is not in FT3's guarded built-in allowlist";
  const allowed = new Set([...schema.required, ...schema.optional]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) return `unexpected argument: ${key}`;
  }
  for (const key of schema.required) {
    if (!(key in input)) return `missing required argument: ${key}`;
  }

  const validPath = (value: unknown): boolean =>
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 32_768 &&
    !value.includes("\0");
  const validLimit = (value: unknown): boolean =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 100_000;
  const validOffset = (value: unknown): boolean =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000;

  if ("path" in input && !validPath(input.path)) return "path must be a non-empty bounded string";
  if ("offset" in input && !validOffset(input.offset))
    return "offset must be a non-negative integer";
  if ("limit" in input && !validLimit(input.limit))
    return "limit must be a positive bounded integer";
  if (
    "content" in input &&
    (typeof input.content !== "string" || input.content.length > 100_000_000)
  ) {
    return "content must be a bounded string";
  }
  if ("edits" in input) {
    if (!Array.isArray(input.edits) || input.edits.length === 0 || input.edits.length > 1_000) {
      return "edits must be a non-empty bounded array";
    }
    for (const edit of input.edits) {
      if (!isRecord(edit) || !hasExactKeys(edit, ["oldText", "newText"])) {
        return "each edit must contain only oldText and newText";
      }
      if (
        typeof edit.oldText !== "string" ||
        typeof edit.newText !== "string" ||
        edit.oldText.length > 1_000_000 ||
        edit.newText.length > 1_000_000
      ) {
        return "edit text must be bounded strings";
      }
    }
  }
  if (
    "pattern" in input &&
    (typeof input.pattern !== "string" ||
      input.pattern.length === 0 ||
      input.pattern.length > 10_000)
  ) {
    return "pattern must be a non-empty bounded string";
  }
  if (
    "glob" in input &&
    (typeof input.glob !== "string" || input.glob.length === 0 || input.glob.length > 2_000)
  ) {
    return "glob must be a non-empty bounded string";
  }
  for (const key of ["ignoreCase", "literal"] as const) {
    if (key in input && typeof input[key] !== "boolean") return `${key} must be boolean`;
  }
  if ("context" in input && !validOffset(input.context))
    return "context must be a non-negative integer";
  if ("command" in input) {
    if (
      typeof input.command !== "string" ||
      input.command.trim().length === 0 ||
      input.command.length > 32_768 ||
      input.command.includes("\0")
    ) {
      return "command must be a non-empty bounded string";
    }
  }
  if ("timeout" in input) {
    if (
      typeof input.timeout !== "number" ||
      !Number.isSafeInteger(input.timeout) ||
      input.timeout < 1 ||
      input.timeout > 3_600_000
    ) {
      return "timeout must be between 1ms and 1 hour";
    }
  }
  return undefined;
}

/** Versioned policy consumed by the Pi child extension. */
export function buildPiToolGuardPolicy(input: PiToolGuardPolicyInput): string {
  return `${JSON.stringify(
    {
      version: PI_TOOL_GUARD_POLICY_VERSION,
      runtimeMode: input.runtimeMode,
      workspaceRoot: input.workspaceRoot,
    },
    null,
    2,
  )}\n`;
}

/**
 * Exact CJS extension passed to Pi with `--no-extensions --extension <path>`.
 * Tests load this source itself so the checked code is the code Pi executes.
 */
export const PI_TOOL_GUARD_EXTENSION_SOURCE = `"use strict";
const fs = require("node:fs");
const path = require("node:path");

const POLICY_FILE = path.join(__dirname, "..", "..", ${JSON.stringify(PI_TOOL_GUARD_POLICY_FILE)});
const CONFIRM_TIMEOUT_MS = ${PI_TOOL_GUARD_CONFIRM_TIMEOUT_MS};
const MAX_APPROVAL_MESSAGE_CHARS = ${PI_TOOL_GUARD_MAX_APPROVAL_MESSAGE_CHARS};
const READY_MESSAGE = ${JSON.stringify(PI_TOOL_GUARD_READY_MESSAGE)};
const CONFIRM_TITLE_PREFIX = ${JSON.stringify(PI_TOOL_GUARD_CONFIRM_TITLE_PREFIX)};
const BLOCKED_NOTIFY_PREFIX = ${JSON.stringify(PI_TOOL_GUARD_BLOCKED_NOTIFY_PREFIX)};
const RUNTIME_MODES = new Set(${JSON.stringify(PI_RUNTIME_MODES)});
const TOOLS = new Set(${JSON.stringify(PI_TOOLS)});
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["edit", "write"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function validateInput(name, input) {
  if (!isRecord(input)) return "tool arguments must be an object";
  const schemas = {
    read: { required: ["path"], optional: ["offset", "limit"] },
    write: { required: ["path", "content"], optional: [] },
    edit: { required: ["path", "edits"], optional: [] },
    grep: { required: ["pattern"], optional: ["path", "glob", "ignoreCase", "literal", "context", "limit"] },
    find: { required: ["pattern"], optional: ["path", "limit"] },
    ls: { required: [], optional: ["path", "limit"] },
    bash: { required: ["command"], optional: ["timeout"] },
    powershell: { required: ["command"], optional: ["timeout"] },
  };
  const schema = schemas[name];
  if (!schema || !TOOLS.has(name)) return "tool is not in FT3's guarded built-in allowlist";
  const allowed = new Set([...schema.required, ...schema.optional]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) return "unexpected argument: " + key;
  }
  for (const key of schema.required) {
    if (!(key in input)) return "missing required argument: " + key;
  }
  const validPath = (value) => typeof value === "string" && value.trim().length > 0 &&
    value.length <= 32768 && !value.includes("\\0");
  const validLimit = (value) => Number.isSafeInteger(value) && value >= 1 && value <= 100000;
  const validOffset = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 100000000;
  if ("path" in input && !validPath(input.path)) return "path must be a non-empty bounded string";
  if ("offset" in input && !validOffset(input.offset)) return "offset must be a non-negative integer";
  if ("limit" in input && !validLimit(input.limit)) return "limit must be a positive bounded integer";
  if ("content" in input && (typeof input.content !== "string" || input.content.length > 100000000)) {
    return "content must be a bounded string";
  }
  if ("edits" in input) {
    if (!Array.isArray(input.edits) || input.edits.length === 0 || input.edits.length > 1000) {
      return "edits must be a non-empty bounded array";
    }
    for (const edit of input.edits) {
      if (!isRecord(edit) || !hasExactKeys(edit, ["oldText", "newText"])) {
        return "each edit must contain only oldText and newText";
      }
      if (typeof edit.oldText !== "string" || typeof edit.newText !== "string" ||
          edit.oldText.length > 1000000 || edit.newText.length > 1000000) {
        return "edit text must be bounded strings";
      }
    }
  }
  if ("pattern" in input && (typeof input.pattern !== "string" || input.pattern.length === 0 || input.pattern.length > 10000)) {
    return "pattern must be a non-empty bounded string";
  }
  if ("glob" in input && (typeof input.glob !== "string" || input.glob.length === 0 || input.glob.length > 2000)) {
    return "glob must be a non-empty bounded string";
  }
  for (const key of ["ignoreCase", "literal"]) {
    if (key in input && typeof input[key] !== "boolean") return key + " must be boolean";
  }
  if ("context" in input && !validOffset(input.context)) return "context must be a non-negative integer";
  if ("command" in input && (typeof input.command !== "string" || input.command.trim().length === 0 ||
      input.command.length > 32768 || input.command.includes("\\0"))) {
    return "command must be a non-empty bounded string";
  }
  if ("timeout" in input && (!Number.isSafeInteger(input.timeout) || input.timeout < 1 ||
      input.timeout > 3600000)) return "timeout must be between 1ms and 1 hour";
  return undefined;
}

function loadPolicy() {
  try {
    const value = JSON.parse(fs.readFileSync(POLICY_FILE, "utf8"));
    if (!isRecord(value) || value.version !== 1 || !RUNTIME_MODES.has(value.runtimeMode) ||
        typeof value.workspaceRoot !== "string" || value.workspaceRoot.trim().length === 0) {
      return null;
    }
    const workspaceRoot = fs.realpathSync.native(value.workspaceRoot);
    if (!fs.statSync(workspaceRoot).isDirectory()) return null;
    return { runtimeMode: value.runtimeMode, workspaceRoot };
  } catch {
    return null;
  }
}

function canonicalTarget(root, rawPath) {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0 || rawPath.includes("\\0")) {
    return undefined;
  }
  let current = path.resolve(root, rawPath);
  const suffix = [];
  while (true) {
    try {
      fs.lstatSync(current);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        const parent = path.dirname(current);
        if (parent === current) return undefined;
        suffix.unshift(path.basename(current));
        current = parent;
        continue;
      }
      return undefined;
    }
    try {
      // realpath resolves existing symlink ancestors; lstat above also makes
      // dangling symlinks fail closed instead of treating them as new files.
      return path.resolve(fs.realpathSync.native(current), ...suffix);
    } catch {
      return undefined;
    }
  }
}

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative));
}

function safeGlob(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2000) return false;
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  return !value.split(/[\\\\/]+/).some((part) => part === "..");
}

function decide(policy, toolName, input) {
  const validationError = validateInput(toolName, input);
  if (validationError) return { action: "block", reason: validationError };
  const mode = policy.runtimeMode;
  if (!RUNTIME_MODES.has(mode)) return { action: "block", reason: "unknown FT3 runtime mode" };
  if (mode === "full-access") return { action: "allow" };
  if (toolName === "find" && !safeGlob(input.pattern)) {
    return { action: "block", reason: "find pattern may not escape its checked search root" };
  }
  if (toolName === "grep" && input.glob !== undefined && !safeGlob(input.glob)) {
    return { action: "block", reason: "grep glob may not escape its checked search root" };
  }
  if (SHELL_TOOLS.has(toolName)) {
    return { action: "confirm", reason: "shell command: " + input.command };
  }
  if (!READ_TOOLS.has(toolName) && !WRITE_TOOLS.has(toolName)) {
    return { action: "block", reason: "tool is not in FT3's guarded built-in allowlist" };
  }
  const rawPath = input.path === undefined ? "." : input.path;
  const target = canonicalTarget(policy.workspaceRoot, rawPath);
  if (!target) return { action: "block", reason: "path cannot be resolved safely" };
  const insideWorkspace = isWithinRoot(policy.workspaceRoot, target);
  if (WRITE_TOOLS.has(toolName)) {
    if (mode === "approval-required") {
      return { action: "block", reason: "the approval-required filesystem envelope is read-only" };
    }
    if (!insideWorkspace) {
      return { action: "confirm", reason: "write outside the workspace: " + rawPath };
    }
    return { action: "allow" };
  }
  if (!insideWorkspace) return { action: "confirm", reason: "read outside the workspace: " + rawPath };
  return { action: "allow" };
}

function notifyBlocked(ctx, toolName, toolCallId, reason) {
  try {
    if (ctx && ctx.ui && typeof ctx.ui.notify === "function") {
      ctx.ui.notify(BLOCKED_NOTIFY_PREFIX + toolName + " " + toolCallId + ": " + reason, "warning");
    }
  } catch {
    // The tool_call return below is the enforcement path.
  }
}

async function handleToolCall(event, ctx, policy) {
  const toolName = typeof event?.toolName === "string" ? event.toolName : "unknown-tool";
  const toolCallId = typeof event?.toolCallId === "string" ? event.toolCallId : "";
  const input = event?.input;
  if (!policy) {
    const reason = "FT3 guard policy is missing or unreadable — refusing closed";
    notifyBlocked(ctx, toolName, toolCallId || "unknown-id", reason);
    return { block: true, reason };
  }
  if (toolCallId.length === 0 || toolCallId.length > 256 || /\\s/.test(toolCallId)) {
    const reason = "tool call id is malformed — refusing closed";
    notifyBlocked(ctx, toolName, "unknown-id", reason);
    return { block: true, reason };
  }
  const validationError = validateInput(toolName, input);
  if (validationError) {
    notifyBlocked(ctx, toolName, toolCallId, validationError);
    return { block: true, reason: validationError };
  }
  const verdict = decide(policy, toolName, input);
  if (verdict.action === "allow") return undefined;
  if (verdict.action === "block") {
    notifyBlocked(ctx, toolName, toolCallId, verdict.reason);
    return { block: true, reason: verdict.reason };
  }
  if (!ctx?.ui || typeof ctx.ui.confirm !== "function") {
    const reason = "FT3 approval UI is unavailable — refusing closed (" + verdict.reason + ")";
    notifyBlocked(ctx, toolName, toolCallId, reason);
    return { block: true, reason };
  }
  let message;
  try {
    message = JSON.stringify({
      protocol: 1,
      toolName,
      toolCallId,
      reason: verdict.reason,
      input,
    });
  } catch {
    message = "";
  }
  if (!message || message.length > MAX_APPROVAL_MESSAGE_CHARS) {
    const reason = "tool arguments are too large for FT3 approval review — refusing closed";
    notifyBlocked(ctx, toolName, toolCallId, reason);
    return { block: true, reason };
  }
  let confirmed = false;
  try {
    confirmed = await ctx.ui.confirm(
      CONFIRM_TITLE_PREFIX + toolName + " " + toolCallId,
      message,
      { timeout: CONFIRM_TIMEOUT_MS },
    );
  } catch {
    confirmed = false;
  }
  if (confirmed === true) return undefined;
  const reason = "Denied by FT3 approval: " + verdict.reason;
  notifyBlocked(ctx, toolName, toolCallId, reason);
  return { block: true, reason };
}

module.exports = function ft3ToolGuard(pi) {
  const policy = loadPolicy();
  if (!policy) throw new Error("FT3 Pi guard policy is missing or invalid");
  pi.on("session_start", (_event, ctx) => {
    try {
      ctx.ui.notify(READY_MESSAGE, "info");
    } catch {
      // Startup handshake times out on the host if RPC UI is unavailable.
    }
  });
  pi.on("tool_call", (event, ctx) => handleToolCall(event, ctx, policy));
};
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

/** Parse and validate the structured RPC request emitted by the guard. */
export function parsePiGuardConfirmRecord(record: {
  readonly title?: unknown;
  readonly message?: unknown;
}): PiGuardToolCall | undefined {
  if (typeof record.title !== "string" || typeof record.message !== "string") return undefined;
  if (record.message.length > PI_TOOL_GUARD_MAX_APPROVAL_MESSAGE_CHARS) return undefined;
  if (!record.title.startsWith(PI_TOOL_GUARD_CONFIRM_TITLE_PREFIX)) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(record.message) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isRecord(body) ||
    !hasExactKeys(body, ["protocol", "toolName", "toolCallId", "reason", "input"])
  ) {
    return undefined;
  }
  if (
    body.protocol !== 1 ||
    typeof body.toolName !== "string" ||
    !(PI_TOOLS as ReadonlyArray<string>).includes(body.toolName) ||
    typeof body.toolCallId !== "string" ||
    body.toolCallId.length === 0 ||
    body.toolCallId.length > 256 ||
    /\s/.test(body.toolCallId) ||
    typeof body.reason !== "string" ||
    body.reason.length > 2_000 ||
    !isRecord(body.input)
  ) {
    return undefined;
  }
  const expectedTitle = `${PI_TOOL_GUARD_CONFIRM_TITLE_PREFIX}${body.toolName} ${body.toolCallId}`;
  if (record.title !== expectedTitle || validatePiToolCallArguments(body.toolName, body.input)) {
    return undefined;
  }
  return {
    toolName: body.toolName as PiGuardToolCall["toolName"],
    toolCallId: body.toolCallId,
    input: body.input,
    reason: body.reason,
  };
}

/** Attribute a guard's fire-and-forget block notification. */
export function parsePiGuardBlockedNotify(
  message: unknown,
): { readonly toolName: string; readonly toolCallId: string; readonly reason: string } | undefined {
  if (typeof message !== "string" || !message.startsWith(PI_TOOL_GUARD_BLOCKED_NOTIFY_PREFIX)) {
    return undefined;
  }
  const parsed = /^(\S+) (\S+): ([\s\S]*)$/.exec(
    message.slice(PI_TOOL_GUARD_BLOCKED_NOTIFY_PREFIX.length),
  );
  if (!parsed?.[1] || !parsed[2]) return undefined;
  return { toolName: parsed[1], toolCallId: parsed[2], reason: (parsed[3] ?? "").slice(0, 500) };
}

/** Write policy and exact extension into the FT3-owned Pi agent directory. */
export const ensurePiToolGuardFiles = (
  agentDir: string,
  input: PiToolGuardPolicyInput,
): Effect.Effect<void, Error, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(path.join(agentDir, PI_TOOL_GUARD_DIR), { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(agentDir, PI_TOOL_GUARD_ENTRY),
      PI_TOOL_GUARD_EXTENSION_SOURCE,
    );
    yield* fileSystem.writeFileString(
      path.join(agentDir, PI_TOOL_GUARD_POLICY_FILE),
      buildPiToolGuardPolicy(input),
    );
  });

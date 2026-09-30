// @effect-diagnostics nodeBuiltinImport:off - This test loads the generated Node extension in a VM and cleans real temporary files.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";

import { describe, it } from "vite-plus/test";

import {
  buildPiToolGuardPolicy,
  parsePiGuardBlockedNotify,
  parsePiGuardConfirmRecord,
  PI_TOOL_GUARD_CONFIRM_TIMEOUT_MS,
  PI_TOOL_GUARD_CONFIRM_TITLE_PREFIX,
  PI_TOOL_GUARD_EXTENSION_SOURCE,
  PI_TOOL_GUARD_READY_MESSAGE,
  validatePiToolCallArguments,
} from "./piToolGuard.ts";

const requireFromTest = NodeModule.createRequire(import.meta.url);

interface CapturedConfirm {
  readonly title: string;
  readonly message: string;
  readonly options: unknown;
}

interface FakeUi {
  confirmAnswer: boolean;
  confirms: Array<CapturedConfirm>;
  notifies: Array<{ readonly message: string; readonly type: string }>;
}

interface FakePi {
  handlers: Map<string, (event: unknown, ctx: unknown) => Promise<unknown> | void>;
  on(event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown> | void): void;
}

function makeUi(answer: boolean): FakeUi {
  return { confirmAnswer: answer, confirms: [], notifies: [] };
}

function uiContext(ui: FakeUi): unknown {
  return {
    ui: {
      confirm: async (title: string, message: string, options: unknown) => {
        ui.confirms.push({ title, message, options });
        return ui.confirmAnswer;
      },
      notify: (message: string, type: string) => {
        ui.notifies.push({ message, type });
      },
    },
  };
}

/** Load the exact shipped extension with a real temporary workspace. */
function loadGuard(runtimeMode: string): {
  handler: (event: unknown, ctx: unknown) => Promise<unknown>;
  sessionStart: (event: unknown, ctx: unknown) => void;
  dir: string;
  workspaceRoot: string;
} {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-guard-test-"));
  const workspaceRoot = NodePath.join(dir, "workspace");
  try {
    const guardDir = NodePath.join(dir, "extensions", "ft3-guard");
    NodeFS.mkdirSync(guardDir, { recursive: true });
    NodeFS.mkdirSync(NodePath.join(workspaceRoot, "src"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(dir, "ft3-policy.json"),
      JSON.stringify({ version: 1, runtimeMode, workspaceRoot }),
    );
    NodeFS.writeFileSync(NodePath.join(guardDir, "index.js"), PI_TOOL_GUARD_EXTENSION_SOURCE);
    const factory = requireFromTest(NodePath.join(guardDir, "index.js")) as (pi: FakePi) => void;
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown> | void>();
    factory({ handlers, on: (event, handler) => void handlers.set(event, handler) });
    const handler = handlers.get("tool_call");
    const sessionStart = handlers.get("session_start");
    NodeAssert.ok(handler, "guard must register its pre-execution tool_call hook");
    NodeAssert.ok(sessionStart, "guard must register its startup handshake hook");
    return {
      handler: handler as (event: unknown, ctx: unknown) => Promise<unknown>,
      sessionStart: sessionStart as (event: unknown, ctx: unknown) => void,
      dir,
      workspaceRoot,
    };
  } catch (error) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function blocked(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && (value as { block?: unknown }).block === true
  );
}

describe("pi tool guard", () => {
  it("builds a versioned policy file", () => {
    const parsed = JSON.parse(
      buildPiToolGuardPolicy({ runtimeMode: "approval-required", workspaceRoot: "C:\\work" }),
    ) as { version: number; runtimeMode: string; workspaceRoot: string };
    NodeAssert.equal(parsed.version, 1);
    NodeAssert.equal(parsed.runtimeMode, "approval-required");
    NodeAssert.equal(parsed.workspaceRoot, "C:\\work");
  });

  it("signals startup readiness through Pi RPC notify", () => {
    const { sessionStart, dir } = loadGuard("auto");
    try {
      const ui = makeUi(false);
      sessionStart({}, uiContext(ui));
      NodeAssert.deepEqual(ui.notifies, [{ message: PI_TOOL_GUARD_READY_MESSAGE, type: "info" }]);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows schema-valid workspace reads and edits in auto-accept-edits", async () => {
    const { handler, dir, workspaceRoot } = loadGuard("auto-accept-edits");
    try {
      const ui = makeUi(false);
      NodeAssert.equal(
        await handler(
          {
            toolName: "read",
            toolCallId: "c1",
            input: { path: NodePath.join(workspaceRoot, "src/a.ts") },
          },
          uiContext(ui),
        ),
        undefined,
      );
      NodeAssert.equal(
        await handler(
          {
            toolName: "edit",
            toolCallId: "c2",
            input: {
              path: NodePath.join(workspaceRoot, "src/a.ts"),
              edits: [{ oldText: "before", newText: "after" }],
            },
          },
          uiContext(ui),
        ),
        undefined,
      );
      NodeAssert.deepEqual(ui.confirms, []);
      NodeAssert.deepEqual(ui.notifies, []);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("asks once before every shell command outside full-access", async () => {
    const { handler, dir } = loadGuard("auto");
    try {
      const denied = makeUi(false);
      const result = await handler(
        { toolName: "bash", toolCallId: "c3", input: { command: "cat ../../secret.txt" } },
        uiContext(denied),
      );
      NodeAssert.equal(denied.confirms.length, 1);
      NodeAssert.ok(
        denied.confirms[0]?.title.startsWith(PI_TOOL_GUARD_CONFIRM_TITLE_PREFIX + "bash "),
      );
      NodeAssert.equal(
        (JSON.parse(denied.confirms[0]?.message ?? "{}") as { input?: { command?: string } }).input
          ?.command,
        "cat ../../secret.txt",
      );
      NodeAssert.equal(
        (denied.confirms[0]?.options as { timeout?: number } | undefined)?.timeout,
        PI_TOOL_GUARD_CONFIRM_TIMEOUT_MS,
      );
      NodeAssert.ok(blocked(result));

      const allowed = makeUi(true);
      NodeAssert.equal(
        await handler(
          { toolName: "powershell", toolCallId: "c4", input: { command: "Get-Location" } },
          uiContext(allowed),
        ),
        undefined,
      );
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves symlinks before allowing workspace writes", async () => {
    const { handler, dir, workspaceRoot } = loadGuard("auto-accept-edits");
    try {
      const outside = NodePath.join(dir, "outside");
      const link = NodePath.join(workspaceRoot, "escape");
      NodeFS.mkdirSync(outside);
      try {
        NodeFS.symlinkSync(outside, link, "junction");
      } catch {
        try {
          NodeFS.symlinkSync(outside, link, "dir");
        } catch {
          // Some Windows configurations disable symlink creation.
        }
      }
      const ui = makeUi(true);
      const result = await handler(
        {
          toolName: "write",
          toolCallId: "c5",
          input: { path: NodePath.join(link, "created.txt"), content: "x" },
        },
        uiContext(ui),
      );
      if (NodeFS.existsSync(link)) {
        NodeAssert.equal(ui.confirms.length, 1);
        NodeAssert.match(ui.confirms[0]?.message ?? "", /write outside the workspace/);
        NodeAssert.equal(result, undefined);
      } else {
        const traversal = await handler(
          { toolName: "write", toolCallId: "c5b", input: { path: "../outside.txt", content: "x" } },
          uiContext(ui),
        );
        NodeAssert.equal(ui.confirms.length, 2);
        NodeAssert.equal(result, undefined);
        NodeAssert.equal(traversal, undefined);
      }
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps approval-required read-only and asks for external reads", async () => {
    const { handler, dir, workspaceRoot } = loadGuard("approval-required");
    try {
      const ui = makeUi(true);
      NodeAssert.equal(
        await handler(
          {
            toolName: "read",
            toolCallId: "c6",
            input: { path: NodePath.join(workspaceRoot, "src/a.ts") },
          },
          uiContext(ui),
        ),
        undefined,
      );
      NodeAssert.deepEqual(ui.confirms, []);
      const write = await handler(
        {
          toolName: "write",
          toolCallId: "c7",
          input: { path: NodePath.join(workspaceRoot, "src/a.ts"), content: "x" },
        },
        uiContext(ui),
      );
      NodeAssert.ok(blocked(write));
      NodeAssert.deepEqual(ui.confirms, []);

      const outside = makeUi(true);
      const externalRead = await handler(
        { toolName: "read", toolCallId: "c8", input: { path: NodePath.join(dir, "outside.txt") } },
        uiContext(outside),
      );
      NodeAssert.equal(outside.confirms.length, 1);
      NodeAssert.equal(externalRead, undefined);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows valid built-ins in full-access but still blocks unknown tools", async () => {
    const { handler, dir } = loadGuard("full-access");
    try {
      const ui = makeUi(false);
      NodeAssert.equal(
        await handler(
          { toolName: "bash", toolCallId: "c9", input: { command: "rm -rf /" } },
          uiContext(ui),
        ),
        undefined,
      );
      NodeAssert.ok(
        blocked(
          await handler(
            { toolName: "custom_tool", toolCallId: "c10", input: { anything: 1 } },
            uiContext(ui),
          ),
        ),
      );
      NodeAssert.deepEqual(ui.confirms, []);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed for malformed arguments and unknown modes", async () => {
    const { handler, dir } = loadGuard("auto");
    try {
      const ui = makeUi(true);
      const invalid: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
        ["read", { path: "file", extra: true }],
        ["write", { path: "file" }],
        ["edit", { path: "file", edits: [{ oldText: "x", newText: "y", extra: true }] }],
        ["bash", { command: " ", timeout: 10 }],
        ["find", { pattern: "../**/*" }],
      ];
      for (const [toolName, input] of invalid) {
        NodeAssert.ok(
          blocked(await handler({ toolName, toolCallId: "bad-" + toolName, input }, uiContext(ui))),
          toolName + " must be blocked",
        );
      }
      NodeAssert.deepEqual(ui.confirms, []);
      NodeAssert.throws(
        () => loadGuard("future-mode"),
        /FT3 Pi guard policy is missing or invalid/,
      );
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when approval UI is missing, throws, or declines", async () => {
    const { handler, dir } = loadGuard("auto");
    try {
      NodeAssert.ok(
        blocked(
          await handler({ toolName: "bash", toolCallId: "c11", input: { command: "ls" } }, {}),
        ),
      );
      const throwing = await handler(
        { toolName: "bash", toolCallId: "c12", input: { command: "ls" } },
        {
          ui: {
            confirm: async () => {
              throw new Error("gone");
            },
            notify: () => {},
          },
        },
      );
      NodeAssert.ok(blocked(throwing));
      NodeAssert.ok(
        blocked(
          await handler(
            { toolName: "bash", toolCallId: "c13", input: { command: "ls" } },
            uiContext(makeUi(false)),
          ),
        ),
      );
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Pi guard argument and approval bridge", () => {
  it("rejects extra or malformed arguments before producing an approval prompt", () => {
    NodeAssert.equal(
      validatePiToolCallArguments("read", { path: "src/a", extra: true }) !== undefined,
      true,
    );
    NodeAssert.equal(validatePiToolCallArguments("write", { path: "src/a" }) !== undefined, true);
    NodeAssert.equal(
      validatePiToolCallArguments("bash", {
        command: "echo hi",
        timeout: Number.POSITIVE_INFINITY,
      }) !== undefined,
      true,
    );
    NodeAssert.equal(validatePiToolCallArguments("custom_tool", {}) !== undefined, true);
  });

  it("parses structured guard confirmations and rejects altered or truncated records", () => {
    const message = JSON.stringify({
      protocol: 1,
      toolName: "bash",
      toolCallId: "call-123",
      reason: "shell command: pwd",
      input: { command: "pwd" },
    });
    NodeAssert.deepEqual(
      parsePiGuardConfirmRecord({ title: "FT3 tool approval: bash call-123", message }),
      {
        toolName: "bash",
        toolCallId: "call-123",
        reason: "shell command: pwd",
        input: { command: "pwd" },
      },
    );
    NodeAssert.equal(
      parsePiGuardConfirmRecord({
        title: "FT3 tool approval: bash call-123",
        message: "truncated",
      }),
      undefined,
    );
    NodeAssert.equal(
      parsePiGuardConfirmRecord({ title: "FT3 tool approval: write call-123", message }),
      undefined,
    );
  });

  it("attributes blocked calls and ignores unrelated notifications", () => {
    NodeAssert.deepEqual(
      parsePiGuardBlockedNotify(
        "FT3 guard blocked write call-9: write outside the workspace is refused",
      ),
      {
        toolName: "write",
        toolCallId: "call-9",
        reason: "write outside the workspace is refused",
      },
    );
    NodeAssert.equal(parsePiGuardBlockedNotify("Command blocked by user"), undefined);
    NodeAssert.equal(parsePiGuardBlockedNotify(undefined), undefined);
  });
});

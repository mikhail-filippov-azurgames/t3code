import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  buildPiLaunchEnvironment,
  isPiBlockedLaunchEnvironmentKey,
  isPiExtensionUiDialog,
  isPiToolAllowedWithoutApproval,
  piExtensionUiDeclinedResponse,
  resolvePiLaunchProfile,
  resolvePiToolsForRuntimeMode,
} from "./piPermissionBridge.ts";

describe("Pi launch environment", () => {
  it("fails closed for Node hooks, proxies, and OS loader injection variables", () => {
    for (const name of [
      "NODE_OPTIONS",
      "node_path",
      "HTTPS_PROXY",
      "http_proxy",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "DYLD_INSERT_LIBRARIES",
      "DYLD_FRAMEWORK_PATH",
    ]) {
      NodeAssert.equal(isPiBlockedLaunchEnvironmentKey(name), true, name);
      const result = buildPiLaunchEnvironment(resolvePiLaunchProfile("full-access"), {
        [name]: "injected-value",
      });
      NodeAssert.equal(result.ok, false);
      if (!result.ok) {
        NodeAssert.match(result.reason, new RegExp(`unsafe environment variable ${name}`, "i"));
      }
    }
  });

  it("passes only verified values and overrides the ambient managed agent directory", () => {
    const result = buildPiLaunchEnvironment(
      resolvePiLaunchProfile("full-access"),
      {
        PATH: "/usr/bin",
        LD_PRELOAD: "",
        NODE_OPTIONS: "",
        PI_CODING_AGENT_DIR: "/ambient/pi",
      },
      "/managed/pi",
    );

    NodeAssert.equal(result.ok, true);
    if (!result.ok) return;
    NodeAssert.deepEqual(result.environment, {
      PATH: "/usr/bin",
      PI_CODING_AGENT_DIR: "/managed/pi",
    });
  });
});

describe("resolvePiToolsForRuntimeMode", () => {
  it("keeps approval-required read-only (no shell, no writes)", () => {
    NodeAssert.deepEqual(resolvePiToolsForRuntimeMode("approval-required"), [
      "read",
      "grep",
      "find",
      "ls",
    ]);
  });

  it("enables writes without shell for auto modes", () => {
    for (const mode of ["auto-accept-edits", "auto"] as const) {
      const tools = resolvePiToolsForRuntimeMode(mode);
      NodeAssert.ok(tools.includes("edit") && tools.includes("write"));
      NodeAssert.ok(!tools.includes("bash") && !tools.includes("powershell"));
    }
  });

  it("enables everything only for full-access", () => {
    NodeAssert.deepEqual([...resolvePiToolsForRuntimeMode("full-access")].sort(), [
      "bash",
      "edit",
      "find",
      "grep",
      "ls",
      "powershell",
      "read",
      "write",
    ]);
  });
});

describe("isPiToolAllowedWithoutApproval", () => {
  it("denies shell outside full-access and unknown tools everywhere", () => {
    NodeAssert.equal(isPiToolAllowedWithoutApproval("bash", "auto"), false);
    NodeAssert.equal(isPiToolAllowedWithoutApproval("powershell", "auto-accept-edits"), false);
    NodeAssert.equal(isPiToolAllowedWithoutApproval("custom_tool", "full-access"), false);
    NodeAssert.equal(isPiToolAllowedWithoutApproval("bash", "full-access"), true);
  });

  it("denies writes when approval is required", () => {
    NodeAssert.equal(isPiToolAllowedWithoutApproval("edit", "approval-required"), false);
    NodeAssert.equal(isPiToolAllowedWithoutApproval("write", "approval-required"), false);
    NodeAssert.equal(isPiToolAllowedWithoutApproval("read", "approval-required"), true);
  });
});

describe("pi extension UI bridge", () => {
  it("classifies only select/confirm/input/editor as dialogs", () => {
    for (const method of ["select", "confirm", "input", "editor"]) {
      NodeAssert.equal(isPiExtensionUiDialog(method), true);
    }
    for (const method of ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]) {
      NodeAssert.equal(isPiExtensionUiDialog(method), false);
    }
  });

  it("fails closed on every dialog decline shape", () => {
    NodeAssert.deepEqual(piExtensionUiDeclinedResponse("select"), { cancelled: true });
    NodeAssert.deepEqual(piExtensionUiDeclinedResponse("confirm"), {
      confirmed: false,
      cancelled: true,
    });
    NodeAssert.deepEqual(piExtensionUiDeclinedResponse("input"), { value: "", cancelled: true });
  });
});

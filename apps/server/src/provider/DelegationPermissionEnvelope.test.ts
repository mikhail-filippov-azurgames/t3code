import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  compareDelegationPermissionEnvelopes,
  DELEGATION_MCP_CAPABILITY_UNIVERSE,
  delegationMcpCapabilitySubsets,
  loadDelegationPermissionEnvelope,
  normalizeDelegationPermissionEnvelope,
  recoverDelegationChildCaps,
  sanitizeDelegationChildCapsSnapshot,
  type DelegationPermissionEnvelopeInput,
} from "./DelegationPermissionEnvelope.ts";

const driver = (value: string) => ProviderDriverKind.make(value);
const instanceId = ProviderInstanceId.make("provider_one");

function input(
  driverKind: string,
  runtimeMode: DelegationPermissionEnvelopeInput["runtimeMode"] = "approval-required",
  config: ProviderInstanceConfig["config"] = {},
  environment: Readonly<Record<string, string | undefined>> = {},
): DelegationPermissionEnvelopeInput {
  return {
    driverKind: driver(driverKind),
    runtimeMode,
    interactionMode: "default",
    instanceConfig: { driver: driver(driverKind), enabled: true, config },
    environment,
    workspaceRoot: "C:/repo",
    worktreePath: "C:/repo",
    branch: "main",
    t3McpCapabilities: new Set(["orchestration", "pull-requests"]),
    providerConfigurationFiles: [],
  };
}

describe("normalizeDelegationPermissionEnvelope", () => {
  it("normalizes the explicit Codex runtime mapping", () => {
    const supervised = normalizeDelegationPermissionEnvelope(input("codex"));
    const full = normalizeDelegationPermissionEnvelope(input("codex", "full-access"));

    expect(supervised).toMatchObject({
      status: "verified",
      filesystem: "read-only",
      commandExecution: "approval-required",
      approvalBypass: false,
    });
    expect(full).toMatchObject({
      status: "verified",
      filesystem: "unrestricted",
      commandExecution: "unrestricted",
      approvalBypass: true,
    });
  });

  it("fails closed for Codex security and MCP launch overrides", () => {
    for (const launchArgs of [
      "-c sandbox_mode=danger-full-access",
      "--config=mcp_servers.remote.url=https://example.com",
      "--enable web_search",
    ]) {
      expect(
        normalizeDelegationPermissionEnvelope(input("codex", "approval-required", { launchArgs })),
      ).toMatchObject({ status: "unverifiable" });
    }
  });

  it("accepts fingerprinted Codex security configuration at full access", () => {
    const envelope = normalizeDelegationPermissionEnvelope({
      ...input("codex", "full-access", {
        launchArgs: "-c sandbox_mode=danger-full-access",
      }),
      environment: { CODEX_SECURITY_PROFILE: "custom" },
      providerConfigurationFiles: [
        {
          path: "C:/codex/config.toml",
          content: '[mcp_servers.remote]\nurl = "https://example.com"\n',
        },
      ],
    });

    expect(envelope).toMatchObject({
      status: "verified",
      filesystem: "unrestricted",
      commandExecution: "unrestricted",
      network: "unrestricted",
      approvalBypass: true,
    });
  });

  it("uses the effective Codex launch-args environment override", () => {
    const envelope = normalizeDelegationPermissionEnvelope(
      input(
        "codex",
        "approval-required",
        { launchArgs: "" },
        {
          T3CODE_CODEX_LAUNCH_ARGS: "-c sandbox_mode=danger-full-access",
        },
      ),
    );
    expect(envelope).toMatchObject({ status: "unverifiable" });
  });

  it("reflects Claude bypass and allowed/disallowed tool overrides", () => {
    const bypass = normalizeDelegationPermissionEnvelope(
      input("claudeAgent", "approval-required", {
        launchArgs:
          "--permission-mode bypassPermissions --allowedTools Bash,Read --disallowedTools Read",
      }),
    );
    expect(bypass).toMatchObject({
      status: "verified",
      filesystem: "unrestricted",
      approvalBypass: true,
      externalTools: ["Bash"],
    });
  });

  it("fails closed for unknown Claude security-affecting arguments", () => {
    expect(
      normalizeDelegationPermissionEnvelope(
        input("claudeAgent", "approval-required", { launchArgs: "--mcp-config ./mcp.json" }),
      ),
    ).toMatchObject({ status: "unverifiable" });
  });

  it("normalizes OpenCode auto as supervised and rejects configured permission content", () => {
    expect(normalizeDelegationPermissionEnvelope(input("opencode", "auto"))).toMatchObject({
      status: "verified",
      filesystem: "read-only",
      commandExecution: "approval-required",
    });
    expect(
      normalizeDelegationPermissionEnvelope(
        input(
          "opencode",
          "approval-required",
          {},
          {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { bash: "allow" } }),
          },
        ),
      ),
    ).toMatchObject({ status: "unverifiable" });
  });

  it("normalizes the Muse mapping onto the posture-selected host", () => {
    expect(normalizeDelegationPermissionEnvelope(input("museCode", "full-access"))).toMatchObject({
      status: "verified",
      filesystem: "unrestricted",
      commandExecution: "unrestricted",
      approvalBypass: true,
    });
    expect(
      normalizeDelegationPermissionEnvelope(input("museCode", "approval-required")),
    ).toMatchObject({
      status: "verified",
      filesystem: "read-only",
      commandExecution: "approval-required",
      approvalBypass: false,
    });
  });

  it("normalizes Grok and Antigravity mappings and denies dynamic Cursor", () => {
    expect(normalizeDelegationPermissionEnvelope(input("grok", "full-access"))).toMatchObject({
      status: "verified",
      approvalBypass: true,
    });
    expect(normalizeDelegationPermissionEnvelope(input("antigravity", "auto"))).toMatchObject({
      status: "verified",
      commandExecution: "approval-required",
    });
    expect(normalizeDelegationPermissionEnvelope(input("cursor"))).toMatchObject({
      status: "unverifiable",
    });
    expect(normalizeDelegationPermissionEnvelope(input("forkDriver"))).toMatchObject({
      status: "unverifiable",
    });
  });

  it("fingerprints effective provider config without exposing it", () => {
    const first = normalizeDelegationPermissionEnvelope(input("codex"));
    const second = normalizeDelegationPermissionEnvelope(
      input("codex", "approval-required", { binaryPath: "other-codex" }),
    );
    expect(first.status).toBe("verified");
    expect(second.status).toBe("verified");
    if (first.status === "verified" && second.status === "verified") {
      expect(first.fingerprint).not.toBe(second.fingerprint);
      expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it.effect("reads effective Codex home configuration and fails closed for MCP authority", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-delegation-codex-" });
      const homePath = path.join(root, "home");
      const worktreePath = path.join(root, "worktree");
      yield* fs.makeDirectory(homePath, { recursive: true });
      yield* fs.makeDirectory(worktreePath, { recursive: true });
      yield* fs.writeFileString(path.join(homePath, "config.toml"), 'model = "gpt-test"\n');
      const base = {
        ...input("codex", "approval-required", { homePath, launchArgs: "" }),
        worktreePath,
      };
      const safe = yield* loadDelegationPermissionEnvelope(base);
      expect(safe.status).toBe("verified");

      yield* fs.writeFileString(
        path.join(homePath, "config.toml"),
        `[projects.'${worktreePath.toLowerCase().replaceAll("\\", "/")}']\ntrust_level = "trusted"\n`,
      );
      const trustedProject = yield* loadDelegationPermissionEnvelope(base);
      expect(trustedProject.status).toBe("verified");

      yield* fs.writeFileString(
        path.join(homePath, "config.toml"),
        `[projects.'${worktreePath.toLowerCase().replaceAll("\\", "/")}']\ntrust_level = "untrusted"\n`,
      );
      const untrustedProject = yield* loadDelegationPermissionEnvelope(base);
      expect(untrustedProject).toMatchObject({ status: "unverifiable" });

      yield* fs.writeFileString(path.join(homePath, "config.toml"), 'trust_level = "trusted"\n');
      const topLevelTrust = yield* loadDelegationPermissionEnvelope(base);
      expect(topLevelTrust).toMatchObject({ status: "unverifiable" });

      yield* fs.writeFileString(
        path.join(homePath, "config.toml"),
        `[projects.'${worktreePath.toLowerCase().replaceAll("\\", "/")}']\ntrust_level = "trusted"\n[mcp_servers.remote]\nurl = "https://example.com"\n`,
      );
      const trustedProjectWithMcp = yield* loadDelegationPermissionEnvelope(base);
      expect(trustedProjectWithMcp).toMatchObject({ status: "unverifiable" });

      yield* fs.writeFileString(
        path.join(homePath, "config.toml"),
        '[mcp_servers.remote]\nurl = "https://example.com"\n',
      );
      const unsafe = yield* loadDelegationPermissionEnvelope(base);
      expect(unsafe).toMatchObject({ status: "unverifiable" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads Claude user and workspace settings from the effective config locations", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-delegation-claude-" });
      const homePath = path.join(root, "home");
      const worktreePath = path.join(root, "worktree");
      yield* fs.makeDirectory(homePath, { recursive: true });
      yield* fs.makeDirectory(path.join(worktreePath, ".claude"), { recursive: true });
      yield* fs.writeFileString(path.join(homePath, "settings.json"), '{"model":"opus"}\n');
      const base = {
        ...input("claudeAgent", "approval-required", { homePath, launchArgs: "" }),
        worktreePath,
      };
      const safe = yield* loadDelegationPermissionEnvelope(base);
      expect(safe.status).toBe("verified");

      yield* fs.writeFileString(
        path.join(worktreePath, ".claude", "settings.local.json"),
        '{"permissions":{"allow":["Bash"]}}\n',
      );
      const unsafe = yield* loadDelegationPermissionEnvelope(base);
      expect(unsafe).toMatchObject({ status: "unverifiable" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("compareDelegationPermissionEnvelopes", () => {
  const workspace = {
    projectId: "project-1",
    workspaceRoot: "C:/repo",
    worktreePath: "C:/repo",
    branch: "main",
  };

  it("allows an equal or narrower target and rejects automatic-authority escalation", () => {
    const parent = normalizeDelegationPermissionEnvelope(input("codex", "auto-accept-edits"));
    const narrow = normalizeDelegationPermissionEnvelope(input("codex", "approval-required"));
    const broad = normalizeDelegationPermissionEnvelope(input("codex", "full-access"));

    expect(
      compareDelegationPermissionEnvelopes({
        parent,
        target: narrow,
        parentInteractionMode: "default",
        targetInteractionMode: "plan",
        parentWorkspace: workspace,
        targetWorkspace: workspace,
      }),
    ).toEqual({ allowed: true });
    expect(
      compareDelegationPermissionEnvelopes({
        parent,
        target: broad,
        parentInteractionMode: "default",
        targetInteractionMode: "default",
        parentWorkspace: workspace,
        targetWorkspace: workspace,
      }),
    ).toMatchObject({ allowed: false, code: "permission_escalation_denied" });
  });

  it("rejects unverifiable envelopes, plan-to-default, workspace changes, and broader MCP grants", () => {
    const parent = normalizeDelegationPermissionEnvelope(input("codex", "full-access"));
    const target = normalizeDelegationPermissionEnvelope(input("codex", "full-access"));
    const unverifiable = normalizeDelegationPermissionEnvelope(input("cursor"));

    expect(
      compareDelegationPermissionEnvelopes({
        parent,
        target: unverifiable,
        parentInteractionMode: "default",
        targetInteractionMode: "default",
        parentWorkspace: workspace,
        targetWorkspace: workspace,
      }),
    ).toMatchObject({ allowed: false, code: "permission_envelope_unverifiable" });
    expect(
      compareDelegationPermissionEnvelopes({
        parent,
        target,
        parentInteractionMode: "plan",
        targetInteractionMode: "default",
        parentWorkspace: workspace,
        targetWorkspace: workspace,
      }),
    ).toMatchObject({ allowed: false, code: "permission_escalation_denied" });
    expect(
      compareDelegationPermissionEnvelopes({
        parent,
        target,
        parentInteractionMode: "default",
        targetInteractionMode: "default",
        parentWorkspace: workspace,
        targetWorkspace: { ...workspace, worktreePath: "C:/other" },
      }),
    ).toMatchObject({ allowed: false, code: "permission_escalation_denied" });

    const targetWithBroaderMcp =
      target.status === "verified"
        ? { ...target, t3McpCapabilities: [...target.t3McpCapabilities, "device"] }
        : target;
    expect(
      compareDelegationPermissionEnvelopes({
        parent,
        target: targetWithBroaderMcp,
        parentInteractionMode: "default",
        targetInteractionMode: "default",
        parentWorkspace: workspace,
        targetWorkspace: workspace,
      }),
    ).toMatchObject({ allowed: false, code: "permission_escalation_denied" });
  });
});

void instanceId;

describe("Pi delegation permission envelope", () => {
  const piDriver = driver("pi");
  const piConfigValues = {
    binaryPath: "pi",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "ollama",
    model: "qwen2.5-coder:7b",
  };
  const piConfig: ProviderInstanceConfig = {
    driver: piDriver,
    enabled: true,
    config: piConfigValues,
  };
  const piInput = (
    runtimeMode: DelegationPermissionEnvelopeInput["runtimeMode"],
    config: ProviderInstanceConfig = piConfig,
    environment: Readonly<Record<string, string | undefined>> = {},
  ) => ({
    ...input("pi", runtimeMode, config.config, environment),
    t3McpCapabilities: new Set<string>(),
  });
  const workspace = {
    projectId: "project-1",
    workspaceRoot: "C:/repo",
    worktreePath: "C:/repo",
    branch: "main",
  };

  it("accepts Pi only under a verified full-access parent because its host process is unrestricted", () => {
    const parent = normalizeDelegationPermissionEnvelope(input("codex", "full-access"));
    const target = normalizeDelegationPermissionEnvelope(piInput("approval-required"));

    expect(target).toMatchObject({
      status: "verified",
      filesystem: "unrestricted",
      externalDirectories: "unrestricted",
      commandExecution: "unrestricted",
      network: "unrestricted",
      approvalBypass: true,
      externalTools: [],
      t3McpCapabilities: [],
    });
    expect(
      compareDelegationPermissionEnvelopes({
        parent,
        target,
        parentInteractionMode: "default",
        targetInteractionMode: "default",
        parentWorkspace: workspace,
        targetWorkspace: workspace,
      }),
    ).toEqual({ allowed: true });

    const narrowParent = normalizeDelegationPermissionEnvelope(input("codex", "approval-required"));
    expect(
      compareDelegationPermissionEnvelopes({
        parent: narrowParent,
        target,
        parentInteractionMode: "default",
        targetInteractionMode: "default",
        parentWorkspace: workspace,
        targetWorkspace: workspace,
      }),
    ).toMatchObject({ allowed: false, code: "permission_escalation_denied" });
  });

  it("accepts local Pi endpoints and freezes runtime, endpoint, and effective environment changes", () => {
    const first = normalizeDelegationPermissionEnvelope(piInput("approval-required"));
    const otherRuntime = normalizeDelegationPermissionEnvelope(piInput("full-access"));
    const otherEndpoint = normalizeDelegationPermissionEnvelope(
      piInput("approval-required", {
        ...piConfig,
        config: { ...piConfigValues, baseUrl: "http://localhost:1234/v1" },
      }),
    );
    const ignoredAmbientAgentDir = normalizeDelegationPermissionEnvelope(
      piInput("approval-required", piConfig, { PI_CODING_AGENT_DIR: "C:/ambient/pi" }),
    );

    expect(first.status).toBe("verified");
    expect(otherRuntime.status).toBe("verified");
    expect(otherEndpoint.status).toBe("verified");
    if (
      first.status === "verified" &&
      otherRuntime.status === "verified" &&
      otherEndpoint.status === "verified" &&
      ignoredAmbientAgentDir.status === "verified"
    ) {
      expect(first.fingerprint).not.toBe(otherRuntime.fingerprint);
      expect(first.fingerprint).not.toBe(otherEndpoint.fingerprint);
      expect(first.fingerprint).toBe(ignoredAmbientAgentDir.fingerprint);
    }
  });

  it("fails closed for custom runtime, runtime hooks, proxies, and non-loopback endpoints", () => {
    const unsafeTargets: Array<DelegationPermissionEnvelopeInput> = [
      piInput("full-access", {
        ...piConfig,
        config: { ...piConfigValues, binaryPath: "C:/custom/pi.exe" },
      }),
      piInput("full-access", piConfig, { PI_BUNDLED_PI_BIN: "C:/custom/pi.exe" }),
      piInput("full-access", piConfig, { NODE_OPTIONS: "--require C:/hooks/inject.cjs" }),
      piInput("full-access", piConfig, { HTTPS_PROXY: "http://proxy.example:8080" }),
      piInput("full-access", piConfig, { LD_PRELOAD: "/tmp/inject.so" }),
      piInput("full-access", piConfig, { DYLD_INSERT_LIBRARIES: "/tmp/inject.dylib" }),
      piInput("full-access", {
        ...piConfig,
        config: {
          ...piConfigValues,
          baseUrl: "https://api.example.com/v1",
        },
      }),
    ];

    for (const candidate of unsafeTargets) {
      expect(normalizeDelegationPermissionEnvelope(candidate)).toMatchObject({
        status: "unverifiable",
      });
    }
  });
});

describe("delegationMcpCapabilitySubsets", () => {
  it("enumerates all 16 sorted subsets of the frozen universe", () => {
    expect(DELEGATION_MCP_CAPABILITY_UNIVERSE).toEqual([
      "device",
      "orchestration",
      "preview",
      "pull-requests",
    ]);
    const subsets = delegationMcpCapabilitySubsets();
    expect(subsets).toHaveLength(16);
    expect(new Set(subsets.map((subset) => subset.join(","))).size).toBe(16);
    for (const subset of subsets) {
      expect([...subset].toSorted()).toEqual(subset);
    }
  });

  it("sanitizes stored child caps snapshots", () => {
    expect(sanitizeDelegationChildCapsSnapshot(["orchestration", "device"])).toEqual(
      new Set(["orchestration", "device"]),
    );
    expect(sanitizeDelegationChildCapsSnapshot(undefined)).toBeUndefined();
    expect(sanitizeDelegationChildCapsSnapshot(["orchestration", "calendar"])).toBeUndefined();
    expect(sanitizeDelegationChildCapsSnapshot("orchestration")).toBeUndefined();
  });

  it.effect("recovers the exact subset for a stored fingerprint", () =>
    Effect.gen(function* () {
      const expected = normalizeDelegationPermissionEnvelope({
        ...input("codex"),
        t3McpCapabilities: new Set(["orchestration", "pull-requests"]),
      });
      expect(expected.status).toBe("verified");
      if (expected.status !== "verified") return;
      const recovery = yield* recoverDelegationChildCaps({
        expectedFingerprint: expected.fingerprint,
        loadWithCaps: (caps) =>
          Effect.succeed(
            normalizeDelegationPermissionEnvelope({ ...input("codex"), t3McpCapabilities: caps }),
          ),
      });
      expect(recovery).toMatchObject({ status: "recovered" });
      if (recovery.status !== "recovered") return;
      expect([...recovery.caps].toSorted()).toEqual(["orchestration", "pull-requests"]);
      expect(recovery.envelope.status).toBe("verified");
      if (recovery.envelope.status !== "verified") return;
      expect(recovery.envelope.fingerprint).toBe(expected.fingerprint);
    }),
  );

  it.effect("reports no-match when the config drifted", () =>
    Effect.gen(function* () {
      const expected = normalizeDelegationPermissionEnvelope({
        ...input("codex"),
        t3McpCapabilities: new Set(["orchestration", "pull-requests"]),
      });
      expect(expected.status).toBe("verified");
      if (expected.status !== "verified") return;
      const drifted = { ...input("codex"), runtimeMode: "full-access" as const };
      const recovery = yield* recoverDelegationChildCaps({
        expectedFingerprint: expected.fingerprint,
        loadWithCaps: (caps) =>
          Effect.succeed(
            normalizeDelegationPermissionEnvelope({ ...drifted, t3McpCapabilities: caps }),
          ),
      });
      expect(recovery).toEqual({ status: "no-match" });
    }),
  );
});

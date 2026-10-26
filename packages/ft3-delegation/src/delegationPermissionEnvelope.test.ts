import { describe, expect, it } from "@effect/vitest";

import {
  delegationPermissionDecision,
  delegationPermissionDenial,
  normalizeDelegationPermissionEnvelope,
  tokenizeLaunchArgs,
  type DelegationPermissionDenialInput,
  type DelegationPermissionEnvelopeInput,
} from "./delegationPermissionEnvelope.ts";

const claude = (
  overrides: Partial<DelegationPermissionEnvelopeInput> = {},
): DelegationPermissionEnvelopeInput => ({
  driverKind: "claudeAgent",
  runtimeMode: "auto",
  interactionMode: "default",
  instanceConfig: {},
  ...overrides,
});

const codex = (
  overrides: Partial<DelegationPermissionEnvelopeInput> = {},
): DelegationPermissionEnvelopeInput => ({
  driverKind: "codex",
  runtimeMode: "auto",
  interactionMode: "default",
  instanceConfig: {},
  ...overrides,
});

const decide = (
  parent: DelegationPermissionEnvelopeInput,
  target: DelegationPermissionEnvelopeInput,
  projects: { readonly parent?: string; readonly target?: string } = {},
) =>
  delegationPermissionDecision({
    parent: { projectId: projects.parent ?? "project:one", envelope: parent },
    target: { projectId: projects.target ?? "project:one", envelope: target },
  });

describe("tokenizeLaunchArgs", () => {
  it("keeps quoted values together", () => {
    expect(tokenizeLaunchArgs(`--permission-mode "bypassPermissions" --verbose`)).toEqual([
      "--permission-mode",
      "bypassPermissions",
      "--verbose",
    ]);
  });
});

describe("normalizeDelegationPermissionEnvelope", () => {
  it("takes the broader of the declared and Claude launch-argument modes", () => {
    const envelope = normalizeDelegationPermissionEnvelope(
      claude({
        runtimeMode: "auto",
        instanceConfig: { launchArgs: "--permission-mode bypassPermissions" },
      }),
    );

    expect(envelope).toMatchObject({ status: "verified", filesystem: 2, automaticity: 3 });
  });

  it("refuses a Claude launch argument that cannot be compared", () => {
    const envelope = normalizeDelegationPermissionEnvelope(
      claude({ instanceConfig: { launchArgs: "--sandbox strict" } }),
    );

    expect(envelope.status).toBe("unverifiable");
  });

  it("refuses a Codex config override that touches authority", () => {
    const envelope = normalizeDelegationPermissionEnvelope(
      codex({ instanceConfig: { launchArgs: "-c sandbox_mode=danger-full-access" } }),
    );

    expect(envelope.status).toBe("unverifiable");
  });

  it("still verifies Codex full access, which cannot be broadened further", () => {
    const envelope = normalizeDelegationPermissionEnvelope(
      codex({ runtimeMode: "full-access", instanceConfig: { launchArgs: "-c sandbox_mode=X" } }),
    );

    expect(envelope.status).toBe("verified");
  });

  it("caps OpenCode auto mode, which has no automatic reviewer", () => {
    const envelope = normalizeDelegationPermissionEnvelope(
      claude({ driverKind: "opencode", runtimeMode: "auto" }),
    );

    expect(envelope).toMatchObject({ status: "verified", automaticity: 1 });
  });

  it("refuses OpenCode config content that sets authority", () => {
    const envelope = normalizeDelegationPermissionEnvelope(
      claude({
        driverKind: "opencode",
        environment: [
          { name: "OPENCODE_CONFIG_CONTENT", value: '{"permission":{"edit":"allow"}}' },
        ],
      }),
    );

    expect(envelope.status).toBe("unverifiable");
  });
});

describe("delegationPermissionDecision", () => {
  it("allows a target inside the parent project", () => {
    expect(decide(claude(), claude())).toEqual({ _tag: "Allowed" });
  });

  it("denies a target in another project", () => {
    expect(decide(claude(), claude(), { target: "project:two" })).toMatchObject({
      _tag: "Denied",
      code: "permission_escalation_denied",
    });
  });

  it("allows a narrower target inside the same project", () => {
    expect(decide(claude({ runtimeMode: "full-access" }), claude({ runtimeMode: "auto" }))).toEqual(
      { _tag: "Allowed" },
    );
  });

  it("denies a broader target mode reached through Claude launch arguments", () => {
    expect(
      decide(
        claude({ runtimeMode: "auto" }),
        claude({
          runtimeMode: "auto",
          instanceConfig: { launchArgs: "--dangerously-skip-permissions" },
        }),
      ),
    ).toMatchObject({ _tag: "Denied", code: "permission_escalation_denied" });
  });

  it("allows the same bypass when the parent already runs it", () => {
    const bypass = { launchArgs: "--permission-mode bypassPermissions" };
    expect(
      decide(
        claude({ runtimeMode: "full-access", instanceConfig: bypass }),
        claude({ runtimeMode: "auto", instanceConfig: bypass }),
      ),
    ).toEqual({ _tag: "Allowed" });
  });

  it("denies a filesystem broader than the parent even at the same automaticity", () => {
    expect(
      decide(
        claude({ runtimeMode: "approval-required" }),
        claude({ runtimeMode: "auto-accept-edits" }),
      ),
    ).toMatchObject({ _tag: "Denied", code: "permission_escalation_denied" });
  });

  it("lets a forced plan narrow a full-access declaration", () => {
    expect(
      decide(
        claude({ runtimeMode: "approval-required" }),
        claude({
          runtimeMode: "full-access",
          instanceConfig: { launchArgs: "--permission-mode plan" },
        }),
      ),
    ).toEqual({ _tag: "Allowed" });
  });

  it("denies a target tool surface wider than the parent", () => {
    expect(
      decide(
        claude({
          runtimeMode: "full-access",
          instanceConfig: { launchArgs: "--allowedTools Read" },
        }),
        claude({
          runtimeMode: "full-access",
          instanceConfig: { launchArgs: "--allowedTools Read,Bash" },
        }),
      ),
    ).toMatchObject({ _tag: "Denied", code: "permission_escalation_denied" });
  });

  it("denies when the parent envelope cannot be verified", () => {
    expect(
      decide(
        claude({ instanceConfig: { launchArgs: "--sandbox strict" } }),
        claude({ runtimeMode: "approval-required" }),
      ),
    ).toMatchObject({ _tag: "Denied", code: "permission_envelope_unverifiable" });
  });

  it("denies an OpenCode auto child of an OpenCode auto parent handing off to Claude auto", () => {
    expect(
      decide(
        claude({ driverKind: "opencode", runtimeMode: "auto" }),
        claude({ runtimeMode: "auto" }),
      ),
    ).toMatchObject({ _tag: "Denied", code: "permission_escalation_denied" });
  });
});

describe("delegationPermissionDenial", () => {
  const instances = {
    "codex:parent": { driver: "codex", config: {} },
    "claude:clean": { driver: "claudeAgent", config: {} },
    "claude:bypass": {
      driver: "claudeAgent",
      config: { launchArgs: "--permission-mode bypassPermissions" },
    },
  };
  const providers = [
    { instanceId: "codex:parent", driver: "codex" },
    { instanceId: "claude:clean", driver: "claudeAgent" },
    { instanceId: "claude:bypass", driver: "claudeAgent" },
  ];

  const denial = (
    targetInstanceId: string,
    settings: DelegationPermissionDenialInput["settings"] = { providerInstances: instances },
  ) =>
    delegationPermissionDenial({
      settings,
      providers,
      parentThread: {
        projectId: "project:one",
        modelSelection: { instanceId: "codex:parent" },
        runtimeMode: "auto",
        interactionMode: "default",
      },
      targetInstanceId,
      runtimeMode: "auto",
      interactionMode: "default",
    });

  it("allows a target whose provider configuration fits the parent envelope", () => {
    expect(denial("claude:clean")).toBeUndefined();
  });

  it("maps an escalation to runtime_mode_escalation_denied", () => {
    expect(denial("claude:bypass")).toEqual({
      code: "runtime_mode_escalation_denied",
      reason: "Target automatic authority is broader than the parent permission envelope.",
    });
  });

  it("maps an unverifiable target envelope to capability_denied", () => {
    expect(
      denial("claude:strict", {
        providerInstances: {
          ...instances,
          "claude:strict": {
            driver: "claudeAgent",
            config: { launchArgs: "--sandbox strict" },
          },
        },
      }),
    ).toMatchObject({ code: "capability_denied" });
  });
});

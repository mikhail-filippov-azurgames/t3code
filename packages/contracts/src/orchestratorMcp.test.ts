import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ORCHESTRATOR_MCP_DEFAULT_WAIT_TIMEOUT_MS,
  ORCHESTRATOR_MCP_MAX_WAIT_TIMEOUT_MS,
  ORCHESTRATOR_MCP_PROTOCOL_VERSION,
  ORCHESTRATOR_MCP_TOOL_NAMES,
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpFailure,
  OrchestratorMcpSwitchProviderInput,
  OrchestratorMcpSwitchProviderResult,
  OrchestratorMcpTaskResult,
} from "./orchestratorMcp.ts";

const decodeCapabilities = Schema.decodeUnknownSync(OrchestratorMcpCapabilitiesResult);
const decodeDelegate = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);
const decodeFailure = Schema.decodeUnknownSync(OrchestratorMcpFailure);
const decodeTask = Schema.decodeUnknownSync(OrchestratorMcpTaskResult);
const decodeSwitchInput = Schema.decodeUnknownSync(OrchestratorMcpSwitchProviderInput);
const decodeSwitchResult = Schema.decodeUnknownSync(OrchestratorMcpSwitchProviderResult);

const target = {
  providerInstanceId: "claude_work",
  driverKind: "claudeAgent",
  model: "claude-opus-5",
  options: [{ id: "effort", value: "high" }],
} as const;

const delegateInput = {
  idempotencyKey: "architecture-1",
  title: "Architecture review",
  prompt: "Inspect the current contracts and return an implementation boundary.",
  role: "architecture",
  target,
} as const;

const taskResult = {
  taskId: "child-thread-1",
  status: "completed",
  requested: {
    ...target,
    options: [...target.options],
    runtimeMode: "approval-required",
    interactionMode: "plan",
    providerConfigFingerprint: "sha256:target-config",
  },
  observed: {
    provider: {
      providerInstanceId: "claude_work",
      driverKind: "claudeAgent",
      evidence: "runtime-session-bound",
    },
    model: null,
  },
  lineage: {
    taskId: "child-thread-1",
    parentEnvironmentId: "environment-1",
    parentThreadId: "parent-thread-1",
    parentTurnId: "parent-turn-1",
    projectId: "project-1",
    childThreadId: "child-thread-1",
    delegatedMessageId: "delegated-message-1",
    delegatedTurnId: "delegated-turn-1",
  },
  pendingApproval: false,
  pendingUserInput: false,
  requestedAt: "2026-09-14T10:00:00.000Z",
  startedAt: "2026-09-14T10:00:01.000Z",
  completedAt: "2026-09-14T10:01:00.000Z",
  updatedAt: "2026-09-14T10:01:00.000Z",
  terminalError: null,
  result: {
    text: "Use the existing command reactor.",
    assistantMessageId: "assistant-message-1",
    checkpointRef: null,
    evidenceRefs: ["oc://doc/123e4567-e89b-42d3-a456-426614174000"],
  },
  waitTimedOut: false,
} as const;

describe("orchestrator MCP contracts", () => {
  it("freezes the accepted orchestrator MCP tool surface", () => {
    expect(ORCHESTRATOR_MCP_PROTOCOL_VERSION).toBe(3);
    expect(Object.values(ORCHESTRATOR_MCP_TOOL_NAMES)).toEqual([
      "orchestrator_capabilities",
      "delegate_task",
      "task_status",
      "task_wait",
      "task_cancel",
      "switch_provider",
      "board_create_card",
      "board_update_card",
      "board_delete_card",
      "board_list_cards",
    ]);
  });

  it("decodes a delegation without OCL handoff", () => {
    const decoded = decodeDelegate(delegateInput);

    expect(decoded.handoff).toBeUndefined();
    expect(decoded.role).toBe("architecture");
    expect(decoded.target.providerInstanceId).toBe("claude_work");
  });

  it("decodes a complete revision-matched OCL handoff", () => {
    const decoded = decodeDelegate({
      ...delegateInput,
      execution: { mode: "wait", timeoutMs: 5_000 },
      handoff: {
        contractRef: "oc://doc/123e4567-e89b-42d3-a456-426614174000",
        requiredRevision: 2,
        implementsRevision: 2,
        stage: "implementation",
        owns: ["packages/contracts/src/orchestratorMcp.ts"],
        reads: ["packages/contracts/src/orchestration.ts"],
        forbidden: ["apps/mobile/**"],
        acceptance: ["contracts decode"],
        outputs: ["typed schemas"],
        evidence: [],
        predecessorRefs: [],
      },
    });

    expect(decoded.handoff?.requiredRevision).toBe(2);
    expect(decoded.execution?.timeoutMs).toBe(5_000);
  });

  it("rejects mismatched revisions, malformed refs, and partial handoffs", () => {
    expect(() =>
      decodeDelegate({
        ...delegateInput,
        handoff: {
          contractRef: "oc://doc/123e4567-e89b-42d3-a456-426614174000",
          requiredRevision: 2,
          implementsRevision: 1,
          stage: "implementation",
          owns: [],
          reads: [],
          forbidden: [],
          acceptance: [],
          outputs: [],
          evidence: [],
          predecessorRefs: [],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeDelegate({
        ...delegateInput,
        handoff: {
          contractRef: "C:/context/contract.md",
          requiredRevision: 2,
          implementsRevision: 2,
          stage: "implementation",
          owns: [],
          reads: [],
          forbidden: [],
          acceptance: [],
          outputs: [],
          evidence: [],
          predecessorRefs: [],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeDelegate({
        ...delegateInput,
        handoff: {
          contractRef: "oc://doc/123e4567-e89b-42d3-a456-426614174000",
          requiredRevision: 2,
          implementsRevision: 2,
          stage: "implementation",
        },
      }),
    ).toThrow();
  });

  it("rejects duplicate options and invalid execution bounds", () => {
    expect(() =>
      decodeDelegate({
        ...delegateInput,
        target: {
          ...target,
          options: [
            { id: "effort", value: "low" },
            { id: "effort", value: "high" },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeDelegate({
        ...delegateInput,
        execution: { mode: "async", timeoutMs: 1_000 },
      }),
    ).toThrow();
    expect(() =>
      decodeDelegate({
        ...delegateInput,
        execution: { mode: "wait", timeoutMs: ORCHESTRATOR_MCP_MAX_WAIT_TIMEOUT_MS + 1 },
      }),
    ).toThrow();
  });

  it("keeps requested, observed, and exact turn lineage separate", () => {
    const decoded = decodeTask(taskResult);

    expect(decoded.requested.model).toBe("claude-opus-5");
    expect(decoded.observed.model).toBeNull();
    expect(decoded.lineage.parentTurnId).toBe("parent-turn-1");
    expect(decoded.lineage.delegatedMessageId).toBe("delegated-message-1");
    expect(decoded.lineage.delegatedTurnId).toBe("delegated-turn-1");
  });

  it("accepts observed models only with provider evidence", () => {
    expect(
      decodeTask({
        ...taskResult,
        observed: {
          ...taskResult.observed,
          model: { model: "gpt-5.6-sol", evidence: "provider-rerouted" },
        },
      }).observed.model,
    ).toEqual({ model: "gpt-5.6-sol", evidence: "provider-rerouted" });
    expect(() =>
      decodeTask({
        ...taskResult,
        observed: {
          ...taskResult.observed,
          model: { model: "claude-opus-5" },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeTask({
        ...taskResult,
        observed: {
          provider: null,
          model: { model: "gpt-5.6-sol", evidence: "provider-executed" },
        },
      }),
    ).toThrow();
  });

  it("rejects contradictory task identities and terminal fields", () => {
    expect(() =>
      decodeTask({
        ...taskResult,
        lineage: { ...taskResult.lineage, delegatedTurnId: "other-turn", taskId: "other-task" },
      }),
    ).toThrow();
    expect(() => decodeTask({ ...taskResult, waitTimedOut: true })).toThrow();
    expect(() =>
      decodeTask({
        ...taskResult,
        status: "running",
        completedAt: null,
      }),
    ).toThrow();
  });

  it("decodes fail-closed capability summaries and wait limits", () => {
    const decoded = decodeCapabilities({
      protocolVersion: 3,
      parent: {
        environmentId: "environment-1",
        threadId: "parent-thread-1",
        turnId: "parent-turn-1",
        projectId: "project-1",
        runtimeMode: "approval-required",
        interactionMode: "plan",
        branch: "feat/orchestration",
        worktreePath: "C:/workspace/t3code",
        permissionEnvelope: {
          status: "unverifiable",
          reason: "Parent provider launch configuration is not fully understood.",
        },
      },
      roles: ["architecture", "implementation", "review", "test", "research", "general"],
      wait: {
        defaultTimeoutMs: ORCHESTRATOR_MCP_DEFAULT_WAIT_TIMEOUT_MS,
        maxTimeoutMs: ORCHESTRATOR_MCP_MAX_WAIT_TIMEOUT_MS,
      },
      providers: [
        {
          providerInstanceId: "cursor_work",
          driverKind: "cursor",
          displayName: "Cursor",
          models: [],
          permissionEnvelope: {
            status: "unverifiable",
            reason: "ACP modes are dynamic.",
          },
          delegatable: false,
          unavailableReason: "permission_envelope_unverifiable",
        },
      ],
      workspacePolicy: "inherit-only",
      oclPolicy: "optional-stable-ref-plus-durable-handoff",
    });

    expect(decoded.parent.permissionEnvelope.status).toBe("unverifiable");
    expect(decoded.providers[0]?.delegatable).toBe(false);
  });

  it("decodes a provider switch with carried scope", () => {
    const decoded = decodeSwitchInput({
      taskId: "child-thread-1",
      target,
      reason: "The orchestrator provider hit its usage limit.",
    });

    expect(decoded.taskId).toBe("child-thread-1");
    expect(decoded.target.providerInstanceId).toBe("claude_work");
    expect(decoded.reason).toContain("usage limit");

    const result = decodeSwitchResult({
      taskId: "child-thread-1",
      switchedAt: "2026-09-14T10:02:00.000Z",
      oldProvider: {
        providerInstanceId: "codex_one",
        driverKind: "codex",
        model: "gpt-test",
      },
      requested: {
        ...target,
        options: [...target.options],
        runtimeMode: "approval-required",
        interactionMode: "plan",
        providerConfigFingerprint: "sha256:switch-target-config",
      },
      reason: "The orchestrator provider hit its usage limit.",
      scope: { messageCount: 2, pendingCount: 1, lineagePreserved: true },
      advanced: false,
      task: taskResult,
    });

    expect(result.oldProvider.model).toBe("gpt-test");
    expect(result.scope.lineagePreserved).toBe(true);
    expect(result.task?.taskId).toBe("child-thread-1");
    expect(() =>
      decodeSwitchResult({
        taskId: "child-thread-1",
        switchedAt: "2026-09-14T10:02:00.000Z",
        oldProvider: {
          providerInstanceId: "codex_one",
          driverKind: "codex",
          model: "gpt-test",
        },
        requested: {
          ...target,
          options: [...target.options],
          runtimeMode: "approval-required",
          interactionMode: "plan",
          providerConfigFingerprint: "sha256:switch-target-config",
        },
        reason: "The orchestrator provider hit its usage limit.",
        scope: { messageCount: 0, pendingCount: 0, lineagePreserved: false },
        advanced: false,
        task: taskResult,
      }),
    ).toThrow();
  });

  it("decodes an ordinary-thread switch with no owned task", () => {
    const result = decodeSwitchResult({
      taskId: "thread-1",
      switchedAt: "2026-09-14T10:02:00.000Z",
      oldProvider: {
        providerInstanceId: "codex_one",
        driverKind: "codex",
        model: "gpt-test",
      },
      requested: {
        ...target,
        options: [...target.options],
        runtimeMode: "full-access",
        interactionMode: "default",
        providerConfigFingerprint: "sha256:switch-target-config",
      },
      reason: "The orchestrator provider hit its usage limit.",
      scope: { messageCount: 2, pendingCount: 1, lineagePreserved: true },
      advanced: false,
      task: null,
    });

    expect(result.taskId).toBe("thread-1");
    expect(result.advanced).toBe(false);
    expect(result.task).toBeNull();
  });

  it("decodes every typed pre-spawn failure code", () => {
    const codes = [
      "capability_denied",
      "parent_not_active",
      "provider_unavailable",
      "model_unavailable",
      "invalid_model_options",
      "permission_escalation_denied",
      "permission_envelope_unverifiable",
      "provider_configuration_changed",
      "ocl_handoff_invalid",
      "idempotency_conflict",
      "task_not_found",
      "task_not_cancellable",
      "provider_handoff_unsupported",
      "thread_has_no_history",
      "orchestration_error",
    ] as const;

    for (const code of codes) {
      expect(decodeFailure({ _tag: "OrchestratorMcpFailure", code, message: code }).code).toBe(
        code,
      );
    }
  });
});

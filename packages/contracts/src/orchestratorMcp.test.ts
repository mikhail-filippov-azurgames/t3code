import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ArchitectureReviewRecord,
  ControlPlaneRole,
  CoordinatorArchitectRoutingEvidence,
  ORCHESTRATOR_MCP_DEFAULT_WAIT_TIMEOUT_MS,
  ORCHESTRATOR_MCP_MAX_WAIT_TIMEOUT_MS,
  ORCHESTRATOR_MCP_PROTOCOL_VERSION,
  ORCHESTRATOR_MCP_TOOL_NAMES,
  ORCHESTRATOR_MCP_TASK_PAGE_MAX,
  ORCHESTRATOR_MCP_TASK_SOURCE_TURN_IDS_MAX,
  ORCHESTRATOR_MCP_TASK_TURN_MAX,
  OrchestratorMcpArchitectCreateOrGetInput,
  OrchestratorMcpCoordinatorArchitectSidebarSnapshot,
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpFailure,
  OrchestratorMcpPublishToCoordinatorInput,
  OrchestratorMcpReviewAnswerInput,
  OrchestratorMcpReviewRequestInput,
  OrchestratorMcpSendToTaskInput,
  OrchestratorMcpSendToTaskResult,
  OrchestratorMcpSwitchProviderInput,
  OrchestratorMcpSwitchProviderResult,
  OrchestratorMcpTaskResult,
  OrchestratorMcpTaskListInput,
  OrchestratorMcpTaskMemoryEntry,
  OrchestratorMcpTaskReadInput,
  OrchestratorMcpTaskSearchInput,
  TaskPageLimit,
  TaskTranscriptTurnLimit,
} from "./orchestratorMcp.ts";
import { OrchestrationThreadActivity } from "./orchestration.ts";

const decodeCapabilities = Schema.decodeUnknownSync(OrchestratorMcpCapabilitiesResult);
const decodeDelegate = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);
const decodeSendToTask = Schema.decodeUnknownSync(OrchestratorMcpSendToTaskInput);
const decodeSendToTaskResult = Schema.decodeUnknownSync(OrchestratorMcpSendToTaskResult);
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
    outputStatus: "available",
    assistantMessageId: "assistant-message-1",
    checkpointRef: null,
    evidenceRefs: ["oc://doc/123e4567-e89b-42d3-a456-426614174000"],
  },
  waitTimedOut: false,
} as const;

const sendToTaskResult = {
  taskId: taskResult.taskId,
  messageId: "follow-up-message-1",
  commandId: "mcp-send-to-task-start:abc123",
  status: "queued",
  requested: taskResult.requested,
  observed: taskResult.observed,
  queuedAt: "2026-09-14T10:02:00.000Z",
} as const;

describe("orchestrator MCP contracts", () => {
  it("freezes the accepted orchestrator MCP tool surface", () => {
    expect(ORCHESTRATOR_MCP_PROTOCOL_VERSION).toBe(7);
    expect(Object.values(ORCHESTRATOR_MCP_TOOL_NAMES)).toEqual([
      "orchestrator_capabilities",
      "delegate_task",
      "send_to_task",
      "task_list",
      "task_search",
      "task_read",
      "task_status",
      "task_wait",
      "task_cancel",
      "switch_provider",
      "board_create_card",
      "board_update_card",
      "board_delete_card",
      "board_list_cards",
      "architect_create_or_get",
      "architect_replace",
      "architect_detach",
      "architecture_review_request",
      "architecture_review_answer",
      "architecture_review_cancel",
      "publish_to_coordinator",
      "get_coordinator_binding",
      "list_architecture_reviews",
    ]);
  });

  it("decodes a delegation without OCL handoff", () => {
    const decoded = decodeDelegate(delegateInput);

    expect(decoded.handoff).toBeUndefined();
    expect(decoded.role).toBe("architecture");
    expect(decoded.target.providerInstanceId).toBe("claude_work");
  });

  it("decodes a follow-up message and its stable queue receipt", () => {
    expect(
      decodeSendToTask({
        taskId: "child-thread-1",
        idempotencyKey: "follow-up-1",
        message: "Continue the implementation from the current state.",
      }),
    ).toMatchObject({ taskId: "child-thread-1", idempotencyKey: "follow-up-1" });
    expect(decodeSendToTaskResult(sendToTaskResult)).toMatchObject({
      taskId: "child-thread-1",
      messageId: "follow-up-message-1",
      commandId: "mcp-send-to-task-start:abc123",
      status: "queued",
      requested: { model: "claude-opus-5" },
    });
    expect(() =>
      decodeSendToTask({
        taskId: "child-thread-1",
        idempotencyKey: "follow-up-1",
        message: "   ",
      }),
    ).toThrow();
  });

  it("bounds delegated-task memory queries and paginated transcript reads", () => {
    expect(
      Schema.decodeUnknownSync(OrchestratorMcpTaskListInput)({
        limit: 100,
        afterTaskId: "child-1",
      }),
    ).toMatchObject({ limit: 100 });
    expect(() =>
      Schema.decodeUnknownSync(OrchestratorMcpTaskSearchInput)({
        query: "x".repeat(257),
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(OrchestratorMcpTaskReadInput)({
        taskId: "child-1",
        turnLimit: 21,
      }),
    ).toThrow();
    const decodeRead = Schema.decodeUnknownSync(OrchestratorMcpTaskReadInput);
    expect(
      decodeRead({ taskId: "child-1", turnLimit: 20, beforeCursor: "x".repeat(2048) }),
    ).toMatchObject({ turnLimit: 20 });
    expect(() => decodeRead({ taskId: "child-1", beforeCursor: "x".repeat(2049) })).toThrow();
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

  it("requires an explicit delegated output status", () => {
    expect(
      decodeTask({
        ...taskResult,
        result: { ...taskResult.result, outputStatus: "unavailable" },
      }).result?.outputStatus,
    ).toBe("unavailable");
    expect(
      decodeTask({
        ...taskResult,
        result: { ...taskResult.result, outputStatus: "empty" },
      }).result?.outputStatus,
    ).toBe("empty");
    expect(() =>
      decodeTask({
        ...taskResult,
        result: {
          text: "",
          assistantMessageId: null,
          checkpointRef: null,
          evidenceRefs: [],
        },
      }),
    ).toThrow();
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
      protocolVersion: 7,
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
      "routing_evidence_mismatch",
      "delegated_executor_denied",
      "architect_denied",
      "binding_not_found",
      "binding_conflict",
      "review_not_found",
      "review_state_conflict",
      "feature_disabled",
    ] as const;

    for (const code of codes) {
      expect(decodeFailure({ _tag: "OrchestratorMcpFailure", code, message: code }).code).toBe(
        code,
      );
    }
  });
});

describe("phase 1 coordinator/architect contracts", () => {
  const decodeRole = Schema.decodeUnknownSync(ControlPlaneRole);
  const decodeCreate = Schema.decodeUnknownSync(OrchestratorMcpArchitectCreateOrGetInput);
  const decodeRequest = Schema.decodeUnknownSync(OrchestratorMcpReviewRequestInput);
  const decodeAnswer = Schema.decodeUnknownSync(OrchestratorMcpReviewAnswerInput);
  const decodePublish = Schema.decodeUnknownSync(OrchestratorMcpPublishToCoordinatorInput);

  it("keeps the control plane to coordinator and architect only", () => {
    expect(decodeRole("coordinator")).toBe("coordinator");
    expect(decodeRole("architect")).toBe("architect");
    expect(() => decodeRole("root")).toThrow();
    expect(() => decodeRole("executor")).toThrow();
    expect(() => decodeRole("orchestrator")).toThrow();
  });

  it("requires an explicit task effort on architect creation, with no default", () => {
    const modelSelection = {
      instanceId: "codex",
      model: "gpt-6-luna",
      options: [{ id: "reasoningEffort", value: "max" }],
    } as const;
    const routingEvidence = {
      policyRef: "oc://doc/3900df61-9dd5-4621-9278-34ac20d60648@10",
      policyRevision: 10,
      role: "architecture",
      taskEffort: "high",
      consideredCandidates: [
        {
          alias: "L",
          providerInstanceId: "codex",
          driverKind: "codex",
          model: "gpt-6-luna",
          options: [{ id: "reasoningEffort", value: "max" }],
          disposition: "selected",
          reason: "Selected by the architecture policy for this effort cell.",
        },
      ],
    } as const;
    const base = {
      coordinatorThreadId: "coordinator-1",
      modelSelection,
      routingEvidence,
      idempotencyKey: "create-1",
    } as const;
    expect(() => decodeCreate(base)).toThrow();
    expect(decodeCreate({ ...base, taskEffort: "high" }).taskEffort).toBe("high");
    expect(() =>
      decodeCreate({
        ...base,
        taskEffort: "high",
        routingEvidence: { ...routingEvidence, consideredCandidates: [] },
      }),
    ).toThrow();
  });

  it("decodes the unary sidebar snapshot without widening the status machine", () => {
    const decodeSnapshot = Schema.decodeUnknownSync(
      OrchestratorMcpCoordinatorArchitectSidebarSnapshot,
    );
    expect(decodeSnapshot({ binding: null, reviews: [] })).toEqual({ binding: null, reviews: [] });
  });

  it("decodes review delivery state distinctly from the status machine", () => {
    const decodeRecord = Schema.decodeUnknownSync(ArchitectureReviewRecord);
    const base = {
      reviewId: "review-1",
      bindingId: "binding-1",
      coordinatorThreadId: "coordinator-1",
      architectThreadId: "arch:coordinator-1",
      subjectChildThreadId: null,
      reason: "hard-bug",
      question: "Is the retry safe to run twice?",
      refs: {},
      executionPosture: "continue",
      answerDisposition: null,
      status: "open",
      answerSummary: null,
      requestIdempotencyKey: "request-1",
      answerIdempotencyKey: null,
      answerPayloadFingerprint: null,
      publishIdempotencyKey: null,
      cancelIdempotencyKey: null,
      cancelledAt: null,
      cancelledBy: null,
      createdAt: "2026-09-28T12:00:00.000Z",
      answeredAt: null,
      publishedAt: null,
      publishDeliveredAt: null,
      lastPublishFailure: null,
    } as const;
    // Older servers omit the additive delivery fields; new servers always
    // include them, while updated consumers can still decode legacy rows.
    const legacyShape: Record<string, unknown> = { ...base };
    delete legacyShape.publishDeliveredAt;
    delete legacyShape.lastPublishFailure;
    const legacy = decodeRecord(legacyShape);
    expect(legacy.publishDeliveredAt).toBeUndefined();
    expect(legacy.lastPublishFailure).toBeUndefined();
    // No answer: nothing recorded, nothing delivered, no failure.
    const open = decodeRecord(base);
    expect(open.answeredAt).toBeNull();
    expect(open.publishDeliveredAt).toBeNull();
    expect(open.lastPublishFailure).toBeNull();
    // Answered but undelivered with a refusal: distinguishable from open.
    const refused = decodeRecord({
      ...base,
      status: "answered",
      answerDisposition: "recommendation",
      answerSummary: "Ship it.",
      answeredAt: "2026-09-28T12:01:00.000Z",
      lastPublishFailure: {
        reason: "parent_scope_drift",
        message: "refused [reason=parent_scope_drift]",
        attemptedAt: "2026-09-28T12:02:00.000Z",
      },
    });
    expect(refused.answeredAt).not.toBeNull();
    expect(refused.publishDeliveredAt).toBeNull();
    expect(refused.lastPublishFailure?.reason).toBe("parent_scope_drift");
    // Delivered: the wake proof carries its own timestamp.
    const delivered = decodeRecord({
      ...base,
      status: "published",
      answeredAt: "2026-09-28T12:01:00.000Z",
      publishedAt: "2026-09-28T12:03:00.000Z",
      publishDeliveredAt: "2026-09-28T12:03:00.000Z",
      lastPublishFailure: null,
    });
    expect(delivered.publishDeliveredAt).not.toBeNull();
  });

  it("decodes routing evidence naming the current accepted policy revision", () => {
    const decodeEvidence = Schema.decodeUnknownSync(CoordinatorArchitectRoutingEvidence);
    const evidence = decodeEvidence({
      policyRef: "oc://doc/3900df61-9dd5-4621-9278-34ac20d60648@10",
      policyRevision: 10,
      role: "architecture",
      taskEffort: "high",
      consideredCandidates: [
        {
          alias: "S",
          providerInstanceId: "codex",
          driverKind: "codex",
          model: "gpt-6-sol",
          options: [{ id: "reasoningEffort", value: "max" }],
          disposition: "selected",
          reason: "Selected by the architecture policy for this effort cell.",
        },
      ],
    });
    expect(evidence.policyRef).toBe("oc://doc/3900df61-9dd5-4621-9278-34ac20d60648@10");
    expect(evidence.policyRevision).toBe(10);
  });

  it("rejects a policyRef whose @revision suffix disagrees with policyRevision", () => {
    const decodeEvidence = Schema.decodeUnknownSync(CoordinatorArchitectRoutingEvidence);
    const evidence = {
      policyRef: "oc://doc/3900df61-9dd5-4621-9278-34ac20d60648@10",
      policyRevision: 11,
      role: "architecture",
      taskEffort: "high",
      consideredCandidates: [
        {
          alias: "S",
          providerInstanceId: "codex",
          driverKind: "codex",
          model: "gpt-6-sol",
          options: [],
          disposition: "selected",
          reason: "Selected by the architecture policy for this effort cell.",
        },
      ],
    } as const;
    expect(() => decodeEvidence(evidence)).toThrow();
    expect(() =>
      decodeEvidence({
        ...evidence,
        policyRef: "oc://doc/3900df61-9dd5-4621-9278-34ac20d60648@11",
        policyRevision: 10,
      }),
    ).toThrow();
  });

  it("rejects a policyRef without an @revision suffix", () => {
    const decodeEvidence = Schema.decodeUnknownSync(CoordinatorArchitectRoutingEvidence);
    expect(() =>
      decodeEvidence({
        policyRef: "oc://doc/3900df61-9dd5-4621-9278-34ac20d60648",
        policyRevision: 10,
        role: "architecture",
        taskEffort: "high",
        consideredCandidates: [
          {
            alias: "S",
            providerInstanceId: "codex",
            driverKind: "codex",
            model: "gpt-6-sol",
            options: [],
            disposition: "selected",
            reason: "Selected by the architecture policy for this effort cell.",
          },
        ],
      }),
    ).toThrow();
  });

  it("requires an explicit execution posture on every review request, with no default", () => {
    const base = {
      coordinatorThreadId: "coordinator-1",
      reason: "hard-bug",
      question: "Is the retry safe to run twice?",
      idempotencyKey: "review-1",
    } as const;
    expect(() => decodeRequest(base)).toThrow();
    for (const posture of ["continue", "pause-branch", "pause-all"] as const) {
      expect(decodeRequest({ ...base, executionPosture: posture }).executionPosture).toBe(posture);
    }
  });

  it("requires a typed answer disposition and bounds the summary", () => {
    const base = { reviewId: "review-1", summary: "Ship it.", idempotencyKey: "answer-1" };
    expect(() => decodeAnswer(base)).toThrow();
    for (const disposition of [
      "recommendation",
      "needs-human-decision",
      "needs-more-evidence",
    ] as const) {
      expect(decodeAnswer({ ...base, disposition }).disposition).toBe(disposition);
    }
    expect(() =>
      decodeAnswer({ ...base, disposition: "recommendation", summary: "x".repeat(2001) }),
    ).toThrow();
    expect(decodePublish({ reviewId: "review-1", idempotencyKey: "publish-1" }).reviewId).toBe(
      "review-1",
    );
  });

  it("shares named history limits and bounds source-turn lineage", () => {
    const decodePage = Schema.decodeUnknownSync(TaskPageLimit);
    const decodeTurns = Schema.decodeUnknownSync(TaskTranscriptTurnLimit);
    expect(decodePage(ORCHESTRATOR_MCP_TASK_PAGE_MAX)).toBe(ORCHESTRATOR_MCP_TASK_PAGE_MAX);
    expect(() => decodePage(ORCHESTRATOR_MCP_TASK_PAGE_MAX + 1)).toThrow();
    expect(decodeTurns(ORCHESTRATOR_MCP_TASK_TURN_MAX)).toBe(ORCHESTRATOR_MCP_TASK_TURN_MAX);
    expect(() => decodeTurns(ORCHESTRATOR_MCP_TASK_TURN_MAX + 1)).toThrow();
    const decodeEntry = Schema.decodeUnknownSync(OrchestratorMcpTaskMemoryEntry);
    const sourceTurnIds = Array.from(
      { length: ORCHESTRATOR_MCP_TASK_SOURCE_TURN_IDS_MAX },
      (_, index) => `turn-${index}`,
    );
    const entry = {
      taskId: "task-1",
      childThreadId: "child-1",
      role: "implementation",
      title: "Task",
      latestStatus: "completed",
      latestTurnId: null,
      updatedAt: "2026-09-28T12:00:00.000Z",
      worktreePath: null,
      summary: {
        text: "Summary",
        source: "deterministic",
        sourceTurnIds,
        watermark: 0,
        stale: false,
        state: "ready",
        error: null,
      },
    };
    expect(decodeEntry(entry).summary?.sourceTurnIds).toHaveLength(
      ORCHESTRATOR_MCP_TASK_SOURCE_TURN_IDS_MAX,
    );
    expect(() =>
      decodeEntry({
        ...entry,
        summary: {
          ...entry.summary,
          sourceTurnIds: [...sourceTurnIds, "turn-extra"],
        },
      }),
    ).toThrow();
  });

  it("keeps v6 activity reads forward compatible with unknown kinds", () => {
    const decodeActivity = Schema.decodeUnknownSync(OrchestrationThreadActivity);
    const unknownActivity = decodeActivity({
      id: "future-v7-activity",
      tone: "info",
      kind: "future.server.activity",
      summary: "A newer server activity",
      payload: { version: 7, extra: true },
      turnId: null,
      createdAt: "2026-09-28T12:00:00.000Z",
    });

    // Old clients can decode and skip a kind they do not understand while
    // preserving the same list/read/send surfaces.
    expect(unknownActivity.kind).toBe("future.server.activity");
    expect(unknownActivity.payload).toEqual({ version: 7, extra: true });
  });
});

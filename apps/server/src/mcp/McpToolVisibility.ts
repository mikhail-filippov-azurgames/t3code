import { ORCHESTRATOR_MCP_TOOL_NAMES } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { BoardRepository } from "../persistence/Services/Board.ts";
import { CoordinatorArchitectRepository } from "../persistence/Services/CoordinatorArchitect.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

/**
 * Slice 2 of the tools/list context diet: show a session exactly the tools
 * its credential could invoke ("visible = callable"). Slices 3 (descriptions)
 * and 4 (schemas) are intentionally untouched.
 *
 * The static part below mirrors the call-time capability gates tool by tool:
 * preview/device/pull-requests/calendar check one capability flag, every
 * orchestrator-toolkit tool additionally requires the frozen orchestration
 * scope, and the role classes mirror the architect/coordinator denials in
 * `toolkits/orchestrator/service.ts`. The dynamic part (board registration,
 * delegated-executor shells, architect bindings) is resolved per request in
 * `resolveVisibleTools` because no static scope field distinguishes a
 * coordinator from an ordinary chat or an executor child.
 */

export const PREVIEW_TOOL_NAMES = [
  "preview_status",
  "preview_open",
  "preview_navigate",
  "preview_resize",
  "preview_set_appearance",
  "preview_snapshot",
  "preview_click",
  "preview_type",
  "preview_press",
  "preview_scroll",
  "preview_evaluate",
  "preview_wait_for",
  "preview_recording_start",
  "preview_recording_stop",
] as const;

export const DEVICE_TOOL_NAMES = [
  "device_list",
  "device_open",
  "device_screenshot",
  "device_close",
] as const;

export const CALENDAR_TOOL_NAMES = [
  "calendar_list",
  "calendar_create",
  "calendar_update",
  "calendar_delete",
] as const;

export const PULL_REQUEST_TOOL_NAMES = [
  "link_pull_request",
  "unlink_pull_request",
  "list_thread_pull_requests",
] as const;

const T = ORCHESTRATOR_MCP_TOOL_NAMES;

/** Delegation core an ordinary chat must keep (ProviderService always grants it orchestration). */
export const DELEGATION_CORE_TOOL_NAMES = [
  T.capabilities,
  T.delegateTask,
  T.sendToTask,
  T.taskList,
  T.taskSearch,
  T.taskSummaryHistory,
  T.taskRead,
  T.taskStatus,
  T.taskWait,
  T.taskCancel,
  T.switchProvider,
] as const;

/** Task reads a bound architect reuses against the linked coordinator lineage. */
export const TASK_READ_TOOL_NAMES = [
  T.taskList,
  T.taskSearch,
  T.taskSummaryHistory,
  T.taskRead,
  T.taskStatus,
  T.taskWait,
] as const;

/** Delegation writes the architect is denied (denyArchitectCaller at call time). */
export const ARCHITECT_DENIED_DELEGATION_TOOL_NAMES = [
  T.capabilities,
  T.delegateTask,
  T.sendToTask,
  T.taskCancel,
  T.switchProvider,
] as const;

export const BOARD_TOOL_NAMES = [
  T.boardCreateCard,
  T.boardUpdateCard,
  T.boardDeleteCard,
  T.boardListCards,
] as const;

/** Coordinator control-plane management (self-scoped by thread identity at call time). */
export const COORDINATOR_MANAGEMENT_TOOL_NAMES = [
  T.architectCreateOrGet,
  T.architectReplace,
  T.architectDetach,
  T.architectureReviewRequest,
  T.architectureReviewCancel,
] as const;

export const ARCHITECT_ANSWER_TOOL_NAMES = [
  T.architectureReviewAnswer,
  T.prepareCoordinatorPublication,
] as const;

export const PUBLISH_TOOL_NAME = T.publishToCoordinator;

export const BINDING_READ_TOOL_NAMES = [
  T.getCoordinatorBinding,
  T.listArchitectureReviews,
] as const;

/** Every tool name the `/mcp` server registers (50). Fails a test on drift. */
export const ALL_KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...PREVIEW_TOOL_NAMES,
  ...DEVICE_TOOL_NAMES,
  ...CALENDAR_TOOL_NAMES,
  ...PULL_REQUEST_TOOL_NAMES,
  ...Object.values(T),
]);

const isArchitectScope = (scope: McpInvocationScope): boolean =>
  scope.controlPlaneRole === "architect";

const hasOrchestration = (scope: McpInvocationScope): boolean =>
  scope.capabilities.has("orchestration") && scope.orchestration !== undefined;

/**
 * Static visibility: capabilities, frozen orchestration scope, and
 * control-plane role only. Returns false for unknown tool names
 * (fail closed) so a newly registered tool cannot leak before it is
 * classified here.
 */
export const isToolVisibleToScope = (scope: McpInvocationScope, toolName: string): boolean => {
  if (!ALL_KNOWN_TOOL_NAMES.has(toolName)) return false;
  if ((PREVIEW_TOOL_NAMES as ReadonlyArray<string>).includes(toolName)) {
    return scope.capabilities.has("preview");
  }
  if ((DEVICE_TOOL_NAMES as ReadonlyArray<string>).includes(toolName)) {
    return scope.capabilities.has("device");
  }
  if ((PULL_REQUEST_TOOL_NAMES as ReadonlyArray<string>).includes(toolName)) {
    return scope.capabilities.has("pull-requests");
  }
  if ((CALENDAR_TOOL_NAMES as ReadonlyArray<string>).includes(toolName)) {
    return scope.capabilities.has("orchestration");
  }
  if (!hasOrchestration(scope)) return false;
  if (isArchitectScope(scope)) {
    return (
      (TASK_READ_TOOL_NAMES as ReadonlyArray<string>).includes(toolName) ||
      (ARCHITECT_ANSWER_TOOL_NAMES as ReadonlyArray<string>).includes(toolName) ||
      toolName === PUBLISH_TOOL_NAME ||
      (BINDING_READ_TOOL_NAMES as ReadonlyArray<string>).includes(toolName)
    );
  }
  return !(ARCHITECT_ANSWER_TOOL_NAMES as ReadonlyArray<string>).includes(toolName);
};

export interface McpVisibilityDynamics {
  readonly isRegisteredCoordinator: boolean;
  readonly isDelegatedExecutor: boolean;
  readonly hasActiveArchitectBinding: boolean;
}

const STATIC_DYNAMICS: McpVisibilityDynamics = {
  isRegisteredCoordinator: true,
  isDelegatedExecutor: false,
  hasActiveArchitectBinding: true,
};

/**
 * Dynamic refinement the static scope cannot express. Every lookup is
 * optional-service and fail-open to the static answer with a warning: the
 * call-time gates stay authoritative, so a degraded lookup only ever
 * over-shows, never over-denies.
 */
export const resolveVisibilityDynamics = (
  scope: McpInvocationScope,
): Effect.Effect<McpVisibilityDynamics, never> =>
  Effect.gen(function* () {
    const board = yield* Effect.serviceOption(BoardRepository);
    const snapshots = yield* Effect.serviceOption(ProjectionSnapshotQuery);
    const architects = yield* Effect.serviceOption(CoordinatorArchitectRepository);
    if (Option.isNone(board) && Option.isNone(snapshots) && Option.isNone(architects)) {
      return STATIC_DYNAMICS;
    }
    const failOpen = <A, E>(
      effect: Effect.Effect<A, E>,
      label: string,
      fallback: A,
    ): Effect.Effect<A> =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(effect);
        if (Exit.isSuccess(exit)) return exit.value;
        yield* Effect.logWarning(`MCP tool visibility fell back to the static rule for ${label}.`);
        return fallback;
      });
    const isRegisteredCoordinator =
      Option.isNone(board) ||
      (yield* failOpen(
        Effect.map(board.value.listOrchestrators(), (rows) =>
          rows.some((row) => row.threadId === scope.threadId),
        ),
        "board registration",
        true,
      ));
    // A missing shell hides the dynamic tools just like denyExecutorCaller
    // denies the call fail-closed; only a missing projection service falls
    // back to the static answer.
    const isDelegatedExecutor =
      !Option.isNone(snapshots) &&
      (yield* failOpen(
        Effect.map(snapshots.value.getThreadShellById(scope.threadId), (shell) =>
          Option.isNone(shell) ||
          (shell.value.delegationParent !== null && shell.value.delegationParent !== undefined)
            ? true
            : false,
        ),
        "executor shell",
        false,
      ));
    const hasActiveArchitectBinding =
      Option.isNone(architects) ||
      (yield* failOpen(
        Effect.map(architects.value.getActiveBindingByArchitect(scope.threadId), (binding) =>
          binding === null ? false : true,
        ),
        "architect binding",
        true,
      ));
    return { isRegisteredCoordinator, isDelegatedExecutor, hasActiveArchitectBinding };
  });

/**
 * Full per-request visible set: static rule minus the dynamic exclusions.
 * Coordinator-only state (board, binding reads) additionally requires a
 * human-marked board orchestrator; executors and architects never own it.
 */
export const resolveVisibleTools = (
  scope: McpInvocationScope,
): Effect.Effect<ReadonlySet<string>, never> =>
  Effect.gen(function* () {
    const dynamics = yield* resolveVisibilityDynamics(scope);
    const visible = new Set<string>();
    for (const toolName of ALL_KNOWN_TOOL_NAMES) {
      if (!isToolVisibleToScope(scope, toolName)) continue;
      if ((BOARD_TOOL_NAMES as ReadonlyArray<string>).includes(toolName)) {
        if (isArchitectScope(scope)) continue;
        if (dynamics.isDelegatedExecutor || !dynamics.isRegisteredCoordinator) continue;
      }
      if ((BINDING_READ_TOOL_NAMES as ReadonlyArray<string>).includes(toolName)) {
        if (isArchitectScope(scope)) {
          if (!dynamics.hasActiveArchitectBinding) continue;
        } else if (dynamics.isDelegatedExecutor || !dynamics.isRegisteredCoordinator) {
          continue;
        }
      }
      if ((COORDINATOR_MANAGEMENT_TOOL_NAMES as ReadonlyArray<string>).includes(toolName)) {
        if (dynamics.isDelegatedExecutor) continue;
        // architecture_review_cancel additionally requires a marked
        // coordinator (mirrors the call-time registration gate); the other
        // management writes stay self-scoped by thread identity.
        if (toolName === T.architectureReviewCancel && !dynamics.isRegisteredCoordinator) {
          continue;
        }
      }
      if (toolName === PUBLISH_TOOL_NAME && !isArchitectScope(scope)) {
        if (dynamics.isDelegatedExecutor || !dynamics.isRegisteredCoordinator) continue;
      }
      if ((TASK_READ_TOOL_NAMES as ReadonlyArray<string>).includes(toolName)) {
        if (isArchitectScope(scope) && !dynamics.hasActiveArchitectBinding) continue;
      }
      if ((ARCHITECT_ANSWER_TOOL_NAMES as ReadonlyArray<string>).includes(toolName)) {
        if (!dynamics.hasActiveArchitectBinding) continue;
      }
      if (toolName === PUBLISH_TOOL_NAME && isArchitectScope(scope)) {
        if (!dynamics.hasActiveArchitectBinding) continue;
      }
      visible.add(toolName);
    }
    return visible as ReadonlySet<string>;
  });

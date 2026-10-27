import { OrchestratorMcpFailure, type NodeId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as McpInvocationContext from "../../../apps/server/src/mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import { applyAuthorTextPolicy } from "../../ft3-delegation/src/secretTextPolicy.ts";
import {
  TaskHandoff,
  type TaskAttachHandoffInput,
  type TaskAttachHandoffResult,
} from "./contracts.ts";

type Scope = McpInvocationContext.McpInvocationScope;

const encodeHandoff = Schema.encodeSync(Schema.fromJsonString(TaskHandoff));
const decodeHandoff = Schema.decodeUnknownOption(Schema.fromJsonString(TaskHandoff));

const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The delegated task handoff could not be completed.",
  });

/** The handoff is agent-authored text read by other agents, so it follows the author policy. */
const handoffTexts = (handoff: TaskHandoff): ReadonlyArray<string> => [
  handoff.contractRef,
  handoff.stage,
  ...handoff.owns,
  ...handoff.reads,
  ...handoff.forbidden,
  ...handoff.acceptance,
  ...handoff.outputs,
  ...handoff.evidence,
  ...handoff.predecessorRefs,
];

const handoffCarriesSecret = (handoff: TaskHandoff): boolean => {
  try {
    return handoffTexts(handoff).some(
      (text) => applyAuthorTextPolicy("handoff", text)._tag === "Rejected",
    );
  } catch {
    // A failed check must reject the handoff like a detected secret does.
    return true;
  }
};

const notFound = () =>
  new OrchestratorMcpFailure({
    code: "task_not_found",
    message: "The delegated task was not found.",
  });

interface OwnedTask {
  readonly parentThreadId: ThreadId;
  readonly taskId: NodeId;
}

interface HandoffRow {
  readonly attached: string | null;
  readonly legacy: string | null;
}

export class TaskHandoffService extends Context.Service<
  TaskHandoffService,
  {
    readonly get: (taskId: NodeId) => Effect.Effect<TaskHandoff | null, OrchestratorMcpFailure>;
    readonly attach: (
      scope: Scope,
      input: TaskAttachHandoffInput,
    ) => Effect.Effect<TaskAttachHandoffResult, OrchestratorMcpFailure>;
  }
>()("@t3tools/ft3-orchestration/TaskHandoffService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const sql = yield* SqlClient.SqlClient;

  const ownedTask = Effect.fn("Ft3TaskHandoffService.ownedTask")(function* (
    scope: Scope,
    taskId: NodeId,
  ) {
    const caller = yield* McpInvocationContext.requireThreadScope(scope, "Task handoffs");
    if (!scope.capabilities.has("orchestration")) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "This credential cannot attach delegated task handoffs.",
      });
    }
    const parent = yield* threads
      .getThreadShell(caller.thread.threadId)
      .pipe(Effect.mapError(unavailable));
    if (parent === null || parent.deletedAt !== null) {
      return yield* new OrchestratorMcpFailure({
        code: "thread_not_found",
        message: "The calling thread was not found.",
      });
    }
    const { subagents } = yield* threads
      .getThreadRecords(parent.id, ["subagents"])
      .pipe(Effect.mapError(unavailable));
    const task = subagents.find((candidate) => candidate.id === taskId);
    if (
      task === undefined ||
      task.origin !== "app_owned" ||
      task.threadId !== parent.id ||
      task.childThreadId === null
    ) {
      return yield* notFound();
    }
    const child = yield* threads
      .getThreadShell(task.childThreadId)
      .pipe(Effect.mapError(unavailable));
    if (
      child === null ||
      child.deletedAt !== null ||
      child.projectId !== parent.projectId ||
      child.lineage.parentThreadId !== parent.id ||
      child.lineage.relationshipToParent !== "subagent"
    ) {
      return yield* notFound();
    }
    return { parentThreadId: parent.id, taskId: task.id } satisfies OwnedTask;
  });

  const read = Effect.fn("Ft3TaskHandoffService.read")(function* (taskId: NodeId) {
    const rows = yield* sql<HandoffRow>`
      SELECT
        (SELECT handoff_json FROM ft3_task_handoffs WHERE task_id = ${taskId}) AS attached,
        (
          SELECT json_extract(payload_json, '$.handoff')
          FROM orchestration_v2_projection_subagents
          WHERE subagent_id = ${taskId}
        ) AS legacy
    `.pipe(Effect.mapError(unavailable));
    const raw = rows[0]?.attached ?? rows[0]?.legacy ?? null;
    if (raw === null) return null;
    return Option.getOrNull(decodeHandoff(raw));
  });

  return TaskHandoffService.of({
    get: read,
    attach: Effect.fn("Ft3TaskHandoffService.attach")(function* (scope, input) {
      const owned = yield* ownedTask(scope, input.taskId);
      if (handoffCarriesSecret(input.handoff)) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message:
            "The authored handoff could not be confirmed secret-free. Remove sensitive values and try again.",
        });
      }
      const canonical = encodeHandoff(input.handoff);
      const existing = yield* sql<{
        readonly handoff_json: string;
        readonly parent_thread_id: string;
      }>`
        SELECT handoff_json, parent_thread_id FROM ft3_task_handoffs WHERE task_id = ${input.taskId}
      `.pipe(Effect.mapError(unavailable));
      const current = existing[0];
      if (current !== undefined) {
        if (current.parent_thread_id !== owned.parentThreadId) return yield* notFound();
        if (current.handoff_json !== canonical) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "This task already has a different handoff attached.",
          });
        }
        return { taskId: input.taskId, handoff: input.handoff, created: false };
      }
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO ft3_task_handoffs (task_id, parent_thread_id, handoff_json, created_at)
        VALUES (${input.taskId}, ${owned.parentThreadId}, ${canonical}, ${createdAt})
        ON CONFLICT(task_id) DO NOTHING
      `.pipe(Effect.mapError(unavailable));
      const stored = yield* sql<{ readonly handoff_json: string }>`
        SELECT handoff_json FROM ft3_task_handoffs WHERE task_id = ${input.taskId}
      `.pipe(Effect.mapError(unavailable));
      if (stored[0]?.handoff_json !== canonical) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "This task already has a different handoff attached.",
        });
      }
      return { taskId: input.taskId, handoff: input.handoff, created: true };
    }),
  });
});

export const layer = Layer.effect(TaskHandoffService, make);

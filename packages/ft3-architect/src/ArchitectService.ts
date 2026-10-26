import type { ThreadId } from "@t3tools/contracts";
import * as BoardRepository from "@t3tools/ft3-board/repository";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpInvocationContext from "../../../apps/server/src/mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import * as ArchitectRepository from "./ArchitectRepository.ts";
import * as Contracts from "./contracts.ts";

type Scope = McpInvocationContext.McpInvocationScope;

export class ArchitectService extends Context.Service<
  ArchitectService,
  {
    readonly getBinding: (
      scope: Scope,
      input: Contracts.ArchitectGetCoordinatorBindingInput,
    ) => Effect.Effect<
      Contracts.ArchitectGetCoordinatorBindingResult,
      Contracts.ArchitectMcpFailure
    >;
    readonly listReviews: (
      scope: Scope,
      input: Contracts.ArchitectListArchitectureReviewsInput,
    ) => Effect.Effect<
      Contracts.ArchitectListArchitectureReviewsResult,
      Contracts.ArchitectMcpFailure
    >;
  }
>()("@t3tools/ft3-architect/ArchitectService") {}

const unavailable = () =>
  new Contracts.ArchitectMcpFailure({
    code: "orchestration_error",
    message: "The architect query could not be completed.",
  });

const make = Effect.gen(function* () {
  const repo = yield* ArchitectRepository.ArchitectRepository;
  const board = yield* BoardRepository.BoardRepository;
  const threads = yield* ThreadManagement.ThreadManagementService;

  const resolveCaller = Effect.fn("Ft3ArchitectService.resolveCaller")(function* (scope: Scope) {
    if (!scope.capabilities.has("orchestration")) {
      return yield* new Contracts.ArchitectMcpFailure({
        code: "capability_denied",
        message: "This credential cannot read architect bindings or reviews.",
      });
    }
    const caller = yield* McpInvocationContext.requireThreadScope(scope, "Architect queries");
    const shell = yield* threads
      .getThreadShell(caller.thread.threadId)
      .pipe(Effect.mapError(unavailable));
    if (shell === null || shell.deletedAt !== null) {
      return yield* new Contracts.ArchitectMcpFailure({
        code: "thread_not_found",
        message: "The calling thread was not found.",
      });
    }
    if (shell.lineage.relationshipToParent === "subagent") {
      return yield* new Contracts.ArchitectMcpFailure({
        code: "delegated_executor_denied",
        message: "Delegated executor threads cannot query architect bindings or reviews.",
      });
    }
    const binding = yield* repo
      .getActiveBindingByArchitect(caller.thread.threadId)
      .pipe(Effect.mapError(unavailable));
    return { caller, binding };
  });

  const requireQueryScope = Effect.fn("Ft3ArchitectService.requireQueryScope")(function* (
    scope: Scope,
    coordinatorThreadId: ThreadId,
  ) {
    const { caller, binding } = yield* resolveCaller(scope);
    if (binding !== null) {
      if (binding.coordinatorThreadId !== coordinatorThreadId) {
        return yield* new Contracts.ArchitectMcpFailure({
          code: "architect_denied",
          message: "Architect threads may only query their own binding and reviews.",
        });
      }
      return;
    }
    if (caller.thread.threadId !== coordinatorThreadId) {
      return yield* new Contracts.ArchitectMcpFailure({
        code: "capability_denied",
        message: "Only the coordinator thread itself (or a human on it) may query this binding.",
      });
    }
    const orchestrators = yield* board.listOrchestrators().pipe(Effect.mapError(unavailable));
    if (
      !orchestrators.some(
        (mark) => mark.threadId === coordinatorThreadId && mark.createdBy === "human",
      )
    ) {
      return yield* new Contracts.ArchitectMcpFailure({
        code: "capability_denied",
        message:
          "This thread is not a registered board orchestrator. Ask a human to mark this thread as a board orchestrator, then retry this tool.",
      });
    }
  });

  return ArchitectService.of({
    getBinding: Effect.fn("Ft3ArchitectService.getBinding")(function* (scope, input) {
      yield* requireQueryScope(scope, input.coordinatorThreadId);
      const binding = yield* repo
        .getActiveBindingByCoordinator(input.coordinatorThreadId)
        .pipe(Effect.mapError(unavailable));
      return { binding };
    }),
    listReviews: Effect.fn("Ft3ArchitectService.listReviews")(function* (scope, input) {
      yield* requireQueryScope(scope, input.coordinatorThreadId);
      const reviews = yield* repo
        .listReviewsByCoordinator({
          coordinatorThreadId: input.coordinatorThreadId,
          ...(input.status === undefined ? {} : { status: input.status }),
        })
        .pipe(Effect.mapError(unavailable));
      return { reviews };
    }),
  });
});

export const layer = Layer.effect(ArchitectService, make);

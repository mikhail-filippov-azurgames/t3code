import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { toolkitRegistration } from "../../../apps/server/src/mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../../apps/server/src/mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../apps/server/src/mcp/McpToolAccess.ts";
import * as FeatureGate from "@t3tools/ft3-policies/server";
import * as BoardRepository from "./BoardRepository.ts";
import * as BoardService from "./BoardService.ts";
import { requireBoardWith } from "./featureGuard.ts";
import { planFailureCode } from "./rpc.ts";
import * as PlanService from "./PlanService.ts";
import * as Contracts from "./contracts.ts";
import { toolkit } from "./tools.ts";

const taskNotFound = () =>
  new Contracts.BoardMcpFailure({
    code: "task_not_found",
    message: "The board card was not found.",
  });
const planFailure = (failure: PlanService.PlanError): Contracts.BoardMcpFailure =>
  new Contracts.BoardMcpFailure({ code: planFailureCode(failure), message: failure.message });
const unavailable = () =>
  new Contracts.BoardMcpFailure({
    code: "orchestration_error",
    message: "The board operation could not be completed.",
  });

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const gate = yield* FeatureGate.FeatureGate;
    const requireBoard = requireBoardWith(gate);

    const handlers = McpToolAccess.toLayer(toolkit, {
      board_create_card: McpToolAccess.writes((input) =>
        Effect.gen(function* () {
          yield* requireBoard;
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* BoardService.BoardService;
          return yield* service.create(scope, input);
        }),
      ),
      board_list_cards: McpToolAccess.readsAsCaller((input) =>
        Effect.gen(function* () {
          yield* requireBoard;
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* BoardService.BoardService;
          return yield* service.list(scope, input);
        }),
      ),
      board_update_card: McpToolAccess.writes((input) =>
        Effect.gen(function* () {
          yield* requireBoard;
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* BoardService.BoardService;
          return yield* service.update(scope, input);
        }),
      ),
      board_delete_card: McpToolAccess.writes((input) =>
        Effect.gen(function* () {
          yield* requireBoard;
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* BoardService.BoardService;
          return yield* service.delete(scope, input);
        }),
      ),
      plan_read: McpToolAccess.readsAsCaller((input) =>
        Effect.gen(function* () {
          yield* requireBoard;
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const caller = yield* McpInvocationContext.requireThreadScope(scope, "Plan tools");
          const repo = yield* BoardRepository.BoardRepository;
          const card = yield* repo.getCard(input.cardId).pipe(Effect.mapError(() => unavailable()));
          if (card === null || card.orchestratorThreadId !== caller.thread.threadId) {
            return yield* taskNotFound();
          }
          const plans = yield* PlanService.PlanService;
          const detail = yield* plans
            .readDetail({ cardId: input.cardId, version: input.version ?? "current" })
            .pipe(Effect.mapError(planFailure));
          return {
            cardId: input.cardId,
            state: detail.record.state,
            doc: detail.doc,
            sha256: detail.sha256,
            stepIds: detail.stepIds,
            content: detail.content,
          };
        }),
      ),
      plan_submit_for_discussion: McpToolAccess.writes((input) =>
        Effect.gen(function* () {
          yield* requireBoard;
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const caller = yield* McpInvocationContext.requireThreadScope(scope, "Plan tools");
          const repo = yield* BoardRepository.BoardRepository;
          const card = yield* repo.getCard(input.cardId).pipe(Effect.mapError(() => unavailable()));
          if (card === null || card.orchestratorThreadId !== caller.thread.threadId) {
            return yield* taskNotFound();
          }
          const plans = yield* PlanService.PlanService;
          return yield* plans.submitForDiscussion(input.cardId).pipe(Effect.mapError(planFailure));
        }),
      ),
    });

    return toolkitRegistration(toolkit, handlers).pipe(
      Layer.provide(BoardService.layer),
      Layer.provide(BoardRepository.layer),
    );
  }),
).pipe(Layer.provide(FeatureGate.layer));
export { appliedRoutingPolicyRef } from "@t3tools/ft3-policies/server";

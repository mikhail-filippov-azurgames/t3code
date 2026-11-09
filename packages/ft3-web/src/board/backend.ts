import { FT3_BOARD_WS_METHODS as WS_METHODS } from "@t3tools/ft3-board/rpc-contracts";
import {
  MessageId,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import type { Atom, AtomRegistry } from "effect/reactivity";

import { startThreadTurn } from "@t3tools/client-runtime/operations";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";

export interface BoardOrchestratorRequestInput {
  readonly threadId: ThreadId;
  readonly text: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export function createBoardEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry.EnvironmentRegistry | SecureRandom.SecureRandom | R,
    E
  >,
) {
  const commandScheduler = createAtomCommandScheduler();
  const serial = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: EnvironmentId }) => environmentId,
  };

  const orchestratorsList = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:board:orchestrators-list",
    tag: WS_METHODS.boardOrchestratorsList,
    staleTimeMs: 15_000,
    refreshIntervalMs: 15_000,
  });
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:board:list",
    tag: WS_METHODS.boardList,
    staleTimeMs: 15_000,
    refreshIntervalMs: 15_000,
  });
  const resolve = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:board:resolve",
    tag: WS_METHODS.boardResolve,
    staleTimeMs: 15_000,
    refreshIntervalMs: 15_000,
  });
  const delegations = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:board:executor-delegations",
    tag: WS_METHODS.boardExecutorDelegations,
    staleTimeMs: 15_000,
    refreshIntervalMs: 15_000,
  });
  const delegatedTaskSummaryHistory = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:board:delegated-summary-history",
    tag: WS_METHODS.boardDelegatedTaskSummaryHistory,
    staleTimeMs: 15_000,
    refreshIntervalMs: 15_000,
  });
  // The chat side panel reads the card list to scope the Mail tab; it polls on
  // its own visibility gate instead of the board page's fixed interval.
  const listForChatPanel = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:board:list-chat-panel",
    tag: WS_METHODS.boardList,
    staleTimeMs: 60_000,
  });
  const refreshLists = (environmentId: EnvironmentId, registry: AtomRegistry.AtomRegistry) => {
    registry.refresh(list({ environmentId, input: {} }));
    registry.refresh(list({ environmentId, input: { includeArchived: true } }));
    registry.refresh(listForChatPanel({ environmentId, input: { includeArchived: true } }));
  };
  const refreshAll = (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      registry.refresh(orchestratorsList({ environmentId, input: {} }));
      refreshLists(environmentId, registry);
    });
  const refreshCards = (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => refreshLists(environmentId, registry));

  const requestOrchestrator = createEnvironmentCommand(runtime, {
    label: "environment-data:board:request-orchestrator",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (input: BoardOrchestratorRequestInput) => sendOrchestratorRequest(input),
  });

  return {
    orchestratorsList,
    list,
    listForChatPanel,
    resolve,
    delegations,
    delegatedTaskSummaryHistory,
    orchestratorAdd: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:board:orchestrator-add",
      tag: WS_METHODS.boardOrchestratorAdd,
      scheduler: commandScheduler,
      concurrency: serial,
      onSuccess: refreshAll,
    }),
    orchestratorRemove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:board:orchestrator-remove",
      tag: WS_METHODS.boardOrchestratorRemove,
      scheduler: commandScheduler,
      concurrency: serial,
      onSuccess: refreshAll,
    }),
    resendBrief: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:board:orchestrator-resend-brief",
      tag: WS_METHODS.boardOrchestratorResendBrief,
      scheduler: commandScheduler,
      concurrency: serial,
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:board:create",
      tag: WS_METHODS.boardCreate,
      scheduler: commandScheduler,
      concurrency: serial,
      onSuccess: refreshCards,
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:board:start",
      tag: WS_METHODS.boardStart,
      scheduler: commandScheduler,
      concurrency: serial,
      onSuccess: refreshCards,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:board:update",
      tag: WS_METHODS.boardUpdate,
      scheduler: commandScheduler,
      concurrency: serial,
      onSuccess: refreshCards,
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:board:delete",
      tag: WS_METHODS.boardDelete,
      scheduler: commandScheduler,
      concurrency: serial,
      onSuccess: refreshCards,
    }),
    requestOrchestrator,
  };
}

const sendOrchestratorRequest = Effect.fn("Ft3Board.sendOrchestratorRequest")(function* (
  input: BoardOrchestratorRequestInput,
) {
  const random = yield* SecureRandom.SecureRandom;
  const messageId = yield* random.uuidV4().pipe(Effect.map(MessageId.make));
  return yield* startThreadTurn({
    threadId: input.threadId,
    message: { messageId, role: "user", text: input.text, attachments: [] },
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
  });
});

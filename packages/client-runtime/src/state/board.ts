/**
 * Orchestrator board reads and writes for one environment.
 *
 * The server owns the orchestrator registry, cards, and progress history:
 * `board.orchestrators.list` and `board.list` answer with the environment's
 * state, and a successful mutation refreshes the affected read so callers never
 * merge a local write against a stale list.
 *
 * The human cannot stop, reassign, or re-status a card (design §5); the UI
 * offers a request instead. That request reuses the ordinary thread-turn
 * command: the orchestrator thread receives a user message and starts a turn.
 * The server-only `thread.message.system.append` command is not in the client
 * command union, so there is no client system-note path to reuse.
 *
 * @module state/board
 */
import {
  MessageId,
  WS_METHODS,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { Atom, AtomRegistry } from "effect/unstable/reactivity";

import { startThreadTurn } from "../operations/commands.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * A message the human sends when a forbidden card action needs the
 * orchestrator. The turn runs with the orchestrator thread's own provider
 * settings so the request is a normal follow-up, not a new conversation.
 */
export interface BoardOrchestratorRequestInput {
  readonly threadId: ThreadId;
  readonly text: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export function createBoardEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
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
  });
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:board:list",
    tag: WS_METHODS.boardList,
    staleTimeMs: 15_000,
  });

  // Registry changes also cascade cards, so both reads refresh together.
  const refreshAll = (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      registry.refresh(orchestratorsList({ environmentId, input: {} }));
      registry.refresh(list({ environmentId, input: {} }));
    });
  const refreshCards = (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => registry.refresh(list({ environmentId, input: {} })));

  const requestOrchestrator = createEnvironmentCommand(runtime, {
    label: "environment-data:board:request-orchestrator",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (input: BoardOrchestratorRequestInput) => sendOrchestratorRequest(input),
  });

  return {
    orchestratorsList,
    list,
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
    // Re-delivery appends a notice and may start a turn, but changes neither the
    // registry nor the cards, so no read refresh is needed.
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

function sendOrchestratorRequest(input: BoardOrchestratorRequestInput) {
  return Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const messageId = yield* crypto.randomUUIDv4.pipe(Effect.map(MessageId.make));
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    return yield* startThreadTurn({
      threadId: input.threadId,
      message: { messageId, role: "user", text: input.text, attachments: [] },
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      createdAt,
    });
  });
}

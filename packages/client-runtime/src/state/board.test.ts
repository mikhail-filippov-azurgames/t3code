import { describe, expect, it } from "@effect/vitest";
import {
  BoardCardId,
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  type BoardCard,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { createBoardEnvironmentAtoms } from "./board.ts";
import { runAtomCommand } from "./runtime.ts";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const NOW = "2026-01-05T08:00:00.000Z";

function makeCard(cardId: string): BoardCard {
  return {
    cardId: BoardCardId.make(cardId),
    orchestratorThreadId: threadId,
    title: "Wire board contracts",
    body: "Add the board page.",
    status: "todo",
    createdBy: "human",
    assignee: createModelSelection(ProviderInstanceId.make("codex"), "gpt-6-astra"),
    executorRole: "implementation",
    executorThreadId: null,
    outcome: null,
    lastError: null,
    failureStreak: 0,
    order: 0,
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** A connected environment whose board RPCs are recorded, with in-memory lists. */
const makeHarness = Effect.fn("boardTest.makeHarness")(function* () {
  const calls: string[] = [];
  const cards: BoardCard[] = [];
  const orchestrators: string[] = [];
  const dispatched: ClientOrchestrationCommand[] = [];
  const client = {
    [WS_METHODS.boardOrchestratorsList]: () => {
      calls.push(WS_METHODS.boardOrchestratorsList);
      return Effect.succeed({
        orchestrators: orchestrators.map((id) => ({
          threadId: ThreadId.make(id),
          createdBy: "human" as const,
          createdAt: NOW,
        })),
      });
    },
    [WS_METHODS.boardList]: () => {
      calls.push(WS_METHODS.boardList);
      return Effect.succeed({ cards: [...cards] });
    },
    [WS_METHODS.boardOrchestratorAdd]: () => {
      calls.push(WS_METHODS.boardOrchestratorAdd);
      orchestrators.push(threadId as string);
      return Effect.succeed({ threadId, createdBy: "human" as const, createdAt: NOW });
    },
    [WS_METHODS.boardCreate]: () => {
      calls.push(WS_METHODS.boardCreate);
      const card = makeCard("card-created");
      cards.push(card);
      return Effect.succeed(card);
    },
    [WS_METHODS.boardStart]: () => {
      calls.push(WS_METHODS.boardStart);
      return Effect.succeed(makeCard("card-started"));
    },
    [WS_METHODS.boardUpdate]: () => {
      calls.push(WS_METHODS.boardUpdate);
      return Effect.succeed(makeCard("card-updated"));
    },
    [WS_METHODS.boardDelete]: () => {
      calls.push(WS_METHODS.boardDelete);
      return Effect.succeed({});
    },
    [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) => {
      calls.push(ORCHESTRATION_WS_METHODS.dispatchCommand);
      dispatched.push(command);
      return Effect.succeed({ sequence: 1 });
    },
  } as unknown as WsRpcProtocolClient;
  const session = { client } as RpcSession;
  const supervisor = EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId,
      label: "local",
      httpBaseUrl: "https://environment.test",
      wsBaseUrl: "wss://environment.test",
    }),
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected" as const,
    }),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const environments = EnvironmentRegistry.of({
    run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
    followStream: (_id, stream) => Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry["Service"]);
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const atoms = createBoardEnvironmentAtoms(
    Atom.runtime(
      Layer.mergeAll(
        Layer.succeed(EnvironmentRegistry, environments),
        Layer.succeed(
          Crypto.Crypto,
          Crypto.make({
            randomBytes: (size) => new Uint8Array(size),
            digest: (_algorithm, data) => Effect.succeed(data),
          }),
        ),
      ),
    ),
  );
  return { atoms, calls, dispatched, registry };
});

describe("createBoardEnvironmentAtoms", () => {
  it.effect("create persists on the server and refreshes the card list", () =>
    Effect.gen(function* () {
      const { atoms, calls, registry } = yield* makeHarness();
      const listAtom = atoms.list({ environmentId, input: {} });

      const initial = yield* AtomRegistry.getResult(registry, listAtom, {
        suspendOnWaiting: true,
      });
      expect(initial.cards).toEqual([]);

      const result = yield* Effect.promise(() =>
        runAtomCommand(
          registry,
          atoms.create,
          {
            environmentId,
            input: {
              orchestratorThreadId: threadId,
              title: "Wire board contracts",
              body: "Add the board page.",
              executorRole: "implementation",
            },
          },
          { reportFailure: false },
        ),
      );
      expect(AsyncResult.isSuccess(result)).toBe(true);
      expect(calls).toContain(WS_METHODS.boardCreate);

      const refreshed = yield* AtomRegistry.getResult(registry, listAtom, {
        suspendOnWaiting: true,
      });
      expect(refreshed.cards.map((card) => card.cardId as string)).toEqual(["card-created"]);
      expect(calls.filter((call) => call === WS_METHODS.boardList)).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("orchestratorAdd refreshes both the registry and the cards", () =>
    Effect.gen(function* () {
      const { atoms, calls, registry } = yield* makeHarness();
      const listAtom = atoms.list({ environmentId, input: {} });
      const orchestratorsAtom = atoms.orchestratorsList({ environmentId, input: {} });

      yield* AtomRegistry.getResult(registry, listAtom, { suspendOnWaiting: true });
      yield* AtomRegistry.getResult(registry, orchestratorsAtom, { suspendOnWaiting: true });

      const result = yield* Effect.promise(() =>
        runAtomCommand(
          registry,
          atoms.orchestratorAdd,
          { environmentId, input: { threadId } },
          { reportFailure: false },
        ),
      );
      expect(AsyncResult.isSuccess(result)).toBe(true);
      expect(calls).toContain(WS_METHODS.boardOrchestratorAdd);

      const orchestrators = yield* AtomRegistry.getResult(registry, orchestratorsAtom, {
        suspendOnWaiting: true,
      });
      expect(orchestrators.orchestrators.map((entry) => entry.threadId as string)).toEqual([
        threadId as string,
      ]);
      expect(calls.filter((call) => call === WS_METHODS.boardList)).toHaveLength(2);
      expect(calls.filter((call) => call === WS_METHODS.boardOrchestratorsList)).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("requestOrchestrator sends the request as a turn on the orchestrator thread", () =>
    Effect.gen(function* () {
      const { atoms, dispatched, registry } = yield* makeHarness();
      const result = yield* Effect.promise(() =>
        runAtomCommand(
          registry,
          atoms.requestOrchestrator,
          {
            environmentId,
            input: {
              threadId,
              text: "Please reassign card card-1.",
              modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-6-astra"),
              runtimeMode: "full-access",
              interactionMode: "default",
            },
          },
          { reportFailure: false },
        ),
      );
      expect(AsyncResult.isSuccess(result)).toBe(true);
      expect(dispatched).toHaveLength(1);
      const command = dispatched[0]!;
      expect(command.type).toBe("thread.turn.start");
      if (command.type === "thread.turn.start") {
        expect(command.threadId).toBe(threadId);
        expect(command.message.text).toBe("Please reassign card card-1.");
      }
    }).pipe(Effect.scoped),
  );
});

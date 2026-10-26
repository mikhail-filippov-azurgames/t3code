import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, EnvironmentAuthorizationError } from "@t3tools/contracts";
import {
  BoardCardId,
  BoardMcpFailure,
  type BoardCard,
  type BoardListInput,
} from "@t3tools/ft3-board/contracts";
import {
  type PreparedConnection,
  type SupervisorConnectionState,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import type { RpcSession, WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { createBoardEnvironmentAtoms } from "./backend.ts";

const environmentId = EnvironmentId.make("board-test");
const threadId = ThreadId.make("coordinator");
const card: BoardCard = {
  cardId: BoardCardId.make("11111111-1111-4111-8111-111111111111"),
  orchestratorThreadId: threadId,
  title: "Ship S3",
  body: "Acceptance",
  status: "todo",
  readiness: "ready",
  readinessNote: null,
  createdBy: "human",
  assignee: null,
  executorRole: "implementation",
  executorThreadId: null,
  outcome: null,
  lastError: null,
  failureStreak: 0,
  order: 0,
  archived: false,
  createdAt: "2026-10-26T00:00:00Z",
  updatedAt: "2026-10-26T00:00:00Z",
};

const makeHarness = Effect.fn("Ft3BoardTest.makeHarness")(function* (
  failure?: BoardMcpFailure | EnvironmentAuthorizationError,
) {
  const calls: Array<{ method: string; input: unknown }> = [];
  const cards: BoardCard[] = [];
  const coordinators: Array<{ threadId: ThreadId; createdBy: "human"; createdAt: string }> = [];
  const record = <A>(method: string, input: unknown, value: () => A) => {
    calls.push({ method, input });
    return failure && method === "board.start" ? Effect.fail(failure) : Effect.sync(value);
  };
  const client = {
    "board.list": (input: BoardListInput) =>
      record("board.list", input, () => ({ cards: [...cards], events: [] })),
    "board.orchestrators.list": (input: unknown) =>
      record("board.orchestrators.list", input, () => ({ orchestrators: [...coordinators] })),
    "board.create": (input: unknown) =>
      record("board.create", input, () => {
        cards.push(card);
        return card;
      }),
    "board.start": (input: unknown) => record("board.start", input, () => card),
    "board.update": (input: unknown) => record("board.update", input, () => card),
    "board.delete": (input: unknown) => record("board.delete", input, () => ({})),
    "board.resolve": (input: unknown) =>
      record("board.resolve", input, () => ({
        matches: [],
        details: [{ card, orchestratorThreadTitle: "Coordinator", events: [] }],
      })),
    "board.executorDelegations": (input: unknown) =>
      record("board.executorDelegations", input, () => ({
        delegations: [
          {
            taskId: "task:one",
            childThreadId: ThreadId.make("executor-child"),
            title: "Probe the parser",
            latestStatus: "completed" as const,
            latestTurnId: null,
            updatedAt: card.updatedAt,
            summary: null,
          },
        ],
        nextCursor: null,
      })),
    "board.orchestrator.add": (input: unknown) =>
      record("board.orchestrator.add", input, () => {
        const entry = { threadId, createdBy: "human" as const, createdAt: card.createdAt };
        coordinators.push(entry);
        return entry;
      }),
    "board.orchestrator.remove": (input: unknown) =>
      record("board.orchestrator.remove", input, () => ({})),
    "board.orchestrator.resendBrief": (input: unknown) =>
      record("board.orchestrator.resendBrief", input, () => ({})),
  } as unknown as WsRpcProtocolClient;
  const session = { client } as RpcSession;
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>({
    ...AVAILABLE_CONNECTION_STATE,
    phase: "connected" as const,
  });
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId,
      label: "board",
      httpBaseUrl: "https://board.test",
      wsBaseUrl: "wss://board.test",
    }),
    state,
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    _id,
    stream,
  ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const environments = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
    followStream,
    stateChanges: () => SubscriptionRef.changes(state),
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const atoms = createBoardEnvironmentAtoms(
    Atom.runtime(
      Layer.mergeAll(
        Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments),
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
  return { atoms, calls, registry };
});

describe("FT3 board WS client", () => {
  it.effect("creates a card through the session and refreshes both mounted archive variants", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, calls, registry } = yield* makeHarness();
        const active = atoms.list({ environmentId, input: {} });
        const archived = atoms.list({ environmentId, input: { includeArchived: true } });
        yield* AtomRegistry.mount(registry, active);
        yield* AtomRegistry.mount(registry, archived);
        yield* AtomRegistry.getResult(registry, active, { suspendOnWaiting: true });
        yield* AtomRegistry.getResult(registry, archived, { suspendOnWaiting: true });
        const input = {
          orchestratorThreadId: threadId,
          title: "Ship S3",
          body: "Acceptance",
          executorRole: "implementation" as const,
        };
        const result = yield* Effect.promise(() =>
          runAtomCommand(
            registry,
            atoms.create,
            { environmentId, input },
            { reportFailure: false },
          ),
        );
        expect(AsyncResult.isSuccess(result)).toBe(true);
        expect(calls).toContainEqual({ method: "board.create", input });
        expect(
          (yield* AtomRegistry.getResult(registry, active, { suspendOnWaiting: true })).cards,
        ).toEqual([card]);
        expect(
          (yield* AtomRegistry.getResult(registry, archived, { suspendOnWaiting: true })).cards,
        ).toEqual([card]);
        expect(calls.filter((call) => call.method === "board.list")).toHaveLength(4);
      }),
    ),
  );

  it.effect("routes registered mutations and pinned lookup to their ft3 methods", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, calls, registry } = yield* makeHarness();
        yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.orchestratorAdd, { environmentId, input: { threadId } }),
        );
        yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.resendBrief, { environmentId, input: { threadId } }),
        );
        yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.start, { environmentId, input: { cardId: card.cardId } }),
        );
        yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.update, {
            environmentId,
            input: { cardId: card.cardId, archived: true },
          }),
        );
        const resolved = yield* AtomRegistry.getResult(
          registry,
          atoms.resolve({ environmentId, input: { tokens: [], cardIds: [card.cardId] } }),
          { suspendOnWaiting: true },
        );
        expect(resolved.details[0]?.card).toEqual(card);
        const delegations = yield* AtomRegistry.getResult(
          registry,
          atoms.delegations({ environmentId, input: { cardId: card.cardId } }),
          { suspendOnWaiting: true },
        );
        expect(delegations.delegations[0]?.title).toBe("Probe the parser");
        expect(calls.map((call) => call.method)).toEqual([
          "board.orchestrator.add",
          "board.orchestrator.resendBrief",
          "board.start",
          "board.update",
          "board.resolve",
          "board.executorDelegations",
        ]);
        expect(calls[3]?.input).toEqual({ cardId: card.cardId, archived: true });
      }),
    ),
  );

  it.effect("keeps server failures observable without refreshing successful data", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failure = new BoardMcpFailure({
          code: "readiness_not_ready",
          message: "Waiting for human input.",
        });
        const { atoms, calls, registry } = yield* makeHarness(failure);
        const list = atoms.list({ environmentId, input: {} });
        yield* AtomRegistry.mount(registry, list);
        yield* AtomRegistry.getResult(registry, list, { suspendOnWaiting: true });
        const result = yield* Effect.promise(() =>
          runAtomCommand(
            registry,
            atoms.start,
            { environmentId, input: { cardId: card.cardId } },
            { reportFailure: false },
          ),
        );
        expect(AsyncResult.isFailure(result)).toBe(true);
        expect(calls.filter((call) => call.method === "board.list")).toHaveLength(1);
      }),
    ),
  );
});

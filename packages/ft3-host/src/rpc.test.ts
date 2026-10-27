import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as BoardContracts from "@t3tools/ft3-board/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import { FT3_WS_METHODS, authorizationLayer, group } from "./rpc.ts";

const cardId = BoardContracts.BoardCardId.make("11111111-1111-4111-8111-111111111111");
const card = {
  cardId,
  orchestratorThreadId: ThreadId.make("coordinator"),
  title: "Ship the board slice",
  body: "",
  status: "todo" as const,
  readiness: "ready" as const,
  readinessNote: null,
  createdBy: "human" as const,
  assignee: null,
  executorRole: "implementation" as const,
  executorThreadId: null,
  outcome: null,
  lastError: null,
  failureStreak: 0,
  order: 0,
  archived: false,
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
};

const piStatus = {
  instanceId: "pi",
  phase: "stopped" as const,
  ready: false,
  endpoint: "http://127.0.0.1:8080/v1",
  model: null,
  modelIds: [],
  owned: false,
  canStart: true,
  error: null,
};

const stubs = {
  [FT3_WS_METHODS.boardOrchestratorsList]: () => Effect.succeed({ orchestrators: [] }),
  [FT3_WS_METHODS.boardOrchestratorAdd]: () =>
    Effect.succeed({
      threadId: ThreadId.make("coordinator"),
      createdBy: "human" as const,
      createdAt: "2026-10-26T00:00:00.000Z",
    }),
  [FT3_WS_METHODS.boardOrchestratorRemove]: () => Effect.succeed({}),
  [FT3_WS_METHODS.boardOrchestratorResendBrief]: () => Effect.succeed({}),
  [FT3_WS_METHODS.boardResolve]: () => Effect.succeed({ matches: [], details: [] }),
  [FT3_WS_METHODS.boardExecutorDelegations]: () =>
    Effect.succeed({ delegations: [], nextCursor: null }),
  [FT3_WS_METHODS.boardList]: () => Effect.succeed({ cards: [], events: [] }),
  [FT3_WS_METHODS.boardCreate]: () => Effect.succeed(card),
  [FT3_WS_METHODS.boardStart]: () => Effect.succeed(card),
  [FT3_WS_METHODS.boardUpdate]: () => Effect.succeed(card),
  [FT3_WS_METHODS.boardDelete]: () => Effect.succeed({}),
  [FT3_WS_METHODS.getCoordinatorArchitectSidebar]: () =>
    Effect.succeed({ binding: null, reviews: [], publishable: [] }),
  [FT3_WS_METHODS.getCoordinatorArchitectSidebarByArchitect]: () =>
    Effect.succeed({ binding: null, reviews: [], publishable: [] }),
  [FT3_WS_METHODS.publishArchitectPublication]: () =>
    Effect.succeed({ reviewId: "review", status: "published" as const }),
  [FT3_WS_METHODS.vcsListCommitHistory]: () =>
    Effect.succeed({ commits: [], isRepo: false, nextCursor: null }),
  [FT3_WS_METHODS.vcsListRefs]: () => Effect.succeed({ refs: [], isRepo: false }),
  [FT3_WS_METHODS.vcsGetCommitDiff]: () =>
    Effect.succeed({ commit: "0".repeat(40), patch: "", truncated: false }),
  [FT3_WS_METHODS.piInferenceServerStatus]: () => Effect.succeed(piStatus),
  [FT3_WS_METHODS.piInferenceServerStart]: () => Effect.succeed(piStatus),
  [FT3_WS_METHODS.piInferenceServerStop]: () => Effect.succeed(piStatus),
};

const clientWith = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  RpcTest.makeClient(group).pipe(
    Effect.provide(Layer.merge(group.toLayer(stubs), authorizationLayer(scopes))),
  );

describe("FT3 RPC scope map", () => {
  it("declares exactly one scope for every FT3 RPC in the group", () => {
    expect(new Set(Object.values(FT3_WS_METHODS))).toEqual(new Set(group.requests.keys()));
  });
});

describe("FT3 RPC authorization", () => {
  it.effect("calls every FT3 RPC method through the harness with its scope", () =>
    Effect.gen(function* () {
      const client = yield* clientWith([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
      expect(yield* client[FT3_WS_METHODS.boardOrchestratorsList]({})).toEqual({
        orchestrators: [],
      });
      expect(
        yield* client[FT3_WS_METHODS.boardOrchestratorAdd]({ threadId: ThreadId.make("c") }),
      ).toMatchObject({ createdBy: "human" });
      expect(
        yield* client[FT3_WS_METHODS.boardOrchestratorRemove]({ threadId: ThreadId.make("c") }),
      ).toEqual({});
      expect(
        yield* client[FT3_WS_METHODS.boardOrchestratorResendBrief]({
          threadId: ThreadId.make("c"),
        }),
      ).toEqual({});
      expect(yield* client[FT3_WS_METHODS.boardResolve]({ tokens: [], cardIds: [] })).toEqual({
        matches: [],
        details: [],
      });
      expect(yield* client[FT3_WS_METHODS.boardExecutorDelegations]({ cardId })).toEqual({
        delegations: [],
        nextCursor: null,
      });
      expect(yield* client[FT3_WS_METHODS.boardList]({})).toEqual({ cards: [], events: [] });
      expect(
        yield* client[FT3_WS_METHODS.boardCreate]({
          orchestratorThreadId: ThreadId.make("c"),
          title: "Ship the board slice",
          body: "",
          executorRole: "implementation",
        }),
      ).toMatchObject({ status: "todo" });
      expect(yield* client[FT3_WS_METHODS.boardStart]({ cardId })).toMatchObject({ cardId });
      expect(yield* client[FT3_WS_METHODS.boardUpdate]({ cardId, archived: true })).toMatchObject({
        cardId,
      });
      expect(yield* client[FT3_WS_METHODS.boardDelete]({ cardId })).toEqual({});
      expect(
        yield* client[FT3_WS_METHODS.getCoordinatorArchitectSidebar]({
          coordinatorThreadId: ThreadId.make("c"),
        }),
      ).toEqual({ binding: null, reviews: [], publishable: [] });
      expect(
        yield* client[FT3_WS_METHODS.getCoordinatorArchitectSidebarByArchitect]({
          architectThreadId: ThreadId.make("architect"),
        }),
      ).toEqual({ binding: null, reviews: [], publishable: [] });
      expect(
        yield* client[FT3_WS_METHODS.publishArchitectPublication]({
          reviewId: "review",
          idempotencyKey: "key",
        }),
      ).toEqual({ reviewId: "review", status: "published" });
      expect(
        yield* client[FT3_WS_METHODS.vcsListCommitHistory]({ cwd: "/repo", limit: 10 }),
      ).toEqual({ commits: [], isRepo: false, nextCursor: null });
      expect(yield* client[FT3_WS_METHODS.vcsListRefs]({ cwd: "/repo" })).toEqual({
        refs: [],
        isRepo: false,
      });
      expect(
        yield* client[FT3_WS_METHODS.vcsGetCommitDiff]({ cwd: "/repo", commit: "0".repeat(40) }),
      ).toEqual({ commit: "0".repeat(40), patch: "", truncated: false });
      const piInput = { instanceId: ProviderInstanceId.make("pi"), model: "bonsai-2-27b" };
      expect(yield* client[FT3_WS_METHODS.piInferenceServerStatus](piInput)).toEqual(piStatus);
      expect(yield* client[FT3_WS_METHODS.piInferenceServerStart](piInput)).toEqual(piStatus);
      expect(yield* client[FT3_WS_METHODS.piInferenceServerStop](piInput)).toEqual(piStatus);
    }).pipe(Effect.scoped),
  );

  it.effect("denies every FT3 RPC method without its scope", () =>
    Effect.gen(function* () {
      const client = yield* clientWith([]);
      const read = AuthOrchestrationReadScope;
      const operate = AuthOrchestrationOperateScope;
      expect(
        yield* client[FT3_WS_METHODS.boardOrchestratorsList]({}).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: read });
      expect(
        yield* client[FT3_WS_METHODS.boardOrchestratorAdd]({ threadId: ThreadId.make("c") }).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: operate });
      expect(
        yield* client[FT3_WS_METHODS.boardOrchestratorRemove]({
          threadId: ThreadId.make("c"),
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: operate });
      expect(
        yield* client[FT3_WS_METHODS.boardOrchestratorResendBrief]({
          threadId: ThreadId.make("c"),
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: operate });
      expect(
        yield* client[FT3_WS_METHODS.boardResolve]({ tokens: [], cardIds: [] }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: read });
      expect(
        yield* client[FT3_WS_METHODS.boardExecutorDelegations]({ cardId }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: read });
      expect(yield* client[FT3_WS_METHODS.boardList]({}).pipe(Effect.flip)).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: read,
      });
      expect(
        yield* client[FT3_WS_METHODS.boardCreate]({
          orchestratorThreadId: ThreadId.make("c"),
          title: "Ship the board slice",
          body: "",
          executorRole: "implementation",
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: operate });
      expect(yield* client[FT3_WS_METHODS.boardStart]({ cardId }).pipe(Effect.flip)).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: operate,
      });
      expect(
        yield* client[FT3_WS_METHODS.boardUpdate]({ cardId, archived: true }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: operate });
      expect(yield* client[FT3_WS_METHODS.boardDelete]({ cardId }).pipe(Effect.flip)).toMatchObject(
        {
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: operate,
        },
      );
      expect(
        yield* client[FT3_WS_METHODS.getCoordinatorArchitectSidebar]({
          coordinatorThreadId: ThreadId.make("c"),
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: read });
      expect(
        yield* client[FT3_WS_METHODS.getCoordinatorArchitectSidebarByArchitect]({
          architectThreadId: ThreadId.make("architect"),
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: read });
      expect(
        yield* client[FT3_WS_METHODS.publishArchitectPublication]({
          reviewId: "review",
          idempotencyKey: "key",
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: operate });
      expect(
        yield* client[FT3_WS_METHODS.vcsListCommitHistory]({ cwd: "/repo" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: read });
      expect(
        yield* client[FT3_WS_METHODS.vcsListRefs]({ cwd: "/repo" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: read });
      expect(
        yield* client[FT3_WS_METHODS.vcsGetCommitDiff]({
          cwd: "/repo",
          commit: "0".repeat(40),
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: read });
      const piInput = { instanceId: ProviderInstanceId.make("pi") };
      expect(
        yield* client[FT3_WS_METHODS.piInferenceServerStatus](piInput).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: read });
      expect(
        yield* client[FT3_WS_METHODS.piInferenceServerStart](piInput).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: operate });
      expect(
        yield* client[FT3_WS_METHODS.piInferenceServerStop](piInput).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: operate });
    }).pipe(Effect.scoped),
  );
});

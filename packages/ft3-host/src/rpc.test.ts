import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  type AuthEnvironmentScope,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as BoardContracts from "@t3tools/ft3-board/contracts";
import {
  FEATURE_IDS,
  type PolicyDocumentKey,
  type FeatureResolution,
} from "@t3tools/ft3-policies/contracts";
import * as MailContracts from "@t3tools/ft3-mail/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Schema from "effect/Schema";

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

const mailTask = Schema.decodeSync(MailContracts.MailTask)({
  taskId: "task:timeline",
  title: "Timeline",
  brief: "Read the timeline.",
  level: "medium",
  cardId: null,
  isolation: null,
  runtimeMode: null,
  interactionMode: null,
  responseBudgetSeconds: 1800,
  status: "open",
  outcome: null,
  summary: null,
  createdByThreadId: "thread:lead",
  clientRequestId: "request:timeline",
  requestFingerprint: "fp",
  createdAt: "2026-11-04T00:00:00.000Z",
  updatedAt: "2026-11-04T00:00:00.000Z",
  closedAt: null,
});

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

const piProfile = {
  model: "ft3-local/bonsai-2-27b",
  baseUrl: "http://127.0.0.1:8080/v1",
  executablePath: "C:\\Bonsai\\bin\\llama-server.exe",
  modelPath: "C:\\Bonsai\\models\\bonsai.gguf",
  gpuLayers: 48,
  contextSize: 81_920,
  parallel: 1,
  temperature: 1,
  topP: 0.95,
  topK: 20,
  minP: 0.05,
  flashAttention: true,
  cacheTypeK: "q4_0" as const,
  cacheTypeV: "q4_0" as const,
  jinja: true,
  reasoning: true,
  reasoningEffort: "medium" as const,
};

const noRequirements = {
  documentsStore: false,
  rolesManifest: false,
  leadSkills: false,
  leadRole: false,
  routingPolicy: false,
  requestedRoles: false,
  plannerRole: false,
  architectRole: false,
  planOrchestratorSkill: false,
};

const noFeatures: Record<(typeof FEATURE_IDS)[number], FeatureResolution> = Object.fromEntries(
  FEATURE_IDS.map((id) => [
    id,
    { id, requestedEnabled: false, effectiveEnabled: false, offReason: null },
  ]),
) as Record<(typeof FEATURE_IDS)[number], FeatureResolution>;

const noSnapshot = {
  configVersion: 1,
  documents: [],
  requirements: noRequirements,
  features: noFeatures,
  needsAttention: false,
  warnings: [],
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
  [FT3_WS_METHODS.boardDelegatedTaskSummaryHistory]: () =>
    Effect.succeed({ records: [], nextCursor: null }),
  [FT3_WS_METHODS.boardList]: () => Effect.succeed({ cards: [], events: [], plans: [] }),
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
  [FT3_WS_METHODS.vcsResolveCommitMentions]: () => Effect.succeed({ commits: [] }),
  [FT3_WS_METHODS.vcsListRefs]: () => Effect.succeed({ refs: [], isRepo: false }),
  [FT3_WS_METHODS.vcsGetCommitDiff]: () =>
    Effect.succeed({ commit: "0".repeat(40), patch: "", truncated: false }),
  [FT3_WS_METHODS.piInferenceServerStatus]: () => Effect.succeed(piStatus),
  [FT3_WS_METHODS.piInferenceServerStart]: () => Effect.succeed(piStatus),
  [FT3_WS_METHODS.piInferenceServerStop]: () => Effect.succeed(piStatus),
  [FT3_WS_METHODS.piInferenceProfileGet]: () => Effect.succeed(piProfile),
  [FT3_WS_METHODS.piInferenceProfileSave]: () => Effect.succeed(piProfile),
  [FT3_WS_METHODS.piBonsaiPresetDetect]: () => Effect.succeed(null),
  [FT3_WS_METHODS.piBonsaiPresetApply]: () => Effect.succeed(null),
  [FT3_WS_METHODS.docsResolve]: () => Effect.succeed({ status: "not_found" as const }),
  [FT3_WS_METHODS.docsRead]: () => Effect.succeed({ status: "not_found" as const }),
  [FT3_WS_METHODS.policiesGetSnapshot]: () => Effect.succeed(noSnapshot),
  [FT3_WS_METHODS.policiesReadDocument]: () =>
    Effect.succeed({ status: "unavailable" as const, key: "routingPolicy" as const, issues: [] }),
  [FT3_WS_METHODS.policiesSaveDocument]: () =>
    Effect.succeed({
      status: "not_writable" as const,
      snapshot: noSnapshot,
    }),
  [FT3_WS_METHODS.policiesGetPendingChange]: ({ key }: { key: PolicyDocumentKey }) =>
    Effect.succeed({ key, pending: false, change: null }),
  [FT3_WS_METHODS.policiesApplyPending]: () =>
    Effect.succeed({
      status: "nothing_pending" as const,
      snapshot: noSnapshot,
    }),
  [FT3_WS_METHODS.policiesSetApplyExternalEdits]: ({ enabled }: { enabled: boolean }) =>
    Effect.succeed({
      enabled,
      snapshot: noSnapshot,
    }),
  [FT3_WS_METHODS.policiesSetDocument]: () => Effect.succeed({ snapshot: noSnapshot }),
  [FT3_WS_METHODS.policiesSetFeature]: () => Effect.succeed({ snapshot: noSnapshot }),
  [FT3_WS_METHODS.policiesListStoreDocuments]: () => Effect.succeed({ documents: [] }),
  [FT3_WS_METHODS.policiesBrowseServerDirectory]: () =>
    Effect.succeed({ parent: null, directories: [], files: [], truncated: false }),
  [FT3_WS_METHODS.mailTimeline]: () => Effect.succeed({ task: mailTask, entries: [] }),
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
      const client = yield* clientWith([
        AuthOrchestrationReadScope,
        AuthOrchestrationOperateScope,
        AuthSettingsWriteScope,
      ]);
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
      expect(
        yield* client[FT3_WS_METHODS.boardDelegatedTaskSummaryHistory]({
          parentThreadId: ThreadId.make("c"),
        }),
      ).toEqual({ records: [], nextCursor: null });
      expect(yield* client[FT3_WS_METHODS.boardList]({})).toEqual({
        cards: [],
        events: [],
        plans: [],
      });
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
      expect(yield* client[FT3_WS_METHODS.piInferenceProfileGet](piInput)).toEqual(piProfile);
      expect(
        yield* client[FT3_WS_METHODS.piInferenceProfileSave]({
          instanceId: ProviderInstanceId.make("pi"),
          profile: piProfile,
        }),
      ).toEqual(piProfile);
      expect(yield* client[FT3_WS_METHODS.policiesGetSnapshot]({})).toEqual({
        configVersion: 1,
        documents: [],
        requirements: noRequirements,
        features: noFeatures,
        needsAttention: false,
        warnings: [],
      });
      expect(
        yield* client[FT3_WS_METHODS.policiesGetPendingChange]({ key: "routingPolicy" }),
      ).toEqual({ key: "routingPolicy", pending: false, change: null });
      expect(yield* client[FT3_WS_METHODS.policiesReadDocument]({ key: "routingPolicy" })).toEqual({
        status: "unavailable",
        key: "routingPolicy",
        issues: [],
      });
      expect(
        yield* client[FT3_WS_METHODS.policiesSaveDocument]({
          key: "routingPolicy",
          baseSha256: "a".repeat(64),
          content: "",
        }),
      ).toMatchObject({ status: "not_writable" });
      expect(
        yield* client[FT3_WS_METHODS.policiesApplyPending]({
          key: "routingPolicy",
          liveSha256: "a".repeat(64),
        }),
      ).toMatchObject({ status: "nothing_pending" });
      expect(
        yield* client[FT3_WS_METHODS.policiesSetApplyExternalEdits]({ enabled: true }),
      ).toMatchObject({ enabled: true });
      expect(
        yield* client[FT3_WS_METHODS.policiesSetDocument]({
          key: "routingPolicy",
          source: { kind: "builtin" },
        }),
      ).toMatchObject({ snapshot: { configVersion: 1 } });
      expect(
        yield* client[FT3_WS_METHODS.policiesSetFeature]({ feature: "mail", enabled: true }),
      ).toMatchObject({ snapshot: { configVersion: 1 } });
      expect(yield* client[FT3_WS_METHODS.policiesListStoreDocuments]({})).toEqual({
        documents: [],
      });
      expect(yield* client[FT3_WS_METHODS.policiesListStoreDocuments]({ query: "roles" })).toEqual({
        documents: [],
      });
      expect(
        yield* client[FT3_WS_METHODS.policiesBrowseServerDirectory]({ directory: "/srv/ft3" }),
      ).toEqual({ parent: null, directories: [], files: [], truncated: false });
      expect(yield* client[FT3_WS_METHODS.mailTimeline]({ taskId: "task:timeline" })).toEqual({
        task: mailTask,
        entries: [],
      });
      expect(yield* client[FT3_WS_METHODS.docsRead]({ ref: "plans/a.md" })).toEqual({
        status: "not_found",
      });
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
      expect(
        yield* client[FT3_WS_METHODS.boardDelegatedTaskSummaryHistory]({
          parentThreadId: ThreadId.make("c"),
        }).pipe(Effect.flip),
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
      expect(
        yield* client[FT3_WS_METHODS.piInferenceProfileGet]({
          ...piInput,
          model: "bonsai-2-27b",
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: read });
      expect(
        yield* client[FT3_WS_METHODS.piInferenceProfileSave]({
          instanceId: ProviderInstanceId.make("pi"),
          profile: piProfile,
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: operate });
      expect(yield* client[FT3_WS_METHODS.policiesGetSnapshot]({}).pipe(Effect.flip)).toMatchObject(
        { _tag: "EnvironmentAuthorizationError", requiredPermission: read },
      );
      expect(
        yield* client[FT3_WS_METHODS.policiesGetPendingChange]({
          key: "routingPolicy",
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: read });
      expect(
        yield* client[FT3_WS_METHODS.policiesReadDocument]({ key: "routingPolicy" }).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: read });
      const write = AuthSettingsWriteScope;
      expect(
        yield* client[FT3_WS_METHODS.policiesSaveDocument]({
          key: "routingPolicy",
          baseSha256: "a".repeat(64),
          content: "",
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: write });
      expect(
        yield* client[FT3_WS_METHODS.policiesApplyPending]({
          key: "routingPolicy",
          liveSha256: "a".repeat(64),
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: write });
      expect(
        yield* client[FT3_WS_METHODS.policiesSetApplyExternalEdits]({ enabled: true }).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: write });
      expect(
        yield* client[FT3_WS_METHODS.policiesSetDocument]({
          key: "routingPolicy",
          source: { kind: "builtin" },
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: write });
      expect(
        yield* client[FT3_WS_METHODS.policiesSetFeature]({ feature: "mail", enabled: true }).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: write });
      expect(
        yield* client[FT3_WS_METHODS.policiesListStoreDocuments]({}).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: read });
      expect(
        yield* client[FT3_WS_METHODS.policiesBrowseServerDirectory]({
          directory: "/srv/ft3",
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: write });
      expect(
        yield* client[FT3_WS_METHODS.mailTimeline]({ taskId: "task:timeline" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: read });
      expect(
        yield* client[FT3_WS_METHODS.docsRead]({ ref: "plans/a.md" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: read });
    }).pipe(Effect.scoped),
  );
});

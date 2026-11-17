import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  type AuthEnvironmentScope,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderInstanceEnvironment,
  ServerSettingsError,
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
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Schema from "effect/Schema";

import {
  FT3_WS_METHODS,
  authorizationLayer,
  group,
  handlers,
  zavodRpcServiceLayer,
} from "./rpc.ts";
import { ZavodRpcError, type ZavodStatus } from "./rpc-contracts.ts";
import * as ServerConfig from "../../../apps/server/src/config.ts";
import * as ServerSettings from "../../../apps/server/src/serverSettings.ts";

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

const mailLetter = Schema.decodeSync(MailContracts.MailLetter)({
  letterId: "letter:one",
  taskId: "task:timeline",
  sequence: 1,
  senderThreadId: "thread:lead",
  recipient: "lead",
  kind: "request",
  body: "Start.",
  replyToLetterId: null,
  sourceLetterId: null,
  planPhase: null,
  planStep: null,
  planSha256: null,
  planDocId: null,
  classifierKind: null,
  classifierConfidence: null,
  kindDisputed: false,
  leadKind: null,
  clientRequestId: "request:letter",
  requestFingerprint: "fp",
  createdAt: "2026-11-04T00:00:00.000Z",
});

const planRecord = {
  cardId,
  required: true,
  requiredBy: "human" as const,
  requiredReason: null,
  state: "accepted" as const,
  planDocId: "plan-doc",
  plannerMemberId: null,
  plannerThreadId: null,
  reviewRounds: 0,
  acceptedSha256: "0".repeat(64),
  acceptedRevision: 1,
  acceptedAt: "2026-10-26T00:00:00.000Z",
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

const noFeatureSources: Record<(typeof FEATURE_IDS)[number], "default" | "project"> =
  Object.fromEntries(FEATURE_IDS.map((id) => [id, "default"])) as Record<
    (typeof FEATURE_IDS)[number],
    "default" | "project"
  >;

const noSnapshot = {
  configVersion: 1,
  documents: [],
  requirements: noRequirements,
  features: noFeatures,
  featureSources: noFeatureSources,
  needsAttention: false,
  warnings: [],
};

const zavodStatus = {
  state: "off" as const,
  baseUrl: "https://zavod.example/v1",
  baseUrlSource: "state" as const,
  reason: null,
};
const isZavodRpcError = Schema.is(ZavodRpcError);
const encodeZavodRpcError = Schema.encodeUnknownSync(Schema.toCodecJson(ZavodRpcError));

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
  [FT3_WS_METHODS.boardPlanGet]: () =>
    Effect.succeed({
      record: planRecord,
      doc: { stableId: "plan", relPath: "corvis/plans/plan.md", name: "plan.md" },
      liveSha256: null,
      versions: [],
    }),
  [FT3_WS_METHODS.boardPlanSetRequired]: () => Effect.succeed(planRecord),
  [FT3_WS_METHODS.boardPlanAccept]: () => Effect.succeed(planRecord),
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
  [FT3_WS_METHODS.mailTasks]: () =>
    Effect.succeed({ tasks: [mailTask], letters: { "task:timeline": [] } }),
  [FT3_WS_METHODS.mailLetter]: () =>
    Effect.succeed({ letter: mailLetter, effectiveKind: mailLetter.kind }),
  [FT3_WS_METHODS.zavodDetect]: () => Effect.succeed(zavodStatus),
  [FT3_WS_METHODS.zavodConnect]: () =>
    Effect.succeed({
      ...zavodStatus,
      claudeInstanceId: ProviderInstanceId.make("zavod-claude"),
      codexInstanceId: ProviderInstanceId.make("zavod-codex"),
    }),
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
        AuthProvidersManageScope,
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
      expect(yield* client[FT3_WS_METHODS.boardPlanGet]({ cardId })).toMatchObject({
        liveSha256: null,
        versions: [],
      });
      expect(
        yield* client[FT3_WS_METHODS.boardPlanSetRequired]({ cardId, required: true }),
      ).toMatchObject({ cardId });
      expect(
        yield* client[FT3_WS_METHODS.boardPlanAccept]({ cardId, sha256: "0".repeat(64) }),
      ).toMatchObject({
        cardId,
      });
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
        featureSources: noFeatureSources,
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
      expect(
        yield* client[FT3_WS_METHODS.mailTasks]({
          cardIds: ["card-1"],
          lettersPerTask: 10,
          threadId: "thread:lead",
        }),
      ).toEqual({
        tasks: [mailTask],
        letters: { "task:timeline": [] },
      });
      expect(
        yield* client[FT3_WS_METHODS.mailLetter]({
          letterId: "letter:one",
          threadId: "thread:lead",
        }),
      ).toMatchObject({ effectiveKind: "request" });
      expect(yield* client[FT3_WS_METHODS.docsRead]({ ref: "plans/a.md" })).toEqual({
        status: "not_found",
      });
      expect(yield* client[FT3_WS_METHODS.zavodDetect]({})).toEqual(zavodStatus);
      expect(yield* client[FT3_WS_METHODS.zavodConnect]({})).toMatchObject({
        ...zavodStatus,
        claudeInstanceId: "zavod-claude",
        codexInstanceId: "zavod-codex",
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
        yield* client[FT3_WS_METHODS.boardPlanGet]({ cardId }).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: read,
      });
      expect(
        yield* client[FT3_WS_METHODS.boardPlanSetRequired]({ cardId, required: true }).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: operate });
      expect(
        yield* client[FT3_WS_METHODS.boardPlanAccept]({ cardId, sha256: "0".repeat(64) }).pipe(
          Effect.flip,
        ),
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
        yield* client[FT3_WS_METHODS.mailTasks]({
          cardIds: ["card-1"],
          threadId: "thread:lead",
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: read });
      expect(
        yield* client[FT3_WS_METHODS.mailLetter]({
          letterId: "letter:one",
          threadId: "thread:lead",
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: read });
      expect(
        yield* client[FT3_WS_METHODS.docsRead]({ ref: "plans/a.md" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: read });
      expect(yield* client[FT3_WS_METHODS.zavodDetect]({}).pipe(Effect.flip)).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: read,
      });
      expect(yield* client[FT3_WS_METHODS.zavodConnect]({}).pipe(Effect.flip)).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthProvidersManageScope,
      });
    }).pipe(Effect.scoped),
  );
});

const zavodTestLayer = ServerSettings.layerTest().pipe(
  Layer.provideMerge(ServerConfig.layerTest(".", { prefix: "t3-zavod-rpc-" })),
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
);

const decodeProviderEnvironment = Schema.decodeEffect(ProviderInstanceEnvironment);

const zavodFixture = Effect.fn("test.zavodRpcFixture")(function* (
  options: {
    readonly state?: ZavodStatus["state"];
    readonly failSettings?: boolean;
    readonly failCreate?: boolean;
    readonly instanceEnvironment?: boolean;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const platform = yield* HostProcess.Platform;
  const home = path.join(config.baseDir, "user");
  const helperPath = path.join(
    home,
    ".zavod",
    "bin",
    platform === "win32" ? "zavod-key.exe" : "zavod-key",
  );
  const key = "fixture-zavod-secret-never-returned";
  const state = options.state ?? "off";
  const claudeHome = path.join(home, "custom-claude");
  const codexHome = path.join(home, "custom-codex");
  const claudeOn = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://zavod.example" } });
  const codexOn =
    'model_provider = "zavod"\n[model_providers.zavod]\nbase_url = "https://zavod.example/v1"\n';
  for (const [file, text] of [
    [
      path.join(home, ".zavod", "desktop", "state.json"),
      JSON.stringify({ version: 1, base_url: "https://zavod.example", key }),
    ],
    [path.join(home, ".claude", "settings.json"), claudeOn],
    [path.join(home, ".codex", "config.toml"), codexOn],
    [
      path.join(claudeHome, "settings.json"),
      !options.instanceEnvironment && (state === "on" || state === "mixed") ? claudeOn : "{}",
    ],
    [
      path.join(codexHome, "config.toml"),
      state === "on" ? codexOn : state === "unsupported" ? "model_provider = [" : "",
    ],
  ] as const) {
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, text);
  }
  if (state !== "absent") {
    yield* fs.makeDirectory(path.dirname(helperPath), { recursive: true });
    yield* fs.writeFileString(helperPath, key);
  }
  for (const [id, driver, homePath] of [
    ["claudeAgent", "claudeAgent", claudeHome],
    ["codex", "codex", codexHome],
  ] as const) {
    yield* settings.updateProviderInstance({
      operation: "upsert",
      instanceId: ProviderInstanceId.make(id),
      instance: {
        driver: ProviderDriverKind.make(driver),
        config: { homePath: options.instanceEnvironment ? "" : homePath, fixtureSecret: key },
        ...(options.instanceEnvironment
          ? {
              environment:
                driver === "claudeAgent"
                  ? [
                      { name: "CLAUDE_CONFIG_DIR", value: homePath, sensitive: false },
                      {
                        name: "ANTHROPIC_BASE_URL",
                        value: "https://zavod.example",
                        sensitive: false,
                      },
                      {
                        name: "CODEX_HOME",
                        value: path.join(home, "ignored-claude-codex"),
                        sensitive: false,
                      },
                    ]
                  : [
                      { name: "CODEX_HOME", value: homePath, sensitive: false },
                      {
                        name: "ANTHROPIC_BASE_URL",
                        value: "https://other.example",
                        sensitive: false,
                      },
                      {
                        name: "CLAUDE_CONFIG_DIR",
                        value: path.join(home, "ignored-codex-claude"),
                        sensitive: false,
                      },
                    ],
            }
          : {}),
      },
    });
  }

  let reads = 0;
  const mutations: string[] = [];
  const failure = () =>
    new ServerSettingsError({
      settingsPath: config.settingsPath,
      operation: "create-provider-instance",
      cause: new Error(`${helperPath} ${key}`),
    });
  const wrapped = ServerSettings.ServerSettingsService.of({
    ...settings,
    getSettings: Effect.suspend(() => {
      reads++;
      return options.failSettings ? Effect.fail(failure()) : settings.getSettings;
    }),
    updateProviderInstance: (mutation, patch) => {
      mutations.push(mutation.operation);
      return options.failCreate && mutation.operation === "create"
        ? Effect.fail(failure())
        : settings.updateProviderInstance(mutation, patch);
    },
  });
  const context = yield* Layer.build(zavodRpcServiceLayer).pipe(
    Effect.provideService(ServerSettings.ServerSettingsService, wrapped),
    Effect.provideService(HostProcess.HomeDirectory, home),
    Effect.provideService(HostProcess.Environment, {
      CLAUDE_CONFIG_DIR: path.join(home, options.instanceEnvironment ? "empty-claude" : ".claude"),
      CODEX_HOME: path.join(home, options.instanceEnvironment ? "empty-codex" : ".codex"),
    }),
  );
  const handlerLayer = group
    .toLayer({
      ...stubs,
      [FT3_WS_METHODS.zavodDetect]: handlers[FT3_WS_METHODS.zavodDetect],
      [FT3_WS_METHODS.zavodConnect]: handlers[FT3_WS_METHODS.zavodConnect],
    })
    .pipe(Layer.provide(Layer.succeedContext(context)));

  return {
    fs,
    path,
    settings,
    helperPath,
    key,
    claudeHome,
    codexHome,
    root: path.join(config.stateDir, "zavod"),
    mutations,
    get reads() {
      return reads;
    },
    client: (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
      RpcTest.makeClient(group).pipe(
        Effect.provide(Layer.merge(handlerLayer, authorizationLayer(scopes))),
      ),
  };
});

describe("Zavod RPC", () => {
  it.effect("detects effective instance environments without reading secret references", () =>
    Effect.gen(function* () {
      const f = yield* zavodFixture({ state: "on", instanceEnvironment: true });
      const client = yield* f.client([AuthOrchestrationReadScope, AuthProvidersManageScope]);
      expect((yield* client[FT3_WS_METHODS.zavodDetect]({})).state).toBe("on");
      for (const [id, name] of [
        ["claudeAgent", "CLAUDE_CONFIG_DIR"],
        ["claudeAgent", "ANTHROPIC_BASE_URL"],
        ["codex", "CODEX_HOME"],
      ] as const) {
        const instanceId = ProviderInstanceId.make(id);
        const previous = (yield* f.settings.getSettings).providerInstances[instanceId]!;
        yield* f.settings.updateProviderInstance({
          operation: "upsert",
          instanceId,
          instance: {
            ...previous,
            environment: yield* decodeProviderEnvironment([
              { name, secret: { provider: "fixture", reference: "private-reference" } },
            ]),
          },
        });
        const result = yield* client[FT3_WS_METHODS.zavodDetect]({});
        expect(result.state).toBe("unsupported");
        expect(JSON.stringify(result)).not.toContain("private-reference");
        const before = yield* f.settings.getSettings;
        expect(yield* client[FT3_WS_METHODS.zavodConnect]({}).pipe(Effect.flip)).toMatchObject({
          stage: "state",
        });
        expect(yield* f.settings.getSettings).toEqual(before);
        yield* f.settings.updateProviderInstance({
          operation: "upsert",
          instanceId,
          instance: previous,
        });
      }
      const instanceId = ProviderInstanceId.make("codex");
      const codex = (yield* f.settings.getSettings).providerInstances[instanceId]!;
      yield* f.settings.updateProviderInstance({
        operation: "upsert",
        instanceId,
        instance: {
          ...codex,
          environment: yield* decodeProviderEnvironment([
            { name: "CODEX_HOME", secret: { provider: "fixture", reference: "private-reference" } },
          ]),
        },
      });
      yield* f.fs.remove(f.helperPath);
      expect((yield* client[FT3_WS_METHODS.zavodDetect]({})).state).toBe("absent");
    }).pipe(Effect.scoped, Effect.provide(zavodTestLayer)),
  );
  it.effect("authorizes before reading settings or writing managed instances", () =>
    Effect.gen(function* () {
      const f = yield* zavodFixture();
      const denied = yield* f.client([]);
      expect(yield* denied[FT3_WS_METHODS.zavodDetect]({}).pipe(Effect.flip)).toMatchObject({
        requiredPermission: AuthOrchestrationReadScope,
      });
      expect(yield* denied[FT3_WS_METHODS.zavodConnect]({}).pipe(Effect.flip)).toMatchObject({
        requiredPermission: AuthProvidersManageScope,
      });
      expect(f.reads).toBe(0);
      const readOnly = yield* f.client([AuthOrchestrationReadScope]);
      expect(yield* readOnly[FT3_WS_METHODS.zavodDetect]({})).toEqual(zavodStatus);
      expect(yield* readOnly[FT3_WS_METHODS.zavodConnect]({}).pipe(Effect.flip)).toMatchObject({
        requiredPermission: AuthProvidersManageScope,
      });
      expect(f.reads).toBe(1);
      expect(f.mutations).toEqual([]);
      expect(yield* f.fs.exists(f.root)).toBe(false);
      const manager = yield* f.client([AuthProvidersManageScope]);
      expect(yield* manager[FT3_WS_METHODS.zavodDetect]({}).pipe(Effect.flip)).toMatchObject({
        requiredPermission: AuthOrchestrationReadScope,
      });
      expect(yield* manager[FT3_WS_METHODS.zavodConnect]({})).toMatchObject({
        state: "off",
        claudeInstanceId: "zavod-claude",
        codexInstanceId: "zavod-codex",
      });
    }).pipe(Effect.scoped, Effect.provide(zavodTestLayer)),
  );

  it.effect(
    "returns safe diagnostics and connects on, off or mixed through the real services",
    () =>
      Effect.gen(function* () {
        for (const state of ["on", "off", "mixed", "unsupported", "absent"] as const) {
          yield* Effect.gen(function* () {
            const f = yield* zavodFixture({ state });
            const client = yield* f.client([AuthOrchestrationReadScope, AuthProvidersManageScope]);
            const before = yield* f.settings.getSettings;
            const detected = yield* client[FT3_WS_METHODS.zavodDetect]({});
            expect(detected.state).toBe(state);
            expect(Object.keys(detected).sort()).toEqual([
              "baseUrl",
              "baseUrlSource",
              "reason",
              "state",
            ]);
            expect(detected.baseUrlSource).toBe(state === "absent" ? null : "state");
            expect(JSON.stringify(detected)).not.toContain(f.helperPath);
            expect(JSON.stringify(detected)).not.toContain(f.key);
            if (state === "on" || state === "off" || state === "mixed") {
              const connected = yield* client[FT3_WS_METHODS.zavodConnect]({});
              expect(connected).toEqual({
                ...detected,
                claudeInstanceId: "zavod-claude",
                codexInstanceId: "zavod-codex",
              });
              expect(JSON.stringify(connected)).not.toContain(f.helperPath);
              expect(JSON.stringify(connected)).not.toContain(f.key);
            } else {
              expect(
                yield* client[FT3_WS_METHODS.zavodConnect]({}).pipe(Effect.flip),
              ).toMatchObject({
                _tag: "ZavodRpcError",
                operation: "connect",
                stage: "state",
              });
            }
            if (state === "on" || state === "off" || state === "mixed") {
              expect(f.mutations).toEqual(["create", "create"]);
              expect(yield* f.fs.exists(f.path.join(f.root, "zavod-claude", "settings.json"))).toBe(
                true,
              );
              expect(yield* f.fs.exists(f.path.join(f.root, "zavod-codex", "config.toml"))).toBe(
                true,
              );
            } else {
              expect(yield* f.settings.getSettings).toEqual(before);
              expect(f.mutations).toEqual([]);
              expect(yield* f.fs.exists(f.root)).toBe(false);
            }
          }).pipe(Effect.scoped, Effect.provide(zavodTestLayer));
        }
      }),
  );

  it.effect("re-detects configured homes before connecting", () =>
    Effect.gen(function* () {
      const f = yield* zavodFixture();
      const client = yield* f.client([AuthOrchestrationReadScope, AuthProvidersManageScope]);
      expect((yield* client[FT3_WS_METHODS.zavodDetect]({})).state).toBe("off");
      yield* f.fs.writeFileString(
        f.path.join(f.claudeHome, "settings.json"),
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://zavod.example" } }),
      );
      yield* f.fs.writeFileString(
        f.path.join(f.codexHome, "config.toml"),
        'model_provider = "zavod"\n[model_providers.zavod]\nbase_url = "https://zavod.example/v1"\n',
      );
      expect(yield* client[FT3_WS_METHODS.zavodConnect]({})).toMatchObject({
        state: "on",
        claudeInstanceId: "zavod-claude",
        codexInstanceId: "zavod-codex",
      });
      expect(f.mutations).toEqual(["create", "create"]);
      expect(yield* f.fs.exists(f.root)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(zavodTestLayer)),
  );

  it.effect(
    "maps settings and connection failures to typed errors without raw causes or paths",
    () =>
      Effect.gen(function* () {
        for (const failSettings of [true, false]) {
          yield* Effect.gen(function* () {
            const f = yield* zavodFixture({ failSettings, failCreate: true });
            const client = yield* f.client([AuthOrchestrationReadScope, AuthProvidersManageScope]);
            const error = yield* client[FT3_WS_METHODS.zavodConnect]({}).pipe(Effect.flip);
            expect(isZavodRpcError(error)).toBe(true);
            expect(error).toMatchObject({
              operation: "connect",
              stage: failSettings ? "settings" : "write",
            });
            expect(error.message).toBe("Zavod request failed.");
            expect(Object.keys(error)).not.toContain("cause");
            expect(encodeZavodRpcError(error)).toEqual({
              _tag: "ZavodRpcError",
              operation: "connect",
              stage: failSettings ? "settings" : "write",
            });
            expect(JSON.stringify(error)).not.toContain(f.helperPath);
            expect(JSON.stringify(error)).not.toContain(f.key);
            expect(yield* f.fs.exists(f.root)).toBe(false);
            if (failSettings) {
              expect(yield* client[FT3_WS_METHODS.zavodDetect]({}).pipe(Effect.flip)).toMatchObject(
                { _tag: "ZavodRpcError", operation: "detect", stage: "settings" },
              );
            }
          }).pipe(Effect.scoped, Effect.provide(zavodTestLayer));
        }
        yield* Effect.gen(function* () {
          const f = yield* zavodFixture();
          yield* f.settings.updateProviderInstance({
            operation: "create",
            instanceId: ProviderInstanceId.make("zavod-codex"),
            instance: {
              driver: ProviderDriverKind.make("codex"),
              config: { homePath: "foreign-home", fixtureSecret: f.key },
            },
          });
          const client = yield* f.client([AuthProvidersManageScope]);
          const error = yield* client[FT3_WS_METHODS.zavodConnect]({}).pipe(Effect.flip);
          expect(encodeZavodRpcError(error)).toEqual({
            _tag: "ZavodRpcError",
            operation: "connect",
            stage: "conflict",
            instanceId: "zavod-codex",
          });
          expect(f.mutations).toEqual([]);
          expect(yield* f.fs.exists(f.root)).toBe(false);
        }).pipe(Effect.scoped, Effect.provide(zavodTestLayer));
      }),
  );
});

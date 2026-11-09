// @effect-diagnostics nodeBuiltinImport:off - the harness creates a document store on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ThreadId,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import { docLinkOf } from "@t3tools/ft3-docs/contracts";
import { DEFAULT_PLANS_FOLDER } from "@t3tools/ft3-docs/root";
import * as DocsServer from "@t3tools/ft3-docs/server";
import { migrations as docsMigrations } from "@t3tools/ft3-docs/migrations";
import type { FeatureId } from "@t3tools/ft3-policies/contracts";
import * as FeatureGate from "@t3tools/ft3-policies/server";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/sql/Migrator";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import { liveThreadShell } from "../../../apps/server/src/mcp/McpToolAccess.testkit.ts";
import { ProjectStoreV2 } from "../../../apps/server/src/orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import { ServerSettingsService } from "../../../apps/server/src/serverSettings.ts";
import * as BoardMailFacts from "./boardMailFacts.ts";
import * as BoardRepository from "./BoardRepository.ts";
import * as BoardService from "./BoardService.ts";
import * as Contracts from "./contracts.ts";
import { migrations as boardMigrations } from "./migrations.ts";
import * as PlanGate from "./PlanGate.ts";
import * as PlanService from "./PlanService.ts";

export const LEAD_THREAD_ID = ThreadId.make("thread:lead");
export const PLANNER_THREAD_ID = ThreadId.make("thread:planner");
const PARENT_THREAD_ID = ThreadId.make("thread:parent");
export const CARD_ID = Contracts.BoardCardId.make("3f0c1a2e-0000-4000-8000-000000000001");
const PROJECT_ID = ProjectId.make("project:corvis");

export interface PlanTestOptions {
  readonly planning?: boolean;
  readonly planningProjectOverrides?: Readonly<Record<string, boolean>>;
  readonly projectFeatureOverrides?: Readonly<Record<string, Partial<Record<FeatureId, boolean>>>>;
  readonly threadProjects?: Readonly<Record<string, string>>;
  readonly unresolvedThreads?: ReadonlySet<string>;
  /** Makes the lead thread a child, so its plan document writes are denied. */
  readonly childLead?: boolean;
  /** The project title for the plan folder; null when the project row is gone. */
  readonly projectTitle?: string | null;
  /** Overrides `ft3.docs.plansFolder` for the plan service. */
  readonly plansFolder?: string;
  /** Receives every threads.dispatch input, so tests can count lead events. */
  readonly onDispatch?: (input: unknown) => void;
  /**
   * The board's mail facts. The default reports no mail activity, as if the
   * mail tables were purged; tests that need mail provide a fake layer.
   */
  readonly mailFacts?: Layer.Layer<BoardMailFacts.BoardMailFacts>;
}

/** Counts `DocsService.read` calls, so summary tests can prove the step cache. */
export class PlanDocsReads extends Context.Service<PlanDocsReads, Ref.Ref<number>>()(
  "@t3tools/ft3-board/planning.testkit/PlanDocsReads",
) {}

export type PlanTestServices =
  | PlanService.PlanService
  | BoardService.BoardService
  | BoardRepository.BoardRepository
  | PlanGate.PlanGate
  | DocsServer.DocsService
  | DocsServer.DocumentsWriteFactsPort
  | SqlClient.SqlClient
  | PlanDocsReads;

const cryptoLayer = Layer.succeed(
  SecureRandom.SecureRandom,
  SecureRandom.make((size) => globalThis.crypto.getRandomValues(new Uint8Array(size))),
);

const threadsLayer = (options: PlanTestOptions) =>
  Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (threadId) => {
      if (options.unresolvedThreads?.has(String(threadId)) === true) return Effect.succeed(null);
      const parent =
        options.childLead === true && threadId === LEAD_THREAD_ID ? PARENT_THREAD_ID : null;
      return Effect.succeed({
        ...liveThreadShell(threadId),
        projectId: ProjectId.make(options.threadProjects?.[String(threadId)] ?? PROJECT_ID),
        lineage: {
          rootThreadId: parent ?? threadId,
          parentThreadId: parent,
          relationshipToParent: parent === null ? null : "subagent",
        },
      });
    },
    dispatch: (command) =>
      Effect.try({
        try: () => {
          options.onDispatch?.(command);
          return {} as never;
        },
        catch: (cause) => cause as never,
      }),
  });

const projectsLayer = (options: PlanTestOptions) =>
  Layer.mock(ProjectStoreV2)({
    getShell: () => {
      const title = options.projectTitle === undefined ? "Corvis Core" : options.projectTitle;
      if (title === null) return Effect.succeedNone;
      const project: OrchestrationProjectShell = {
        id: PROJECT_ID,
        title,
        workspaceRoot: "/workspace/corvis",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-10-26T00:00:00.000Z",
        updatedAt: "2026-10-26T00:00:00.000Z",
      };
      return Effect.succeedSome(project);
    },
  });

const featureGateLayer = (options: PlanTestOptions) =>
  Layer.mock(FeatureGate.FeatureGate)({
    require: (feature, projectId) => {
      const enabled =
        options.projectFeatureOverrides?.[projectId ?? ""]?.[feature] ??
        (feature === "planning"
          ? (options.planningProjectOverrides?.[projectId ?? ""] ?? options.planning ?? true)
          : true);
      return enabled
        ? Effect.void
        : Effect.fail(new FeatureGate.FeatureDisabledError({ feature, code: "feature_disabled" }));
    },
  });

const makeRoot = () =>
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ft3-board-planning-")));

const removeRoot = (root: string) =>
  Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true }));

const migrator = Migrator.make({});
const prepareSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON`;
  yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY)`;
  yield* migrator({
    loader: Migrator.fromRecord({ ...boardMigrations, ...docsMigrations }),
    table: "ft3_migrations",
  });
});

const settingsLayer = (options: PlanTestOptions) =>
  Layer.mock(ServerSettingsService)({
    getSettings: Effect.succeed({
      ...DEFAULT_SERVER_SETTINGS,
      ft3: {
        docs: {
          root: null,
          plansFolder: options.plansFolder ?? DEFAULT_PLANS_FOLDER,
        },
      },
    }),
  });

const testLayer = (root: string, options: PlanTestOptions) => {
  const sql = NodeSqliteClient.layer({ filename: ":memory:" });
  const threads = threadsLayer(options);
  const featureGate = featureGateLayer(options);
  const base = Layer.mergeAll(
    sql,
    cryptoLayer,
    threads,
    projectsLayer(options),
    featureGate,
    settingsLayer(options),
  );
  const docsInner = DocsServer.docsServiceLayer({ root }).pipe(
    Layer.provide(DocsServer.lineageDocumentsWrite),
    Layer.provide(DocsServer.noProtectedDocuments),
    Layer.provide(base),
  );
  const docsReads = Layer.effect(PlanDocsReads, Ref.make(0));
  const docs = Layer.effect(
    DocsServer.DocsService,
    Effect.gen(function* () {
      const reads = yield* PlanDocsReads;
      const inner = yield* DocsServer.DocsService;
      return DocsServer.DocsService.of({
        ...inner,
        read: (input) =>
          Ref.update(reads, (count) => count + 1).pipe(Effect.andThen(inner.read(input))),
      });
    }),
  ).pipe(Layer.provide(Layer.mergeAll(docsReads, docsInner)));
  const plans = PlanService.planServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(base, docs, options.mailFacts ?? BoardMailFacts.noBoardMailFactsLayer),
    ),
  );
  const gate = PlanGate.planGateLayer.pipe(Layer.provide(Layer.mergeAll(plans, docs)));
  const facts = PlanService.planningDocumentsWriteFacts.pipe(Layer.provide(plans));
  const repository = BoardRepository.layer.pipe(Layer.provide(sql));
  const board = BoardService.layer.pipe(
    Layer.provide(Layer.mergeAll(base, plans, gate, repository)),
  );
  return Layer.mergeAll(
    sql,
    docs,
    plans,
    gate,
    facts,
    docsReads,
    repository,
    threads,
    featureGate,
    board,
  );
};

/** Runs `use` against a fresh schema, document store and planning services. */
export const withPlanning = <A, E>(
  use: Effect.Effect<A, E, PlanTestServices>,
  options: PlanTestOptions = {},
) =>
  Effect.gen(function* () {
    const root = yield* makeRoot();
    return yield* Effect.gen(function* () {
      yield* prepareSchema;
      return yield* use;
    }).pipe(Effect.provide(testLayer(root, options)), Effect.ensuring(removeRoot(root)));
  });

/** The startup redelivery of the accepted-event outbox, on the store and dispatcher of `options`. */
export const restartAcceptDelivery = (options: PlanTestOptions) =>
  Layer.build(PlanService.planAcceptOutboxDrainLayer).pipe(
    Effect.scoped,
    Effect.provide(threadsLayer(options)),
  );

/** Inserts the lead thread, its board orchestrator and one card; the card is the plan's card. */
export const seedCard = (
  title = "Storage plan",
  id = CARD_ID,
  orchestratorThreadId = LEAD_THREAD_ID,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT OR IGNORE INTO orchestration_v2_projection_threads (thread_id) VALUES (${orchestratorThreadId})`;
    yield* sql`INSERT OR IGNORE INTO ft3_board_orchestrators (thread_id, created_by, created_at) VALUES (${orchestratorThreadId}, 'human', '2026-10-26T00:00:00.000Z')`;
    yield* sql`INSERT INTO ft3_board_cards (card_id, orchestrator_thread_id, title, body, status, created_by, executor_role, failure_streak, order_index, archived, created_at, updated_at) VALUES (${id}, ${orchestratorThreadId}, ${title}, 'Body', 'todo', 'human', 'implementation', 0, 0, 0, '2026-10-26T00:00:00.000Z', '2026-10-26T00:00:00.000Z')`;
  });

/** A plan the strict check accepts; the stable id line keeps the store from rewriting the file. */
export const validPlan = (planDocId: string, title = "Storage plan") =>
  [
    "---",
    `stable_id: ${planDocId}`,
    "schema: corvis-plan-v1",
    `cardId: ${CARD_ID}`,
    "---",
    `# Plan: ${title}`,
    "",
    "## Goal",
    "",
    "Store the plan.",
    "",
    "## Decisions",
    "",
    "Use the docs store.",
    "",
    "## Steps",
    "| step | change | owns | verify |",
    "|---|---|---|---|",
    "| P1 | add the table | ft3-board | migration test |",
    "",
    "## Risks and rollback",
    "",
    "Drop the table.",
    "",
  ].join("\n");

/** Replaces the plan document as the human editor would, outside any agent rule. */
export const editPlan = (planDocId: string, content: string) =>
  Effect.gen(function* () {
    const docs = yield* DocsServer.DocsService;
    yield* docs.writeAsHuman({ ref: docLinkOf(planDocId), content });
  });

/** The live digest of a plan document, as the accept and gate checks compare it. */
export const liveSha256Of = (planDocId: string) =>
  Effect.gen(function* () {
    const docs = yield* DocsServer.DocsService;
    const ref = yield* docs.docRef(docLinkOf(planDocId));
    return ref.sha256 ?? null;
  });

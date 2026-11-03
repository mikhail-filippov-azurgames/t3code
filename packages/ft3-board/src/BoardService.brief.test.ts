import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import { liveThreadShell } from "../../../apps/server/src/mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../apps/server/src/persistence/Sqlite.ts";
import * as ServerSettings from "../../../apps/server/src/serverSettings.ts";
import { layerMemory as policyAppliedStoreLayer } from "../../ft3-policies/src/policyAppliedStore.ts";
import {
  PolicyChangeTracker,
  layer as policyChangeTrackerLayer,
} from "../../ft3-policies/src/policyChangeTracker.ts";
import { layer as policyDocumentLoaderLayer } from "../../ft3-policies/src/policyDocumentLoader.ts";
import { memoryPolicyDocumentPort } from "../../ft3-policies/src/policyDocuments.testkit.ts";
import * as BoardRepository from "./BoardRepository.ts";
import * as BoardService from "./BoardService.ts";
import * as Contracts from "./contracts.ts";

const threadId = ThreadId.make("thread:ft3-brief");
const epoch = "2026-10-26T00:00:00.000Z";
const ROLES_MANIFEST_PATH = "policies/roles/roles.json";

const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: () => Effect.die("unused"),
  }),
);

const appliedRoles = (leadBody: string): ReadonlyMap<string, string> =>
  new Map([
    [
      ROLES_MANIFEST_PATH,
      [
        "{",
        '  "schema": "corvis-role-map-v1",',
        '  "revision": 1,',
        '  "configured": true,',
        '  "roles": [ { "id": "lead", "roleId": "lead", "file": "lead.md" } ]',
        "}",
        "",
      ].join("\n"),
    ],
    [
      "policies/roles/lead.md",
      [
        "---",
        "schema: corvis-role-v1",
        "roleId: lead",
        "revision: 1",
        "configured: true",
        "---",
        "",
        leadBody,
        "",
      ].join("\n"),
    ],
  ]);

const rolesSource = {
  routingPolicy: { kind: "builtin" },
  roles: { kind: "doc", address: { kind: "path", relPath: ROLES_MANIFEST_PATH } },
  leadSkills: { kind: "builtin" },
} as const;

type Service = BoardService.BoardService["Service"];

const wake = <A>(
  options: {
    readonly applied?: ReadonlyMap<string, string>;
    readonly markFirst?: boolean;
  },
  action: (service: Service) => Effect.Effect<A, Contracts.BoardMcpFailure>,
) =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<string>>([]);
    const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id: ThreadId) => Effect.succeed(liveThreadShell(id)),
      dispatch: (command) =>
        command.type === "message.dispatch"
          ? Ref.update(dispatched, (texts) => [...texts, command.text]).pipe(Effect.as({} as never))
          : Effect.succeed({} as never),
    });
    const tracker =
      options.applied === undefined
        ? Layer.empty
        : policyChangeTrackerLayer.pipe(
            Layer.provide(policyDocumentLoaderLayer(memoryPolicyDocumentPort(options.applied))),
            Layer.provide(policyAppliedStoreLayer),
          );
    const layer = Layer.mergeAll(
      BoardService.layer.pipe(
        Layer.provideMerge(BoardRepository.layer),
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provide(threads),
        Layer.provide(cryptoLayer),
        Layer.provide(ServerSettings.layerTest()),
      ),
      tracker,
    );
    return yield* Effect.gen(function* () {
      const trackerService = yield* Effect.serviceOption(PolicyChangeTracker);
      if (Option.isSome(trackerService)) {
        yield* trackerService.value.refresh({ sources: rolesSource, features: { board: true } });
      }
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
        thread_id: threadId,
        project_id: "project:ft3-brief",
        title: "Coordinator",
        default_provider: "codex",
        provider_instance_id: "codex",
        runtime_mode: "full-access",
        interaction_mode: "default",
        created_at: epoch,
        updated_at: epoch,
        payload_json: "{}",
      })}`;
      const repo = yield* BoardRepository.BoardRepository;
      if (options.markFirst !== false) {
        yield* repo.addOrchestrator({ threadId, createdBy: "human", createdAt: epoch });
      }
      const service = yield* BoardService.BoardService;
      const result = yield* action(service);
      const orchestrators = yield* service.listOrchestrators();
      return {
        result,
        texts: yield* Ref.get(dispatched),
        rolesConfigured: orchestrators.rolesConfigured,
      };
    }).pipe(Effect.provide(layer));
  });

const resend = (options: { readonly applied?: ReadonlyMap<string, string> }) =>
  wake(options, (service) => service.resendBrief({ threadId }));

describe("ft3 board Coordinator brief", () => {
  it.effect("starts with the Coordinator identity while roles are off", () =>
    Effect.gen(function* () {
      const result = yield* resend({});
      assert.equal(result.rolesConfigured, false);
      assert.equal(result.texts.length, 1);
      assert.isTrue(result.texts[0]!.startsWith("You are the lead for this board thread."));
    }),
  );

  it.effect("starts with the applied lead role instruction when roles are configured", () =>
    Effect.gen(function* () {
      const result = yield* resend({ applied: appliedRoles("# Lead\n\nOwn the board.") });
      assert.equal(result.rolesConfigured, true);
      assert.isTrue(
        result.texts[0]!.startsWith(
          "Your role is lead. Follow this role instruction before any work.\n\n# Lead\n\nOwn the board.",
        ),
      );
      assert.include(result.texts[0]!, "You are the lead for this board thread.");
      assert.include(result.texts[0]!, "are consultants you may call for one concrete question");
      assert.include(result.texts[0]!, "ask the `planner` role and follow its role file");
      assert.notInclude(result.texts[0]!, "create-orchestrator-architect");
      assert.notInclude(result.texts[0]!, "architect_create_or_get");
    }),
  );

  it.effect("sends the full brief on the first bind of the lead", () =>
    Effect.gen(function* () {
      const result = yield* wake({ markFirst: false }, (service) =>
        service.markOrchestrator({ threadId }),
      );
      assert.equal(result.texts.length, 1);
      assert.include(result.texts[0]!, "You are the lead for this board thread.");
      assert.include(result.texts[0]!, "Keep statuses truthful");
      assert.include(result.texts[0]!, "This thread was marked a board lead by a human.");
    }),
  );

  it.effect("sends a short wake instead of the brief when a human starts a card", () =>
    Effect.gen(function* () {
      const result = yield* wake({ applied: appliedRoles("# Lead\n\nOwn the board.") }, (service) =>
        Effect.gen(function* () {
          const card = yield* service.createHumanCard({
            orchestratorThreadId: threadId,
            title: "Mail: address matrix",
            body: "Map every address to its owner.",
            executorRole: "implementation",
          });
          yield* service.startCard({ cardId: card.cardId });
          return card;
        }),
      );
      assert.equal(result.texts.length, 1);
      const text = result.texts[0]!;
      const shortId = String(result.result.cardId).slice(0, 8);
      assert.include(text, `Card "Mail: address matrix" (${shortId}) was started by a human`);
      assert.include(text, "orchestrator, ready");
      assert.include(text, "Map every address to its owner.");
      assert.notInclude(text, "You are the lead for this board thread.");
      assert.notInclude(text, "Keep statuses truthful");
      assert.isTrue(text.endsWith("Rules: see your lead brief."));
    }),
  );
});

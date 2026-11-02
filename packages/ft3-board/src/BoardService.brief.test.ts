// @effect-diagnostics nodeBuiltinImport:off - tests write role files into a temporary directory.
import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { liveThreadShell } from "../../../apps/server/src/mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../apps/server/src/persistence/Sqlite.ts";
import * as BoardRepository from "./BoardRepository.ts";
import * as BoardService from "./BoardService.ts";
import * as Contracts from "./contracts.ts";

const threadId = ThreadId.make("thread:ft3-brief");
const epoch = "2026-10-26T00:00:00.000Z";
const rolesDirEnv = "T3CODE_FT3_ROLES_DIR";

const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: () => Effect.die("unused"),
  }),
);

const makeRolesDir = (): string => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ft3-brief-roles-"));
  NodeFS.writeFileSync(NodePath.join(dir, "lead.md"), "lead");
  return dir.replace(/\\/g, "/");
};

type Service = BoardService.BoardService["Service"];

const wake = <A>(
  rolesDir: string | undefined,
  action: (service: Service) => Effect.Effect<A, Contracts.BoardMcpFailure>,
  options: { readonly markFirst?: boolean } = {},
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
    const layer = BoardService.layer.pipe(
      Layer.provideMerge(BoardRepository.layer),
      Layer.provideMerge(SqlitePersistence.layerMemory),
      Layer.provide(threads),
      Layer.provide(cryptoLayer),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv(
            rolesDir === undefined ? { env: {} } : { env: { [rolesDirEnv]: rolesDir } },
          ),
        ),
      ),
    );
    return yield* Effect.gen(function* () {
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
      return { result, texts: yield* Ref.get(dispatched), rolesDir: orchestrators.rolesDir };
    }).pipe(Effect.provide(layer));
  });

const resend = (rolesDir: string | undefined) =>
  wake(rolesDir, (service) => service.resendBrief({ threadId }));

describe("ft3 board Coordinator brief", () => {
  it.effect("starts with the Coordinator identity while roles are off", () =>
    Effect.gen(function* () {
      const result = yield* resend(undefined);
      assert.equal(result.rolesDir, "");
      assert.equal(result.texts.length, 1);
      assert.isTrue(result.texts[0]!.startsWith("You are the lead for this board thread."));
    }),
  );

  it.effect("starts with the lead role instruction when roles are configured", () =>
    Effect.gen(function* () {
      const dir = makeRolesDir();
      const result = yield* resend(dir);
      assert.equal(result.rolesDir, dir);
      assert.isTrue(
        result.texts[0]!.startsWith(
          `Your role is lead. Before any work, read the whole file ${dir}/lead.md and follow it.`,
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
      const result = yield* wake(undefined, (service) => service.markOrchestrator({ threadId }), {
        markFirst: false,
      });
      assert.equal(result.texts.length, 1);
      assert.include(result.texts[0]!, "You are the lead for this board thread.");
      assert.include(result.texts[0]!, "Keep statuses truthful");
      assert.include(result.texts[0]!, "This thread was marked a board lead by a human.");
    }),
  );

  it.effect("sends a short wake instead of the brief when a human starts a card", () =>
    Effect.gen(function* () {
      const dir = makeRolesDir();
      const result = yield* wake(dir, (service) =>
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
      assert.isTrue(text.endsWith(`Rules: see your lead brief and ${dir}/lead.md.`));
    }),
  );
});

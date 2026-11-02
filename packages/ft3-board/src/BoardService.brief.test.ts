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

const brief = (rolesDir: string | undefined) =>
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
      yield* repo.addOrchestrator({ threadId, createdBy: "human", createdAt: epoch });
      const service = yield* BoardService.BoardService;
      yield* service.resendBrief({ threadId });
      const orchestrators = yield* service.listOrchestrators();
      return { texts: yield* Ref.get(dispatched), rolesDir: orchestrators.rolesDir };
    }).pipe(Effect.provide(layer));
  });

describe("ft3 board Coordinator brief", () => {
  it.effect("starts with the Coordinator identity while roles are off", () =>
    Effect.gen(function* () {
      const result = yield* brief(undefined);
      assert.equal(result.rolesDir, "");
      assert.equal(result.texts.length, 1);
      assert.isTrue(result.texts[0]!.startsWith("You are the Coordinator for this board thread."));
    }),
  );

  it.effect("starts with the lead role instruction when roles are configured", () =>
    Effect.gen(function* () {
      const dir = makeRolesDir();
      const result = yield* brief(dir);
      assert.equal(result.rolesDir, dir);
      assert.isTrue(
        result.texts[0]!.startsWith(
          `Your role is lead. Before any work, read the whole file ${dir}/lead.md and follow it.`,
        ),
      );
      assert.include(result.texts[0]!, "You are the Coordinator for this board thread.");
    }),
  );
});

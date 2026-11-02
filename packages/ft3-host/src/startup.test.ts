// @effect-diagnostics nodeBuiltinImport:off - tests use a temporary roles directory.
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { layer } from "./server.ts";

const rolesDirEnv = "T3CODE_FT3_ROLES_DIR";

const buildHostLayer = (env: Record<string, string>) =>
  Layer.build(
    layer.pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    ),
  ).pipe(Effect.scoped);

describe("ft3 host startup", () => {
  it.effect("builds without a roles directory", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(buildHostLayer({}));
      assert.equal(exit._tag, "Success");
    }),
  );

  it.effect("starts with a configured roles directory", () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ft3-host-roles-"));
      const exit = yield* Effect.exit(buildHostLayer({ [rolesDirEnv]: dir }));
      assert.equal(exit._tag, "Success");
    }),
  );

  it.effect("fails startup when the roles directory does not exist", () =>
    Effect.gen(function* () {
      const missing = NodePath.join(NodeOS.tmpdir(), "t3-ft3-host-roles-missing");
      const exit: Exit.Exit<unknown, unknown> = yield* Effect.exit(
        buildHostLayer({ [rolesDirEnv]: missing }),
      );
      assert.equal(exit._tag, "Failure");
      const message = exit._tag === "Failure" ? Cause.pretty(exit.cause) : "";
      assert.include(message, rolesDirEnv);
      assert.include(message, "not an existing directory");
    }),
  );
});

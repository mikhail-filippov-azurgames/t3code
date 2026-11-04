// @effect-diagnostics nodeBuiltinImport:off - tests use a temporary store root.
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as docs from "@t3tools/ft3-docs/server";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ServerSettings from "../../../apps/server/src/serverSettings.ts";
import { docsProtectionLayer } from "./server.ts";

const buildProtection = (root: string) =>
  Layer.build(
    docsProtectionLayer(docs, root).pipe(
      Layer.provide(docs.docsStoreLayer({ root })),
      // No board table here: the plan-document lookup must fail, not read empty.
      Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.succeed(
          Crypto.Crypto,
          Crypto.make({
            randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
            digest: () => Effect.die("unused"),
          }),
        ),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
  ).pipe(Effect.scoped);

describe("docs protection layer", () => {
  it.effect("refuses the write when the board table is missing", () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ft3-host-protection-"));
      try {
        const context = yield* buildProtection(root);
        const protection = Context.get(context, docs.DocsProtection);
        const error = yield* protection
          .isProtected({ stableId: "x", relPath: "notes/free.md" })
          .pipe(Effect.flip);
        assert.equal(error.code, "store_unavailable");
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }),
  );
});

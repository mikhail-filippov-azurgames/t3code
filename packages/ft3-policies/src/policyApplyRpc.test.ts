// @effect-diagnostics nodeBuiltinImport:off - the fake store hashes document content.
import * as NodeCrypto from "node:crypto";

import { DocsService, DocsServiceError } from "@t3tools/ft3-docs/server";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerSettings from "../../../apps/server/src/serverSettings.ts";
import {
  PolicyAppliedStore,
  type PolicyAppliedRecord,
  layerMemory as policyAppliedStoreLayer,
} from "./policyAppliedStore.ts";
import { layer as policyChangeTrackerLayer } from "./policyChangeTracker.ts";
import {
  docsPolicyDocumentReadPort,
  layer as policyDocumentLoaderLayer,
} from "./policyDocumentLoader.ts";
import { policiesRpcHandlers } from "./rpc.ts";
import { FT3_POLICIES_WS_METHODS } from "./rpc-contracts.ts";

const ROUTING_POLICY_PATH = "policies/routing-policy.md";

// A live editor does not run inside a shell with the legacy settings.
delete process.env.T3CODE_FT3_ROLES_DIR;
delete process.env.T3CODE_FT3_ROUTING_POLICY_REF;

const sha256 = (content: string): string =>
  NodeCrypto.createHash("sha256").update(content, "utf8").digest("hex");

const routingPolicy = (revision: number, implementationCell = "A1"): string =>
  [
    "---",
    `revision: ${revision}`,
    "---",
    "",
    "| Role | low | medium | high | very-high |",
    "|---|---|---|---|---|",
    "| `architect` | A1 | A1 | A1 | A1 |",
    `| \`implementation\` | ${implementationCell} | A1 | A1 | A1 |`,
    "| `review-*` | A1 | A1 | A1 | A1 |",
    "| `test` | A1 | A1 | A1 | A1 |",
    "| `research` | A1 | A1 | A1 | A1 |",
    "| `general` | A1 | A1 | A1 | A1 |",
    "",
    "### Alpha (`alpha / acp`)",
    "| Alias | model | low | medium | high | very-high |",
    "|---|---|---|---|---|---|",
    "| A1 | `alpha-one` | — | — | — | — |",
    "",
  ].join("\n");

const docsOver = (files: Map<string, string>) =>
  DocsService.of({
    list: ({ folder }) =>
      Effect.succeed({
        folder: folder ?? "",
        folders: [],
        documents: [...files.keys()]
          .filter((relPath) => relPath.startsWith(folder === undefined ? "" : `${folder}/`))
          .map((relPath) => ({
            relPath,
            stableId: relPath,
            name: relPath.split("/").pop() ?? relPath,
            description: "",
            updatedAt: "2026-11-03T00:00:00.000Z",
          })),
      }),
    manifest: ({ folder }) =>
      Effect.succeed(
        [...files.keys()]
          .filter((relPath) => relPath.startsWith(folder === undefined ? "" : `${folder}/`))
          .map((relPath) => ({
            name: relPath.split("/").pop() ?? relPath,
            relPath,
            stableId: relPath,
            description: "",
            updatedAt: "2026-11-03T00:00:00.000Z",
          })),
      ),
    read: ({ ref }) => {
      const content = files.get(ref);
      if (content === undefined) {
        return Effect.fail(new DocsServiceError({ code: "document_not_found", ref }));
      }
      return Effect.succeed({
        stableId: ref,
        relPath: ref,
        name: ref.split("/").pop() ?? ref,
        description: "",
        sha256: sha256(content),
        ocLink: `oc://doc/${ref}`,
        content,
      });
    },
    resolve: ({ ref }) =>
      Effect.gen(function* () {
        const content = files.get(ref);
        if (content === undefined) {
          return yield* new DocsServiceError({ code: "document_not_found", ref });
        }
        return {
          document: {
            stableId: ref,
            relPath: ref,
            name: ref.split("/").pop() ?? ref,
            description: "",
            sha256: sha256(content),
            ocLink: `oc://doc/${ref}`,
          },
          absolutePath: `/store/${ref}`,
        };
      }),
    search: () => Effect.succeed([]),
    write: () => Effect.die("unused in the policy apply tests"),
    writeAsHuman: ({ ref, content, baseSha256 }) =>
      Effect.gen(function* () {
        const live = files.get(ref);
        if (live === undefined) {
          return yield* new DocsServiceError({ code: "document_not_found", ref });
        }
        if (baseSha256 !== undefined && baseSha256 !== sha256(live)) {
          return yield* new DocsServiceError({ code: "document_changed", ref });
        }
        files.set(ref, content);
        return {
          stableId: ref,
          relPath: ref,
          name: ref.split("/").pop() ?? ref,
          sha256: sha256(content),
          ocLink: `oc://doc/${ref}`,
        };
      }),
    locateServerPath: () => Effect.succeed(null),
    setDescription: () => Effect.die("unused in the policy apply tests"),
    docRef: () => Effect.die("unused in the policy apply tests"),
  });

const policySettings = (applyExternalEdits: boolean) => ({
  documents: {
    routingPolicy: {
      kind: "doc",
      address: { kind: "path", relPath: ROUTING_POLICY_PATH },
    },
    roles: { kind: "builtin" },
    leadSkills: { kind: "builtin" },
  },
  applyExternalEdits,
  features: { documents: true, board: false, planning: false },
});

const services = (
  files: Map<string, string>,
  applyExternalEdits: boolean,
  applied: Layer.Layer<PolicyAppliedStore> = policyAppliedStoreLayer,
) => {
  const docs = docsOver(files);
  return Layer.mergeAll(
    policyChangeTrackerLayer.pipe(
      Layer.provide(policyDocumentLoaderLayer(docsPolicyDocumentReadPort(docs))),
      Layer.provide(applied),
    ),
    Layer.succeed(DocsService, docs),
    ServerSettings.layerTest({ ft3: { policies: policySettings(applyExternalEdits) } }),
  );
};

const getSnapshot = policiesRpcHandlers[FT3_POLICIES_WS_METHODS.policiesGetSnapshot];
const saveDocument = policiesRpcHandlers[FT3_POLICIES_WS_METHODS.policiesSaveDocument];
const getPending = policiesRpcHandlers[FT3_POLICIES_WS_METHODS.policiesGetPendingChange];
const applyPending = policiesRpcHandlers[FT3_POLICIES_WS_METHODS.policiesApplyPending];
const setApplyExternalEdits =
  policiesRpcHandlers[FT3_POLICIES_WS_METHODS.policiesSetApplyExternalEdits];

const revisionOf = (snapshot: {
  readonly documents: ReadonlyArray<{
    readonly key: string;
    readonly applied: { readonly revision: number } | null;
    readonly pending: boolean;
    readonly kept: boolean;
    readonly errors: ReadonlyArray<{ readonly code: string }>;
  }>;
}) => snapshot.documents.find((document) => document.key === "routingPolicy") ?? null;

describe("policy write and apply RPC", () => {
  it.effect("saves a valid document from the Policies tab and applies it at once", () => {
    const files = new Map([[ROUTING_POLICY_PATH, routingPolicy(1)]]);
    return Effect.gen(function* () {
      const first = yield* getSnapshot({});
      assert.equal(revisionOf(first)?.applied?.revision, 1);

      const saved = yield* saveDocument({
        key: "routingPolicy",
        baseSha256: sha256(routingPolicy(1)),
        content: routingPolicy(2),
      });

      assert.equal(saved.status, "saved");
      assert.equal(revisionOf(saved.snapshot)?.applied?.revision, 2);
      assert.isFalse(revisionOf(saved.snapshot)?.pending);
      assert.equal(files.get(ROUTING_POLICY_PATH), routingPolicy(2));
    }).pipe(Effect.provide(services(files, false)));
  });

  it.effect("keeps the applied version when the saved document is invalid", () => {
    const files = new Map([[ROUTING_POLICY_PATH, routingPolicy(1)]]);
    return Effect.gen(function* () {
      yield* getSnapshot({});
      const broken = routingPolicy(2, "A1 (all low)");
      const saved = yield* saveDocument({
        key: "routingPolicy",
        baseSha256: sha256(routingPolicy(1)),
        content: broken,
      });
      const status = revisionOf(saved.snapshot);

      assert.equal(saved.status, "invalid");
      assert.equal(status?.applied?.revision, 1);
      assert.isTrue(status?.kept);
      assert.deepStrictEqual(
        status?.errors.map((issue) => issue.code),
        ["policy_invalid_kept", "table_row_invalid", "role_missing"],
      );
      assert.equal(files.get(ROUTING_POLICY_PATH), broken);
    }).pipe(Effect.provide(services(files, false)));
  });

  it.effect("refuses a save whose base SHA is stale", () => {
    const files = new Map([[ROUTING_POLICY_PATH, routingPolicy(1)]]);
    return Effect.gen(function* () {
      yield* getSnapshot({});
      files.set(ROUTING_POLICY_PATH, routingPolicy(2));
      const saved = yield* saveDocument({
        key: "routingPolicy",
        baseSha256: sha256(routingPolicy(1)),
        content: routingPolicy(3),
      });

      assert.equal(saved.status, "changed_externally");
      assert.equal(files.get(ROUTING_POLICY_PATH), routingPolicy(2));
    }).pipe(Effect.provide(services(files, false)));
  });

  it.effect("holds an external edit as pending, shows the diff, then applies it", () => {
    const files = new Map([[ROUTING_POLICY_PATH, routingPolicy(1)]]);
    return Effect.gen(function* () {
      yield* getSnapshot({});
      files.set(ROUTING_POLICY_PATH, routingPolicy(2));

      const pendingSnapshot = yield* getSnapshot({});
      assert.equal(revisionOf(pendingSnapshot)?.applied?.revision, 1);
      assert.isTrue(revisionOf(pendingSnapshot)?.pending);

      const pending = yield* getPending({ key: "routingPolicy" });
      assert.isTrue(pending.pending);
      const diff = pending.change?.files[0]?.diff ?? "";
      assert.include(diff, "--- a/policies/routing-policy.md");
      assert.include(diff, "-revision: 1");
      assert.include(diff, "+revision: 2");
      assert.isTrue(pending.change?.valid);

      const applied = yield* applyPending({
        key: "routingPolicy",
        liveSha256: sha256(routingPolicy(2)),
      });
      assert.equal(applied.status, "applied");
      assert.equal(revisionOf(applied.snapshot)?.applied?.revision, 2);
      assert.isFalse(revisionOf(applied.snapshot)?.pending);
    }).pipe(Effect.provide(services(files, false)));
  });

  it.effect("refuses Apply of a newer live edit and never applies an invalid one", () => {
    const files = new Map([[ROUTING_POLICY_PATH, routingPolicy(1)]]);
    return Effect.gen(function* () {
      yield* getSnapshot({});
      files.set(ROUTING_POLICY_PATH, routingPolicy(2));
      yield* getPending({ key: "routingPolicy" });

      const stale = yield* applyPending({
        key: "routingPolicy",
        liveSha256: sha256(routingPolicy(1)),
      });
      assert.equal(stale.status, "changed_externally");
      assert.equal(revisionOf(stale.snapshot)?.applied?.revision, 1);

      const broken = routingPolicy(3, "A1 (all low)");
      files.set(ROUTING_POLICY_PATH, broken);
      yield* getPending({ key: "routingPolicy" });
      const invalid = yield* applyPending({
        key: "routingPolicy",
        liveSha256: sha256(broken),
      });
      assert.equal(invalid.status, "invalid");
      assert.equal(revisionOf(invalid.snapshot)?.applied?.revision, 1);
      assert.isTrue(revisionOf(invalid.snapshot)?.kept);
    }).pipe(Effect.provide(services(files, false)));
  });

  it.effect(
    "applies external edits immediately once the toggle is on, and keeps invalid ones out",
    () => {
      const files = new Map([[ROUTING_POLICY_PATH, routingPolicy(1)]]);
      return Effect.gen(function* () {
        yield* getSnapshot({});
        files.set(ROUTING_POLICY_PATH, routingPolicy(2));
        const pending = yield* getSnapshot({});
        assert.isTrue(revisionOf(pending)?.pending);

        const enabled = yield* setApplyExternalEdits({ enabled: true });
        assert.isTrue(enabled.enabled);
        assert.equal(revisionOf(enabled.snapshot)?.applied?.revision, 2);

        files.set(ROUTING_POLICY_PATH, routingPolicy(3, "A1 (all low)"));
        const auto = yield* getSnapshot({});
        assert.equal(revisionOf(auto)?.applied?.revision, 2);
        assert.isTrue(revisionOf(auto)?.kept);
        assert.isFalse(revisionOf(auto)?.pending);

        const off = yield* setApplyExternalEdits({ enabled: false });
        assert.isFalse(off.enabled);
        files.set(ROUTING_POLICY_PATH, routingPolicy(4));
        const held = yield* getSnapshot({});
        assert.equal(revisionOf(held)?.applied?.revision, 2);
        assert.isTrue(revisionOf(held)?.pending);
      }).pipe(Effect.provide(services(files, false)));
    },
  );

  it.effect(
    "restores the applied version after a restart and does not apply pending silently",
    () => {
      const files = new Map([[ROUTING_POLICY_PATH, routingPolicy(1)]]);
      return Effect.gen(function* () {
        // One applied store shared by both tracker instances, as the database is.
        const applied = yield* Ref.make(new Map<string, readonly PolicyAppliedRecord[]>());
        const sharedStore = Layer.succeed(
          PolicyAppliedStore,
          PolicyAppliedStore.of({
            load: ({ scope, key }) =>
              Effect.map(Ref.get(applied), (all) => all.get(`${scope}:${key}`) ?? []),
            save: ({ scope, key, files: appliedFiles, appliedAt, appliedBy }) =>
              Ref.update(applied, (all) => {
                const next = new Map(all);
                next.set(
                  `${scope}:${key}`,
                  appliedFiles.map((file) => ({ ...file, appliedAt, appliedBy })),
                );
                return next;
              }),
          }),
        );

        yield* getSnapshot({}).pipe(Effect.provide(services(files, false, sharedStore)));

        // Restart: a new tracker over the persisted applied copy.
        const restored = yield* getSnapshot({}).pipe(
          Effect.provide(services(files, false, sharedStore)),
        );
        assert.equal(revisionOf(restored)?.applied?.revision, 1);
        assert.isFalse(revisionOf(restored)?.pending);

        // An external edit made while the server was off stays pending after restart.
        files.set(ROUTING_POLICY_PATH, routingPolicy(2));
        const afterRestart = yield* getSnapshot({}).pipe(
          Effect.provide(services(files, false, sharedStore)),
        );
        assert.equal(revisionOf(afterRestart)?.applied?.revision, 1);
        assert.isTrue(revisionOf(afterRestart)?.pending);
      });
    },
  );
});

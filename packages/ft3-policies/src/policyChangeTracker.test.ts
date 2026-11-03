// @effect-diagnostics nodeBuiltinImport:off - the fake store hashes document content.
import * as NodeCrypto from "node:crypto";

import { DocsService, DocsServiceError } from "@t3tools/ft3-docs/server";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { PolicyDocumentSource } from "./contracts.ts";
import {
  PolicyChangeTracker,
  type PolicyDocumentStatus,
  layer as policyChangeTrackerLayer,
} from "./policyChangeTracker.ts";
import {
  PolicyDocumentLoader,
  docsPolicyDocumentReadPort,
  layer as policyDocumentLoaderLayer,
} from "./policyDocumentLoader.ts";
import { layerMemory as policyAppliedStoreLayer } from "./policyAppliedStore.ts";

const sha256 = (content: string): string =>
  NodeCrypto.createHash("sha256").update(content, "utf8").digest("hex");

/** A `DocsService` over an in-memory file map; only reads are used by the loader. */
const fakeDocs = (files: ReadonlyMap<string, string>) =>
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
        [...files.entries()]
          .filter(([relPath]) => relPath.startsWith(folder === undefined ? "" : `${folder}/`))
          .map(([relPath]) => ({
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
        const relPath = ref;
        const content = files.get(relPath);
        if (content === undefined) {
          return yield* new DocsServiceError({ code: "document_not_found", ref });
        }
        return {
          document: {
            stableId: relPath,
            relPath,
            name: relPath.split("/").pop() ?? relPath,
            description: "",
            sha256: sha256(content),
            ocLink: `oc://doc/${relPath}`,
          },
          absolutePath: `/store/${relPath}`,
        };
      }),
    search: () => Effect.succeed([]),
    write: () => Effect.die("unused in the policy loader tests"),
    writeAsHuman: () => Effect.die("unused in the policy loader tests"),
    locateServerPath: () => Effect.succeed(null),
    setDescription: () => Effect.die("unused in the policy loader tests"),
    docRef: () => Effect.die("unused in the policy loader tests"),
  });

/** The loader layer over the fake store, through the same port the RPC layer uses. */
const loaderLayer = (files: ReadonlyMap<string, string>) =>
  policyDocumentLoaderLayer(docsPolicyDocumentReadPort(fakeDocs(files)));

const ROUTING_POLICY_PATH = "policies/routing-policy.md";
const ROLES_DIR = "policies/roles/";

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

const ROLES_MANIFEST = [
  "{",
  '  "schema": "corvis-role-map-v1",',
  '  "revision": 3,',
  '  "configured": true,',
  '  "roles": [',
  '    { "id": "lead", "roleId": "lead", "file": "lead.md" },',
  '    { "id": "implementation", "roleId": "implementation", "file": "implementation.md", "upstreamRole": "implementation" }',
  "  ]",
  "}",
  "",
].join("\n");

const roleFile = (roleId: string, revision = 1): string =>
  [
    "---",
    "schema: corvis-role-v1",
    `roleId: ${roleId}`,
    `revision: ${revision}`,
    "configured: true",
    "---",
    "",
    "# Role",
    "",
  ].join("\n");

const docSource = (relPath: string): PolicyDocumentSource => ({
  kind: "doc",
  address: { kind: "path", relPath },
});

const builtin = { kind: "builtin" } as const;

const sources = {
  routingPolicy: docSource(ROUTING_POLICY_PATH),
  roles: builtin,
  leadSkills: builtin,
} as const;

const withTracker = (
  store: Map<string, string>,
  use: (tracker: PolicyChangeTracker["Service"]) => Effect.Effect<void, never, never>,
) =>
  Effect.gen(function* () {
    const tracker = yield* PolicyChangeTracker;
    return yield* use(tracker);
  }).pipe(
    Effect.provide(
      policyChangeTrackerLayer.pipe(
        Layer.provide(loaderLayer(store)),
        Layer.provide(policyAppliedStoreLayer),
      ),
    ),
  );

const routingStatus = (snapshot: {
  readonly documents: readonly PolicyDocumentStatus[];
}): PolicyDocumentStatus | undefined =>
  snapshot.documents.find((document) => document.key === "routingPolicy");

describe("PolicyChangeTracker applied versions", () => {
  it.effect("applies a valid update and keeps the live sha", () => {
    const store = new Map([[ROUTING_POLICY_PATH, routingPolicy(1)]]);
    return withTracker(store, (tracker) =>
      Effect.gen(function* () {
        const first = yield* tracker.refresh({
          sources,
          features: { board: true },
          applyExternalEdits: true,
        });
        const initial = routingStatus(first);
        assert.equal(initial?.applied?.revision, 1);
        assert.equal(initial?.applied?.sha256, sha256(routingPolicy(1)));
        assert.deepStrictEqual(initial?.errors, []);
        assert.equal(initial?.kept, false);
        assert.equal(first.configVersion, 1);

        store.set(ROUTING_POLICY_PATH, routingPolicy(2));
        const second = yield* tracker.refresh({
          sources,
          features: { board: true },
          applyExternalEdits: true,
        });
        const updated = routingStatus(second);

        assert.equal(updated?.applied?.revision, 2);
        assert.equal(updated?.applied?.sha256, sha256(routingPolicy(2)));
        assert.equal(updated?.seen?.revision, 2);
        assert.equal(updated?.seen?.sha256, sha256(routingPolicy(2)));
        assert.deepStrictEqual(updated?.errors, []);
        assert.equal(second.configVersion, 2);

        const applied = yield* tracker.applied("routingPolicy");
        assert.equal(applied?.revision, 2);
      }),
    );
  });

  it.effect("keeps the applied version when the new one has a line error", () => {
    const store = new Map([[ROUTING_POLICY_PATH, routingPolicy(1)]]);
    return withTracker(store, (tracker) =>
      Effect.gen(function* () {
        yield* tracker.refresh({ sources, features: { board: true }, applyExternalEdits: true });

        const broken = routingPolicy(2, "A1 (all low)");
        store.set(ROUTING_POLICY_PATH, broken);
        const snapshot = yield* tracker.refresh({
          sources,
          features: { board: true },
          applyExternalEdits: true,
        });
        const status = routingStatus(snapshot);
        const line = broken.split("\n").findIndex((text) => text.includes("(all low)")) + 1;

        assert.equal(status?.applied?.revision, 1);
        assert.equal(status?.applied?.sha256, sha256(routingPolicy(1)));
        assert.equal(status?.seen?.revision, 2);
        assert.equal(status?.kept, true);
        assert.deepStrictEqual(
          status?.errors.map((issue) => issue.code),
          ["policy_invalid_kept", "table_row_invalid", "role_missing"],
        );
        assert.equal(
          status?.errors[0]?.message,
          'Document "routingPolicy" has errors and was not applied; revision 1 stays active.',
        );
        assert.equal(status?.errors[1]?.line, line);
        assert.equal(status?.errors[1]?.document, "routingPolicy");
        assert.equal(status?.errors[1]?.text, "A1 (all low)");
        assert.equal(snapshot.configVersion, 1);

        const applied = yield* tracker.applied("routingPolicy");
        assert.equal(applied?.revision, 1);
      }),
    );
  });

  it.effect("applies the fixed document and clears the kept error", () => {
    const store = new Map([[ROUTING_POLICY_PATH, routingPolicy(1)]]);
    return withTracker(store, (tracker) =>
      Effect.gen(function* () {
        yield* tracker.refresh({ sources, features: { board: true }, applyExternalEdits: true });
        store.set(ROUTING_POLICY_PATH, routingPolicy(2, "A1 (all low)"));
        yield* tracker.refresh({ sources, features: { board: true }, applyExternalEdits: true });

        store.set(ROUTING_POLICY_PATH, routingPolicy(3));
        const snapshot = yield* tracker.refresh({
          sources,
          features: { board: true },
          applyExternalEdits: true,
        });
        const status = routingStatus(snapshot);

        assert.equal(status?.applied?.revision, 3);
        assert.equal(status?.seen?.revision, 3);
        assert.deepStrictEqual(status?.errors, []);
        assert.deepStrictEqual(status?.warnings, []);
        assert.equal(status?.kept, false);
        assert.equal(snapshot.configVersion, 2);
      }),
    );
  });
});

describe("PolicyDocumentLoader store trees", () => {
  it.effect("reads the roles manifest and its files through DocsService", () => {
    const store = new Map([
      [`${ROLES_DIR}roles.json`, ROLES_MANIFEST],
      [`${ROLES_DIR}lead.md`, roleFile("lead")],
      [`${ROLES_DIR}implementation.md`, roleFile("implementation")],
    ]);
    return Effect.gen(function* () {
      const loader = yield* PolicyDocumentLoader;
      const loaded = yield* loader.load({
        key: "roles",
        source: docSource(`${ROLES_DIR}roles.json`),
        features: { board: true },
      });

      if (loaded.key !== "roles") throw new Error("expected the roles document");
      assert.equal(loaded.valid, true);
      assert.equal(loaded.revision, 3);
      assert.equal(loaded.configured, true);
      assert.equal(loaded.sha256, sha256(ROLES_MANIFEST));
      assert.deepStrictEqual(loaded.issues, []);
      assert.equal(loaded.requirements.leadRole, true);
      const document = loaded.document;
      assert.equal(document?.roles.length, 2);
      assert.deepStrictEqual(
        document?.roles.map((role) => role.id),
        ["lead", "implementation"],
      );
    }).pipe(Effect.provide(loaderLayer(store)));
  });

  it.effect("reports a missing document without failing the effect", () => {
    return Effect.gen(function* () {
      const loader = yield* PolicyDocumentLoader;
      const loaded = yield* loader.load({
        key: "routingPolicy",
        source: docSource(ROUTING_POLICY_PATH),
      });

      assert.equal(loaded.valid, false);
      assert.equal(loaded.document, null);
      assert.equal(loaded.sha256, null);
      assert.deepStrictEqual(
        loaded.issues.map((issue) => issue.code),
        ["document_missing"],
      );
      assert.equal(loaded.issues[0]?.message.includes(ROUTING_POLICY_PATH), true);
    }).pipe(Effect.provide(loaderLayer(new Map())));
  });
});

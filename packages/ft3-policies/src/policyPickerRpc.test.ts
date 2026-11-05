// @effect-diagnostics nodeBuiltinImport:off - the browse tests list a real temporary directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { DocsService, DocsServiceError } from "@t3tools/ft3-docs/server";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { policiesRpcHandlers, SERVER_DIRECTORY_LISTING_CAP } from "./rpc.ts";
import {
  FT3_POLICIES_WS_METHODS,
  type PoliciesBrowseServerDirectoryResult,
  type PoliciesDirectoryBrowseError,
} from "./rpc-contracts.ts";

const listStoreDocuments = policiesRpcHandlers[FT3_POLICIES_WS_METHODS.policiesListStoreDocuments];
const browseServerDirectory =
  policiesRpcHandlers[FT3_POLICIES_WS_METHODS.policiesBrowseServerDirectory];

const docsOver = (options: {
  readonly manifest: ReadonlyArray<{
    readonly relPath: string;
    readonly stableId: string;
    readonly name: string;
    readonly description: string;
  }>;
  readonly manifestError?: DocsServiceError;
  readonly search: Effect.Effect<
    ReadonlyArray<{
      readonly relPath: string;
      readonly stableId: string;
      readonly title: string;
      readonly snippet: string;
      readonly score: number;
    }>,
    DocsServiceError
  >;
}) =>
  DocsService.of({
    list: () => Effect.die("unused in the picker tests"),
    manifest: () =>
      options.manifestError === undefined
        ? Effect.succeed(options.manifest.map((entry) => ({ ...entry, updatedAt: "" })))
        : Effect.fail(options.manifestError),
    read: () => Effect.die("unused in the picker tests"),
    docStat: () => Effect.die("unused in the picker tests"),
    resolve: () => Effect.die("unused in the picker tests"),
    search: () => options.search,
    write: () => Effect.die("unused in the picker tests"),
    writeAsHuman: () => Effect.die("unused in the picker tests"),
    locateServerPath: () => Effect.die("unused in the picker tests"),
    setDescription: () => Effect.die("unused in the picker tests"),
    docRef: () => Effect.die("unused in the picker tests"),
  });

const docsLayer = (options: Parameters<typeof docsOver>[0]) =>
  Layer.succeed(DocsService, docsOver(options));

describe("policies.listStoreDocuments", () => {
  it.effect("lists the manifest sorted by store path when no query is given", () =>
    Effect.gen(function* () {
      const result = yield* listStoreDocuments({});
      assert.deepStrictEqual(
        result.documents.map((entry) => entry.relPath),
        ["policies/routing-policy.md", "roles/lead.md", "roles/roles.json"],
      );
      assert.equal(result.documents[2]?.stableId, "id-roles");
      assert.equal(result.documents[2]?.description, "Role map");
    }).pipe(
      Effect.provide(
        docsLayer({
          manifest: [
            {
              relPath: "roles/roles.json",
              stableId: "id-roles",
              name: "roles.json",
              description: "Role map",
            },
            {
              relPath: "policies/routing-policy.md",
              stableId: "id-routing",
              name: "routing-policy.md",
              description: "",
            },
            { relPath: "roles/lead.md", stableId: "id-lead", name: "lead.md", description: "" },
          ],
          search: Effect.succeed([]),
        }),
      ),
    ),
  );

  it.effect("searches through the docs index when a query is given", () =>
    Effect.gen(function* () {
      const result = yield* listStoreDocuments({ query: "lead" });
      assert.deepStrictEqual(
        result.documents.map((entry) => entry.relPath),
        ["roles/lead.md"],
      );
      assert.equal(result.documents[0]?.name, "Lead");
    }).pipe(
      Effect.provide(
        docsLayer({
          manifest: [
            { relPath: "roles/lead.md", stableId: "id-lead", name: "lead.md", description: "hit" },
            {
              relPath: "roles/roles.json",
              stableId: "id-roles",
              name: "roles.json",
              description: "",
            },
          ],
          search: Effect.succeed([
            {
              relPath: "roles/lead.md",
              stableId: "id-lead",
              title: "Lead",
              snippet: "hit",
              score: 1,
            },
          ]),
        }),
      ),
    ),
  );

  it.effect("falls back to a path filter when the search index is unavailable", () =>
    Effect.gen(function* () {
      const result = yield* listStoreDocuments({ query: "routing" });
      assert.deepStrictEqual(
        result.documents.map((entry) => entry.relPath),
        ["policies/routing-policy.md"],
      );
    }).pipe(
      Effect.provide(
        docsLayer({
          manifest: [
            {
              relPath: "policies/routing-policy.md",
              stableId: "id-routing",
              name: "routing-policy.md",
              description: "",
            },
            {
              relPath: "roles/roles.json",
              stableId: "id-roles",
              name: "roles.json",
              description: "",
            },
          ],
          search: Effect.fail(new DocsServiceError({ code: "search_unavailable" })),
        }),
      ),
    ),
  );

  it.effect("surfaces a store failure as a store-documents error", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(listStoreDocuments({}));
      assert.equal(failure._tag, "PoliciesStoreDocumentsError");
      assert.include(failure.message, "store_unavailable");
    }).pipe(
      Effect.provide(
        docsLayer({
          manifest: [],
          manifestError: new DocsServiceError({ code: "store_unavailable" }),
          search: Effect.succeed([]),
        }),
      ),
    ),
  );
});

describe("policies.browseServerDirectory", () => {
  // Effect.flip carries the success shape into the error channel, so failure
  // assertions see both channels here.
  const withTempDir = (
    build: (directory: string) => void,
    run: (
      directory: string,
    ) => Effect.Effect<
      void,
      PoliciesDirectoryBrowseError | PoliciesBrowseServerDirectoryResult,
      never
    >,
  ) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ft3-policy-browse-"));
        build(directory);
        return directory;
      }),
      (directory) => run(directory),
      (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
    );

  const fixture = (directory: string) => {
    NodeFS.mkdirSync(NodePath.join(directory, "sub"));
    NodeFS.mkdirSync(NodePath.join(directory, "empty"));
    NodeFS.writeFileSync(NodePath.join(directory, "roles.json"), "{}");
    NodeFS.writeFileSync(NodePath.join(directory, "ROUTING.MD"), "");
    NodeFS.writeFileSync(NodePath.join(directory, "notes.txt"), "");
  };

  it.effect("lists directories and .json/.md files sorted by name", () =>
    withTempDir(fixture, (directory) =>
      Effect.gen(function* () {
        const result = yield* browseServerDirectory({ directory });
        assert.deepStrictEqual(
          result.directories.map((entry) => entry.name),
          ["empty", "sub"],
        );
        assert.deepStrictEqual(
          result.files.map((entry) => entry.name),
          ["roles.json", "ROUTING.MD"],
        );
        assert.equal(result.files[0]?.path, NodePath.join(directory, "roles.json"));
        assert.equal(result.parent, NodePath.dirname(directory));
        assert.isFalse(result.truncated);
      }),
    ),
  );

  it.effect("caps a huge directory and reports the listing as truncated", () =>
    withTempDir(
      (directory) => {
        for (let index = 0; index < SERVER_DIRECTORY_LISTING_CAP + 5; index += 1) {
          NodeFS.writeFileSync(NodePath.join(directory, `doc-${index}.md`), "");
        }
      },
      (directory) =>
        Effect.gen(function* () {
          const result = yield* browseServerDirectory({ directory });
          assert.isTrue(result.truncated);
          assert.equal(result.files.length, SERVER_DIRECTORY_LISTING_CAP);
        }),
    ),
  );

  it.effect("reports a null parent at a filesystem root", () =>
    Effect.gen(function* () {
      const result = yield* browseServerDirectory({
        directory: NodePath.parse(process.cwd()).root,
      });
      assert.isNull(result.parent);
    }),
  );

  it.effect("refuses a relative path", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(browseServerDirectory({ directory: "relative/dir" }));
      assert.equal(failure.code, "not_absolute");
    }),
  );

  it.effect("refuses a path that is not a directory", () =>
    withTempDir(fixture, (directory) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          browseServerDirectory({ directory: NodePath.join(directory, "roles.json") }),
        );
        assert.equal(failure.code, "not_directory");
      }),
    ),
  );

  it.effect("reports a missing directory as unreadable", () =>
    withTempDir(fixture, (directory) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          browseServerDirectory({ directory: NodePath.join(directory, "missing") }),
        );
        assert.equal(failure.code, "read_failed");
      }),
    ),
  );
});

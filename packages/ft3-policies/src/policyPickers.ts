// @effect-diagnostics nodeBuiltinImport:off - the server directory browse lists a real directory.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { DocsService } from "@t3tools/ft3-docs/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  type PoliciesBrowseServerDirectoryInput,
  type PoliciesBrowseServerDirectoryResult,
  PoliciesDirectoryBrowseError,
  type PoliciesListStoreDocumentsInput,
  type PoliciesListStoreDocumentsResult,
  PoliciesStoreDocumentsError,
} from "./rpc-contracts.ts";

const STORE_PICKER_LIMIT = 50;

const storeDocumentsError = (cause: { readonly code: string }) =>
  new PoliciesStoreDocumentsError({
    message: `Could not list the store documents (${cause.code}).`,
  });

export const SERVER_DIRECTORY_LISTING_CAP = 1000;
const POLICY_FILE_EXTENSIONS = new Set([".json", ".md"]);

export class PolicyPickers extends Context.Service<
  PolicyPickers,
  {
    readonly listStoreDocuments: (
      input: PoliciesListStoreDocumentsInput,
    ) => Effect.Effect<PoliciesListStoreDocumentsResult, PoliciesStoreDocumentsError>;
    readonly browseServerDirectory: (
      input: PoliciesBrowseServerDirectoryInput,
    ) => Effect.Effect<PoliciesBrowseServerDirectoryResult, PoliciesDirectoryBrowseError>;
  }
>()("@t3tools/ft3-policies/policyPickers") {}

const make = Effect.gen(function* () {
  const docs = yield* DocsService;

  /**
   * The store side of the source picker. An empty query lists the manifest
   * (recursively, capped); a query searches titles, paths and bodies through the
   * same index `docs_search` uses, falling back to a path/name filter when the
   * index is unavailable.
   */
  const listStoreDocuments = Effect.fn("PolicyPickers.listStoreDocuments")(function* (
    input: PoliciesListStoreDocumentsInput,
  ) {
    const query = input.query?.trim() ?? "";
    if (query === "") {
      const entries = yield* docs.manifest({ limit: STORE_PICKER_LIMIT });
      return {
        documents: entries
          .map((entry) => ({
            stableId: entry.stableId,
            relPath: entry.relPath,
            name: entry.name,
            description: entry.description,
          }))
          .toSorted((left, right) => left.relPath.localeCompare(right.relPath)),
      } satisfies PoliciesListStoreDocumentsResult;
    }
    const results = yield* docs.search({ query, limit: STORE_PICKER_LIMIT }).pipe(
      Effect.catchIf(
        (error) => error.code === "search_unavailable" || error.code === "invalid_input",
        () => Effect.succeed(null),
      ),
    );
    if (results !== null) {
      const seen = new Set<string>();
      return {
        documents: results.flatMap((result) => {
          if (seen.has(result.stableId)) return [];
          seen.add(result.stableId);
          return [
            {
              stableId: result.stableId,
              relPath: result.relPath,
              name: result.title,
              description: result.snippet,
            },
          ];
        }),
      } satisfies PoliciesListStoreDocumentsResult;
    }
    const needle = query.toLowerCase();
    const entries = yield* docs.manifest({ limit: 200 });
    return {
      documents: entries
        .filter(
          (entry) =>
            entry.relPath.toLowerCase().includes(needle) ||
            entry.name.toLowerCase().includes(needle),
        )
        .slice(0, STORE_PICKER_LIMIT)
        .map((entry) => ({
          stableId: entry.stableId,
          relPath: entry.relPath,
          name: entry.name,
          description: entry.description,
        })),
    } satisfies PoliciesListStoreDocumentsResult;
  }, Effect.mapError(storeDocumentsError));

  /**
   * The server-file side of the source picker: lists one absolute directory on
   * the server's filesystem (a native OS dialog can't serve remote clients) with
   * directories for navigation and .json/.md files for selection.
   */
  const browseServerDirectory = Effect.fn("PolicyPickers.browseServerDirectory")(function* (
    input: PoliciesBrowseServerDirectoryInput,
  ) {
    const directory = input.directory;
    if (!NodePath.isAbsolute(directory)) {
      return yield* new PoliciesDirectoryBrowseError({
        directory,
        code: "not_absolute",
        message: `"${directory}" is not an absolute server path.`,
      });
    }
    const stat = yield* Effect.tryPromise({
      try: () => NodeFSP.stat(directory),
      catch: () =>
        new PoliciesDirectoryBrowseError({
          directory,
          code: "read_failed",
          message: `Could not read the server directory "${directory}".`,
        }),
    });
    if (!stat.isDirectory()) {
      return yield* new PoliciesDirectoryBrowseError({
        directory,
        code: "not_directory",
        message: `"${directory}" is not a server directory.`,
      });
    }
    const directories: Array<{ name: string; path: string }> = [];
    const files: Array<{ name: string; path: string }> = [];
    const truncated = yield* Effect.tryPromise({
      try: async () => {
        const handle = await NodeFSP.opendir(directory);
        try {
          for await (const dirent of handle) {
            if (directories.length + files.length >= SERVER_DIRECTORY_LISTING_CAP) return true;
            const fullPath = NodePath.join(directory, dirent.name);
            if (dirent.isDirectory()) {
              directories.push({ name: dirent.name, path: fullPath });
            } else if (
              dirent.isFile() &&
              POLICY_FILE_EXTENSIONS.has(NodePath.extname(dirent.name).toLowerCase())
            ) {
              files.push({ name: dirent.name, path: fullPath });
            }
          }
          return false;
        } finally {
          await handle.close().catch(() => undefined);
        }
      },
      catch: () =>
        new PoliciesDirectoryBrowseError({
          directory,
          code: "read_failed",
          message: `Could not read the server directory "${directory}".`,
        }),
    });
    const byName = (left: { name: string }, right: { name: string }) =>
      left.name.localeCompare(right.name);
    const parent = NodePath.dirname(directory);
    return {
      parent: parent === directory ? null : parent,
      directories: directories.toSorted(byName),
      files: files.toSorted(byName),
      truncated,
    } satisfies PoliciesBrowseServerDirectoryResult;
  });

  return PolicyPickers.of({ listStoreDocuments, browseServerDirectory });
});

export const layer: Layer.Layer<PolicyPickers, never, DocsService> = Layer.effect(
  PolicyPickers,
  make,
);

// @effect-diagnostics nodeBuiltinImport:off - the service hashes the document bytes it reads.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { type DocRef, parseDocRef } from "./contracts.ts";
import * as DocsIndex from "./index.ts";
import * as DocsReconciler from "./reconciler.ts";
import * as DocsStore from "./store.ts";

/** Every way `DocsService` refuses or fails a call (design §5). */
export const DocsServiceErrorCode = Schema.Literals([
  "invalid_ref",
  "document_outside_store",
  "document_not_found",
  "document_changed",
  "document_protected",
  "capability_denied",
  "invalid_input",
  "search_unavailable",
  "store_unavailable",
]);
export type DocsServiceErrorCode = typeof DocsServiceErrorCode.Type;

/** Why the write rule refused a caller; the denial message names it (design §3.5). */
export const DocsWriteDenialReason = Schema.Literals([
  "write_disabled",
  "no_caller_thread",
  "planner_plan_unknown",
  "planner_other_document",
  "general_without_grant",
  "child_read_only",
]);
export type DocsWriteDenialReason = typeof DocsWriteDenialReason.Type;

/** Why the write rule allowed a caller. */
export type DocumentsWriteAllowReason = "top_level_thread" | "granted_general" | "planner_plan";

const denialDetail = (reason: DocsWriteDenialReason): string => {
  switch (reason) {
    case "write_disabled":
      return "document writes are turned off for every thread";
    case "no_caller_thread":
      return "the call is not attached to a thread";
    case "planner_plan_unknown":
      return "this planner has no plan document yet";
    case "planner_other_document":
      return "a planner may change only the plan document of its card";
    case "general_without_grant":
      return "a general child needs the lead's explicit documents:write grant";
    case "child_read_only":
      return "a delegated child may only read documents";
  }
};

export class DocsServiceError extends Schema.TaggedError<DocsServiceError>()("DocsServiceError", {
  code: DocsServiceErrorCode,
  ref: Schema.optionalKey(Schema.String),
  /** Last known store path of a document that could not be resolved. */
  relPath: Schema.optionalKey(Schema.String),
  /** The write rule's reason, present on `capability_denied`. */
  reason: Schema.optionalKey(DocsWriteDenialReason),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.code) {
      case "invalid_ref":
        return `"${this.ref ?? ""}" is not a document reference. Use a store path or an oc://doc link.`;
      case "document_outside_store":
        return `"${this.ref ?? ""}" is not a document in the store. Use a store path or an oc://doc link.`;
      case "document_not_found":
        return this.relPath === undefined
          ? `Document "${this.ref ?? ""}" was not found.`
          : `Document "${this.ref ?? ""}" was not found; its last known path was "${this.relPath}".`;
      case "document_changed":
        return `Document "${this.ref ?? ""}" changed since you read it. Read it again and retry.`;
      case "document_protected":
        return `Document "${this.ref ?? ""}" can be changed only by the human.`;
      case "capability_denied":
        return this.reason === undefined
          ? "This thread may not change documents."
          : `This thread may not change documents (${this.reason}): ${denialDetail(this.reason)}.`;
      case "invalid_input":
        return "The document request is not valid.";
      case "search_unavailable":
        return "Document search is unavailable in this runtime.";
      case "store_unavailable":
        return "The document store is unavailable.";
    }
  }
}

/** The calling thread's lineage, which the write rule reads (design §3.5). */
export interface DocsCaller {
  readonly threadId: string | null;
  readonly parentThreadId: string | null;
}

/**
 * What a caller may change. `store` covers every unprotected document of the
 * store; `document` covers exactly one (a planner and its own plan). Every
 * decision carries the reason it was reached, so a denial can name it.
 */
export type DocumentsWriteDecision =
  | {
      readonly _tag: "Allow";
      readonly scope: "store";
      readonly reason: "top_level_thread" | "granted_general";
    }
  | {
      readonly _tag: "Allow";
      readonly scope: "document";
      readonly stableId: string;
      readonly reason: "planner_plan";
    }
  | { readonly _tag: "Deny"; readonly reason: DocsWriteDenialReason };

/**
 * Port of the `documents:write` rule. The lineage rule lives in `writeRule.ts`
 * and is the default the docs MCP tools use; this service stays the seam so a
 * host can still supply its own rule.
 */
export class DocumentsWriteAccess extends Context.Service<
  DocumentsWriteAccess,
  {
    readonly decide: (caller: DocsCaller) => Effect.Effect<DocumentsWriteDecision, never, never>;
  }
>()("@t3tools/ft3-docs/service/DocumentsWriteAccess") {}

/** Refuses every write, whatever the caller; hosts without the lineage rule use this. */
export const denyAllDocumentsWrite: Layer.Layer<DocumentsWriteAccess> = Layer.succeed(
  DocumentsWriteAccess,
  DocumentsWriteAccess.of({
    decide: Effect.fn("DocumentsWriteAccess.deny")(() =>
      Effect.succeed({ _tag: "Deny", reason: "write_disabled" } as const),
    ),
  }),
);

/**
 * Port of the protected-document rule: policy documents and the plans of other
 * cards are never writable through MCP (design §3.5). Until a rule is provided,
 * nothing is protected; the deny-by-default write port above still refuses.
 */
export class DocsProtection extends Context.Service<
  DocsProtection,
  {
    readonly isProtected: (document: {
      readonly stableId: string;
      readonly relPath: string;
    }) => Effect.Effect<boolean, never, never>;
  }
>()("@t3tools/ft3-docs/service/DocsProtection") {}

/** No document is protected by default; the write rule still denies. */
export const noProtectedDocuments: Layer.Layer<DocsProtection> = Layer.succeed(
  DocsProtection,
  DocsProtection.of({
    isProtected: Effect.fn("DocsProtection.none")(() => Effect.succeed(false)),
  }),
);

/** Metadata of one store document, without its content and without any absolute path. */
export interface DocsDocumentMeta {
  readonly stableId: string;
  readonly relPath: string;
  readonly name: string;
  readonly description: string;
  readonly sha256: string;
  readonly ocLink: string;
}

export interface DocsReadResult extends DocsDocumentMeta {
  readonly content: string;
}

/** A resolved document plus the host path the desktop client opens it with. */
export interface DocsResolution {
  readonly document: DocsDocumentMeta;
  readonly absolutePath: string;
}

export interface DocsListEntry {
  readonly relPath: string;
  readonly stableId: string;
  readonly name: string;
  readonly description: string;
  readonly updatedAt: string;
}

export interface DocsListResult {
  readonly folder: string;
  readonly folders: ReadonlyArray<{
    readonly relPath: string;
    readonly name: string;
    readonly description: string;
  }>;
  readonly documents: ReadonlyArray<DocsListEntry>;
}

export interface DocsServiceOptions {
  /** Store root: `contexts/` and `opencontext.db` live directly under it. */
  readonly root: string;
}

export interface DocsWriteInput {
  readonly caller: DocsCaller;
  /** Existing document by path or `oc://doc` link. */
  readonly ref?: string;
  /** Store path of a new document, or of the replacement target. */
  readonly relPath?: string;
  readonly content: string;
  readonly baseSha256?: string;
  readonly description?: string;
  readonly clientRequestId: string;
}

export interface DocsWriteResult {
  readonly stableId: string;
  readonly relPath: string;
  readonly name: string;
  readonly sha256: string;
  readonly ocLink: string;
}

export interface DocsSetDescriptionInput {
  readonly caller: DocsCaller;
  readonly ref: string;
  readonly description: string;
}

const sha256Hex = (content: string): string =>
  NodeCrypto.createHash("sha256").update(content, "utf8").digest("hex");

const ocLinkOf = (stableId: string): string => `oc://doc/${stableId}`;

/** Store paths are validated by the store; every other store error is a service failure. */
const mapStoreError = (cause: DocsStore.DocsStoreError): DocsServiceError => {
  switch (cause.code) {
    case "store_unavailable":
      return new DocsServiceError({ code: "store_unavailable", cause });
    case "document_not_found":
    case "file_missing":
      return new DocsServiceError({
        code: "document_not_found",
        ...(cause.path === undefined ? {} : { ref: cause.path }),
        cause,
      });
    case "invalid_path":
    case "invalid_name":
    case "invalid_limit":
      return new DocsServiceError({ code: "invalid_ref", cause });
    case "duplicate_stable_id":
    case "document_exists":
    case "folder_exists":
    case "folder_not_found":
      return new DocsServiceError({ code: "invalid_input", cause });
  }
};

const make = Effect.fn("DocsService.make")(function* (options: DocsServiceOptions) {
  const store = yield* DocsStore.DocsStore;
  const reconciler = yield* DocsReconciler.DocsReconciler;
  const index = yield* DocsIndex.DocsIndex;
  const writeAccess = yield* DocumentsWriteAccess;
  const protection = yield* DocsProtection;
  const contextsRoot = NodePath.resolve(options.root, DocsStore.DOCS_STORE_CONTEXTS_DIRECTORY);

  const absolutePathOf = (relPath: string): string =>
    NodePath.resolve(contextsRoot, ...relPath.split("/"));

  const metaOf = (document: DocsStore.DocRecord, sha256: string): DocsDocumentMeta => ({
    stableId: document.stableId,
    relPath: document.relPath,
    name: document.name,
    description: document.description,
    sha256,
    ocLink: ocLinkOf(document.stableId),
  });

  const readContent = Effect.fn("DocsService.readContent")(function* (
    document: DocsStore.DocRecord,
  ) {
    const content = yield* store
      .readDocContent({ relPath: document.relPath })
      .pipe(Effect.mapError(mapStoreError));
    return { content, sha256: sha256Hex(content) };
  });

  /** Resolves a path or `oc://` reference; one reconcile pass repairs a stale row. */
  const locate = Effect.fn("DocsService.locate")(function* (ref: string) {
    const address = parseDocRef(ref);
    if (address === null) {
      return yield* new DocsServiceError({
        code: ref.includes("/") || ref.includes("\\") ? "document_outside_store" : "invalid_ref",
        ref,
      });
    }
    if (address.kind === "path") {
      const document = yield* store.getByPath(address.relPath).pipe(Effect.mapError(mapStoreError));
      if (document === null) {
        return yield* new DocsServiceError({
          code: "document_not_found",
          ref,
          relPath: address.relPath,
        });
      }
      return document;
    }
    const found = yield* store.getByStableId(address.stableId).pipe(Effect.mapError(mapStoreError));
    if (found !== null) return found;
    // A document created or moved outside Corvis resolves after one repair pass.
    yield* reconciler.reconcile().pipe(Effect.ignore);
    const repaired = yield* store
      .getByStableId(address.stableId)
      .pipe(Effect.mapError(mapStoreError));
    if (repaired !== null) return repaired;
    return yield* new DocsServiceError({ code: "document_not_found", ref });
  });

  /** Resolves and reads a document; a row whose file moved is repaired once (design §3.2). */
  const readWithRepair = Effect.fn("DocsService.readWithRepair")(function* (ref: string) {
    const document = yield* locate(ref);
    const first = yield* readContent(document).pipe(
      Effect.map((value) => ({ _tag: "Ok" as const, ...value })),
      Effect.catch(
        (error): Effect.Effect<{ readonly _tag: "Failed"; readonly error: DocsServiceError }> =>
          Effect.succeed({ _tag: "Failed" as const, error }),
      ),
    );
    if (first._tag === "Ok") return { document, content: first.content, sha256: first.sha256 };
    if (first.error.code !== "document_not_found") return yield* first.error;
    yield* reconciler.reconcile().pipe(Effect.ignore);
    const repaired = yield* locate(ref);
    const second = yield* readContent(repaired);
    return { document: repaired, content: second.content, sha256: second.sha256 };
  });

  const list = Effect.fn("DocsService.list")(function* (input: { readonly folder?: string }) {
    const folder = input.folder?.trim().replace(/\/+$/, "") ?? "";
    const folders = yield* store.listFolders(folder);
    const documents = yield* store.listDocs(folder);
    return {
      folder,
      folders: folders
        .filter((entry) => entry.relPath !== "")
        .map((entry) => ({
          relPath: entry.relPath,
          name: entry.name,
          description: entry.description,
        })),
      documents: documents.map((entry) => ({
        relPath: entry.relPath,
        stableId: entry.stableId,
        name: entry.name,
        description: entry.description,
        updatedAt: entry.updatedAt,
      })),
    } satisfies DocsListResult;
  }, Effect.mapError(mapStoreError));

  const manifest = Effect.fn("DocsService.manifest")(function* (input: {
    readonly folder?: string;
    readonly limit?: number;
  }) {
    return yield* store
      .manifest({
        ...(input.folder === undefined ? {} : { folderRelPath: input.folder }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      })
      .pipe(Effect.mapError(mapStoreError));
  });

  const read = Effect.fn("DocsService.read")(function* (input: { readonly ref: string }) {
    const { document, content, sha256 } = yield* readWithRepair(input.ref);
    return { ...metaOf(document, sha256), content } satisfies DocsReadResult;
  });

  const resolve = Effect.fn("DocsService.resolve")(function* (input: { readonly ref: string }) {
    const { document, sha256 } = yield* readWithRepair(input.ref);
    return {
      document: metaOf(document, sha256),
      absolutePath: absolutePathOf(document.relPath),
    } satisfies DocsResolution;
  });

  const search = Effect.fn("DocsService.search")(function* (input: DocsIndex.DocsSearchInput) {
    return yield* index.search(input).pipe(
      Effect.mapError(
        (cause) =>
          new DocsServiceError({
            code: cause.code === "fts5_unavailable" ? "search_unavailable" : "invalid_input",
            cause,
          }),
      ),
    );
  });

  const requireWrite = Effect.fn("DocsService.requireWrite")(function* (
    caller: DocsCaller,
    target: { readonly stableId: string; readonly relPath: string } | null,
  ) {
    const decision = yield* writeAccess.decide(caller);
    if (decision._tag === "Deny") {
      return yield* new DocsServiceError({
        code: "capability_denied",
        reason: decision.reason,
        ...(target === null ? {} : { ref: target.relPath }),
      });
    }
    // A document-scoped right never covers a new document or another document.
    if (
      decision.scope === "document" &&
      (target === null || decision.stableId !== target.stableId)
    ) {
      return yield* new DocsServiceError({
        code: "capability_denied",
        reason: "planner_other_document",
        ...(target === null ? {} : { ref: target.relPath }),
      });
    }
    if (target !== null && (yield* protection.isProtected(target))) {
      return yield* new DocsServiceError({ code: "document_protected", ref: target.relPath });
    }
  });

  const indexDocument = Effect.fn("DocsService.indexDocument")(function* (
    document: DocsStore.DocRecord,
  ) {
    const { content, sha256 } = yield* readContent(document);
    const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    const title = /^#\s+(.+?)\s*$/m.exec(body)?.[1] ?? document.name.replace(/\.md$/i, "");
    yield* index
      .indexDocuments([
        { stableId: document.stableId, relPath: document.relPath, title, body, sha256 },
      ])
      .pipe(Effect.ignore);
  });

  const write = Effect.fn("DocsService.write")(function* (input: DocsWriteInput) {
    const ref = input.ref?.trim();
    const relPath = input.relPath?.trim();
    if ((ref === undefined || ref === "") === (relPath === undefined || relPath === "")) {
      return yield* new DocsServiceError({
        code: "invalid_input",
        ...(ref === undefined ? {} : { ref }),
      });
    }

    const existing = ref === undefined || ref === "" ? null : yield* locate(ref);
    yield* requireWrite(input.caller, existing);

    if (existing === null) {
      const created = yield* store
        .createDoc({
          relPath: relPath ?? "",
          content: input.content,
          ...(input.description === undefined ? {} : { description: input.description }),
        })
        .pipe(Effect.mapError(mapStoreError));
      yield* indexDocument(created);
      const { sha256 } = yield* readContent(created);
      return {
        stableId: created.stableId,
        relPath: created.relPath,
        name: created.name,
        sha256,
        ocLink: ocLinkOf(created.stableId),
      } satisfies DocsWriteResult;
    }

    const live = yield* readContent(existing);
    if (input.baseSha256 !== undefined && input.baseSha256 !== live.sha256) {
      return yield* new DocsServiceError({ code: "document_changed", ref: existing.relPath });
    }
    const saved = yield* store
      .saveDocContent({ relPath: existing.relPath, content: input.content })
      .pipe(Effect.mapError(mapStoreError));
    if (input.description !== undefined) {
      yield* store
        .setDescription({ relPath: saved.relPath, description: input.description })
        .pipe(Effect.mapError(mapStoreError));
    }
    yield* indexDocument(saved);
    const { sha256 } = yield* readContent(saved);
    return {
      stableId: saved.stableId,
      relPath: saved.relPath,
      name: saved.name,
      sha256,
      ocLink: ocLinkOf(saved.stableId),
    } satisfies DocsWriteResult;
  });

  const setDescription = Effect.fn("DocsService.setDescription")(function* (
    input: DocsSetDescriptionInput,
  ) {
    const document = yield* locate(input.ref);
    yield* requireWrite(input.caller, document);
    const saved = yield* store
      .setDescription({ relPath: document.relPath, description: input.description })
      .pipe(Effect.mapError(mapStoreError));
    return {
      stableId: saved.stableId,
      relPath: saved.relPath,
      name: saved.name,
      description: saved.description,
    };
  });

  /** The design's `DocRef` for an address, used by other packages. */
  const docRef = Effect.fn("DocsService.docRef")(function* (ref: string) {
    const { document } = yield* resolve({ ref });
    return {
      stableId: document.stableId,
      relPath: document.relPath,
      name: document.name,
      sha256: document.sha256,
    } satisfies DocRef;
  });

  return DocsService.of({
    list,
    manifest,
    read,
    resolve,
    search,
    write,
    setDescription,
    docRef,
  });
});

export class DocsService extends Context.Service<
  DocsService,
  {
    /** One folder level: subfolders and documents, never an absolute path. */
    readonly list: (input: {
      readonly folder?: string;
    }) => Effect.Effect<DocsListResult, DocsServiceError>;
    /** Recursive list; without a limit every document is returned (design §3.5). */
    readonly manifest: (input: {
      readonly folder?: string;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<DocsStore.DocManifestEntry>, DocsServiceError>;
    readonly read: (input: {
      readonly ref: string;
    }) => Effect.Effect<DocsReadResult, DocsServiceError>;
    readonly resolve: (input: {
      readonly ref: string;
    }) => Effect.Effect<DocsResolution, DocsServiceError>;
    readonly search: (
      input: DocsIndex.DocsSearchInput,
    ) => Effect.Effect<ReadonlyArray<DocsIndex.DocsSearchResult>, DocsServiceError>;
    readonly write: (input: DocsWriteInput) => Effect.Effect<DocsWriteResult, DocsServiceError>;
    readonly setDescription: (input: DocsSetDescriptionInput) => Effect.Effect<
      {
        readonly stableId: string;
        readonly relPath: string;
        readonly name: string;
        readonly description: string;
      },
      DocsServiceError
    >;
    /** Metadata of a resolved document, without content and without a host path. */
    readonly docRef: (ref: string) => Effect.Effect<DocRef, DocsServiceError>;
  }
>()("@t3tools/ft3-docs/service/DocsService") {}

/**
 * Service over one store root. The write and protection rules stay
 * requirements; `layerWithDefaultPorts` supplies the deny-by-default ones.
 */
export const layer = (options: DocsServiceOptions) => {
  const store = DocsStore.layer(options);
  const services = Layer.mergeAll(
    store,
    DocsReconciler.layer(options).pipe(Layer.provide(store)),
    Layer.catch(() => DocsIndex.unavailableLayer)(DocsIndex.layer),
  );
  return Layer.effect(DocsService, make(options)).pipe(Layer.provide(services));
};

/** The same service with the deny-by-default write rule and no protected documents. */
export const layerWithDefaultPorts = (options: DocsServiceOptions) =>
  layer(options).pipe(Layer.provide(Layer.mergeAll(denyAllDocumentsWrite, noProtectedDocuments)));

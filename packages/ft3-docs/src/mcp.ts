/**
 * The docs MCP toolkit (design §3.5): five reads and two writes. Reads see the
 * whole store without an absolute path; writes need the MCP write access and
 * the `documents:write` rule the `DocsService` port resolves per call.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../../apps/server/src/mcp/McpInvocationContext.ts";
import { toolkitRegistration } from "../../../apps/server/src/mcp/McpHttpServer.ts";
import * as McpToolAccess from "../../../apps/server/src/mcp/McpToolAccess.ts";
import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import * as Service from "./service.ts";
import * as Contracts from "./toolContracts.ts";
import * as WriteRule from "./writeRule.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  Service.DocsService,
  ThreadManagement.ThreadManagementService,
];

const docsList = Tool.make("docs_list", {
  description:
    "List one folder level of the Corvis document store: its subfolders and its documents with relPath, stableId, name, description and updatedAt. Omit folder for the store root. The result never carries an absolute path.",
  parameters: Contracts.DocsListInput,
  success: Contracts.DocsListResult,
  failure: Contracts.DocsMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List documents")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const docsManifest = Tool.make("docs_manifest", {
  description:
    "List documents recursively below one folder, with relPath, stableId, name, description and updatedAt. Without limit every document is returned; pass limit to cap the result. The result never carries an absolute path.",
  parameters: Contracts.DocsManifestInput,
  success: Contracts.DocsManifestResult,
  failure: Contracts.DocsMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Manifest documents")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const docsRead = Tool.make("docs_read", {
  description:
    "Read one document by store path or oc://doc link. Returns the full content plus stableId, relPath, name, sha256 and the canonical ocLink. A moved document is found again by its stable id.",
  parameters: Contracts.DocsReadInput,
  success: Contracts.DocsReadResult,
  failure: Contracts.DocsMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read document")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const docsResolve = Tool.make("docs_resolve", {
  description:
    "Resolve an oc://doc link or a store path to its metadata without the content: stableId, relPath, name, description, sha256 and ocLink, never an absolute path.",
  parameters: Contracts.DocsResolveInput,
  success: Contracts.DocsResolvedDocument,
  failure: Contracts.DocsMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Resolve document link")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const docsSearch = Tool.make("docs_search", {
  description:
    "Full-text search over document titles, paths and bodies. Every word is matched as a prefix; there is no morphology, so search письм* rather than письма. Returns relPath, stableId, title, snippet and score, best match first.",
  parameters: Contracts.DocsSearchInput,
  success: Contracts.DocsSearchResult,
  failure: Contracts.DocsMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Search documents")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const docsWrite = Tool.make("docs_write", {
  description:
    "Create a document at relPath, or replace an existing one by ref or relPath. Replacing requires baseSha256 equal to the sha256 you last read; otherwise the call fails with document_changed and you read it again. Writing needs the documents:write right of the calling thread; change a document only through this tool, never by editing files.",
  parameters: Contracts.DocsWriteInput,
  success: Contracts.DocsWriteResult,
  failure: Contracts.DocsMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Write document")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const docsSetDescription = Tool.make("docs_set_description", {
  description:
    "Set the description of one document, addressed by store path or oc://doc link. Writing needs the documents:write right of the calling thread.",
  parameters: Contracts.DocsSetDescriptionInput,
  success: Contracts.DocsSetDescriptionResult,
  failure: Contracts.DocsMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Describe document")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const toolkit = Toolkit.make(
  docsList,
  docsManifest,
  docsRead,
  docsResolve,
  docsSearch,
  docsWrite,
  docsSetDescription,
);

type McpFailureCode = Contracts.DocsMcpFailure["code"];

const failureCode = (code: Service.DocsServiceErrorCode): McpFailureCode => {
  switch (code) {
    case "capability_denied":
      return "capability_denied";
    case "document_protected":
      return "document_protected";
    case "document_changed":
      return "document_changed";
    case "document_not_found":
      return "document_not_found";
    case "document_outside_store":
    case "invalid_ref":
      return "document_outside_store";
    case "store_unavailable":
      return "store_unavailable";
    case "invalid_input":
      return "invalid_request";
    case "search_unavailable":
      return "orchestration_error";
  }
};

const toMcpFailure = (error: Service.DocsServiceError) =>
  new Contracts.DocsMcpFailure({ code: failureCode(error.code), message: error.message });

/** The calling thread's lineage; an MCP client without a thread has no parent either. */
const callerOf = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const threadId = scope.thread?.threadId;
  if (threadId === undefined) {
    return { threadId: null, parentThreadId: null } satisfies Service.DocsCaller;
  }
  const threads = yield* ThreadManagement.ThreadManagementService;
  const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
  return {
    threadId: String(threadId),
    parentThreadId:
      shell === null || shell.lineage.parentThreadId === null
        ? null
        : String(shell.lineage.parentThreadId),
  } satisfies Service.DocsCaller;
});

export interface DocsToolkitOptions {
  /** Store root, resolved once by the host composition. */
  readonly root: string;
  /** Opens every tool call: the `documents` feature gate. */
  readonly requireEnabled: Effect.Effect<void, Contracts.DocsMcpFailure>;
  /** Write rule override; the default is the lineage rule (design §3.5). */
  readonly writeAccess?: Layer.Layer<Service.DocumentsWriteAccess>;
  /** Role, plan identity and grant read by the lineage rule; the default is none of them. */
  readonly writeFacts?: Layer.Layer<WriteRule.DocumentsWriteFactsPort>;
  /** Protected-document rule override; nothing is protected by default. */
  readonly protection?: Layer.Layer<Service.DocsProtection>;
}

/** The toolkit and its service; the guard is the host's feature gate. */
export const mcpLayer = (options: DocsToolkitOptions) => {
  const guard = options.requireEnabled;
  const writeAccess =
    options.writeAccess ??
    (options.writeFacts === undefined
      ? WriteRule.lineageDocumentsWrite
      : WriteRule.documentsWriteAccessLayer.pipe(Layer.provide(options.writeFacts)));
  const handlers = McpToolAccess.toLayer(toolkit, {
    docs_list: McpToolAccess.readsAsCaller((input) =>
      Effect.gen(function* () {
        yield* guard;
        const service = yield* Service.DocsService;
        return yield* service.list(input).pipe(Effect.mapError(toMcpFailure));
      }),
    ),
    docs_manifest: McpToolAccess.readsAsCaller((input) =>
      Effect.gen(function* () {
        yield* guard;
        const service = yield* Service.DocsService;
        const documents = yield* service.manifest(input).pipe(Effect.mapError(toMcpFailure));
        return {
          folder: input.folder ?? "",
          documents: documents.map((entry) => ({
            relPath: entry.relPath,
            stableId: entry.stableId,
            name: entry.name,
            description: entry.description,
            updatedAt: entry.updatedAt,
          })),
        } satisfies Contracts.DocsManifestResult;
      }),
    ),
    docs_read: McpToolAccess.readsAsCaller((input) =>
      Effect.gen(function* () {
        yield* guard;
        const service = yield* Service.DocsService;
        const document = yield* service.read(input).pipe(Effect.mapError(toMcpFailure));
        return {
          stableId: document.stableId,
          relPath: document.relPath,
          name: document.name,
          description: document.description,
          sha256: document.sha256,
          ocLink: document.ocLink,
          content: document.content,
        } satisfies Contracts.DocsReadResult;
      }),
    ),
    docs_resolve: McpToolAccess.readsAsCaller((input) =>
      Effect.gen(function* () {
        yield* guard;
        const service = yield* Service.DocsService;
        const resolved = yield* service.resolve(input).pipe(Effect.mapError(toMcpFailure));
        return {
          stableId: resolved.document.stableId,
          relPath: resolved.document.relPath,
          name: resolved.document.name,
          description: resolved.document.description,
          sha256: resolved.document.sha256,
          ocLink: resolved.document.ocLink,
        } satisfies Contracts.DocsResolvedDocument;
      }),
    ),
    docs_search: McpToolAccess.readsAsCaller((input) =>
      Effect.gen(function* () {
        yield* guard;
        const service = yield* Service.DocsService;
        const results = yield* service.search(input).pipe(Effect.mapError(toMcpFailure));
        return {
          results: results.map((result) => ({
            relPath: result.relPath,
            stableId: result.stableId,
            title: result.title,
            snippet: result.snippet,
            score: result.score,
          })),
        } satisfies Contracts.DocsSearchResult;
      }),
    ),
    docs_write: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        yield* guard;
        const caller = yield* callerOf;
        const service = yield* Service.DocsService;
        return yield* service
          .write({
            caller,
            ...(input.ref === undefined ? {} : { ref: input.ref }),
            ...(input.relPath === undefined ? {} : { relPath: input.relPath }),
            content: input.content,
            ...(input.baseSha256 === undefined ? {} : { baseSha256: input.baseSha256 }),
            ...(input.description === undefined ? {} : { description: input.description }),
            clientRequestId: input.clientRequestId,
          })
          .pipe(Effect.mapError(toMcpFailure));
      }),
    ),
    docs_set_description: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        yield* guard;
        const caller = yield* callerOf;
        const service = yield* Service.DocsService;
        return yield* service
          .setDescription({ caller, ref: input.ref, description: input.description })
          .pipe(Effect.mapError(toMcpFailure));
      }),
    ),
  });

  return toolkitRegistration(toolkit, handlers).pipe(
    Layer.provide(
      Service.layer({ root: options.root }).pipe(
        Layer.provide(writeAccess),
        Layer.provide(options.protection ?? Service.noProtectedDocuments),
      ),
    ),
  );
};

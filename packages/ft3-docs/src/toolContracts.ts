/**
 * MCP schemas of the docs tools (design §3.5). Inputs and results are plain
 * schemas; no tool ever returns an absolute store path.
 */
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** A store-relative document path or an `oc://doc/<id>` link. */
export const DocsRefInput = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048));

export const DocsListInput = Schema.Struct({
  folder: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
});
export type DocsListInput = typeof DocsListInput.Type;

export const DocsManifestInput = Schema.Struct({
  folder: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2000 }))),
});
export type DocsManifestInput = typeof DocsManifestInput.Type;

export const DocsReadInput = Schema.Struct({ ref: DocsRefInput });
export type DocsReadInput = typeof DocsReadInput.Type;

export const DocsResolveInput = Schema.Struct({ ref: DocsRefInput });
export type DocsResolveInput = typeof DocsResolveInput.Type;

export const DocsSearchInput = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  folder: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type DocsSearchInput = typeof DocsSearchInput.Type;

export const DocsWriteInput = Schema.Struct({
  ref: Schema.optionalKey(DocsRefInput),
  relPath: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
  content: Schema.String.check(Schema.isMaxLength(4 * 1024 * 1024)),
  baseSha256: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
  clientRequestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});
export type DocsWriteInput = typeof DocsWriteInput.Type;

export const DocsSetDescriptionInput = Schema.Struct({
  ref: DocsRefInput,
  description: Schema.String.check(Schema.isMaxLength(2000)),
});
export type DocsSetDescriptionInput = typeof DocsSetDescriptionInput.Type;

export const DocsFolderEntry = Schema.Struct({
  relPath: Schema.String,
  name: Schema.String,
  description: Schema.String,
});

export const DocsListEntry = Schema.Struct({
  relPath: Schema.String,
  stableId: Schema.String,
  name: Schema.String,
  description: Schema.String,
  updatedAt: Schema.String,
});

export const DocsListResult = Schema.Struct({
  folder: Schema.String,
  folders: Schema.Array(DocsFolderEntry),
  documents: Schema.Array(DocsListEntry),
});
export type DocsListResult = typeof DocsListResult.Type;

export const DocsManifestResult = Schema.Struct({
  folder: Schema.String,
  documents: Schema.Array(DocsListEntry),
});
export type DocsManifestResult = typeof DocsManifestResult.Type;

export const DocsReadResult = Schema.Struct({
  stableId: Schema.String,
  relPath: Schema.String,
  name: Schema.String,
  description: Schema.String,
  sha256: Schema.String,
  ocLink: Schema.String,
  content: Schema.String,
});
export type DocsReadResult = typeof DocsReadResult.Type;

export const DocsResolvedDocument = Schema.Struct({
  stableId: Schema.String,
  relPath: Schema.String,
  name: Schema.String,
  description: Schema.String,
  sha256: Schema.String,
  ocLink: Schema.String,
});
export type DocsResolvedDocument = typeof DocsResolvedDocument.Type;

export const DocsSearchResult = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      relPath: Schema.String,
      stableId: Schema.String,
      title: Schema.String,
      snippet: Schema.String,
      score: Schema.Number,
    }),
  ),
});
export type DocsSearchResult = typeof DocsSearchResult.Type;

export const DocsWriteResult = Schema.Struct({
  stableId: Schema.String,
  relPath: Schema.String,
  name: Schema.String,
  sha256: Schema.String,
  ocLink: Schema.String,
});
export type DocsWriteResult = typeof DocsWriteResult.Type;

export const DocsSetDescriptionResult = Schema.Struct({
  stableId: Schema.String,
  relPath: Schema.String,
  name: Schema.String,
  description: Schema.String,
});
export type DocsSetDescriptionResult = typeof DocsSetDescriptionResult.Type;

/** A docs tool failure: the shared MCP codes plus the document-specific ones. */
export class DocsMcpFailure extends Schema.TaggedError<DocsMcpFailure>()("OrchestratorMcpFailure", {
  code: Schema.Union([
    OrchestratorMcpFailure.fields.code,
    Schema.Literals([
      "document_not_found",
      "document_outside_store",
      "document_changed",
      "document_protected",
      "store_unavailable",
      "feature_disabled",
    ]),
  ]),
  message: Schema.String,
}) {}

/** Server entry of `ft3-docs`: the store, reconciliation, watch, index and `DocsService`. */
export {
  DEFAULT_DOCS_SETTINGS,
  DOCS_ROOT_ENV,
  DOCS_ROOT_MAX_LENGTH,
  DOCS_SETTINGS_NAMESPACE,
  DocsRootSetting,
  DocsSettings,
  decodeDocsSettingsValue,
  readDocsSettings,
  resolveDocsRoot,
} from "./root.ts";
export {
  DOCS_BRIEF_BLOCK,
  docsBriefBlock,
  documentsBriefLine,
  setDocumentsBriefEnabled,
} from "./brief.ts";
export {
  denyAllDocumentsWrite,
  DocsProtection,
  DocsServiceError,
  DocsWriteDenialReason,
  DocumentsWriteAccess,
  layer as docsServiceLayer,
  layerWithDefaultPorts as docsServiceLayerWithDefaultPorts,
  noProtectedDocuments,
  type DocsCaller,
  type DocsDocumentMeta,
  type DocsListEntry,
  type DocsListResult,
  type DocsReadResult,
  type DocsResolution,
  type DocsServiceErrorCode,
  type DocsServiceOptions,
  type DocsSetDescriptionInput,
  type DocsHumanWriteInput,
  type DocsPathLocation,
  type DocsWriteInput,
  type DocsWriteResult,
  type DocumentsWriteAllowReason,
  type DocumentsWriteDecision,
} from "./service.ts";
export {
  documentsWriteAccessLayer,
  DocumentsWriteFactsPort,
  lineageDocumentsWrite,
  noDocumentsWriteFacts,
  resolveDocumentsWrite,
  type DocumentsWriteFacts,
} from "./writeRule.ts";
export {
  DocsFolderEntry,
  DocsListEntry as DocsListEntrySchema,
  DocsListInput,
  DocsListResult as DocsListResultSchema,
  DocsManifestInput,
  DocsManifestResult,
  DocsMcpFailure,
  DocsReadInput,
  DocsReadResult as DocsReadResultSchema,
  DocsResolvedDocument,
  DocsResolveInput,
  DocsSearchInput,
  DocsSearchResult,
  DocsSetDescriptionInput as DocsSetDescriptionInputSchema,
  DocsSetDescriptionResult,
  DocsWriteInput as DocsWriteInputSchema,
  DocsWriteResult as DocsWriteResultSchema,
} from "./toolContracts.ts";
export { docsBriefBlock as docsBriefBlockText } from "./brief.ts";
export {
  DOCS_STORE_CONTEXTS_DIRECTORY,
  DOCS_STORE_DATABASE_FILENAME,
  DocsStore,
  DocsStoreError,
  type DocFolderRecord,
  type DocManifestEntry,
  type DocRecord,
  type DocsStoreErrorCode,
  type DocsStoreOptions,
} from "./store.ts";
export {
  DocsReconciler,
  type DocsChanged,
  type DocsIndexable,
  type DocsReconcilerOptions,
  layer as reconcilerLayer,
  type ReconcileReport,
} from "./reconciler.ts";
export { DocsWatchService, layer as watchLayer, type DocsWatchOptions } from "./watch.ts";
export {
  applyReport,
  DocsIndex,
  DocsIndexError,
  layer as indexLayer,
  unavailableLayer as unavailableIndexLayer,
  type DocsSearchInput as DocsIndexSearchInput,
  type DocsSearchResult as DocsIndexSearchResult,
} from "./index.ts";
export { DocsService } from "./service.ts";
export {
  mcpLayer as docsMcpLayer,
  toolkit as docsToolkit,
  type DocsToolkitOptions,
} from "./mcp.ts";
export { runtimeLayer as docsRuntimeLayer, type DocsRuntimeOptions } from "./runtime.ts";
export { docsRpcHandlers, docsRpcServiceLayer } from "./rpc.ts";
export { FT3_DOCS_WS_METHODS, docsRpcs, docsRpcScopes } from "./rpc-contracts.ts";

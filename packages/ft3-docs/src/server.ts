/** Server entry of `ft3-docs`: the document store, reconciliation, watch and index. */
export {
  DOCS_STORE_CONTEXTS_DIRECTORY,
  DOCS_STORE_DATABASE_FILENAME,
  DocsStore,
  DocsStoreError,
  layer,
  type DocFolderRecord,
  type DocManifestEntry,
  type DocRecord,
  type DocsStoreErrorCode,
  type DocsStoreOptions,
} from "./store.ts";
export {
  DocsReconciler,
  layer as reconcilerLayer,
  type DocsChanged,
  type DocsDuplicate,
  type DocsIndexable,
  type DocsMissing,
  type DocsMove,
  type DocsReconcilerOptions,
  type ReconcileError,
  type ReconcileReport,
} from "./reconciler.ts";
export { DocsWatchService, layer as watchLayer, type DocsWatchOptions } from "./watch.ts";
export {
  applyReport,
  DocsIndex,
  DocsIndexError,
  layer as indexLayer,
  type DocsSearchInput,
  type DocsSearchResult,
} from "./index.ts";

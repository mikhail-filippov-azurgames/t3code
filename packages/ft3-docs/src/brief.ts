/**
 * The short "how to work with documents" block an agent brief carries while the
 * `documents` feature is effective (design §3.6). The text lives here, in
 * `ft3-docs`, and carries no paths and no ids.
 */
export const DOCS_BRIEF_BLOCK =
  "Documents: links like oc://doc/<id> point to Corvis documents. Read them with docs_read, list a folder with docs_manifest, find text with docs_search, and resolve a link with docs_resolve. Do not edit document files directly; change a document only with docs_write, and only if you were granted that.";

/**
 * Startup switch for the brief block, set once by the host composition from the
 * `documents` feature gate. Briefs are built per delegation, so a toggle change
 * applies on the next server start.
 */
let briefEnabled = false;

export function setDocumentsBriefEnabled(enabled: boolean): void {
  briefEnabled = enabled;
}

/** The brief block while documents are effective; an empty line otherwise. */
export function documentsBriefLine(): string {
  return briefEnabled ? DOCS_BRIEF_BLOCK : "";
}

/** The block itself, for a caller that resolved the feature on its own. */
export function docsBriefBlock(): string {
  return DOCS_BRIEF_BLOCK;
}

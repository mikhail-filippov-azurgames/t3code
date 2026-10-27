import type { ContextMenuItem } from "@t3tools/contracts";

/**
 * The OpenContext document convention: `oc://doc/<stable_id>` for a local store
 * document and `ocl://doc/<stable_id>` for its cloud counterpart, written by
 * agents and the store's own tooling. The parser is explicit rather than a
 * loosened file-path rule — an `oc:`/`ocl:` href is a document reference, never
 * a workspace path or an external web link.
 */
const OPEN_CONTEXT_DOC_HREF_PATTERN = /^(oc|ocl):\/\/doc\/([^/@?#\s]+)(@[1-9]\d*)?\/?$/i;

export type OpenContextDocScheme = "oc" | "ocl";

export interface OpenContextDocHref {
  /** Canonical form, so copying and comparisons do not depend on a trailing slash. */
  readonly href: string;
  readonly scheme: OpenContextDocScheme;
  readonly stableId: string;
}

export function parseOpenContextDocHref(href: string | undefined): OpenContextDocHref | null {
  if (!href) return null;
  const match = OPEN_CONTEXT_DOC_HREF_PATTERN.exec(href.trim());
  const scheme = match?.[1]?.toLowerCase();
  const stableId = match?.[2]?.trim();
  if (!stableId || (scheme !== "oc" && scheme !== "ocl")) return null;
  return { href: `${scheme}://doc/${stableId}${match?.[3] ?? ""}`, scheme, stableId };
}

export type OpenContextDocLinkStatus = "idle" | "found" | "not_found" | "unavailable";

export type OpenContextDocMenuAction =
  | "open-document"
  | "copy-link"
  | "copy-document-path"
  | "status";

export interface OpenContextDocMenuInput {
  readonly status: OpenContextDocLinkStatus;
  /** False when there is no thread to open a files panel in. */
  readonly canOpenDocument: boolean;
  /** Store-relative path, shown so the desktop native menu can surface it. */
  readonly displayPath?: string | undefined;
}

/**
 * Menu items are shared by the desktop native menu and the DOM fallback. A
 * "not found" state is a disabled row rather than a missing menu, because the
 * store the link points at is a fact the user can act on.
 */
export function openContextDocMenuItems(
  input: OpenContextDocMenuInput,
): readonly ContextMenuItem<OpenContextDocMenuAction>[] {
  const items: ContextMenuItem<OpenContextDocMenuAction>[] = [];

  if (input.status === "found") {
    items.push({
      id: "open-document",
      label: "Open document",
      ...(input.canOpenDocument ? {} : { disabled: true }),
    });
  } else if (input.status === "not_found") {
    items.push({ id: "status", label: "Document not found", disabled: true });
  } else if (input.status === "unavailable") {
    items.push({ id: "status", label: "OpenContext store unavailable", disabled: true });
  } else if (input.canOpenDocument) {
    items.push({ id: "open-document", label: "Open document" });
  }

  items.push({ id: "copy-link", label: "Copy link", icon: "copy" });

  if (input.status === "found" && input.displayPath) {
    items.push({
      id: "status",
      label: input.displayPath,
      disabled: true,
      separatorBefore: true,
    });
    items.push({ id: "copy-document-path", label: "Copy document path", icon: "copy" });
  }

  return items;
}

export interface OpenContextDocResolutionFound {
  readonly status: "found";
  readonly stableId: string;
  readonly name: string;
  readonly relativePath: string;
  readonly absolutePath: string;
}

export type OpenContextDocResolveResult =
  | OpenContextDocResolutionFound
  | { readonly status: "not_found" }
  | { readonly status: "store_unavailable" };

// @effect-diagnostics nodeBuiltinImport:off - protection compares configured server paths.
/** Store documents agents may never change through MCP (design §3.5). */
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import type { PolicyDocumentKey, PolicyDocumentSource } from "./contracts.ts";

/** Store identities no agent write may touch, however broad its right. */
export interface ProtectedDocumentIdentities {
  /** Exact stable ids, from `{kind:"doc"}` id addresses. */
  readonly stableIds: ReadonlySet<string>;
  /** Exact store paths, from `{kind:"doc"}` path addresses and in-store `{kind:"path"}` files. */
  readonly relPaths: ReadonlySet<string>;
  /**
   * Folder prefixes with a trailing `/`, from tree manifests; a document
   * below any of them is protected. The empty prefix protects the whole
   * store (a tree manifest addressed at the store root).
   */
  readonly prefixes: ReadonlySet<string>;
}

/** Folder prefix of a manifest path: `policies/roles/` for `policies/roles/roles.json`. */
const folderPrefixOf = (relPath: string): string => {
  const slash = relPath.lastIndexOf("/");
  return slash === -1 ? "" : relPath.slice(0, slash + 1);
};

const isTreeKey = (key: PolicyDocumentKey): boolean => key !== "routingPolicy";

/**
 * The protected identities of one policy document source. `root` is the
 * store root (`contexts/` and `opencontext.db` live directly under it);
 * `{kind:"path"}` sources outside it are unmanaged files docs MCP cannot
 * address, so they contribute nothing.
 */
export function protectedDocumentIdentities(
  sources: Readonly<Record<PolicyDocumentKey, PolicyDocumentSource>>,
  root: string,
): ProtectedDocumentIdentities {
  const stableIds = new Set<string>();
  const relPaths = new Set<string>();
  const prefixes = new Set<string>();
  const contextsRoot = NodePath.resolve(root, "contexts");
  for (const [key, source] of Object.entries(sources) as ReadonlyArray<
    [PolicyDocumentKey, PolicyDocumentSource]
  >) {
    if (source.kind === "builtin") continue;
    if (source.kind === "doc") {
      if (source.address.kind === "id") {
        stableIds.add(source.address.stableId);
        continue;
      }
      relPaths.add(source.address.relPath);
      if (isTreeKey(key)) prefixes.add(folderPrefixOf(source.address.relPath));
      continue;
    }
    const relative = NodePath.relative(contextsRoot, NodePath.resolve(source.path));
    if (relative === "" || relative.startsWith("..") || NodePath.isAbsolute(relative)) continue;
    const relPath = relative.split(NodePath.sep).join("/");
    relPaths.add(relPath);
    if (isTreeKey(key)) prefixes.add(folderPrefixOf(relPath));
  }
  return { stableIds, relPaths, prefixes };
}

/** True when the document is one of the protected identities. */
export function isProtectedDocument(
  identities: ProtectedDocumentIdentities,
  document: { readonly stableId: string; readonly relPath: string },
): boolean {
  if (identities.stableIds.has(document.stableId)) return true;
  if (identities.relPaths.has(document.relPath)) return true;
  for (const prefix of identities.prefixes) {
    if (prefix === "" || document.relPath.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Store reads the static identities cannot do: an id-addressed tree
 * manifest resolves to its folder, and the board table names every plan
 * document. Both callbacks are total; a miss reads as no identity.
 */
export interface ProtectionLookups {
  readonly manifestRelPathOf: (stableId: string) => Effect.Effect<string | null, never, never>;
  readonly planStableIds: Effect.Effect<ReadonlyArray<string>, never, never>;
}

/**
 * The live protected set: the static source identities, the folders of
 * id-addressed tree manifests, and every plan document. Computed per call
 * so a changed source or a new card needs no restart.
 */
export const resolveProtectedIdentities = Effect.fn("protectedDocumentIdentities.resolve")(
  function* (
    sources: Readonly<Record<PolicyDocumentKey, PolicyDocumentSource>>,
    root: string,
    lookups: ProtectionLookups,
  ) {
    const base = protectedDocumentIdentities(sources, root);
    const prefixes = new Set(base.prefixes);
    for (const [key, source] of Object.entries(sources) as ReadonlyArray<
      [PolicyDocumentKey, PolicyDocumentSource]
    >) {
      if (!isTreeKey(key) || source.kind !== "doc" || source.address.kind !== "id") continue;
      const relPath = yield* lookups.manifestRelPathOf(source.address.stableId);
      if (relPath !== null) prefixes.add(folderPrefixOf(relPath));
    }
    const stableIds = new Set(base.stableIds);
    for (const stableId of yield* lookups.planStableIds) stableIds.add(stableId);
    return { stableIds, relPaths: base.relPaths, prefixes };
  },
);

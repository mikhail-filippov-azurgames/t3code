/** Browser-safe store contracts; `ft3-docs` is the only package that knows the format. */
import * as Schema from "effect/Schema";

/** The `@N` label of a document link. The store keeps revisions in frontmatter, never in its schema. */
export const DocRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export type DocRevision = typeof DocRevision.Type;

/** A `stable_id` value. The store generates UUIDv4 strings; existing links may carry older ids. */
export const DocStableId = Schema.String.check(Schema.isPattern(/^[^/@?#\s]+$/));
export type DocStableId = typeof DocStableId.Type;

const DOC_HREF_PATTERN = /^(oc|ocl):\/\/doc\/([^/@?#\s]+)(?:@([1-9]\d*))?\/?$/i;
const DOC_HREF_PREFIX_PATTERN = /^(?:oc|ocl):/i;

/**
 * Canonicalizes a store-relative path: `/` separators, no absolute roots, no
 * `.` or `..` segments, no empty segments. Returns null for anything else.
 */
function normalizeStorePath(input: string): string | null {
  let candidate = input.trim().replace(/\\/g, "/");
  while (candidate.startsWith("./")) candidate = candidate.slice(2);
  if (candidate.length === 0) return null;
  if (candidate.startsWith("/") || candidate.startsWith("~")) return null;
  if (/^[A-Za-z]:/.test(candidate)) return null;
  if (candidate.includes("://")) return null;
  const segments = candidate.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return segments.join("/");
}

const isCanonicalStorePath = Schema.makeFilter(
  (value: string) => normalizeStorePath(value) === value,
  { expected: "a canonical store-relative document path" },
);

/** A document path relative to `contexts/`, always with `/` separators. */
export const DocRelPath = Schema.String.check(isCanonicalStorePath);
export type DocRelPath = typeof DocRelPath.Type;

/** A store-relative path or a `stable_id`; `revision` is a display label, not part of resolution. */
export const DocAddress = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("path"),
    relPath: DocRelPath,
    revision: Schema.optionalKey(DocRevision),
  }),
  Schema.Struct({
    kind: Schema.Literal("id"),
    stableId: DocStableId,
    revision: Schema.optionalKey(DocRevision),
  }),
]);
export type DocAddress = typeof DocAddress.Type;

/** SHA-256 of a document's raw bytes, lowercase hex. */
export const DocSha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
export type DocSha256 = typeof DocSha256.Type;

/** Metadata of a resolved document. `sha256` is absent when only the address is known. */
export const DocRef = Schema.Struct({
  stableId: DocStableId,
  relPath: DocRelPath,
  name: Schema.String,
  sha256: Schema.optionalKey(DocSha256),
});
export type DocRef = typeof DocRef.Type;

/**
 * Parses `oc://doc/<id>[@N]`, `ocl://doc/<id>`, or a store-relative path;
 * returns null when the reference is not a document address.
 */
export function parseDocRef(ref: string): DocAddress | null {
  const trimmed = ref.trim();
  if (trimmed.length === 0) return null;

  if (DOC_HREF_PREFIX_PATTERN.test(trimmed)) {
    const match = DOC_HREF_PATTERN.exec(trimmed);
    const stableId = match?.[2];
    if (!match || !stableId) return null;
    const label = match[3];
    if (label === undefined) return { kind: "id", stableId };
    const revision = Number(label);
    if (!Number.isSafeInteger(revision) || revision < 1) return null;
    return { kind: "id", stableId, revision };
  }

  const relPath = normalizeStorePath(trimmed);
  return relPath === null ? null : { kind: "path", relPath };
}

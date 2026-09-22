import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A stable OpenContext document identifier as it appears in an
 * `oc://doc/<stable_id>` link. The local store mints UUIDs, but the client
 * accepts the token verbatim and lets the server decide whether it resolves.
 */
export const OPEN_CONTEXT_DOC_STABLE_ID_MAX_LENGTH = 128;

export const OpenContextResolveDocInput = Schema.Struct({
  stableId: TrimmedNonEmptyString.check(Schema.isMaxLength(OPEN_CONTEXT_DOC_STABLE_ID_MAX_LENGTH)),
});
export type OpenContextResolveDocInput = typeof OpenContextResolveDocInput.Type;

export const OpenContextResolveDocFound = Schema.Struct({
  status: Schema.Literal("found"),
  stableId: TrimmedNonEmptyString,
  /** The document's file name as the store records it. */
  name: TrimmedNonEmptyString,
  /** Path relative to the OpenContext store root, for display. */
  relativePath: TrimmedNonEmptyString,
  /** Host path the files panel can open read-only. */
  absolutePath: TrimmedNonEmptyString,
});
export type OpenContextResolveDocFound = typeof OpenContextResolveDocFound.Type;

/**
 * Resolving is best-effort: a missing store or an unknown id is an expected
 * outcome the client renders as state, not an error it retries on.
 */
export const OpenContextResolveDocResult = Schema.Union([
  OpenContextResolveDocFound,
  Schema.Struct({ status: Schema.Literal("not_found") }),
  Schema.Struct({ status: Schema.Literal("store_unavailable") }),
]);
export type OpenContextResolveDocResult = typeof OpenContextResolveDocResult.Type;

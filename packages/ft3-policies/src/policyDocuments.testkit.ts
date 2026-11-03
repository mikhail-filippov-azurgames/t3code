// @effect-diagnostics nodeBuiltinImport:off - the fake store hashes document content.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";

import type { PolicyDocumentReadPort } from "./policyDocumentLoader.ts";

const sha256 = (content: string): string =>
  NodeCrypto.createHash("sha256").update(content, "utf8").digest("hex");

/**
 * The policy loader port over an in-memory file map keyed by store-relPath, for
 * tests that need an applied policy version without a document store.
 */
export const memoryPolicyDocumentPort = (
  files: ReadonlyMap<string, string>,
): PolicyDocumentReadPort => ({
  read: ({ ref }) => {
    const content = files.get(ref);
    if (content === undefined) {
      return Effect.fail({ code: "document_not_found", message: `no document ${ref}` });
    }
    return Effect.succeed({ content, sha256: sha256(content), relPath: ref });
  },
  manifest: ({ folder }) =>
    Effect.succeed(
      [...files.keys()]
        .filter((relPath) => folder === "" || relPath.startsWith(`${folder}/`))
        .map((relPath) => ({ relPath })),
    ),
});

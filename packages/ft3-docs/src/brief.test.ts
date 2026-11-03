import { assert, describe, it } from "@effect/vitest";

import {
  DOCS_BRIEF_BLOCK,
  docsBriefBlock,
  documentsBriefLine,
  setDocumentsBriefEnabled,
} from "./brief.ts";

describe("documents brief block", () => {
  it("carries the design text without paths or ids", () => {
    assert.include(DOCS_BRIEF_BLOCK, "docs_read");
    assert.include(DOCS_BRIEF_BLOCK, "docs_manifest");
    assert.include(DOCS_BRIEF_BLOCK, "docs_search");
    assert.include(DOCS_BRIEF_BLOCK, "docs_resolve");
    assert.include(DOCS_BRIEF_BLOCK, "docs_write");
    assert.include(DOCS_BRIEF_BLOCK, "oc://doc/<id>");
    assert.notInclude(DOCS_BRIEF_BLOCK, "contexts");
    assert.notInclude(DOCS_BRIEF_BLOCK, ".opencontext");
    assert.equal(docsBriefBlock(), DOCS_BRIEF_BLOCK);
  });

  it("is empty until the host turns documents on", () => {
    try {
      setDocumentsBriefEnabled(false);
      assert.equal(documentsBriefLine(), "");
      setDocumentsBriefEnabled(true);
      assert.equal(documentsBriefLine(), DOCS_BRIEF_BLOCK);
    } finally {
      setDocumentsBriefEnabled(false);
    }
  });
});

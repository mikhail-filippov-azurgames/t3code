import { describe, expect, it } from "@effect/vitest";

import { readStableId, scanFrontmatter, writeStableId } from "./frontmatter.ts";

const ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";

describe("document frontmatter stable_id", () => {
  it("prepends a block to a document without frontmatter", () => {
    expect(writeStableId("# Plan\n\nBody\n", ID)).toBe(
      `---\nstable_id: ${ID}\n---\n# Plan\n\nBody\n`,
    );
  });

  it("keeps a byte order mark before the new block", () => {
    expect(writeStableId("\uFEFF# Plan\n", ID)).toBe(`\uFEFF---\nstable_id: ${ID}\n---\n# Plan\n`);
  });

  it("inserts the field with the document's CRLF line endings", () => {
    expect(writeStableId("---\r\nkind: note\r\n---\r\n\r\nBody\r\n", ID)).toBe(
      `---\r\nstable_id: ${ID}\r\nkind: note\r\n---\r\n\r\nBody\r\n`,
    );
  });

  it("replaces only the stable_id line and keeps field order", () => {
    const original = `---\nkind: note\nstable_id: ${OTHER_ID}\nrevision: 2\n---\n\nBody\n`;
    expect(writeStableId(original, ID)).toBe(
      `---\nkind: note\nstable_id: ${ID}\nrevision: 2\n---\n\nBody\n`,
    );
  });

  it("keeps quoted values and CRLF intact while replacing the field", () => {
    const original = `---\r\nstatus: draft\r\nstable_id: "${OTHER_ID}"\r\n---\r\nBody\r\n`;
    expect(writeStableId(original, ID)).toBe(
      `---\r\nstatus: draft\r\nstable_id: ${ID}\r\n---\r\nBody\r\n`,
    );
  });

  it("is idempotent for an already written id", () => {
    const written = writeStableId("---\nkind: note\n---\n", ID);
    expect(writeStableId(written, ID)).toBe(written);
  });

  it("reads a plain, quoted, or single-quoted id", () => {
    expect(readStableId(`---\nstable_id: ${ID}\n---\n`)).toBe(ID);
    expect(readStableId(`---\nstable_id: "${ID}"\n---\n`)).toBe(ID);
    expect(readStableId(`---\nstable_id: '${ID}'\n---\n`)).toBe(ID);
  });

  it("does not read an id from the document body", () => {
    expect(readStableId(`---\nkind: note\n---\n\nstable_id: ${ID}\n`)).toBeNull();
    expect(readStableId(`# Note\n\nstable_id: ${ID}\n`)).toBeNull();
  });

  it("treats an unterminated block as the document body", () => {
    expect(scanFrontmatter(`---\nkind: note\n`)).toBeNull();
    expect(readStableId(`---\nstable_id: ${ID}\n`)).toBeNull();
  });
});

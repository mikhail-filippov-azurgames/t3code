/**
 * The `stable_id` field of a document's YAML frontmatter.
 *
 * Writes are byte-local: a document that already has the field keeps its BOM,
 * line endings, field order and every other byte; a document without
 * frontmatter gets exactly the three lines `---`, `stable_id: <id>`, `---`.
 */

const BOM = "\uFEFF";
const DELIMITER_LINE = /^---[ \t]*$/;
const STABLE_ID_PATTERN = /^stable_id:[ \t]*(.*?)[ \t]*$/;
const FRONTMATTER_BLOCK_START = "---";

export interface FrontmatterRange {
  /** Offset of the opening `---` line. */
  readonly start: number;
  /** Offset just after the opening line's line break. */
  readonly bodyStart: number;
  /** Offset of the closing `---` line. */
  readonly end: number;
  /** The line break used by the opening delimiter. */
  readonly eol: string;
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function lineAt(content: string, start: number, end: number): string {
  return stripCarriageReturn(content.slice(start, end));
}

/** Finds a frontmatter block that starts at the document's first byte after a BOM. */
export function scanFrontmatter(content: string): FrontmatterRange | null {
  const start = content.startsWith(BOM) ? BOM.length : 0;
  const firstBreak = content.indexOf("\n", start);
  if (firstBreak === -1) return null;
  if (!DELIMITER_LINE.test(lineAt(content, start, firstBreak))) return null;
  const eol = content[firstBreak - 1] === "\r" ? "\r\n" : "\n";

  let cursor = firstBreak + 1;
  while (cursor <= content.length) {
    const nextBreak = content.indexOf("\n", cursor);
    const lineEnd = nextBreak === -1 ? content.length : nextBreak;
    if (DELIMITER_LINE.test(lineAt(content, cursor, lineEnd))) {
      return { start, bodyStart: firstBreak + 1, end: cursor, eol };
    }
    if (nextBreak === -1) return null;
    cursor = nextBreak + 1;
  }
  return null;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const unquoted =
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
      ? trimmed.slice(1, -1)
      : trimmed;
  return unquoted.trim();
}

/** Reads `stable_id` from frontmatter; the document body is never scanned. */
export function readStableId(content: string): string | null {
  const range = scanFrontmatter(content);
  if (range === null) return null;
  for (const line of content.slice(range.bodyStart, range.end).split("\n")) {
    const match = STABLE_ID_PATTERN.exec(stripCarriageReturn(line));
    if (match === null) continue;
    const stableId = unquote(match[1] ?? "");
    return stableId.length > 0 ? stableId : null;
  }
  return null;
}

/**
 * Sets `stable_id` in place when the field exists, inserts one line when the
 * frontmatter lacks it, and prepends a new block when the file has none.
 */
export function writeStableId(content: string, stableId: string): string {
  const line = `stable_id: ${stableId}`;
  const range = scanFrontmatter(content);
  if (range === null) {
    const bom = content.startsWith(BOM) ? BOM : "";
    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    return `${bom}${FRONTMATTER_BLOCK_START}${eol}${line}${eol}${FRONTMATTER_BLOCK_START}${eol}${content.slice(bom.length)}`;
  }

  const block = content.slice(range.bodyStart, range.end);
  let cursor = 0;
  while (cursor < block.length) {
    const nextBreak = block.indexOf("\n", cursor);
    const lineEnd = nextBreak === -1 ? block.length : nextBreak;
    const text = lineAt(block, cursor, lineEnd);
    if (STABLE_ID_PATTERN.test(text)) {
      const fieldStart = range.bodyStart + cursor;
      return `${content.slice(0, fieldStart)}${line}${content.slice(fieldStart + text.length)}`;
    }
    if (nextBreak === -1) break;
    cursor = nextBreak + 1;
  }

  return `${content.slice(0, range.bodyStart)}${line}${range.eol}${content.slice(range.bodyStart)}`;
}

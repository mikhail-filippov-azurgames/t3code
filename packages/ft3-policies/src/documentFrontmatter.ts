/**
 * Strict frontmatter reader for policy role files and lead skills.
 *
 * The store owns document frontmatter; these parsers only read the fields the
 * role and skill schemas define, keep their line numbers for diagnostics, and
 * never rewrite the file.
 */

export interface FrontmatterField {
  readonly key: string;
  readonly value: string;
  /** 1-based line of the field inside the file. */
  readonly line: number;
  readonly text: string;
}

export interface FrontmatterMalformedLine {
  readonly line: number;
  readonly text: string;
}

export interface DocumentFrontmatter {
  /** A block delimited by `---` starts on the first line after an optional BOM. */
  readonly present: boolean;
  /** The closing `---` was found; a missing one is a syntax error for the caller. */
  readonly closed: boolean;
  readonly fields: readonly FrontmatterField[];
  readonly malformed: readonly FrontmatterMalformedLine[];
  /** Body without the frontmatter block. */
  readonly body: string;
}

const DELIMITER_LINE = /^---[ \t]*$/;
const FIELD_LINE = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const quoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));
  return quoted ? trimmed.slice(1, -1) : trimmed;
}

/** Splits a file into CRLF-tolerant lines carrying their 1-based line numbers. */
export function documentLines(source: string): readonly string[] {
  const text = source.startsWith("\uFEFF") ? source.slice(1) : source;
  return text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

export function parseDocumentFrontmatter(source: string): DocumentFrontmatter {
  const lines = documentLines(source);
  const firstLine = lines[0];
  if (firstLine === undefined || !DELIMITER_LINE.test(firstLine)) {
    return { present: false, closed: false, fields: [], malformed: [], body: source };
  }

  let closingIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (DELIMITER_LINE.test(lines[index] ?? "")) {
      closingIndex = index;
      break;
    }
  }
  if (closingIndex === -1) {
    return { present: true, closed: false, fields: [], malformed: [], body: "" };
  }

  const fields: FrontmatterField[] = [];
  const malformed: FrontmatterMalformedLine[] = [];
  for (let index = 1; index < closingIndex; index += 1) {
    const text = lines[index] ?? "";
    if (text.trim().length === 0) continue;
    const match = FIELD_LINE.exec(text);
    if (match === null) {
      malformed.push({ line: index + 1, text: text.trim() });
      continue;
    }
    fields.push({
      key: match[1] ?? "",
      value: unquote(match[2] ?? ""),
      line: index + 1,
      text: text.trim(),
    });
  }

  return {
    present: true,
    closed: true,
    fields,
    malformed,
    body: lines.slice(closingIndex + 1).join("\n"),
  };
}

/** The first field with this key; a repeated key resolves to the later line. */
export function frontmatterField(
  frontmatter: DocumentFrontmatter,
  key: string,
): FrontmatterField | undefined {
  let found: FrontmatterField | undefined;
  for (const field of frontmatter.fields) {
    if (field.key === key) found = field;
  }
  return found;
}

/** Every field with this key, so a caller can reject a repeated one. */
export function frontmatterFields(
  frontmatter: DocumentFrontmatter,
  key: string,
): readonly FrontmatterField[] {
  return frontmatter.fields.filter((field) => field.key === key);
}

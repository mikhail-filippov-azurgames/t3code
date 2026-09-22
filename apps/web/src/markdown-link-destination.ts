interface MarkdownLinkPosition {
  readonly start?: {
    readonly offset?: number;
  };
  readonly end?: {
    readonly offset?: number;
  };
}

export interface MarkdownLinkDestinationNode {
  readonly type?: string;
  readonly position?: MarkdownLinkPosition;
  readonly children?: ReadonlyArray<{
    readonly position?: MarkdownLinkPosition;
  }>;
}

const LEADING_DESTINATION_WHITESPACE = /^[ \t\r\n]*/;
const DESTINATION_WHITESPACE = /[ \t\r\n]/;

function findDefinitionDestinationStart(rawDefinition: string): number | null {
  for (let index = 1; index < rawDefinition.length; index += 1) {
    const character = rawDefinition[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "]") {
      return rawDefinition[index + 1] === ":" ? index + 2 : null;
    }
  }
  return null;
}

function linkLabelEndOffset(node: MarkdownLinkDestinationNode): number | null {
  let end: number | null = null;
  for (const child of node.children ?? []) {
    const childEnd = child.position?.end?.offset;
    if (typeof childEnd === "number" && (end === null || childEnd > end)) {
      end = childEnd;
    }
  }
  if (end !== null) return end;
  const start = node.position?.start?.offset;
  return typeof start === "number" ? start + 1 : null;
}

/**
 * Reads a link destination from source text after its `](`/`]:` opener without
 * CommonMark unescaping. `\` before `.`, `-`, or `_` is a Windows separator,
 * but CommonMark treats those as escapable punctuation and eats the backslash,
 * so `C:\a\.b` decodes to `C:\a.b` before the resolver ever sees it.
 */
export function readMarkdownLinkDestination(afterOpener: string): string | null {
  const rest = afterOpener.replace(LEADING_DESTINATION_WHITESPACE, "");
  if (rest.startsWith("<")) {
    const end = rest.indexOf(">", 1);
    return end < 0 ? null : rest.slice(1, end);
  }

  let depth = 0;
  let index = 0;
  for (; index < rest.length; index += 1) {
    const character = rest[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      if (depth === 0) break;
      depth -= 1;
      continue;
    }
    if (depth === 0 && character !== undefined && DESTINATION_WHITESPACE.test(character)) {
      break;
    }
  }
  return index === 0 ? null : rest.slice(0, index);
}

/**
 * Returns the destination of an inline `link` or `definition` exactly as
 * written in `markdown`, so Windows separators survive. Null when the node is
 * not one of those or its source range is unavailable.
 */
export function literalMarkdownLinkDestination(
  markdown: string,
  node: MarkdownLinkDestinationNode,
): string | null {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (typeof start !== "number" || typeof end !== "number" || end <= start) return null;
  const raw = markdown.slice(start, end);

  if (node.type === "link") {
    const labelEnd = linkLabelEndOffset(node);
    if (labelEnd === null) return null;
    const labelIndex = labelEnd - start;
    if (raw[labelIndex] !== "]" || raw[labelIndex + 1] !== "(") return null;
    return readMarkdownLinkDestination(raw.slice(labelIndex + 2));
  }

  if (node.type === "definition") {
    const destinationStart = findDefinitionDestinationStart(raw);
    return destinationStart === null
      ? null
      : readMarkdownLinkDestination(raw.slice(destinationStart));
  }

  return null;
}

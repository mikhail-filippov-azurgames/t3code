const OPENING_FRONTMATTER_FENCE = /^\uFEFF?---[ \t]*$/;
const CLOSING_FRONTMATTER_FENCE = /^(?:---|\.\.\.)[ \t]*$/;

export function extractMarkdownFrontmatter(text: string): string | null {
  const firstSeparator = /[\r\n]/.exec(text);
  if (!firstSeparator) return null;

  const firstLine = text.slice(0, firstSeparator.index);
  if (!OPENING_FRONTMATTER_FENCE.test(firstLine)) return null;

  const firstSeparatorWidth =
    text[firstSeparator.index] === "\r" && text[firstSeparator.index + 1] === "\n" ? 2 : 1;
  const yamlStart = firstSeparator.index + firstSeparatorWidth;
  let lineStart = yamlStart;
  while (lineStart <= text.length) {
    const separatorOffset = text.slice(lineStart).search(/[\r\n]/);
    const lineEnd = separatorOffset === -1 ? text.length : lineStart + separatorOffset;
    const line = text.slice(lineStart, lineEnd);
    if (CLOSING_FRONTMATTER_FENCE.test(line)) {
      return text.slice(yamlStart, lineStart).replace(/\r\n|\r/g, "\n").replace(/\n$/, "");
    }
    if (separatorOffset === -1) break;
    const separatorWidth = text[lineEnd] === "\r" && text[lineEnd + 1] === "\n" ? 2 : 1;
    lineStart = lineEnd + separatorWidth;
  }

  return null;
}
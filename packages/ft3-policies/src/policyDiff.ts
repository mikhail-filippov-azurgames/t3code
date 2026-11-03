/**
 * A unified diff of an applied policy file against its live version. Policy
 * documents are small (≤ 1 MiB) and the Policies tab only needs the changed
 * region, so a common-prefix/suffix walk is enough and never allocates an
 * N×M table the way an LCS would.
 */

const CONTEXT_LINES = 3;

const linesOf = (text: string): readonly string[] => {
  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized === "") return [];
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

const range = (start: number, count: number): string =>
  count === 0 ? `${start},0` : `${start + 1},${count}`;

/** `--- a/<label>` / `+++ b/<label>` with one hunk; empty when the bytes match. */
export function unifiedDiff(applied: string, live: string, label: string): string {
  if (applied === live) return "";
  const before = linesOf(applied);
  const after = linesOf(live);

  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const contextStart = Math.max(0, prefix - CONTEXT_LINES);
  const beforeEnd = before.length - suffix;
  const afterEnd = after.length - suffix;
  const contextEnd = Math.max(0, suffix - CONTEXT_LINES);

  const removedCount = beforeEnd - prefix;
  const addedCount = afterEnd - prefix;
  const body: string[] = [];
  for (let index = contextStart; index < prefix; index += 1) {
    body.push(` ${before[index] ?? ""}`);
  }
  for (let index = prefix; index < beforeEnd; index += 1) {
    body.push(`-${before[index] ?? ""}`);
  }
  for (let index = prefix; index < afterEnd; index += 1) {
    body.push(`+${after[index] ?? ""}`);
  }
  for (let index = afterEnd; index < after.length - contextEnd; index += 1) {
    body.push(` ${after[index] ?? ""}`);
  }

  const beforeLines = prefix - contextStart + removedCount + (after.length - contextEnd - afterEnd);
  const afterLines = prefix - contextStart + addedCount + (after.length - contextEnd - afterEnd);
  return [
    `--- a/${label}`,
    `+++ b/${label}`,
    `@@ -${range(contextStart, beforeLines)} +${range(contextStart, afterLines)} @@`,
    ...body,
    "",
  ].join("\n");
}

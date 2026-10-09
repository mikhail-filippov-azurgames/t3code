import { unified } from "unified";
import remarkParse from "remark-parse";

const COMMIT_TOKEN_PATTERN =
  /(^|[^a-z0-9_-])((?:commit:)?[0-9a-f]{7,40})(?!-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=$|[^a-z0-9_-])/giu;
const EXCLUDED = new Set(["code", "link", "linkReference", "image", "imageReference", "html"]);
const CACHE_TTL_MS = 15_000;
const parser = unified().use(remarkParse);

interface MarkdownNode {
  readonly type: string;
  readonly value?: unknown;
  readonly children?: ReadonlyArray<MarkdownNode>;
}

export interface CommitMention {
  readonly token: string;
  readonly sha: string;
  readonly explicit: boolean;
}

export const EMPTY_COMMIT_MENTIONS: ReadonlyArray<CommitMention> = [];
export const EMPTY_COMMIT_MENTION_MATCHES: ReadonlyMap<string, string> = new Map();

function parseCandidate(value: string): CommitMention | null {
  const explicit = /^commit:/iu.test(value);
  const sha = explicit ? value.slice("commit:".length) : value;
  if (!/^[0-9a-f]{7,40}$/iu.test(sha)) {
    return null;
  }
  return { token: value.toLowerCase(), sha: sha.toLowerCase(), explicit };
}

export function extractCommitMentions(markdown: string): ReadonlyArray<CommitMention> {
  if (!COMMIT_TOKEN_PATTERN.test(markdown)) return EMPTY_COMMIT_MENTIONS;
  COMMIT_TOKEN_PATTERN.lastIndex = 0;
  const found = new Map<string, CommitMention>();
  const find = (text: string) => {
    const pattern = new RegExp(COMMIT_TOKEN_PATTERN.source, COMMIT_TOKEN_PATTERN.flags);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const candidate = match[2];
      if (!candidate) continue;
      const parsed = parseCandidate(candidate);
      if (parsed) found.set(parsed.token, parsed);
    }
  };
  const visit = (node: MarkdownNode) => {
    if (node.type === "inlineCode") {
      if (typeof node.value === "string") {
        const candidate = node.value.trim();
        const parsed = parseCandidate(candidate);
        if (parsed && candidate.length === node.value.trim().length)
          found.set(parsed.token, parsed);
      }
      return;
    }
    if (EXCLUDED.has(node.type)) return;
    if (node.type === "text" && typeof node.value === "string") {
      find(node.value);
      return;
    }
    node.children?.forEach(visit);
  };
  visit(parser.parse(markdown) as MarkdownNode);
  return found.size ? [...found.values()] : EMPTY_COMMIT_MENTIONS;
}

type CommitReader = (candidates: ReadonlyArray<string>) => Promise<ReadonlyArray<string>>;
interface CachedCommit {
  readonly expiresAt: number;
  readonly sha: string | null;
}
const cache = new Map<string, CachedCommit>();
const inFlight = new Map<string, Promise<string | null>>();
const keyOf = (environmentId: string, cwd: string, sha: string) =>
  `${environmentId}\0${cwd}\0${sha}`;

export async function resolveCommitMentions(
  environmentId: string,
  cwd: string,
  candidates: ReadonlyArray<string>,
  read: CommitReader,
): Promise<ReadonlyMap<string, string | null>> {
  const now = performance.now();
  const unique = [...new Set(candidates.map((candidate) => candidate.toLowerCase()))];
  const result = new Map<string, string | null>();
  const pending = new Map<string, Promise<string | null>>();
  const missing: string[] = [];
  for (const candidate of unique) {
    const key = keyOf(environmentId, cwd, candidate);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) result.set(candidate, cached.sha);
    else if (inFlight.has(key)) pending.set(candidate, inFlight.get(key)!);
    else missing.push(candidate);
  }
  for (let offset = 0; offset < missing.length; offset += 100) {
    const batch = missing.slice(offset, offset + 100);
    const request = read(batch).then((found) => {
      const resolved = found.map((sha) => sha.toLowerCase());
      for (const candidate of batch) {
        const matches = resolved.filter((sha) => sha.startsWith(candidate));
        const sha = matches.length === 1 ? matches[0]! : null;
        cache.set(keyOf(environmentId, cwd, candidate), {
          expiresAt: performance.now() + CACHE_TTL_MS,
          sha,
        });
      }
      return resolved;
    });
    for (const candidate of batch) {
      const key = keyOf(environmentId, cwd, candidate);
      const waiter = request
        .then((found) => {
          const matches = found.filter((sha) => sha.startsWith(candidate));
          return matches.length === 1 ? matches[0]! : null;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, waiter);
      pending.set(candidate, waiter);
    }
  }
  await Promise.all(
    [...pending].map(async ([candidate, promise]) => result.set(candidate, await promise)),
  );
  return result;
}

export function clearCommitMentionCache(environmentId: string): void {
  const prefix = `${environmentId}\0`;
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
}

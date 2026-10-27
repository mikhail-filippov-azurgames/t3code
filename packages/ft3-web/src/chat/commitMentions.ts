const COMMIT_TOKEN_PATTERN =
  /(^|[^a-z0-9_-])((?:commit:)?[0-9a-f]{7,40})(?!-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=$|[^a-z0-9_-])/giu;
const INLINE_CODE_PATTERN = /(`+)([\s\S]*?)\1/g;
const MARKDOWN_LINK_PATTERN = /!?\[[^\]]*\]\([^)]*\)/g;
const MARKDOWN_REFERENCE_LINK_PATTERN = /!?\[[^\]]*\]\[[^\]]*\]/g;
const HTML_TAG_PATTERN = /<\/?[A-Za-z][^>]*>/g;
const BARE_URL_PATTERN = /\b(?:https?|ftp):\/\/\S+/gi;
const FENCED_CODE_PATTERN = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[^\n]*$|$)/gm;

const COMMIT_MENTION_CACHE_TTL_MS = 15_000;

export interface CommitMention {
  readonly token: string;
  readonly sha: string;
  readonly explicit: boolean;
}

export interface CommitMentionTextSegment {
  readonly text: string;
  /** Full SHA when the server confirmed the token, else null. */
  readonly sha: string | null;
}

export const EMPTY_COMMIT_MENTIONS: ReadonlyArray<CommitMention> = [];
export const EMPTY_COMMIT_MENTION_MATCHES: ReadonlyMap<string, string> = new Map();

const parseCandidate = (value: string): CommitMention | null => {
  const explicit = /^commit:/iu.test(value);
  const sha = explicit ? value.slice("commit:".length) : value;
  if (!/^[0-9a-f]{7,40}$/iu.test(sha)) return null;
  return { token: value.toLowerCase(), sha: sha.toLowerCase(), explicit };
};

const tokenMatchesInText = (
  text: string,
): Array<{ readonly token: string; readonly start: number; readonly end: number }> => {
  const matches: Array<{ readonly token: string; readonly start: number; readonly end: number }> =
    [];
  const pattern = new RegExp(COMMIT_TOKEN_PATTERN.source, COMMIT_TOKEN_PATTERN.flags);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const token = match[2];
    if (token === undefined) continue;
    const start = match.index + match[1]!.length;
    matches.push({ token, start, end: start + token.length });
  }
  return matches;
};

/** Returns a token only when the trimmed inline-code value is one commit candidate. */
export function commitMentionTokenFromInlineCode(text: string): string | null {
  const candidate = text.trim();
  const parsed = parseCandidate(candidate);
  return parsed?.token ?? null;
}

/** Splits plain markdown text while linking only tokens the server confirmed. */
export function commitMentionTextSegments(
  text: string,
  matches: ReadonlyMap<string, string>,
): ReadonlyArray<CommitMentionTextSegment> {
  const segments: CommitMentionTextSegment[] = [];
  let cursor = 0;
  const appendPlain = (value: string) => {
    if (!value) return;
    const previous = segments.at(-1);
    if (previous?.sha === null) {
      segments[segments.length - 1] = { text: previous.text + value, sha: null };
    } else {
      segments.push({ text: value, sha: null });
    }
  };

  for (const tokenMatch of tokenMatchesInText(text)) {
    appendPlain(text.slice(cursor, tokenMatch.start));
    const parsed = parseCandidate(tokenMatch.token);
    const resolved = parsed === null ? undefined : matches.get(parsed.token);
    segments.push({
      text: text.slice(tokenMatch.start, tokenMatch.end),
      sha: resolved ?? null,
    });
    cursor = tokenMatch.end;
  }
  appendPlain(text.slice(cursor));
  return segments;
}

const blank = (value: string): string => value.replace(/[^\n]/g, " ");

/**
 * Reads prose and inline-code spans that contain one commit token. Fenced code,
 * link destinations and URLs are blanked first, so a token there stays inert.
 */
export function extractCommitMentions(markdown: string): ReadonlyArray<CommitMention> {
  if (!tokenMatchesInText(markdown).length) return EMPTY_COMMIT_MENTIONS;

  const found: Array<{ readonly mention: CommitMention; readonly index: number }> = [];
  let prose = markdown.replace(FENCED_CODE_PATTERN, blank);
  prose = prose
    .replace(MARKDOWN_LINK_PATTERN, blank)
    .replace(MARKDOWN_REFERENCE_LINK_PATTERN, blank)
    .replace(HTML_TAG_PATTERN, blank)
    .replace(BARE_URL_PATTERN, blank);
  prose = prose.replace(INLINE_CODE_PATTERN, (span, _fence: string, content: string) => {
    const token = commitMentionTokenFromInlineCode(content);
    const parsed = token === null ? null : parseCandidate(token);
    if (parsed !== null) found.push({ mention: parsed, index: markdown.indexOf(span) });
    return blank(span);
  });

  for (const match of tokenMatchesInText(prose)) {
    const parsed = parseCandidate(match.token);
    if (parsed !== null) found.push({ mention: parsed, index: match.start });
  }

  const unique = new Map<string, CommitMention>();
  for (const entry of found.sort((left, right) => left.index - right.index)) {
    if (!unique.has(entry.mention.token)) unique.set(entry.mention.token, entry.mention);
  }
  return unique.size === 0 ? EMPTY_COMMIT_MENTIONS : [...unique.values()];
}

type CommitReader = (candidates: ReadonlyArray<string>) => Promise<ReadonlyArray<string>>;

interface CachedCommit {
  readonly expiresAt: number;
  readonly sha: string | null;
}

const cache = new Map<string, CachedCommit>();
const inFlight = new Map<string, Promise<string | null>>();
const cacheKey = (environmentId: string, cwd: string, sha: string) =>
  `${environmentId}\0${cwd}\0${sha}`;

/**
 * Resolves abbreviated SHAs against one repository. A candidate resolves only
 * when exactly one commit starts with it, so an ambiguous prefix stays plain.
 */
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
    const key = cacheKey(environmentId, cwd, candidate);
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
        cache.set(cacheKey(environmentId, cwd, candidate), {
          expiresAt: performance.now() + COMMIT_MENTION_CACHE_TTL_MS,
          sha,
        });
      }
      return resolved;
    });
    for (const candidate of batch) {
      const key = cacheKey(environmentId, cwd, candidate);
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

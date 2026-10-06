import {
  BoardCardLookupToken,
  type BoardCardLookupMatch,
  type BoardCardLookupToken as BoardCardLookupTokenType,
} from "@t3tools/contracts";
import { unified } from "unified";
import remarkParse from "remark-parse";

const BOARD_CARD_TOKEN_PATTERN =
  /(^|[^a-z0-9_-])((?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8}))(?=$|[^a-z0-9_-])/giu;
const EXCLUDED_MARKDOWN_NODES = new Set([
  "code",
  "link",
  "linkReference",
  "image",
  "imageReference",
  "html",
]);
const BOARD_CARD_LOOKUP_CACHE_TTL_MS = 15_000;
const markdownParser = unified().use(remarkParse);

interface MarkdownNode {
  readonly type: string;
  readonly value?: unknown;
  readonly children?: ReadonlyArray<MarkdownNode>;
}

export interface BoardCardMentionTextSegment {
  readonly text: string;
  readonly match: BoardCardLookupMatch | null;
}

export const EMPTY_BOARD_CARD_LOOKUP_TOKENS: ReadonlyArray<BoardCardLookupTokenType> = [];
export const EMPTY_BOARD_CARD_LOOKUP_MATCHES: ReadonlyMap<string, BoardCardLookupMatch> = new Map();

const tokenMatchesInText = (
  text: string,
): Array<{ readonly token: string; readonly start: number; readonly end: number }> => {
  const matches: Array<{ readonly token: string; readonly start: number; readonly end: number }> =
    [];
  const pattern = new RegExp(BOARD_CARD_TOKEN_PATTERN.source, BOARD_CARD_TOKEN_PATTERN.flags);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const token = match[2];
    if (token === undefined) continue;
    const start = match.index + match[1]!.length;
    matches.push({ token, start, end: start + token.length });
  }
  return matches;
};

/** Returns a token only when the trimmed inline-code value is one card candidate. */
export function boardCardMentionTokenFromInlineCode(text: string): string | null {
  const candidate = text.trim();
  const [match] = tokenMatchesInText(candidate);
  return match?.start === 0 && match.end === candidate.length ? match.token.toLowerCase() : null;
}

/** Splits plain markdown text while linking only tokens with unique server matches. */
export function boardCardMentionTextSegments(
  text: string,
  matches: ReadonlyMap<string, BoardCardLookupMatch>,
): ReadonlyArray<BoardCardMentionTextSegment> {
  const segments: BoardCardMentionTextSegment[] = [];
  let cursor = 0;
  const appendPlain = (value: string) => {
    if (!value) return;
    const previous = segments.at(-1);
    if (previous?.match === null) {
      segments[segments.length - 1] = { text: previous.text + value, match: null };
    } else {
      segments.push({ text: value, match: null });
    }
  };

  for (const tokenMatch of tokenMatchesInText(text)) {
    appendPlain(text.slice(cursor, tokenMatch.start));
    const resolved = matches.get(tokenMatch.token.toLowerCase());
    segments.push({ text: tokenMatch.token, match: resolved ?? null });
    cursor = tokenMatch.end;
  }
  appendPlain(text.slice(cursor));
  return segments;
}

/** Reads prose and inline-code spans that contain one card token. */
export function extractBoardCardLookupTokens(
  markdown: string,
): ReadonlyArray<BoardCardLookupTokenType> {
  if (!tokenMatchesInText(markdown).length) return EMPTY_BOARD_CARD_LOOKUP_TOKENS;

  const found = new Set<string>();
  const visit = (node: MarkdownNode) => {
    if (node.type === "inlineCode") {
      if (typeof node.value === "string") {
        const token = boardCardMentionTokenFromInlineCode(node.value);
        if (token) found.add(token);
      }
      return;
    }
    if (EXCLUDED_MARKDOWN_NODES.has(node.type)) return;
    if (node.type === "text" && typeof node.value === "string") {
      for (const { token } of tokenMatchesInText(node.value)) found.add(token.toLowerCase());
      return;
    }
    node.children?.forEach(visit);
  };

  visit(markdownParser.parse(markdown) as MarkdownNode);
  return found.size === 0
    ? EMPTY_BOARD_CARD_LOOKUP_TOKENS
    : [...found].map((token) => BoardCardLookupToken.make(token));
}

type BoardCardTokenReader = (
  tokens: ReadonlyArray<BoardCardLookupTokenType>,
) => Promise<ReadonlyArray<BoardCardLookupMatch>>;

interface CachedBoardCardMatch {
  readonly expiresAt: number;
  readonly match: BoardCardLookupMatch | null;
}

const cache = new Map<string, CachedBoardCardMatch>();
const inFlight = new Map<string, Promise<BoardCardLookupMatch | null>>();
const invalidationListeners = new Map<string, Set<() => void>>();

const cacheKey = (environmentId: string, token: string) => `${environmentId}\u0000${token}`;

/** Resolves missing candidates as one batch and caches each environment-token pair for 15 seconds. */
export async function resolveBoardCardMentions(
  environmentId: string,
  tokens: ReadonlyArray<BoardCardLookupTokenType>,
  read: BoardCardTokenReader,
): Promise<ReadonlyMap<string, BoardCardLookupMatch | null>> {
  const now = performance.now();
  for (const [key, cached] of cache) {
    if (cached.expiresAt <= now) cache.delete(key);
  }
  const uniqueTokens = [...new Set(tokens.map((token) => String(token).toLowerCase()))];
  const result = new Map<string, BoardCardLookupMatch | null>();
  const waiters = new Map<string, Promise<BoardCardLookupMatch | null>>();
  const toRead: BoardCardLookupTokenType[] = [];

  for (const token of uniqueTokens) {
    const key = cacheKey(environmentId, token);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) {
      result.set(token, cached.match);
    } else {
      cache.delete(key);
      const pending = inFlight.get(key);
      if (pending) waiters.set(key, pending);
      else toRead.push(BoardCardLookupToken.make(token));
    }
  }

  for (let offset = 0; offset < toRead.length; offset += 100) {
    const batchTokens = toRead.slice(offset, offset + 100);
    const batch = read(batchTokens).then((matches) => {
      const matchesByToken = new Map(
        matches.map((match) => [String(match.token).toLowerCase(), match] as const),
      );
      for (const token of batchTokens) {
        const tokenText = String(token).toLowerCase();
        cache.set(cacheKey(environmentId, tokenText), {
          expiresAt: performance.now() + BOARD_CARD_LOOKUP_CACHE_TTL_MS,
          match: matchesByToken.get(tokenText) ?? null,
        });
      }
      return matchesByToken;
    });

    for (const token of batchTokens) {
      const tokenText = String(token).toLowerCase();
      const key = cacheKey(environmentId, tokenText);
      const pending = batch
        .then((matches) => matches.get(tokenText) ?? null)
        .finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
      waiters.set(key, pending);
    }
  }

  await Promise.all(
    [...waiters].map(async ([key, pending]) => {
      const token = key.slice(key.indexOf("\u0000") + 1);
      result.set(token, await pending);
    }),
  );
  return result;
}

export function clearBoardCardMentionCache(environmentId: string): void {
  const prefix = `${environmentId}\u0000`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
  for (const listener of invalidationListeners.get(environmentId) ?? []) listener();
}

export function subscribeBoardCardMentionCacheInvalidation(
  environmentId: string,
  listener: () => void,
): () => void {
  const listeners = invalidationListeners.get(environmentId) ?? new Set();
  listeners.add(listener);
  invalidationListeners.set(environmentId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) invalidationListeners.delete(environmentId);
  };
}

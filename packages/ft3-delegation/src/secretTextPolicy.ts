export type AuthorTextField =
  | "prompt"
  | "message"
  | "title"
  | "handoff"
  | "question"
  | "reason"
  | "summary"
  | "body"
  | "lastError"
  | "readinessNote";

export type DerivedTextPurpose = "summary" | "wake" | "completion-preview" | "read";

export type SecretKind =
  | "provider-token"
  | "jwt"
  | "private-key"
  | "credential-url"
  | "authorization"
  | "cookie"
  | "secret-assignment";

export type SecretTextDetection =
  | { readonly _tag: "Clean"; readonly count: 0; readonly kinds: readonly [] }
  | {
      readonly _tag: "SecretsFound";
      readonly count: number;
      readonly kinds: ReadonlyArray<SecretKind>;
    };

export type AuthorTextPolicyResult =
  | { readonly _tag: "Accepted"; readonly text: string }
  | {
      readonly _tag: "Rejected";
      readonly error: {
        readonly _tag: "SecretDetected";
        readonly field: AuthorTextField;
      };
    };

export type DerivedTextPolicyResult =
  | { readonly _tag: "Unchanged"; readonly text: string }
  | {
      readonly _tag: "Redacted";
      readonly text: string;
      readonly redactedCount: number;
    };

export const SECRET_REDACTION_LABEL = "[REDACTED]" as const;

interface SecretSpan {
  readonly start: number;
  readonly end: number;
  readonly kind: SecretKind;
}

interface SecretRule {
  readonly kind: SecretKind;
  readonly pattern: RegExp;
  readonly candidateGroup?: string;
  readonly keyGroup?: string;
  readonly requireCredentialLikeValue: boolean;
  readonly minimumCredentialEntropy?: number;
}

const SECRET_RULES: ReadonlyArray<SecretRule> = [
  {
    kind: "provider-token",
    pattern:
      /(?<secret>\b(?:sk-(?:(?:ant|proj|svcacct)-[A-Za-z0-9_-]{16,})|sk_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox(?:[baprs]|[oe])-[A-Za-z0-9-]{10,}|xai-[A-Za-z0-9_-]{16,}|rk_(?:live|test)_[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{30,})\b)/dgi,
    requireCredentialLikeValue: false,
  },
  {
    kind: "provider-token",
    pattern: /(?<secret>\bsk-[A-Za-z0-9_-]{16,}\b)/dgi,
    requireCredentialLikeValue: true,
    minimumCredentialEntropy: 3.8,
  },
  {
    kind: "jwt",
    pattern:
      /(?<secret>\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.(?:[A-Za-z0-9_-]{8,})?(?![A-Za-z0-9_-]))/dgi,
    requireCredentialLikeValue: true,
  },
  {
    kind: "private-key",
    pattern:
      /(?<secret>-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/]{32,}={0,2}\r?\n)+-----END [A-Z0-9 ]*PRIVATE KEY-----)/dgi,
    requireCredentialLikeValue: false,
  },
  {
    kind: "credential-url",
    pattern:
      /[a-z][a-z\d+.-]*:\/\/(?<secret>(?<username>[^/\s:@]+):(?<candidate>[^/\s]+))(?=@[^/\s]+)/dgi,
    candidateGroup: "candidate",
    keyGroup: "username",
    requireCredentialLikeValue: true,
  },
  {
    kind: "authorization",
    pattern:
      /\b(?:Bearer|Basic)\s+(?<secret>[A-Za-z0-9~+/=_-]{8,}(?:\.[A-Za-z0-9~+/=_-]{8,}){0,2})(?![A-Za-z0-9_])/dgi,
    requireCredentialLikeValue: true,
  },
  {
    kind: "secret-assignment",
    pattern:
      /(?<![A-Za-z0-9_$])(?<key>[A-Za-z0-9_.-]*(?:api[\s_-]*key|access[\s_-]*key[\s_-]*id|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|session[_-]?token|secret(?:[_-]?(?:key|token|access[_-]?key))?|authorization|credentials?|password|passwd|passphrase|token|key|pwd|pass))['"]?\s*[:=]\s*(?<secret>"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|\x60(?:\\.|[^\x60\\\r\n])*\x60|[^\s,;}\]]+)/dgi,
    keyGroup: "key",
    requireCredentialLikeValue: true,
  },
];

const COOKIE_HEADER = /\b(?:Set-Cookie|Cookie)\s*:\s*[^\r\n]+/gi;
const SENSITIVE_COOKIE_NAME =
  /^(?:__Host-|__Secure-)?(?:session(?:[_-]?(?:id|token))?|jsessionid|sid|auth(?:entication)?|access[_-]?token|refresh[_-]?token|csrf(?:[_-]?token)?|token|jwt|connect\.sid)$/i;

const PLACEHOLDER_VALUES = new Set([
  "changeme",
  "changeme123",
  "change me",
  "correct horse battery staple",
  "example",
  "fake",
  "hunter2",
  "insert here",
  "letmein",
  "not a real secret",
  "password",
  "password123",
  "placeholder",
  "redacted",
  "replace me",
  "sample",
  "secret",
  "secret123",
  "set me",
  "swordfish",
  "test",
  "todo",
  "undefined",
  "null",
  "none",
]);

function normalizedCandidate(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith("`") && trimmed.endsWith("`")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isPlaceholder(value: string): boolean {
  const candidate = normalizedCandidate(value);
  if (
    candidate === "" ||
    /[()[\]{}]/.test(candidate) ||
    /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.(?:signature|(?:your|example)[_-]?signature)$/i.test(
      candidate,
    ) ||
    /^(?:<[^<>]+>|\$\{[^}]+\}|\{\{[^}]+\}\}|\$[A-Z_][A-Z0-9_]*|%[A-Z_][A-Z0-9_]*%)$/i.test(
      candidate,
    ) ||
    /^(?:process\.env|import\.meta\.env|env|keychain|secretmanager)(?:[.:/_-]|$)/i.test(candidate)
  ) {
    return true;
  }

  const normalized = candidate.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return (
    PLACEHOLDER_VALUES.has(normalized) ||
    /^(?:your|example|sample|dummy|fake|placeholder|redacted|replace me|change me|insert here|set me|not a real)(?: .*)?$/.test(
      normalized,
    ) ||
    /^(?:your )?(?:api key|access token|refresh token|secret|password|credential)(?: value| example| placeholder| here| goes here)$/.test(
      normalized,
    ) ||
    /^[x*.-]{3,}$/i.test(candidate)
  );
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

// Require credential-shaped values so identifiers and documentation examples stay clean.
function looksLikeCredential(value: string, key = "", minimumEntropyOverride?: number): boolean {
  const candidate = normalizedCandidate(value);
  if (isPlaceholder(candidate) || /[\r\n]/.test(candidate)) return false;
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(candidate) && /[A-Z]/.test(candidate)) {
    const camelCaseBoundaries = candidate.match(/[a-z][A-Z]/g)?.length ?? 0;
    if (!/\d/.test(candidate) || (/^[a-z_$]/.test(candidate) && camelCaseBoundaries >= 2)) {
      return false;
    }
  }

  const passwordField = /password|passwd|passphrase/i.test(key);
  const minimumLength = passwordField ? 8 : 12;
  const minimumEntropy = minimumEntropyOverride ?? (passwordField ? 2.7 : 3.1);
  return candidate.length >= minimumLength && shannonEntropy(candidate) >= minimumEntropy;
}

function captureSpan(
  match: RegExpMatchArray,
  group: string | undefined,
): { readonly start: number; readonly end: number } | undefined {
  const indices = group === undefined ? match.indices?.[0] : match.indices?.groups?.[group];
  if (indices === undefined) return undefined;
  return { start: indices[0], end: indices[1] };
}

function collectRegexSpans(input: string): Array<SecretSpan> {
  const spans: Array<SecretSpan> = [];
  for (const rule of SECRET_RULES) {
    for (const match of input.matchAll(rule.pattern)) {
      const span = captureSpan(match, "secret");
      if (span === undefined) continue;

      const candidate =
        rule.candidateGroup === undefined
          ? (match.groups?.secret ?? match[0])
          : (match.groups?.[rule.candidateGroup] ?? "");
      const key = rule.keyGroup === undefined ? "" : (match.groups?.[rule.keyGroup] ?? "");
      if (
        rule.requireCredentialLikeValue &&
        !looksLikeCredential(candidate, key, rule.minimumCredentialEntropy)
      ) {
        continue;
      }
      spans.push({ ...span, kind: rule.kind });
    }
  }
  return spans;
}

function collectCookieSpans(input: string): Array<SecretSpan> {
  const spans: Array<SecretSpan> = [];
  for (const match of input.matchAll(new RegExp(COOKIE_HEADER.source, COOKIE_HEADER.flags))) {
    const line = match[0];
    if (match.index === undefined) continue;
    const colonIndex = line.indexOf(":");
    if (colonIndex < 0) continue;

    const headerValue = line.slice(colonIndex + 1);
    const valueStart = match.index + colonIndex + 1;
    let segmentStart = 0;
    for (const segment of headerValue.split(";")) {
      const equalsIndex = segment.indexOf("=");
      if (equalsIndex >= 0) {
        const key = segment.slice(0, equalsIndex).trim();
        const rawValue = segment.slice(equalsIndex + 1);
        const leadingWhitespace = rawValue.length - rawValue.trimStart().length;
        const candidate = rawValue.trim();
        if (SENSITIVE_COOKIE_NAME.test(key) && looksLikeCredential(candidate, key)) {
          const start = valueStart + segmentStart + equalsIndex + 1 + leadingWhitespace;
          spans.push({
            start,
            end: start + candidate.length,
            kind: "cookie",
          });
        }
      }
      segmentStart += segment.length + 1;
    }
  }
  return spans;
}

function mergeSpans(spans: ReadonlyArray<SecretSpan>): Array<SecretSpan> {
  const sorted = [...spans].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Array<SecretSpan> = [];
  for (const span of sorted) {
    const previous = merged.at(-1);
    if (previous !== undefined && span.start < previous.end) {
      merged[merged.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, span.end),
        kind: previous.kind,
      };
    } else {
      merged.push(span);
    }
  }
  return merged;
}

function collectSecretSpans(input: string): Array<SecretSpan> {
  return [...collectRegexSpans(input), ...collectCookieSpans(input)];
}

function findSecretSpans(input: string): Array<SecretSpan> {
  return mergeSpans(collectSecretSpans(input));
}

/** Returns secret kinds and a count without exposing matched text. */
export function detectSecrets(input: string): SecretTextDetection {
  const matches = collectSecretSpans(input);
  const spans = mergeSpans(matches);
  if (spans.length === 0) return { _tag: "Clean", count: 0, kinds: [] };
  return {
    _tag: "SecretsFound",
    count: spans.length,
    kinds: [...new Set(matches.map((span) => span.kind))].toSorted(),
  };
}

/** Rejects authored text without returning or logging its secret content. */
export function applyAuthorTextPolicy(
  field: AuthorTextField,
  input: string,
): AuthorTextPolicyResult {
  return findSecretSpans(input).length > 0
    ? { _tag: "Rejected", error: { _tag: "SecretDetected", field } }
    : { _tag: "Accepted", text: input };
}

/** Redacts detected spans while preserving every unmatched character. */
export function applyDerivedTextPolicy(
  _purpose: DerivedTextPurpose,
  input: string,
): DerivedTextPolicyResult {
  const spans = findSecretSpans(input);
  if (spans.length === 0) return { _tag: "Unchanged", text: input };

  const parts: Array<string> = [];
  let cursor = 0;
  for (const span of spans) {
    parts.push(input.slice(cursor, span.start), SECRET_REDACTION_LABEL);
    cursor = span.end;
  }
  parts.push(input.slice(cursor));
  return { _tag: "Redacted", text: parts.join(""), redactedCount: spans.length };
}

/** Returns only redacted text if the derived-text check itself fails. */
export function projectDerivedText(
  purpose: DerivedTextPurpose,
  input: string,
  policy: typeof applyDerivedTextPolicy = applyDerivedTextPolicy,
): string {
  try {
    return policy(purpose, input).text;
  } catch {
    return SECRET_REDACTION_LABEL;
  }
}

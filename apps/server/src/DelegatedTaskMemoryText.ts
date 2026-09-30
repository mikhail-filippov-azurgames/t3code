const REDACTED = "[REDACTED]";

const secretAssignments =
  /(["']?[A-Z0-9_.-]*(?:API[_-]?KEY|ACCESS[_-]?(?:KEY|TOKEN)|SECRET(?:[_-]?(?:KEY|TOKEN|ACCESS[_-]?KEY))?|REFRESH[_-]?TOKEN|AUTHORIZATION|CLIENT[_-]?SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|SESSION[_-]?TOKEN|TOKEN|CREDENTIALS?)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s,;}\]]+)/gi;

const recognizableTokens =
  /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|xai-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/gi;

const jwt = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const privateKey =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi;
const credentialUrl = /([a-z][a-z\d+.-]*:\/\/)[^/\s:@]+:[^/@\s]+@/gi;
const authorizationHeader = /\b(Bearer|Basic)\s+[A-Za-z0-9~+/=_\-.]+/gi;
const cookieHeader = /\b(Set-Cookie|Cookie)\s*:\s*[^\r\n]+/gi;

/** Redacts common credential formats from delegated-task derived text. */
export function scrubDelegatedTaskText(input: string): string {
  return input
    .replace(privateKey, REDACTED)
    .replace(credentialUrl, `$1${REDACTED}@`)
    .replace(authorizationHeader, `$1 ${REDACTED}`)
    .replace(cookieHeader, `$1: ${REDACTED}`)
    .replace(secretAssignments, `$1${REDACTED}`)
    .replace(recognizableTokens, REDACTED)
    .replace(jwt, REDACTED);
}

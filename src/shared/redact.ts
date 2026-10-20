/**
 * The one credential-redaction rule set. Worker records and stderr (main/adapters/cli/redact), context packs, diagnostics
 * and probe errors (main/redact-context) and the log view in the UI all run exactly this, so a secret that one surface
 * hides is hidden everywhere. Pure string work: no Node, no DOM.
 *
 * Placeholders: a `key=value` pair keeps the key (and the quotes around a quoted value) and masks the value; `Bearer`/`Basic`
 * keep the scheme word; a URL keeps its scheme and the `@`; private keys and stand-alone tokens become `[REDACTED]`.
 * Best effort by design: it never claims to catch every secret.
 */
export const REDACTED = '[REDACTED]';

const KEY = '(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization|credential)';
// A quoted value (kept quoted), or an optional auth scheme word plus the first unbroken run of non-space text.
const KEY_VALUE = new RegExp(`(["']?${KEY}["']?\\s*[=:]\\s*)(?:"[^"\\n]*"|'[^'\\n]*'|(?:(?:Bearer|Basic)\\s+)?\\S+)`, 'gi');
const TOKEN = /\b(?:(?:sk|rk|xai|pplx|r8)-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})|\bAKIA[A-Z0-9]{16}\b/g;
// An unterminated block runs to the end of the text: a key cut off mid-stream is still a key.
const PRIVATE_KEY = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gi;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
// Basic credentials are base64: require a digit, '+', '/' or a lower-to-upper step so prose such as "Basic usage" survives.
const BASIC = /\b([Bb]asic\s+)(?=[A-Za-z0-9+/]*(?:[0-9+/]|[a-z][A-Z]))[A-Za-z0-9+/]{8,}={0,2}/g;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi;

/** Strip credential-shaped text. Idempotent: redacting redacted text changes nothing. */
export function redactSecrets(value: string): string {
  return value
    .replace(PRIVATE_KEY, REDACTED)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(KEY_VALUE, (match, head: string) => {
      const rest = match.slice(head.length);
      const quote = rest[0];
      return (quote === '"' || quote === "'") && rest.length >= 2 && rest.endsWith(quote) ? `${head}${quote}${REDACTED}${quote}` : `${head}${REDACTED}`;
    })
    .replace(BEARER, `$1${REDACTED}`)
    .replace(BASIC, `$1${REDACTED}`)
    .replace(TOKEN, REDACTED);
}

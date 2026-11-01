/**
 * Redaction for logs, the activity log and error details. Covers URL credentials, token-like query
 * parameters and archive tokens in `/a/<token>/...` paths (docs/architecture.md, archive URL scheme).
 */
const MASK = "***";
const SECRET_QUERY = /([?&;](?:password|passwd|pass|pwd|secret|token|access_token|refresh_token|api_key|apikey|key|auth|session|sid|signature|sig)=)[^&#\s"']*/gi;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@?#]+@/gi;
const ARCHIVE_TOKEN = /(\/a\/)[^/\s?#"']+/g;

export function redactUrl(url: string): string {
  if (!url) return url;
  return url
    .replace(URL_CREDENTIALS, `$1${MASK}@`)
    .replace(ARCHIVE_TOKEN, `$1${MASK}`)
    .replace(SECRET_QUERY, `$1${MASK}`);
}

/** Redacts every URL-like part of free text (log messages). */
export function redactText(text: string): string {
  return redactUrl(text).replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${MASK}`);
}

const SECRET_KEYS = /pass(word|wd)?|secret|token|cookie|authorization|api[_-]?key|credential/i;

export function redactObject<T>(value: T, depth = 0): T {
  if (depth > 8) return MASK as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactObject(v, depth + 1)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? MASK : redactObject(v, depth + 1);
    }
    return out as T;
  }
  if (typeof value === "string") return redactText(value) as unknown as T;
  return value;
}

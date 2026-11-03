/**
 * Plain-language errors (H-08). Every failure the interface shows gives a short sentence in UK English, says what to do next, and never
 * a stack trace, an internal code or a bare status number. The catalogue below is the fallback for any API answer whose own message is
 * missing or looks technical; the API's own messages (docs/api.md) are plain already and are kept when they pass `isPlain`.
 */

/** The codes of docs/api.md, plus "network" for a request that got no answer at all. */
export const FALLBACK_BY_CODE: Record<string, string> = {
  network: "Can't reach the server. Check the connection, then try again.",
  bad_request: "Some details need fixing. Check the highlighted fields, then try again.",
  unauthorized: "Your session has ended. Sign in again to carry on.",
  forbidden: "This account can't do that. Ask the administrator, or sign in with another account.",
  csrf: "The request was refused as a safety check. Reload the page, then try again.",
  not_found: "That item no longer exists. Go back and refresh the list.",
  conflict: "Something changed while you were working. Reload the page, then try again.",
  rate_limited: "Too many attempts. Wait a minute, then try again.",
  setup_required: "Setup isn't finished yet. Finish setup to carry on.",
  offline: "You are offline. Use your saved pages for now, or try again when the connection returns.",
  blocked: "NoConBrain won't fetch that address. Check it, or choose a different one.",
  insufficient_storage: "There isn't enough storage space. Free some space or add a volume under Storage, then try again.",
  provider_error: "The search provider didn't answer. Try again, or check the provider under Online search settings.",
  not_implemented: "That isn't available in this version of NoConBrain.",
  unavailable: "That part of NoConBrain isn't answering right now. Wait a moment, then try again.",
  internal: "NoConBrain hit a problem. Try again, and check the activity log under Storage if it keeps happening.",
};

/** Used when the code is not in the catalogue (an unknown code, or none): chosen by status. */
export function fallbackForStatus(status: number): string {
  if (status === 0) return FALLBACK_BY_CODE.network!;
  if (status === 401) return FALLBACK_BY_CODE.unauthorized!;
  if (status === 403) return FALLBACK_BY_CODE.forbidden!;
  if (status === 404) return FALLBACK_BY_CODE.not_found!;
  if (status === 409) return FALLBACK_BY_CODE.conflict!;
  if (status === 429) return FALLBACK_BY_CODE.rate_limited!;
  if (status === 503) return FALLBACK_BY_CODE.unavailable!;
  if (status === 507) return FALLBACK_BY_CODE.insufficient_storage!;
  if (status >= 500) return FALLBACK_BY_CODE.internal!;
  return "The request didn't go through. Check the details, then try again.";
}

/**
 * True when `text` reads as a sentence for a person: not empty, not a code or a status line, no stack frame, no JSON, no runtime error
 * name (`TypeError`, `ECONNREFUSED`, `SQLITE_…`), and not the browser's own "Failed to fetch".
 */
export function isPlain(text: unknown): text is string {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (t.length < 8 || t.length > 400) return false;
  if (!/\s/.test(t)) return false; // a lone token such as "internal" or "ENOENT"
  if (/\n\s+at\s|\bat\s+\S+\s+\(.*:\d+:\d+\)/.test(t)) return false;
  if (/^[\[{]/.test(t)) return false;
  if (/\b(TypeError|ReferenceError|SyntaxError|RangeError|AggregateError|E(?:CONN\w*|NOENT|ACCES|PERM|PIPE|TIMEDOUT|NOTFOUND|NOSPC|XIST|ISDIR|NOTDIR|MFILE|BUSY|AGAIN|INVAL|IO|XDEV|ROFS|NOTEMPTY)|SQLITE_\w+|ERR_[A-Z_]+|undefined|NaN)\b/.test(t)) return false;
  if (/^(Failed to fetch|NetworkError|Load failed|HTTP \d{3}|Error:)/i.test(t)) return false;
  if (/\[object \w+\]/.test(t)) return false;
  return true;
}

/** The sentence to show for an API failure: the server's own when it is plain, otherwise the catalogue's. */
export function plainMessage(status: number, code: string | undefined, message: unknown): string {
  if (isPlain(message)) return message;
  return (code && FALLBACK_BY_CODE[code]) || fallbackForStatus(status);
}

/** What the page-level error screens say. Never the thrown error's own text: in production Next.js replaces it with a digest anyway. */
export const PAGE_ERROR = {
  title: "Something went wrong",
  message: "This page stopped working. Try again. If it keeps happening, reload the page or check the activity log under Storage.",
};

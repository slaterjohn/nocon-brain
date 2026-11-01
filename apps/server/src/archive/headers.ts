/** The origin allowed to frame archive responses, or `'none'` when the URL is unusable. */
export function originOf(url: string | undefined): string {
  try {
    return url ? new URL(url).origin : "'none'";
  } catch {
    return "'none'";
  }
}

export interface HeaderOptions {
  /** App origin for `frame-ancestors`. */
  appOrigin: string;
  /** Only the interstitial sets this: lets "Open live" leave the sandbox. */
  popups?: boolean;
  extra?: Record<string, string>;
}

/**
 * The header set every listener response carries (docs/architecture.md "Archive response headers"). No `script-src` is
 * needed: `default-src 'none'` blocks scripts and `sandbox` has no `allow-scripts`. No cookie header is ever produced here.
 */
export function archiveHeaders(opts: HeaderOptions | string, extra: Record<string, string> = {}): Record<string, string> {
  const o: HeaderOptions = typeof opts === "string" ? { appOrigin: originOf(opts), extra } : opts;
  const sandbox = o.popups ? "sandbox allow-popups allow-popups-to-escape-sandbox" : "sandbox";
  return {
    "content-security-policy":
      `${sandbox}; default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; media-src 'self'; ` +
      `frame-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors ${o.appOrigin}`,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "private, no-store",
    ...(o.extra ?? {}),
  };
}

import normalizeUrl from "normalize-url";

type Writable<T> = { -readonly [K in keyof T]: T[K] };

export type QueryPolicy = "keep_all" | "strip_tracking" | "allowlist" | "drop_all";

export interface NormaliseOptions {
  /** Resolves relative input. */
  base?: string | URL;
  /** Default `keep_all`. Hyphenated spellings (`strip-tracking`) are accepted. */
  queryPolicy?: QueryPolicy | "keep-all" | "strip-tracking" | "drop-all";
  /** Parameters kept by the `allowlist` policy (exact, case-sensitive). */
  allowParams?: readonly string[];
}

export interface NormalisedUrl {
  /** What to request: WHATWG-serialised, fragment removed, nothing else changed. */
  fetchUrl: string;
  /** Dedup key (`url_key`). Never fetch this. */
  key: string;
  origin: string;
  /** Lower-case, punycode host (no trailing dot). */
  host: string;
  /** Input carried `user:pass@`. The key omits them; the SSRF guard refuses them. */
  hasCredentials: boolean;
}

export class InvalidUrlError extends Error {
  readonly code = "invalid_url";
  constructor(message: string, readonly input: string) {
    super(message);
    this.name = "InvalidUrlError";
  }
}

/** Parameters removed by the `strip_tracking` policy. */
export const TRACKING_PARAMS: readonly (RegExp | string)[] = [
  /^utm_/i, /^mc_/i, /^fbclid$/i, /^gclid$/i, /^dclid$/i, /^gbraid$/i, /^wbraid$/i, /^msclkid$/i, /^yclid$/i, /^twclid$/i,
  /^_ga$/i, /^_gl$/i, /^_gac/i, /^igshid$/i, /^ref_$/i, /^mkt_tok$/i, /^_hsenc$/i, /^_hsmi$/i, /^vero_id$/i,
  /^phpsessid$/i, /^jsessionid$/i, /^sessionid$/i, /^sid$/i,
];

function policyOf(p: NormaliseOptions["queryPolicy"]): QueryPolicy {
  const v = (p ?? "keep_all").replace(/-/g, "_");
  if (v === "keep_all" || v === "strip_tracking" || v === "allowlist" || v === "drop_all") return v;
  throw new InvalidUrlError(`unknown query policy ${p}`, "");
}

export function normaliseUrl(input: string | URL, opts: NormaliseOptions = {}): NormalisedUrl {
  const raw = String(input).trim();
  let u: URL;
  try {
    u = new URL(raw, opts.base);
  } catch {
    throw new InvalidUrlError(`not a valid URL: ${raw.slice(0, 200)}`, raw);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new InvalidUrlError(`unsupported scheme ${u.protocol}`, raw);
  if (!u.hostname) throw new InvalidUrlError("URL has no host", raw);
  const policy = policyOf(opts.queryPolicy);
  const hasCredentials = u.username !== "" || u.password !== "";
  u.hash = "";
  const fetchUrl = u.href;

  const k = new URL(fetchUrl);
  k.username = "";
  k.password = "";
  if (k.hostname.endsWith(".")) k.hostname = k.hostname.replace(/\.+$/, "");
  if (policy === "strip_tracking") k.pathname = k.pathname.replace(/;jsessionid=[^/;?]*/gi, "");

  const nOpts: Writable<NonNullable<Parameters<typeof normalizeUrl>[1]>> = {
    stripHash: true,
    stripWWW: false,
    removeTrailingSlash: false,
    sortQueryParameters: true,
    stripAuthentication: true,
  };
  if (policy === "strip_tracking") nOpts.removeQueryParameters = [...TRACKING_PARAMS];
  else if (policy === "drop_all") nOpts.removeQueryParameters = true;
  else if (policy === "allowlist") nOpts.keepQueryParameters = [...(opts.allowParams ?? [])].map((p) => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  else nOpts.removeQueryParameters = false;

  let key: string;
  try {
    key = normalizeUrl(k.href, nOpts);
  } catch {
    throw new InvalidUrlError(`cannot normalise: ${raw.slice(0, 200)}`, raw);
  }
  return { fetchUrl, key, origin: u.origin, host: k.hostname, hasCredentials };
}

export function urlKey(input: string | URL, opts: NormaliseOptions = {}): string {
  return normaliseUrl(input, opts).key;
}

export function tryNormaliseUrl(input: string | URL, opts: NormaliseOptions = {}): NormalisedUrl | null {
  try {
    return normaliseUrl(input, opts);
  } catch {
    return null;
  }
}

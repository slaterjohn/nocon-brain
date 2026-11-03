import { AppError } from "@ncb/shared";
import { parseRetryAfter } from "@ncb/fetch";
import { attributionFromImageInfo, revisionFromEtag, parsoidMeta, type ImageAttribution } from "./html.js";
import { articleUrl, encodeTitle, historyUrl, normaliseTitle, originFor, type WikiTarget, type WikiUrlOptions } from "./url.js";

/**
 * The only door to Wikipedia and Wikimedia (task Z-07). Everything that talks to them goes through one `WikipediaClient`, which keeps the
 * rules of https://www.mediawiki.org/wiki/API:Etiquette and the Wikimedia User-Agent policy in one place:
 *
 *  - It will not make a request without a contact in the User-Agent (`NCB_CONTACT`).
 *  - One request in flight, and at most one request starts per `minIntervalMs` (1 second): a token bucket with no burst, so no window of
 *    one second ever holds more than one request, redirects and retries included.
 *  - `Retry-After` is honoured on 429 and 503 (without it, at least 5 seconds, then doubling). A wait too long to sit through is handed
 *    back as a `rate_limited` error carrying the delay, so the job queue waits instead of this client.
 *  - Action API calls carry `maxlag=5`; a `maxlag` answer is waited out like a 503.
 *  - A circuit breaker pauses everything for five minutes after repeated 429, 403 or 503 answers.
 *  - Only Wikimedia hosts are ever contacted (or the configured replacement origin); redirects off those hosts are refused.
 */

export const CC_BY_SA = { name: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/" } as const;
const REPO = "https://github.com/slaterjohn/nocon-brain";
const HOST_OK = /(^|\.)(wikipedia|wikimedia|wikidata|mediawiki)\.org$/i;

export type WikipediaReason = "no_contact" | "circuit_open" | "rate_limited" | "forbidden" | "maxlag" | "network" | "blocked_host" | "too_large" | "bad_response";

export class WikipediaError extends AppError {
  constructor(readonly reason: WikipediaReason, message: string, readonly retryAfterMs?: number, code: ConstructorParameters<typeof AppError>[0] = "unavailable") {
    super(code, message, { reason, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
    this.name = "WikipediaError";
  }
}

/** A contact is a web address or an email address, one line, no control characters. */
export function validContact(c: string | undefined): c is string {
  if (!c) return false;
  const t = c.trim();
  if (t.length < 5 || t.length > 200 || /[\u0000-\u001f\u007f()<>;]/.test(t)) return false;
  return /^https?:\/\/[^\s/]+\.?[^\s]*$/i.test(t) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
}

export function wikipediaUserAgent(version: string, contact: string): string {
  const c = contact.trim();
  return `NoConBrain/${version} (${c}${c === REPO ? "" : `; ${REPO}`})`;
}

export interface WikipediaClientOptions extends WikiUrlOptions {
  contact?: string;
  version?: string;
  /** Smallest gap between the starts of two requests. Default 1000. */
  minIntervalMs?: number;
  /** Tries per request, the first included. Default 4. */
  maxAttempts?: number;
  /** Wait after a 429 or 503 that names no delay. Doubles per try. Default 5000. */
  minBackoffMs?: number;
  /** A wait longer than this is not slept through; the error carries it instead. Default 120000. */
  maxInlineWaitMs?: number;
  timeoutMs?: number;
  breaker?: { failures: number; openMs: number };
  /** Called before every request; throws when the server must not use the network (work offline). */
  gate?: () => void;
  /** The result of the network call, for passive connectivity. */
  onNetwork?: (ok: boolean) => void;
  /** Counted once per request that left the machine. */
  onRequest?: (info: { url: string; status: number; bytes: number }) => void;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface WikiResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  /** The address that answered, after redirects. */
  url: string;
  redirects: string[];
}

export interface GetOptions {
  headers?: Record<string, string>;
  maxBytes?: number;
  signal?: AbortSignal;
}

export type PageResult =
  | {
      kind: "ok";
      target: WikiTarget;
      requestedTitle: string;
      /** The title the page really has, when the request was a redirect. */
      redirectedFrom?: string;
      body: Buffer;
      etag?: string;
      lastModified?: string;
      revisionId?: string;
      contentLanguage?: string;
      licence: { name: string; url: string };
      articleUrl: string;
      historyUrl: string;
      bytes: number;
    }
  | { kind: "not_modified"; target: WikiTarget; etag?: string }
  | { kind: "missing"; target: WikiTarget };

export interface TitleInfo {
  title: string;
  exists: boolean;
  disambiguation: boolean;
  redirectTo?: string;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal!.reason ?? new Error("aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export class WikipediaClient {
  private tail: Promise<void> = Promise.resolve();
  private nextStart = 0;
  private pausedUntil = 0;
  private consecutive = 0;
  private openUntil = 0;
  private halfOpen = false;
  private readonly stats = { requests: 0, retries: 0, rateLimited: 0, maxlag: 0, bytes: 0, lastStatus: 0, lastRetryAfterMs: 0 };
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private contact: string | undefined;

  constructor(private readonly o: WikipediaClientOptions = {}) {
    this.fetchImpl = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? defaultSleep;
    this.contact = o.contact?.trim() || undefined;
  }

  // ---- identity and state ---------------------------------------------------------------------------------------------------------

  get hasContact(): boolean {
    return validContact(this.contact);
  }

  get urlOptions(): WikiUrlOptions {
    return { origin: this.o.origin, defaultLang: this.o.defaultLang };
  }

  get userAgent(): string {
    this.assertReady();
    return wikipediaUserAgent(this.o.version ?? "dev", this.contact!);
  }

  get minIntervalMs(): number {
    return this.o.minIntervalMs ?? 1000;
  }

  /** Throws unless a usable contact is set. Nothing is requested, and nothing queued, before this passes. */
  assertReady(): void {
    if (!this.contact) {
      throw new WikipediaError(
        "no_contact", "Wikipedia asks everyone who uses its servers to say who they are. Set NCB_CONTACT to a web address or an email address for the person who runs this server, then restart NoConBrain.",
        undefined, "bad_request",
      );
    }
    if (!validContact(this.contact)) {
      throw new WikipediaError(
        "no_contact", "NCB_CONTACT does not look like a web address (https://...) or an email address. Wikipedia needs one of those in the User-Agent. Correct it and restart NoConBrain.",
        undefined, "bad_request",
      );
    }
  }

  state(): {
    contactConfigured: boolean; breaker: { state: "closed" | "open" | "half_open"; reopensAt?: string }; minIntervalMs: number;
    requests: number; retries: number; rateLimited: number; bytes: number; lastStatus: number;
  } {
    const open = this.now() < this.openUntil;
    return {
      contactConfigured: this.hasContact,
      breaker: open ? { state: "open", reopensAt: new Date(this.openUntil).toISOString() } : this.halfOpen ? { state: "half_open" } : { state: "closed" },
      minIntervalMs: this.minIntervalMs, requests: this.stats.requests, retries: this.stats.retries, rateLimited: this.stats.rateLimited, bytes: this.stats.bytes,
      lastStatus: this.stats.lastStatus,
    };
  }

  /** Closes the breaker and forgets backoff (the Human pressed "try again"). */
  reset(): void {
    this.consecutive = 0;
    this.openUntil = 0;
    this.halfOpen = false;
    this.pausedUntil = 0;
  }

  // ---- the request loop -----------------------------------------------------------------------------------------------------------

  private allowedHost(u: URL): boolean {
    if (this.o.origin) {
      try { if (u.origin === new URL(this.o.origin).origin) return true; } catch { /* fall through */ }
    }
    return u.protocol === "https:" && HOST_OK.test(u.hostname);
  }

  private breakerCheck(): void {
    const t = this.now();
    if (t < this.openUntil) {
      throw new WikipediaError("circuit_open", `Wikipedia asked NoConBrain to slow down several times, so requests are paused until ${new Date(this.openUntil).toISOString().slice(11, 16)} UTC.`, this.openUntil - t);
    }
    if (this.openUntil > 0) this.halfOpen = true; // the pause is over: one request decides whether to carry on
  }

  private noteFailure(): void {
    this.consecutive++;
    const { failures, openMs } = this.o.breaker ?? { failures: 5, openMs: 300_000 };
    if (this.halfOpen || this.consecutive >= failures) {
      this.openUntil = this.now() + openMs;
      this.halfOpen = false;
    }
  }

  private noteSuccess(): void {
    this.consecutive = 0;
    this.openUntil = 0;
    this.halfOpen = false;
  }

  /** One request at a time, in the order asked. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => { release = r; });
    return prev.then(fn).finally(release);
  }

  private async waitTurn(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const t = this.now();
      const at = Math.max(this.nextStart, this.pausedUntil);
      if (at <= t) break;
      await this.sleep(at - t, signal);
    }
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    // A few milliseconds more than the interval, so that a server measuring arrival times (which jitter) never sees two requests inside one interval.
    this.nextStart = this.now() + this.minIntervalMs + Math.ceil(Math.min(25, this.minIntervalMs * 0.05));
  }

  private async readBody(res: Response, max: number): Promise<Buffer> {
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > max) throw new WikipediaError("too_large", "Wikipedia sent more data than NoConBrain allows for one file.");
    if (!res.body) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let n = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > max) { void reader.cancel().catch(() => undefined); throw new WikipediaError("too_large", "Wikipedia sent more data than NoConBrain allows for one file."); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  /** A GET with the whole etiquette applied. Redirects are followed one hop per slot, within Wikimedia hosts only. */
  async get(url: string, o: GetOptions = {}): Promise<WikiResponse> {
    this.assertReady();
    const first = (() => { try { return new URL(url); } catch { throw new WikipediaError("blocked_host", "That is not a Wikipedia address.", undefined, "bad_request"); } })();
    if (!this.allowedHost(first)) throw new WikipediaError("blocked_host", "NoConBrain only contacts Wikipedia and Wikimedia servers from the Wikipedia features.", undefined, "blocked");
    return this.serial(async () => {
      const maxAttempts = this.o.maxAttempts ?? 4;
      const baseBackoff = this.o.minBackoffMs ?? 5000;
      const maxWait = this.o.maxInlineWaitMs ?? 120_000;
      const redirects: string[] = [];
      let current = first;
      let attempt = 0;
      for (;;) {
        this.breakerCheck();
        await this.waitTurn(o.signal);
        this.o.gate?.();
        const timeout = AbortSignal.timeout(this.o.timeoutMs ?? 20_000);
        const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
        let res: Response;
        try {
          res = await this.fetchImpl(current.href, {
            method: "GET", redirect: "manual", signal,
            headers: { "user-agent": this.userAgent, accept: "*/*", "accept-encoding": "gzip", ...(o.headers ?? {}) },
          });
        } catch (e) {
          if (o.signal?.aborted) throw e;
          this.o.onNetwork?.(false);
          attempt++;
          this.stats.retries++;
          if (attempt >= maxAttempts) throw new WikipediaError("network", "Wikipedia could not be reached. Check the connection and try again.");
          this.pausedUntil = this.now() + Math.min(maxWait, baseBackoff * 2 ** (attempt - 1));
          continue;
        }
        this.o.onNetwork?.(true);
        this.stats.requests++;
        this.stats.lastStatus = res.status;
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

        if (res.status >= 300 && res.status < 400 && res.status !== 304 && headers.location) {
          void res.body?.cancel().catch(() => undefined);
          this.o.onRequest?.({ url: current.href, status: res.status, bytes: 0 });
          let next: URL;
          try { next = new URL(headers.location, current); } catch { throw new WikipediaError("bad_response", "Wikipedia sent a redirect that could not be read."); }
          if (!this.allowedHost(next)) throw new WikipediaError("blocked_host", "Wikipedia sent the request to a server outside Wikimedia, so it was not followed.", undefined, "blocked");
          if (redirects.length >= 5) throw new WikipediaError("bad_response", "Wikipedia redirected the request too many times.");
          redirects.push(next.href);
          current = next;
          continue;
        }

        if (res.status === 429 || res.status === 503 || res.status === 403) {
          void res.body?.cancel().catch(() => undefined);
          this.o.onRequest?.({ url: current.href, status: res.status, bytes: 0 });
          this.noteFailure();
          if (res.status === 403) {
            throw new WikipediaError("forbidden", "Wikipedia refused the request (403). It may not accept the contact in NCB_CONTACT, or the address is blocked. Check NCB_CONTACT and try again later.", undefined, "provider_error");
          }
          this.stats.rateLimited++;
          const named = parseRetryAfter(headers["retry-after"], this.now());
          this.stats.lastRetryAfterMs = named ?? 0;
          attempt++;
          const wait = named ?? baseBackoff * 2 ** (attempt - 1);
          if (attempt >= maxAttempts || wait > maxWait) {
            throw new WikipediaError("rate_limited", "Wikipedia is asking NoConBrain to slow down. The work will carry on later.", Math.max(wait, 1000), "rate_limited");
          }
          this.stats.retries++;
          this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
          continue;
        }

        if (res.status >= 500) {
          void res.body?.cancel().catch(() => undefined);
          this.o.onRequest?.({ url: current.href, status: res.status, bytes: 0 });
          attempt++;
          if (attempt >= maxAttempts) return { status: res.status, headers, body: Buffer.alloc(0), url: current.href, redirects };
          this.stats.retries++;
          this.pausedUntil = Math.max(this.pausedUntil, this.now() + Math.min(maxWait, baseBackoff * 2 ** (attempt - 1)));
          continue;
        }

        const body = res.status === 304 ? Buffer.alloc(0) : await this.readBody(res, o.maxBytes ?? 32 * 1024 * 1024);
        this.stats.bytes += body.length;
        this.o.onRequest?.({ url: current.href, status: res.status, bytes: body.length });
        this.noteSuccess();
        return { status: res.status, headers, body, url: current.href, redirects };
      }
    });
  }

  // ---- core REST: pages ----------------------------------------------------------------------------------------------------------

  /**
   * `GET /w/rest.php/v1/page/{title}/html`: Parsoid HTML. `etag` makes the request conditional (a 304 costs almost nothing). The licence is
   * CC BY-SA 4.0, as Wikimedia's Terms of Use fix it for all text; the revision id comes from the response's `X-Revision-Id` or `ETag`, or
   * failing those from the document itself.
   */
  async pageHtml(lang: string, title: string, o: { etag?: string; signal?: AbortSignal; maxBytes?: number } = {}): Promise<PageResult> {
    const t = normaliseTitle(title);
    const target: WikiTarget = { lang: lang.toLowerCase(), title: t };
    const url = `${originFor(lang, this.urlOptions)}/w/rest.php/v1/page/${encodeURIComponent(t)}/html`;
    const res = await this.get(url, { headers: { accept: "text/html", ...(o.etag ? { "if-none-match": o.etag } : {}) }, signal: o.signal, maxBytes: o.maxBytes });
    if (res.status === 304) return { kind: "not_modified", target, etag: res.headers.etag ?? o.etag };
    if (res.status === 404) return { kind: "missing", target };
    if (res.status !== 200) throw new WikipediaError("bad_response", `Wikipedia answered ${res.status} for “${t.replace(/_/g, " ")}”.`);
    let finalTitle = t;
    const m = /\/w\/rest\.php\/v1\/page\/([^/]+)\/html$/.exec(new URL(res.url).pathname);
    if (m) { try { finalTitle = normaliseTitle(decodeURIComponent(m[1]!)); } catch { /* keep */ } }
    const final: WikiTarget = { lang: target.lang, title: finalTitle };
    const head = res.body.subarray(0, 8000).toString("utf8");
    const revisionId = res.headers["x-revision-id"] ?? revisionFromEtag(res.headers.etag) ?? parsoidMeta(head).revisionId;
    return {
      kind: "ok", target: final, requestedTitle: t, ...(finalTitle !== t ? { redirectedFrom: t } : {}), body: res.body,
      ...(res.headers.etag ? { etag: res.headers.etag } : {}), ...(res.headers["last-modified"] ? { lastModified: res.headers["last-modified"] } : {}),
      ...(revisionId ? { revisionId } : {}), ...(res.headers["content-language"] ? { contentLanguage: res.headers["content-language"] } : {}),
      licence: { ...CC_BY_SA }, articleUrl: articleUrl(final, this.urlOptions), historyUrl: historyUrl(final, this.urlOptions), bytes: res.body.length,
    };
  }

  /** A file from a Wikimedia host (an image, a stylesheet): the same limiter, the same User-Agent. */
  media(url: string, o: GetOptions = {}): Promise<WikiResponse> {
    return this.get(url, o);
  }

  // ---- Action API ----------------------------------------------------------------------------------------------------------------

  /** An Action API query with `maxlag=5`. A `maxlag` answer is waited out, as the etiquette asks for background jobs. */
  async api<T = any>(lang: string, params: Record<string, string>, o: { signal?: AbortSignal } = {}): Promise<T> {
    const q = new URLSearchParams({ format: "json", formatversion: "2", maxlag: "5", ...params });
    const url = `${originFor(lang, this.urlOptions)}/w/api.php?${q.toString()}`;
    const maxAttempts = this.o.maxAttempts ?? 4;
    for (let attempt = 1; ; attempt++) {
      const res = await this.get(url, { headers: { accept: "application/json" }, signal: o.signal, maxBytes: 8 * 1024 * 1024 });
      if (res.status !== 200) throw new WikipediaError("bad_response", `Wikipedia answered ${res.status} to a question about pages.`);
      let json: any;
      try { json = JSON.parse(res.body.toString("utf8")); } catch { throw new WikipediaError("bad_response", "Wikipedia sent an answer that could not be read."); }
      if (json?.error?.code === "maxlag") {
        this.stats.maxlag++;
        const named = parseRetryAfter(res.headers["retry-after"], this.now());
        const wait = named ?? 5000;
        if (attempt >= maxAttempts || wait > (this.o.maxInlineWaitMs ?? 120_000)) {
          throw new WikipediaError("maxlag", "Wikipedia's databases are busy, so the request was put off. The work will carry on later.", wait, "rate_limited");
        }
        this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
        continue;
      }
      if (json?.error) throw new WikipediaError("bad_response", `Wikipedia could not answer: ${String(json.error.info ?? json.error.code).slice(0, 200)}`);
      return json as T;
    }
  }

  /** Existence, redirect and disambiguation facts for up to 50 titles per request (`prop=info|pageprops`). */
  async titleInfo(lang: string, titles: string[], o: { signal?: AbortSignal } = {}): Promise<Map<string, TitleInfo>> {
    const out = new Map<string, TitleInfo>();
    for (let i = 0; i < titles.length; i += 50) {
      const batch = titles.slice(i, i + 50);
      const json = await this.api<{ query?: { pages?: { title: string; missing?: boolean | string; pageprops?: Record<string, unknown> }[]; redirects?: { from: string; to: string }[] } }>(
        lang, { action: "query", prop: "info|pageprops", ppprop: "disambiguation", redirects: "1", titles: batch.join("|") }, o);
      const redirects = new Map((json.query?.redirects ?? []).map((r) => [normaliseTitle(r.from), normaliseTitle(r.to)]));
      const byTitle = new Map((json.query?.pages ?? []).map((p) => [normaliseTitle(p.title), p]));
      for (const t of batch) {
        const key = normaliseTitle(t);
        const to = redirects.get(key);
        const page = byTitle.get(to ?? key);
        out.set(key, { title: to ?? key, exists: !!page && !("missing" in page), disambiguation: !!page?.pageprops && "disambiguation" in page.pageprops, ...(to ? { redirectTo: to } : {}) });
      }
    }
    return out;
  }

  /** Author, licence and file-page address for each `File:` title (`prop=imageinfo`, `extmetadata`), 50 per request. */
  async imageInfo(lang: string, files: string[], o: { signal?: AbortSignal } = {}): Promise<Map<string, ImageAttribution & { url?: string }>> {
    const out = new Map<string, ImageAttribution & { url?: string }>();
    const origin = originFor(lang, this.urlOptions);
    for (let i = 0; i < files.length; i += 50) {
      const batch = files.slice(i, i + 50);
      const json = await this.api<{ query?: { pages?: { title: string; missing?: boolean; imageinfo?: { url?: string; descriptionurl?: string; extmetadata?: Record<string, { value?: unknown }> }[] }[] } }>(
        lang, { action: "query", prop: "imageinfo", iiprop: "url|extmetadata", iiextmetadatafilter: "Artist|Credit|LicenseShortName|LicenseUrl|UsageTerms|NonFree|ImageDescription|AttributionRequired|Copyrighted|DateTimeOriginal", titles: batch.join("|") }, o);
      for (const p of json.query?.pages ?? []) {
        const info = p.imageinfo?.[0];
        // A file that lives on Commons is `missing: true` on the wiki itself yet carries its imageinfo (imagerepository "shared"), so only the info counts.
        if (!info) continue;
        out.set(p.title.replace(/ /g, "_"), { ...attributionFromImageInfo(info, origin), ...(info.url ? { url: info.url } : {}) });
      }
    }
    return out;
  }
}

export { encodeTitle };

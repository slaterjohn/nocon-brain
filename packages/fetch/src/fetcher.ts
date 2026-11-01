import { Agent, request } from "undici";
import { Readable, PassThrough, type Transform } from "node:stream";
import { FetchError, type RedirectHop } from "./errors";
import { createSsrfGuard, isSsrfError, allowlistFromEnv, type SsrfGuard } from "./ssrf";
import {
  ByteCounter, DEFAULT_ALLOWED_TYPES, decoderStages, detectCharset, isValidUtf8, parseContentEncoding, parseContentType,
  sniffType, typeAllowed, type CharsetSource,
} from "./content";

export interface Timeouts {
  /** TCP connect. Default 10 s. */
  connectMs: number;
  /** Until response headers. Default 15 s. */
  headersMs: number;
  /** Idle time between body chunks. Default 30 s. */
  bodyMs: number;
  /** Wall clock for the whole fetch including redirects and body. Default 60 s. */
  totalMs: number;
}

export interface HopInfo {
  url: string;
  host: string;
  hop: number;
  method: string;
}
export interface HopResult extends HopInfo {
  status: number;
  retryAfterMs?: number;
  headersMs: number;
}
export interface FetchHooks {
  /** Called before every request, including each redirect hop. Throw to abort (robots, politeness). */
  beforeHop?(info: HopInfo): void | Promise<void>;
  /** Called after each response's headers arrive. */
  afterHop?(info: HopResult): void;
}

export interface FetcherOptions {
  userAgent?: string;
  /** Forced-offline hook. When it returns true no request is made. */
  isOffline?: () => boolean;
  ssrf?: SsrfGuard;
  allowedTypes?: readonly string[];
  /** Default cap on decoded bytes. Default 5 MiB. */
  maxBytes?: number;
  maxRedirects?: number;
  /** Maximum nested Content-Encoding layers. Default 3. */
  maxEncodingLayers?: number;
  timeouts?: Partial<Timeouts>;
  hooks?: FetchHooks;
}

export interface FetchRequestOptions {
  method?: "GET" | "HEAD";
  conditional?: { etag?: string | null; lastModified?: string | null };
  maxBytes?: number;
  /** Allowed content types for this request (also sent as `Accept`). Supports `type/*` and `*\/*`. */
  accept?: readonly string[];
  signal?: AbortSignal;
  bodyMode?: "buffer" | "stream";
  /** Return the first `maxBytes` bytes with `truncated: true` instead of failing with `size_cap`. */
  truncateAtCap?: boolean;
  timeouts?: Partial<Timeouts>;
  hooks?: FetchHooks;
}

export interface FetchTimings {
  startedAt: number;
  /** Request start to the final response's headers. */
  ttfbMs: number;
  totalMs: number;
  hops: { url: string; status: number; headersMs: number }[];
}

export interface FetchResult {
  status: number;
  finalUrl: string;
  redirects: RedirectHop[];
  /** Lower-case names. `set-cookie` is removed. `content-encoding` shows what was undone. */
  headers: Record<string, string>;
  body: Buffer | Readable;
  /** Effective type after sniffing. */
  contentType: string | null;
  declaredContentType: string | null;
  sniffedType: string | null;
  charset: string | null;
  charsetSource: CharsetSource | null;
  notModified: boolean;
  retryAfterMs?: number;
  truncated: boolean;
  bytes: { wire: number; decoded: number };
  timings: FetchTimings;
}

export interface Fetcher {
  fetch(url: string | URL, opts?: FetchRequestOptions): Promise<FetchResult>;
  close(): Promise<void>;
}

export function buildUserAgent(o: { version?: string; repo?: string; contact?: string } = {}): string {
  const repo = o.repo ?? "https://github.com/slaterjohn/nocon-brain";
  return `NoConBrain/${o.version ?? "0.1.0"} (+${repo}${o.contact ? `; ${o.contact}` : ""})`;
}

export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.max(0, t - now);
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);
const TEXTISH = (t: string | null) => !!t && (t.startsWith("text/") || t.endsWith("+xml") || t.endsWith("/xml") || t === "application/json" || t.endsWith("+json") || t === "image/svg+xml");

function flattenHeaders(h: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();
    if (v === undefined || key === "set-cookie" || key === "set-cookie2") continue;
    out[key] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

export function createFetcher(options: FetcherOptions = {}): Fetcher {
  const guard = options.ssrf ?? createSsrfGuard({ allow: allowlistFromEnv() });
  const ua = options.userAgent ?? buildUserAgent();
  const baseTimeouts: Timeouts = { connectMs: 10_000, headersMs: 15_000, bodyMs: 30_000, totalMs: 60_000, ...options.timeouts };
  const allowedTypes = options.allowedTypes ?? DEFAULT_ALLOWED_TYPES;
  const maxRedirects = options.maxRedirects ?? 5;
  const maxLayers = options.maxEncodingLayers ?? 3;
  const defaultMax = options.maxBytes ?? 5 * 1024 * 1024;

  const agent = new Agent({
    connect: { timeout: baseTimeouts.connectMs, lookup: guard.lookup as never },
    headersTimeout: baseTimeouts.headersMs,
    bodyTimeout: baseTimeouts.bodyMs,
    keepAliveTimeout: 4000,
  });

  async function fetchImpl(input: string | URL, opts: FetchRequestOptions): Promise<FetchResult> {
    const started = Date.now();
    const t0 = performance.now();
    const method = opts.method ?? "GET";
    const timeouts: Timeouts = { ...baseTimeouts, ...opts.timeouts };
    const maxBytes = opts.maxBytes ?? defaultMax;
    const hooks = [options.hooks, opts.hooks];
    const redirects: RedirectHop[] = [];
    const hops: FetchTimings["hops"] = [];
    const patterns = opts.accept ?? allowedTypes;

    const ac = new AbortController();
    let deadlineHit = false;
    const timer = setTimeout(() => {
      deadlineHit = true;
      ac.abort();
    }, timeouts.totalMs);
    const onUser = () => ac.abort();
    if (opts.signal) {
      if (opts.signal.aborted) ac.abort();
      else opts.signal.addEventListener("abort", onUser, { once: true });
    }
    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onUser);
    };

    const fail = (err: unknown, url?: string): FetchError => {
      if (err instanceof FetchError) {
        err.url ??= url;
        if (!err.redirects.length) err.redirects = redirects;
        return err;
      }
      const ssrf = isSsrfError(err);
      const code = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
      let fe: FetchError;
      if (ssrf) fe = new FetchError("ssrf_blocked", ssrf.message, { ssrfReason: ssrf.reason });
      else if (code === "UND_ERR_CONNECT_TIMEOUT") fe = new FetchError("timeout_connect", "connect timeout");
      else if (code === "UND_ERR_HEADERS_TIMEOUT") fe = new FetchError("timeout_headers", "timed out waiting for response headers");
      else if (code === "UND_ERR_BODY_TIMEOUT") fe = new FetchError("timeout_body", "timed out reading the response body");
      else if ((err as Error)?.name === "AbortError" || code === "UND_ERR_ABORTED" || ac.signal.aborted) {
        fe = deadlineHit ? new FetchError("timeout_total", `exceeded ${timeouts.totalMs} ms`) : new FetchError("aborted", "aborted by caller");
      } else fe = new FetchError("network", (err as Error)?.message ?? String(err), { cause: err as never });
      fe.url = url;
      fe.redirects = redirects;
      return fe;
    };

    let current: URL | null = null;
    try {
      if (options.isOffline?.()) throw new FetchError("offline", "forced offline: no network request made");
      try {
        current = guard.checkUrl(input);
      } catch (e) {
        throw isSsrfError(e) ? (e as never) : e;
      }
      const seen = new Set<string>([current.href]);
      const hostHeaders: Record<string, string> = {
        "user-agent": ua,
        accept: opts.accept ? [...opts.accept, "*/*;q=0.1"].join(", ") : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-encoding": "gzip, deflate, br",
      };
      if (opts.conditional?.etag) hostHeaders["if-none-match"] = opts.conditional.etag;
      if (opts.conditional?.lastModified) hostHeaders["if-modified-since"] = opts.conditional.lastModified;

      for (let hop = 0; ; hop++) {
        if (options.isOffline?.()) throw new FetchError("offline", "forced offline: no network request made");
        const info: HopInfo = { url: current.href, host: current.host, hop, method };
        for (const h of hooks) await h?.beforeHop?.(info);
        const h0 = performance.now();
        const res = await request(current.href, {
          method,
          headers: hostHeaders,
          dispatcher: agent,
          signal: ac.signal,
          headersTimeout: timeouts.headersMs,
          bodyTimeout: timeouts.bodyMs,
        });
        const headersMs = Math.round(performance.now() - h0);
        const headers = flattenHeaders(res.headers);
        const status = res.statusCode;
        const retryAfterMs = parseRetryAfter(headers["retry-after"]);
        hops.push({ url: current.href, status, headersMs });
        for (const h of hooks) h?.afterHop?.({ ...info, status, retryAfterMs, headersMs });
        const drain = () => res.body.dump({ limit: 64 * 1024 }).catch(() => undefined);

        if (REDIRECT.has(status)) {
          await drain();
          const loc = headers["location"];
          if (!loc) throw new FetchError("bad_redirect", `redirect ${status} without Location`, { url: current.href, status });
          if (hop >= maxRedirects) throw new FetchError("too_many_redirects", `more than ${maxRedirects} redirects`, { url: current.href });
          let next: URL;
          try {
            next = guard.checkRedirect(current, loc);
          } catch (e) {
            redirects.push({ url: current.href, status, location: loc });
            throw e;
          }
          redirects.push({ url: current.href, status, location: next.href });
          if (seen.has(next.href)) throw new FetchError("redirect_loop", `redirect loop at ${next.href}`, { url: next.href });
          seen.add(next.href);
          current = next;
          continue;
        }
        if (status === 429) {
          await drain();
          throw new FetchError("rate_limited", "429 Too Many Requests", { url: current.href, status, retryAfterMs });
        }

        const base = { status, finalUrl: current.href, redirects, headers, retryAfterMs, notModified: status === 304 };
        const timingsOf = (): FetchTimings => ({ startedAt: started, ttfbMs: headersMs, totalMs: Math.round(performance.now() - t0), hops });
        const declared = parseContentType(headers["content-type"]);
        if (method === "HEAD" || status === 204 || status === 304) {
          await drain();
          cleanup();
          return {
            ...base, body: opts.bodyMode === "stream" ? Readable.from([]) : Buffer.alloc(0), contentType: declared.type, declaredContentType: declared.type,
            sniffedType: null, charset: canonicalOrNull(declared.charset), charsetSource: declared.charset ? "header" : null, truncated: false,
            bytes: { wire: 0, decoded: 0 }, timings: timingsOf(),
          };
        }

        // ---- body pipeline
        const cl = headers["content-length"] ? Number(headers["content-length"]) : NaN;
        if (!opts.truncateAtCap && Number.isFinite(cl) && cl > maxBytes) {
          quiet(res.body);
          throw new FetchError("content_length_exceeded", `Content-Length ${cl} exceeds ${maxBytes}`, { url: current.href });
        }
        const encodings = parseContentEncoding(headers["content-encoding"]);
        let stages: Transform[];
        try {
          stages = decoderStages(encodings, maxLayers);
        } catch (e) {
          quiet(res.body);
          throw e;
        }
        const capErr = () => new FetchError("size_cap", `decoded body exceeds ${maxBytes} bytes`, { url: current!.href });
        const truncating = !!opts.truncateAtCap;
        const unlimited = Number.MAX_SAFE_INTEGER;
        const wire = new ByteCounter(truncating && stages.length ? unlimited : maxBytes, capErr, truncating && !stages.length);
        const chain: Transform[] = [wire];
        let last: ByteCounter = wire;
        for (const s of stages) {
          chain.push(s);
          const c = new ByteCounter(truncating ? unlimited : maxBytes, capErr);
          chain.push(c);
          last = c;
        }
        if (truncating && stages.length) {
          const fin = new ByteCounter(maxBytes, capErr, true);
          chain.push(fin);
          last = fin;
        }
        const out = new PassThrough();
        chain.push(out);
        const all: (Readable | Transform)[] = [res.body, ...chain];
        let settled = false;
        const killAll = (err?: Error) => {
          if (settled) return;
          settled = true;
          for (const s of all) s.destroy(err);
        };
        for (let i = 0; i < all.length - 1; i++) all[i]!.pipe(all[i + 1] as Transform);
        for (const s of all.slice(0, -1)) s.on("error", (e) => killAll(e));
        last.on("truncated", () => {
          // stop reading upstream; the already-written part still reaches `out`
          settled = true;
          for (const st of all) if (st !== last && st !== out) st.destroy();
        });
        out.on("error", () => undefined);
        out.on("close", () => {
          settled = true;
          cleanup();
        });
        // Errors raised by a stage are re-emitted on `out` via destroy(err) above.

        const it = out[Symbol.asyncIterator]();
        const head: Buffer[] = [];
        let headLen = 0;
        let ended = false;
        while (headLen < 1024) {
          const r = await it.next();
          if (r.done) {
            ended = true;
            break;
          }
          head.push(r.value as Buffer);
          headLen += (r.value as Buffer).length;
        }
        const headBuf = Buffer.concat(head);
        const sn = sniffType(headBuf, declared.type);
        const isOk = status >= 200 && status < 300;
        const emptyBody = ended && headBuf.length === 0;
        if (isOk && !emptyBody && !typeAllowed(sn.type, patterns)) {
          killAll();
          throw new FetchError("content_type_blocked", `content type ${sn.type ?? "unknown"} (declared ${declared.type ?? "none"}) is not allowed`, { url: current.href, status });
        }
        const isHtml = sn.type === "text/html" || sn.type === "application/xhtml+xml";
        const det = detectCharset(headBuf, declared.charset, isHtml);

        const finish = (buf: Buffer | null) => {
          let charset = det.charset;
          let source: CharsetSource | null = det.source;
          if (!charset && TEXTISH(sn.type)) {
            if (buf) {
              const ok = isValidUtf8(buf);
              charset = ok ? "utf-8" : "windows-1252";
              source = "sniff";
            } else {
              charset = "utf-8";
              source = "default";
            }
          }
          return { charset, source };
        };
        const common = { ...base, contentType: sn.type, declaredContentType: declared.type, sniffedType: sn.sniffed };

        if (opts.bodyMode === "stream") {
          const { charset, source } = finish(null);
          async function* gen() {
            try {
              if (headBuf.length) yield headBuf;
              if (!ended) for (;;) {
                const r = await it.next();
                if (r.done) break;
                yield r.value as Buffer;
              }
            } catch (e) {
              throw fail(e, current!.href);
            } finally {
              cleanup();
            }
          }
          const body = Readable.from(gen(), { objectMode: false });
          const result: FetchResult = {
            ...common, body, charset, charsetSource: source, truncated: false,
            bytes: { wire: 0, decoded: 0 }, timings: timingsOf(),
          };
          // byte counts are live: read them after the stream ends
          Object.defineProperty(result.bytes, "wire", { get: () => wire.count, enumerable: true });
          Object.defineProperty(result.bytes, "decoded", { get: () => last.count, enumerable: true });
          return result;
        }

        const parts: Buffer[] = [headBuf];
        if (!ended) for (;;) {
          const r = await it.next();
          if (r.done) break;
          parts.push(r.value as Buffer);
        }
        const buf = Buffer.concat(parts);
        const { charset, source } = finish(buf);
        cleanup();
        return {
          ...common, body: buf, charset, charsetSource: source, truncated: last.truncated,
          bytes: { wire: wire.count, decoded: last.count }, timings: timingsOf(),
        };
      }
    } catch (e) {
      cleanup();
      throw fail(e, current?.href ?? String(input));
    }
  }

  return {
    fetch: (url, opts = {}) => fetchImpl(url, opts),
    close: () => agent.close(),
  };
}

function canonicalOrNull(label: string | null): string | null {
  if (!label) return null;
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return null;
  }
}

function quiet(s: Readable): void {
  s.on("error", () => undefined);
  s.destroy();
}

import robotsParser from "robots-parser";
import { FetchError } from "./errors";
import type { Fetcher } from "./fetcher";

export type RobotsReason =
  | "allowed" | "disallowed_by_rule" | "robots_unavailable_allow" | "robots_unreachable_disallow" | "bypassed";

export interface RobotsDecision {
  allowed: boolean;
  reason: RobotsReason;
  /** True when `bypass` turned a block into an allow. The caller must log this. */
  bypassed: boolean;
  /** What the verdict would have been without the bypass (set only when `bypassed`). */
  wouldBlockReason?: "disallowed_by_rule" | "robots_unreachable_disallow";
  /** Crawl-delay for our token in ms, capped (default 30 s). `null` when absent. */
  crawlDelayMs: number | null;
  sitemaps: string[];
  robotsUrl: string;
  /** HTTP status of the robots.txt response (final URL after redirects), or null when unreachable. */
  robotsStatus: number | null;
  fromCache: boolean;
  /** A stale good copy was used because refetching failed. */
  stale: boolean;
  expiresAt: number;
}

export interface RobotsServiceOptions {
  fetcher: Pick<Fetcher, "fetch">;
  /** Product token matched against `User-agent:` lines. Default `NoConBrain`. */
  userAgentToken?: string;
  /** Default 24 h. */
  cacheTtlMs?: number;
  /** TTL for unreachable (5xx, timeout, network) results. Default 5 min. */
  unreachableTtlMs?: number;
  /** Parsing limit. Default 500 KiB. */
  maxBytes?: number;
  /** Cap on Crawl-delay. Default 30 s. */
  crawlDelayCapMs?: number;
  maxEntries?: number;
  now?: () => number;
}

interface Entry {
  kind: "rules" | "allow_all" | "disallow_all";
  parser?: ReturnType<typeof robotsParser>;
  status: number | null;
  expiresAt: number;
  fetchedAt: number;
  stale?: boolean;
}

export class RobotsService {
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<Entry>>();
  private readonly token: string;
  private readonly ttl: number;
  private readonly badTtl: number;
  private readonly maxBytes: number;
  private readonly delayCap: number;
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(private readonly opts: RobotsServiceOptions) {
    this.token = opts.userAgentToken ?? "NoConBrain";
    this.ttl = opts.cacheTtlMs ?? 24 * 3600_000;
    this.badTtl = opts.unreachableTtlMs ?? 5 * 60_000;
    this.maxBytes = opts.maxBytes ?? 500 * 1024;
    this.delayCap = opts.crawlDelayCapMs ?? 30_000;
    this.maxEntries = opts.maxEntries ?? 2000;
    this.now = opts.now ?? Date.now;
  }

  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Is `url` crawlable? `bypass: true` is for user-initiated single-page saves: the result is always
   * allowed, and `bypassed` tells the caller to log that robots was overridden.
   * Throws FetchError `offline` (nothing cached) when the fetcher is offline.
   */
  async check(url: string | URL, o: { bypass?: boolean } = {}): Promise<RobotsDecision> {
    const u = new URL(String(url));
    const robotsUrl = `${u.origin}/robots.txt`;
    const { entry, fromCache } = await this.entryFor(u.origin, robotsUrl);
    let reason: RobotsReason;
    let blocked: "disallowed_by_rule" | "robots_unreachable_disallow" | null = null;
    if (entry.kind === "disallow_all") {
      blocked = "robots_unreachable_disallow";
      reason = blocked;
    } else if (entry.kind === "allow_all" || u.pathname === "/robots.txt") {
      reason = entry.kind === "allow_all" ? "robots_unavailable_allow" : "allowed";
    } else if (entry.parser!.isAllowed(u.href, this.token) === false) {
      blocked = "disallowed_by_rule";
      reason = blocked;
    } else reason = "allowed";

    const delay = entry.parser?.getCrawlDelay(this.token);
    const crawlDelayMs = entry.kind === "rules" && typeof delay === "number" && delay > 0 ? Math.min(Math.round(delay * 1000), this.delayCap) : null;
    const bypassed = !!(o.bypass && blocked);
    return {
      allowed: bypassed || !blocked,
      reason: bypassed ? "bypassed" : reason,
      bypassed,
      ...(bypassed ? { wouldBlockReason: blocked! } : {}),
      crawlDelayMs,
      sitemaps: entry.kind === "rules" ? entry.parser!.getSitemaps() : [],
      robotsUrl,
      robotsStatus: entry.status,
      fromCache,
      stale: !!entry.stale,
      expiresAt: entry.expiresAt,
    };
  }

  private async entryFor(origin: string, robotsUrl: string): Promise<{ entry: Entry; fromCache: boolean }> {
    const cached = this.cache.get(origin);
    if (cached && cached.expiresAt > this.now()) return { entry: cached, fromCache: true };
    let p = this.inflight.get(origin);
    if (!p) {
      p = this.load(robotsUrl, cached).finally(() => this.inflight.delete(origin));
      this.inflight.set(origin, p);
    }
    const entry = await p;
    if (this.cache.size >= this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(origin, entry);
    return { entry, fromCache: false };
  }

  private async load(robotsUrl: string, previous?: Entry): Promise<Entry> {
    const now = this.now();
    const unreachable = (status: number | null): Entry => {
      // RFC 9309 2.4: a cached copy may be kept while the file is unreachable.
      if (previous && previous.kind === "rules") return { ...previous, stale: true, expiresAt: now + this.badTtl };
      return { kind: "disallow_all", status, expiresAt: now + this.badTtl, fetchedAt: now };
    };
    try {
      const r = await this.opts.fetcher.fetch(robotsUrl, {
        maxBytes: this.maxBytes,
        truncateAtCap: true,
        accept: ["text/plain", "*/*"],
      });
      const st = r.status;
      if (st >= 200 && st < 300) {
        const text = new TextDecoder(r.charset ?? "utf-8").decode(r.body as Buffer).replace(/^﻿/, "");
        return { kind: "rules", parser: robotsParser(robotsUrl, text), status: st, expiresAt: now + this.ttl, fetchedAt: now };
      }
      if (st === 304 || (st >= 300 && st < 400)) return { kind: "allow_all", status: st, expiresAt: now + this.ttl, fetchedAt: now };
      if (st >= 400 && st < 500 && st !== 429) return { kind: "allow_all", status: st, expiresAt: now + this.ttl, fetchedAt: now };
      return unreachable(st);
    } catch (e) {
      if (e instanceof FetchError) {
        if (e.code === "offline") throw e;
        if (e.code === "rate_limited") {
          const ttl = Math.min(Math.max(e.retryAfterMs ?? this.badTtl, 1000), this.ttl);
          const u = unreachable(429);
          u.expiresAt = now + ttl;
          return u;
        }
        // RFC 9309 2.3.1.2: more than five redirects MAY be treated as "unavailable".
        if (e.code === "too_many_redirects" || e.code === "redirect_loop") return { kind: "allow_all", status: null, expiresAt: now + this.badTtl, fetchedAt: now };
        if (e.code === "aborted") throw e;
        return unreachable(null);
      }
      throw e;
    }
  }
}

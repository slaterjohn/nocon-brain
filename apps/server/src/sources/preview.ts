import type { Readable } from "node:stream";
import { decodeHtml, discoverHtmlAssets, extractLinks } from "@ncb/content";
import { Scope, rankLinks, selectLinks, type CrawlConfig, type LinkCandidate } from "@ncb/crawl";
import type { RobotsService } from "@ncb/fetch";
import type { DiscoveryFetcher } from "./discovery/fetch.js";

/** Most requests one preview may make: the start page, robots.txt and a small sample of in-scope pages. */
export const PREVIEW_MAX_REQUESTS = 12;
/** What a sub-resource (image, style, script) is assumed to weigh when the preview does not fetch it. */
const ASSET_GUESS_BYTES = 30 * 1024;

export interface PreviewEstimate {
  estimate: true;
  label: "Estimate";
  pages: { low: number; high: number };
  bytes: { low: number; high: number };
  basis: string;
  confidence: "low" | "medium" | "high";
}

export interface PreviewRobots {
  checked: boolean;
  allowed: boolean;
  crawlDelayMs?: number;
  message: string;
}

export interface PreviewSample {
  fetched: number;
  inScopeLinks: number;
  averageBytes: number;
  startPageBytes: number;
  sampledFrom: string;
  /** Pages found at each depth in the sample (depth 0 is the start page). */
  depthCounts: Record<string, number>;
}

export interface PreviewResult {
  estimate: PreviewEstimate;
  sample: PreviewSample;
  robots: PreviewRobots;
  warnings: string[];
  requests: number;
}

export interface PreviewDeps {
  fetcher: DiscoveryFetcher;
  robots?: Pick<RobotsService, "check">;
}

interface PageInfo {
  url: string;
  finalUrl: string;
  bytes: number;
  assets: string[];
  follow: { key: string; url: string; depth: number; externalDepth: number }[];
}

async function bodyOf(b: Buffer | Readable): Promise<Buffer> {
  if (Buffer.isBuffer(b)) return b;
  const parts: Buffer[] = [];
  for await (const c of b) parts.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(parts);
}

const fmt = (n: number) => n.toLocaleString("en-GB");
const round = (n: number) => Math.max(0, Math.round(n));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Picks up to `n` items spread evenly over `xs` (the same ones every time). */
function spread<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return [...xs];
  return Array.from({ length: n }, (_, i) => xs[Math.floor(((i + 0.5) * xs.length) / n)]!);
}

/**
 * A sampled estimate for crawl-type sources (task C-15). It fetches the start page and a small sample of the links the crawl
 * would follow (the crawl's own scope and link rules decide which), measures how many new pages each sampled page leads to,
 * and extrapolates level by level up to the depth limit. When the whole reachable site fits in the sample the answer is exact.
 * It never writes to the archive and makes at most `PREVIEW_MAX_REQUESTS` requests.
 */
export async function previewCrawl(
  deps: PreviewDeps,
  a: { config: CrawlConfig; assets: "all" | "same_origin" | "images_css_only" | "none"; respectRobots: boolean; singlePage?: boolean; signal?: AbortSignal; freeBytes?: number },
): Promise<PreviewResult> {
  const cfg = a.config;
  const start = cfg.startUrls[0]!;
  const scope = new Scope(cfg.scope, cfg.query, cfg.startUrls);
  let requests = 0;
  const warnings: string[] = [];
  const robots: PreviewRobots = { checked: false, allowed: true, message: a.respectRobots ? "robots.txt was not checked." : "This source ignores robots.txt." };

  const robotsAllows = async (url: string): Promise<boolean> => {
    if (!deps.robots || !a.respectRobots) return true;
    try {
      return (await deps.robots.check(url, { bypass: false })).allowed;
    } catch {
      return true;
    }
  };

  // robots.txt first: it is one request and it decides whether a crawl would save anything at all.
  if (deps.robots && a.respectRobots) {
    try {
      requests++;
      const dec = await deps.robots.check(start, { bypass: false });
      robots.checked = true;
      if (!dec.allowed && dec.reason === "robots_unreachable_disallow") {
        // The site's robots.txt could not be fetched: a crawl would wait until it can be. That is not the site saying no.
        robots.message = "robots.txt could not be read now, so a crawl would wait until it can.";
        warnings.push("The site's robots.txt could not be read now. A crawl waits until it can be, and respects it then.");
      } else {
        robots.allowed = dec.allowed;
        if (dec.crawlDelayMs) robots.crawlDelayMs = dec.crawlDelayMs;
        robots.message = dec.allowed
          ? dec.crawlDelayMs ? `robots.txt allows the start page and asks for ${Math.round(dec.crawlDelayMs / 1000)} seconds between requests.` : "robots.txt allows the start page."
          : "robots.txt asks crawlers not to save the start page.";
        if (!dec.allowed) warnings.push("The site's robots.txt does not allow the start page, so a crawl from here would save nothing. Choose another start address, or turn off \"respect robots.txt\" only if you have the site owner's permission.");
        if (dec.crawlDelayMs && dec.crawlDelayMs >= 2000) warnings.push(`robots.txt asks for ${Math.round(dec.crawlDelayMs / 1000)} seconds between requests, so a large run will take a long time.`);
      }
    } catch {
      robots.message = "robots.txt could not be read now.";
    }
  } else if (!a.respectRobots) warnings.push("This source ignores robots.txt. Sites may block you if you crawl them without it.");

  const wide = (basis: string, why: string): PreviewResult => {
    warnings.push(why);
    return {
      estimate: { estimate: true, label: "Estimate", pages: { low: robots.allowed ? 1 : 0, high: robots.allowed ? cfg.limits.maxPages : 0 }, bytes: { low: 0, high: cfg.limits.maxBytes }, basis, confidence: "low" },
      sample: { fetched: 0, inScopeLinks: 0, averageBytes: 0, startPageBytes: 0, sampledFrom: start, depthCounts: {} },
      robots, warnings, requests,
    };
  };
  if (!robots.allowed) {
    return { ...wide("The start page is blocked by robots.txt", "Nothing was sampled."), estimate: { estimate: true, label: "Estimate", pages: { low: 0, high: 0 }, bytes: { low: 0, high: 0 }, basis: "robots.txt blocks the start page", confidence: "high" } };
  }

  const budget = () => requests < PREVIEW_MAX_REQUESTS;
  const signalOk = () => !a.signal?.aborted;

  const fetchPage = async (url: string, depth: number, externalDepth: number): Promise<PageInfo | undefined> => {
    if (!budget() || !signalOk()) return undefined;
    if (url !== start && !(await robotsAllows(url))) return undefined;
    requests++;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const onAbort = () => ctl.abort();
    a.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await deps.fetcher.fetch(url, { maxBytes: 2 * 1024 * 1024, accept: ["text/html", "application/xhtml+xml"], signal: ctl.signal });
      if (res.status < 200 || res.status > 299) return undefined;
      const buf = await bodyOf(res.body);
      const finalUrl = res.finalUrl ?? url;
      const html = decodeHtml(buf).text;
      const assets = discoverHtmlAssets(html, finalUrl).map((x) => x.url);
      let candidates: LinkCandidate[] = [];
      const follow: PageInfo["follow"] = [];
      if (!a.singlePage) {
        try {
          const links = extractLinks(html, { url: finalUrl, max: cfg.links.maxLinksPerPage });
          type Cand = LinkCandidate & { d: Extract<ReturnType<Scope["evaluate"]>, { allow: true }> };
          const cands: Cand[] = [];
          for (const l of links) {
            const d = scope.evaluate(l.url, { depth, externalDepth });
            if (!d.allow) continue;
            if (l.features.urlShape === "download") continue;
            cands.push({ url: l.url, region: l.region, score: l.score, features: l.features, position: l.position, isInternal: d.internal, relNofollow: l.relNofollow, anchorText: l.anchorText, d });
          }
          const ranked = rankLinks(cands, depth + 1, (l) => !l.isInternal, cfg.links.weights);
          const sel = selectLinks(ranked, cfg.links);
          candidates = sel.follow.map((f) => f.link);
          for (const c of candidates.slice(0, cfg.links.maxLinksPerPage)) {
            const d = (c as Cand).d;
            follow.push({ key: d.key, url: d.fetchUrl, depth: d.depth, externalDepth: d.externalDepth });
          }
        } catch {
          /* a page the link extractor refuses (too large or too deep) simply has no links in the sample */
        }
      }
      return { url, finalUrl, bytes: buf.length, assets, follow };
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
      a.signal?.removeEventListener("abort", onAbort);
    }
  };

  const startPage = await fetchPage(start, 0, 0);
  if (!startPage) return wide("Could not read the start page", `The start address could not be read now, so the estimate is only the limit set for this source (${fmt(cfg.limits.maxPages)} pages).`);

  const pages: PageInfo[] = [startPage];
  const startKey = scope.evaluate(start, { depth: -1, externalDepth: 0 });
  const seen = new Set<string>([startKey.allow ? startKey.key : start]);
  const level1 = unique(startPage.follow, seen);
  const n1 = level1.length;
  const maxDepth = cfg.scope.maxDepth;

  // Level 1 is counted exactly from the start page; sample it to learn how many new pages each page leads to.
  const fanouts1: number[] = [];
  const level2Pool: PageInfo["follow"] = [];
  let fetchedAllLevel1 = true;
  if (maxDepth >= 2 && !a.singlePage) {
    const s1 = Math.min(5, level1.length, PREVIEW_MAX_REQUESTS - requests - 1);
    const sample1 = spread(level1, Math.max(0, s1));
    fetchedAllLevel1 = sample1.length === level1.length;
    for (const l of sample1) {
      const p = await fetchPage(l.url, l.depth, l.externalDepth);
      if (!p) continue;
      pages.push(p);
      const fresh = unique(p.follow, seen);
      fanouts1.push(fresh.length);
      level2Pool.push(...fresh);
    }
  }
  const fanouts2: number[] = [];
  let level3Pool = 0;
  const level2Fetched: PageInfo[] = [];
  if (maxDepth >= 3 && level2Pool.length > 0) {
    const sample2 = spread(level2Pool, Math.min(PREVIEW_MAX_REQUESTS - requests, 5));
    for (const l of sample2) {
      const p = await fetchPage(l.url, l.depth, l.externalDepth);
      if (!p) continue;
      pages.push(p);
      level2Fetched.push(p);
      const fresh = unique(p.follow, seen);
      fanouts2.push(fresh.length);
      level3Pool += fresh.length;
    }
  }

  // ---- extrapolate -------------------------------------------------------------------------
  const counts: { low: number; high: number }[] = [{ low: 1, high: 1 }];
  let exact = true;
  if (maxDepth >= 1 && !a.singlePage) counts.push({ low: n1, high: n1 });
  if (maxDepth >= 2 && !a.singlePage) {
    if (fetchedAllLevel1 && fanouts1.length === n1) counts.push({ low: level2Pool.length, high: level2Pool.length });
    else {
      exact = false;
      const b = mean(fanouts1);
      counts.push({ low: n1 * b * 0.75, high: n1 * b * 1.35 + 1 });
    }
  }
  if (maxDepth >= 3 && !a.singlePage) {
    const prev = counts[2]!;
    const sampledAll2 = fanouts2.length > 0 && fanouts2.length >= level2Pool.length && prev.low === prev.high;
    if (sampledAll2) counts.push({ low: level3Pool, high: level3Pool });
    else if (fanouts2.length === 0) {
      // Nothing at level 2 to sample: it is a leaf level, or the sample ran out of requests.
      exact = exact && level2Pool.length === 0;
      counts.push({ low: 0, high: level2Pool.length === 0 ? 0 : prev.high * Math.max(1, mean(fanouts1)) * 1.35 });
    } else {
      exact = false;
      const b = mean(fanouts2);
      counts.push({ low: prev.low * b * 0.75, high: prev.high * b * 1.35 + 1 });
    }
  }
  // Deeper levels: keep the last measured growth with a damping factor, because a site's pages overlap more the deeper they go.
  const lastB = fanouts2.length ? mean(fanouts2) : fanouts1.length ? mean(fanouts1) : 0;
  for (let d = 4; d <= maxDepth && !a.singlePage; d++) {
    const prev = counts[d - 1]!;
    if (prev.high === 0) { counts.push({ low: 0, high: 0 }); continue; }
    exact = false;
    const damp = Math.pow(0.85, d - 3);
    counts.push({ low: prev.low * lastB * damp * 0.6, high: prev.high * lastB * 1.35 + 1 });
  }
  const limit = cfg.limits.maxPages;
  const lowPages = Math.min(limit, round(counts.reduce((n, c) => n + c.low, 0)));
  const highPages = Math.min(limit, Math.max(lowPages, round(counts.reduce((n, c) => n + c.high, 0))));

  // ---- bytes -------------------------------------------------------------------------------
  const avgDoc = mean(pages.map((p) => p.bytes));
  const assetCount = (p: PageInfo) => (a.assets === "none" ? 0 : p.assets.length);
  const assetSets = pages.map((p) => new Set(a.assets === "none" ? [] : p.assets));
  const everywhere = assetSets.length > 1 ? [...assetSets[0]!].filter((u) => assetSets.every((s) => s.has(u))).length : 0;
  const own = pages.length > 1 ? mean(pages.map((p, i) => assetSets[i]!.size - everywhere)) : assetCount(startPage);
  const perPage = avgDoc + Math.max(0, own) * ASSET_GUESS_BYTES;
  const shared = everywhere * ASSET_GUESS_BYTES;
  const bytesLow = round(perPage * lowPages * 0.7 + shared);
  const bytesHigh = Math.min(cfg.limits.maxBytes, round(perPage * highPages * 1.4 + shared));

  const confidence: PreviewEstimate["confidence"] = exact ? "high" : pages.length >= 8 ? "medium" : "low";
  const basis = exact
    ? `Every page within ${maxDepth} link${maxDepth === 1 ? "" : "s"} was visible from the sample (${pages.length} page${pages.length === 1 ? "" : "s"} read).`
    : `Read ${pages.length} page${pages.length === 1 ? "" : "s"} and extrapolated how many new pages each leads to, up to ${maxDepth} link${maxDepth === 1 ? "" : "s"} deep.${a.assets === "none" ? "" : ` Assumes about ${ASSET_GUESS_BYTES / 1024} KB for each image, style or script.`}`;

  if (highPages >= limit) warnings.push(`The crawl may reach the limit of ${fmt(limit)} pages for this source.`);
  if (a.freeBytes !== undefined && bytesHigh > a.freeBytes * 0.8) {
    warnings.push(`This could take up to about ${(bytesHigh / 1024 ** 3).toFixed(1)} GB, which is close to or more than the free space on your storage (${(a.freeBytes / 1024 ** 3).toFixed(1)} GB). Lower the size or page limit, or free some space.`);
  }
  if (!budget() && pages.length < 3 && !a.singlePage) warnings.push("Only a few pages could be read for the sample, so the estimate is rough.");

  const depthCounts: Record<string, number> = { "0": 1, ...(n1 ? { "1": n1 } : {}) };
  return {
    estimate: { estimate: true, label: "Estimate", pages: { low: lowPages, high: highPages }, bytes: { low: Math.min(bytesLow, bytesHigh), high: bytesHigh }, basis, confidence },
    sample: { fetched: pages.length, inScopeLinks: n1, averageBytes: round(avgDoc), startPageBytes: startPage.bytes, sampledFrom: start, depthCounts },
    robots, warnings, requests,
  };
}

/** The items whose key is new, marking them as seen. */
function unique(items: PageInfo["follow"], seen: Set<string>): PageInfo["follow"] {
  const out: PageInfo["follow"] = [];
  for (const i of items) {
    if (seen.has(i.key)) continue;
    seen.add(i.key);
    out.push(i);
  }
  return out;
}

import { z } from "zod";
import type { CrawlConfig } from "@ncb/crawl";
import type { Db, Job, JobQueue } from "@ncb/db";
import { AppError, type Clock } from "@ncb/shared";
import { parseOrThrow } from "../lib/zod.js";
import { RetryJobLater } from "../pipeline/service.js";
import type { CrawlAdapter, LinkJudge } from "../crawl/service.js";
import type { BlobStore } from "../services/blobs.js";
import type { ActivityLog } from "../services/activity.js";
import type { SourceService, SourceOut } from "../sources/service.js";
import { WIKIPEDIA_DEFAULT_PAGES, WIKIPEDIA_MAX_DEPTH, WIKIPEDIA_MAX_PAGES } from "../sources/schema.js";
import { WikipediaError, type WikipediaClient } from "./client.js";
import { extractWikiImages, extractWikiLinks, revisionFromEtag, type WikiLink } from "./html.js";
import { articleUrl, displayTitle, historyUrl, isLanguageCode, parseWikipediaUrl, skipKindOf, skipReason, type WikiTarget } from "./url.js";
import type { WikipediaZim } from "./zim-map.js";

/**
 * Wikipedia as a source of pages (tasks Z-07 and Z-08). The article text arrives through the `WikipediaClient` (the routed fetcher) and is
 * stored by the ordinary capture pipeline as a normal page under its reading address; this service adds what is specific to Wikipedia:
 *
 *  - the preview of a topic crawl (counts per level, requests, time at one request a second, bytes);
 *  - the crawl adapter: which links to skip (other namespaces, disambiguation, lists, year pages, articles a knowledge package already holds)
 *    and which to try first (links in the lead section, links that appear more than once);
 *  - the attribution that CC BY-SA asks for, stored per version (`page_attributions`), and per image (`asset_attributions`, from `imageinfo`).
 */

const MIB = 1024 * 1024;
/** Rough sizes for the estimate; the preview says they are estimates. */
const IMAGE_BYTES = 40 * 1024;
const LEAD_BOOST = 40;
const REPEAT_BOOST = 5;

const optionsSchema = z.object({
  /** The article: a title (with `language`) or a Wikipedia address. */
  title: z.string().trim().min(1).max(300).optional(),
  url: z.string().trim().min(1).max(2000).optional(),
  language: z.string().trim().toLowerCase().max(12).default("en"),
  depth: z.number().int("Depth must be a whole number").min(0, "Depth cannot be negative").max(WIKIPEDIA_MAX_DEPTH, `Depth can be at most ${WIKIPEDIA_MAX_DEPTH}. Pages multiply with every level; a Wikipedia package is the better way to keep more.`).default(1),
  maxPages: z.number().int().min(1).max(WIKIPEDIA_MAX_PAGES, `At most ${WIKIPEDIA_MAX_PAGES.toLocaleString("en-GB")} pages. For more, add a Wikipedia knowledge package instead.`).default(WIKIPEDIA_DEFAULT_PAGES),
  images: z.boolean().default(true),
  preferZim: z.boolean().default(true),
  skipDisambiguation: z.boolean().default(true),
  skipLists: z.boolean().default(true),
  skipYears: z.boolean().default(true),
}).superRefine((v, ctx) => {
  if (!v.title && !v.url) ctx.addIssue({ code: "custom", path: ["title"], message: "Enter an article title or a Wikipedia address" });
  if (!isLanguageCode(v.language)) ctx.addIssue({ code: "custom", path: ["language"], message: "Use a language code such as en or de" });
});
export type WikipediaOptions = z.infer<typeof optionsSchema>;

const crawlSchema = optionsSchema.safeExtend({
  name: z.string().trim().min(1).max(120).optional(),
  priority: z.union([z.enum(["P1", "P2", "P3", "P4"]), z.number().int().min(1).max(4)]).optional(),
});

export interface PreviewLevel {
  depth: number;
  /** Links found (level 1) or expected (deeper levels) at this depth, before any rule. */
  candidates: number;
  /** Pages the crawl would fetch at this depth, after the rules and the page cap. */
  willFetch: number;
  /** Articles an enabled knowledge package holds: linked to the package copy, not fetched. */
  inKnowledgePackage: number;
  skipped: { disambiguation: number; lists: number; years: number; missing: number };
  /** True for levels worked out from the first level's link count rather than counted. */
  estimated: boolean;
}

export interface WikipediaPreview {
  estimate: true;
  article: { title: string; language: string; url: string; revisionId: string | null; bytes: number; redirectedFrom: string | null };
  caps: { depth: number; maxPages: number; maxDepth: number; maxPagesCeiling: number };
  options: { images: boolean; preferZim: boolean; skipDisambiguation: boolean; skipLists: boolean; skipYears: boolean };
  levels: PreviewLevel[];
  totals: { pages: number; images: number; requests: number; seconds: number; bytes: number };
  knowledgePackages: { checked: number; present: number; packages: { id: string; title: string }[] };
  /** The first links the crawl would follow, lead-section links first. */
  sample: { title: string; lead: boolean; count: number; inKnowledgePackage: boolean }[];
  /** How many requests the preview itself made. */
  requestsMade: number;
  pace: { requestsPerSecond: number };
  warnings: string[];
}

export interface WikipediaServiceOptions {
  db: Db;
  clock: Clock;
  queue: JobQueue;
  blobs: BlobStore;
  pipeline: { getContentBlobs(versionId: number): { document: string | null } };
  activity: ActivityLog;
  client: WikipediaClient;
  zim: WikipediaZim;
  sources: () => SourceService;
  isOffline: () => boolean;
  log?: { warn(o: unknown, m?: string): void };
}

export class WikipediaService {
  constructor(private readonly o: WikipediaServiceOptions) {}

  get client(): WikipediaClient {
    return this.o.client;
  }

  /** Throws unless Wikipedia may be contacted: a usable `NCB_CONTACT` is set. */
  assertReady(): void {
    this.o.client.assertReady();
  }

  /** The article a start address names (any language subdomain, mobile host, `/wiki/` or `index.php?title=`), as the canonical reading address. */
  parseStart(url: string): { lang: string; title: string; url: string } {
    const t = parseWikipediaUrl(url, this.o.client.urlOptions);
    if (!t) throw new AppError("bad_request", "That is not the address of a Wikipedia article. Use an address such as https://en.wikipedia.org/wiki/Benzene.", { fields: [{ in: "body", path: "startUrl", message: "Use the address of a Wikipedia article" }] });
    return { lang: t.lang, title: t.title, url: articleUrl(t, this.o.client.urlOptions) };
  }

  private target(o: Pick<WikipediaOptions, "title" | "url" | "language">): WikiTarget {
    if (o.url) {
      const t = parseWikipediaUrl(o.url, this.o.client.urlOptions);
      if (!t) throw new AppError("bad_request", "That is not the address of a Wikipedia article.", { fields: [{ in: "body", path: "url", message: "Use the address of a Wikipedia article" }] });
      return t;
    }
    const fromTitle = parseWikipediaUrl(`https://${o.language}.wikipedia.org/wiki/${encodeURIComponent((o.title ?? "").replace(/ /g, "_"))}`);
    if (!fromTitle) throw new AppError("bad_request", "That is not the title of a Wikipedia article.", { fields: [{ in: "body", path: "title", message: "Use the title of an article, without a prefix such as Category:" }] });
    return fromTitle;
  }

  // ---- preview ------------------------------------------------------------------------------------------------------------------

  /**
   * Counts what a crawl would do without saving anything: one request for the article itself and one per 50 candidate titles for existence
   * and disambiguation pages (up to three), then the rules and the page cap. Level 1 is counted; deeper levels are estimated from it.
   */
  async preview(body: unknown, signal?: AbortSignal): Promise<WikipediaPreview> {
    const opts = parseOrThrow(optionsSchema, body);
    this.assertReady();
    if (this.o.isOffline()) throw new AppError("offline", "Wikipedia can only be previewed while the server is online. The preview reads the article from Wikipedia.", { canQueue: false });
    const t = this.target(opts);
    const client = this.o.client;
    const before = client.state().requests;
    const page = await client.pageHtml(t.lang, t.title, { signal });
    if (page.kind === "missing") throw new AppError("not_found", `Wikipedia has no article called “${displayTitle(t.title)}”.`);
    if (page.kind !== "ok") throw new WikipediaError("bad_response", "Wikipedia gave no article.");
    const html = page.body.toString("utf8");
    const seedTitle = page.target.title;
    const links = extractWikiLinks(html).filter((l) => l.title !== seedTitle);
    const imagesOnSeed = opts.images ? extractWikiImages(html).length : 0;

    const skip = { disambiguation: 0, lists: 0, years: 0, missing: 0 };
    const rules = { disambiguation: opts.skipDisambiguation, lists: opts.skipLists, years: opts.skipYears };
    let keep: WikiLink[] = [];
    for (const l of links) {
      const k = skipKindOf(l.title);
      if (k && skipReason(l.title, rules)) { skip[k === "list" ? "lists" : k === "year" ? "years" : "disambiguation"]++; continue; }
      keep.push(l);
    }
    keep.sort((a, b) => Number(b.lead) - Number(a.lead) || b.count - a.count || a.position - b.position);

    // Existence and disambiguation pages, for the candidates the cap could reach.
    const cap1 = Math.max(0, opts.maxPages - 1);
    let checked = 0;
    if (opts.depth >= 1 && keep.length) {
      const head = keep.slice(0, Math.min(keep.length, Math.max(cap1, 1), 150));
      const info = await client.titleInfo(t.lang, head.map((l) => l.title), { signal });
      checked = head.length;
      const drop = new Set<string>();
      for (const l of head) {
        const i = info.get(l.title);
        if (!i) continue;
        if (!i.exists) { skip.missing++; drop.add(l.title); } else if (i.disambiguation && opts.skipDisambiguation) { skip.disambiguation++; drop.add(l.title); }
      }
      keep = keep.filter((l) => !drop.has(l.title));
    }

    const inZim = opts.preferZim ? await this.o.zim.present(t.lang, keep.map((l) => l.title).slice(0, 3000)) : new Set<string>();
    const fetchable = keep.filter((l) => !inZim.has(l.title));
    const pkgs = this.o.zim.packages(t.lang).map((r) => ({ id: r.public_id, title: r.title }));

    const levels: PreviewLevel[] = [{ depth: 0, candidates: 1, willFetch: 1, inKnowledgePackage: 0, skipped: { disambiguation: 0, lists: 0, years: 0, missing: 0 }, estimated: false }];
    let pages = 1;
    if (opts.depth >= 1) {
      const will = Math.min(fetchable.length, Math.max(0, opts.maxPages - pages));
      levels.push({ depth: 1, candidates: links.length, willFetch: will, inKnowledgePackage: [...inZim].length, skipped: skip, estimated: false });
      pages += will;
    }
    // Deeper levels: each fetched page is taken to add about as many new, fetchable links as the first level shows per page, damped for overlap.
    const fan = Math.max(1, Math.min(40, fetchable.length));
    let prev = levels[1]?.willFetch ?? 0;
    for (let d = 2; d <= opts.depth; d++) {
      const cand = Math.round(prev * fan * 0.6);
      const will = Math.max(0, Math.min(cand, opts.maxPages - pages));
      levels.push({ depth: d, candidates: cand, willFetch: will, inKnowledgePackage: 0, skipped: { disambiguation: 0, lists: 0, years: 0, missing: 0 }, estimated: true });
      pages += will;
      prev = will;
    }
    const images = opts.images ? Math.round(Math.min(imagesOnSeed, 40) * pages) : 0;
    const imageBatches = Math.ceil(images / 50);
    const requests = pages + images + imageBatches;
    const seconds = Math.ceil((requests * client.minIntervalMs) / 1000);
    const bytes = Math.round(pages * page.bytes + images * IMAGE_BYTES);

    const warnings: string[] = [];
    if (requests > 500) warnings.push(`This would make about ${requests.toLocaleString("en-GB")} requests to Wikipedia, which takes about ${Math.ceil(seconds / 60)} minutes at one request a second. A Wikipedia package would be quicker and kinder to Wikipedia's servers.`);
    if (bytes > 200 * MIB) warnings.push(`This could save about ${Math.round(bytes / MIB)} MiB.`);
    if (pages >= opts.maxPages && fetchable.length + 1 > opts.maxPages) warnings.push(`The ${opts.maxPages.toLocaleString("en-GB")}-page limit stops the crawl before every link is followed; the links in the lead section go first.`);
    if (opts.preferZim && pkgs.length === 0) warnings.push("No Wikipedia package for this language is installed, so every article is fetched from Wikipedia.");
    if (levels.some((l) => l.estimated)) warnings.push("Levels beyond the first are worked out from the first level and may be quite different.");

    return {
      estimate: true,
      article: { title: displayTitle(seedTitle), language: t.lang, url: page.articleUrl, revisionId: page.revisionId ?? null, bytes: page.bytes, redirectedFrom: page.redirectedFrom ? displayTitle(page.redirectedFrom) : null },
      caps: { depth: opts.depth, maxPages: opts.maxPages, maxDepth: WIKIPEDIA_MAX_DEPTH, maxPagesCeiling: WIKIPEDIA_MAX_PAGES },
      options: { images: opts.images, preferZim: opts.preferZim, skipDisambiguation: opts.skipDisambiguation, skipLists: opts.skipLists, skipYears: opts.skipYears },
      levels,
      totals: { pages, images, requests, seconds, bytes },
      knowledgePackages: { checked: Math.min(keep.length, 3000), present: inZim.size, packages: pkgs },
      sample: keep.slice(0, 12).map((l) => ({ title: displayTitle(l.title), lead: l.lead, count: l.count, inKnowledgePackage: inZim.has(l.title) })),
      requestsMade: client.state().requests - before,
      pace: { requestsPerSecond: 1000 / client.minIntervalMs },
      warnings,
    };
  }

  // ---- crawl ------------------------------------------------------------------------------------------------------------------

  /**
   * Starts a topic crawl as an ordinary source: a `linked_collection` with `adapter: "wikipedia"` whose run is the crawl engine with the
   * Wikipedia adapter. The caps are those of the preview. Nothing is queued unless the contact is set.
   */
  async startCrawl(body: unknown): Promise<{ source: SourceOut; downloadIds: string[] }> {
    const o = parseOrThrow(crawlSchema, body);
    this.assertReady();
    const t = this.target(o);
    const url = articleUrl(t, this.o.client.urlOptions);
    const sources = this.o.sources();
    const source = sources.create({
      name: o.name ?? `Wikipedia: ${displayTitle(t.title)}`,
      type: "linked_collection", adapter: "wikipedia", startUrl: url, strategy: "explore", profile: "custom", priority: o.priority ?? 3,
      config: {
        depth: o.depth, maxPages: o.maxPages,
        wikipedia: { language: t.lang, images: o.images, linkedExpansionDepth: o.depth, preferZim: o.preferZim, skipDisambiguation: o.skipDisambiguation, skipLists: o.skipLists, skipYears: o.skipYears },
      },
    });
    const run = await sources.run(source.id, { requestedBy: "user" });
    return { source: sources.get(source.id), downloadIds: run.downloadIds };
  }

  // ---- the crawl adapter -----------------------------------------------------------------------------------------------------

  private async documentOf(versionId: number): Promise<string | undefined> {
    const sha = this.o.pipeline.getContentBlobs(versionId).document;
    if (!sha) return undefined;
    return (await this.o.blobs.read(sha)).data.toString("utf8");
  }

  adapter(): CrawlAdapter {
    return {
      skipsRobots: true,
      judge: async ({ versionId, config }): Promise<LinkJudge> => {
        const w = (config as CrawlConfig).wikipedia!;
        const urlOptions = this.o.client.urlOptions;
        const html = await this.documentOf(versionId);
        const links = html ? extractWikiLinks(html) : [];
        const by = new Map(links.map((l) => [l.title, l]));
        const rules = { disambiguation: w.skipDisambiguation, lists: w.skipLists, years: w.skipYears };
        const candidates = links.filter((l) => !skipReason(l.title, rules)).map((l) => l.title).slice(0, 3000);
        const inZim = w.preferZim ? await this.o.zim.present(w.language, candidates) : new Set<string>();
        return {
          skip: (url) => {
            const t = parseWikipediaUrl(url, urlOptions);
            if (!t) return "wikipedia:not_article";
            if (t.lang !== w.language) return "wikipedia:other_language";
            const why = skipReason(t.title, rules);
            if (why) return why;
            return inZim.has(t.title) ? "wikipedia:in_zim" : null;
          },
          boost: (url) => {
            const t = parseWikipediaUrl(url, urlOptions);
            const l = t ? by.get(t.title) : undefined;
            return l ? (l.lead ? LEAD_BOOST : 0) + Math.min(l.count - 1, 4) * REPEAT_BOOST : 0;
          },
        };
      },
    };
  }

  // ---- attribution -----------------------------------------------------------------------------------------------------------

  /**
   * Called when a version has finished the pipeline. A Wikipedia page (the fetcher marks its documents) gets the CC BY-SA details Wikimedia's
   * Terms of Use ask for: the article address, the history address, the revision and the licence. The images' details follow as a job.
   */
  afterVersion(versionId: number): void {
    const { db } = this.o;
    const v = db.get<{ id: number; page_id: number; final_url: string; headers_json: string | null; fetched_at: number; etag: string | null }>(
      "SELECT id, page_id, final_url, headers_json, fetched_at, etag FROM page_versions WHERE id = ?", [versionId]);
    if (!v?.headers_json) return;
    let headers: Record<string, string>;
    try { headers = JSON.parse(v.headers_json) as Record<string, string>; } catch { return; }
    if (headers["x-ncb-source"] !== "wikipedia") return;
    const t = parseWikipediaUrl(v.final_url, this.o.client.urlOptions);
    if (!t) return;
    const revision = headers["x-revision-id"] ?? revisionFromEtag(headers.etag ?? v.etag ?? undefined) ?? null;
    const opts = this.o.client.urlOptions;
    const retrieved = new Date(v.fetched_at).toISOString().slice(0, 10);
    const credit = `Text from Wikipedia, “${displayTitle(t.title)}”, licensed under CC BY-SA 4.0. The authors are listed in the article history. Retrieved ${retrieved}${revision ? `, revision ${revision}` : ""}.`;
    db.transaction(() => {
      db.run(
        `INSERT INTO page_attributions (version_id, license_name, license_url, source_url, revision_id, history_url, credit_text) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (version_id) DO UPDATE SET license_name = excluded.license_name, license_url = excluded.license_url, source_url = excluded.source_url,
           revision_id = excluded.revision_id, history_url = excluded.history_url, credit_text = excluded.credit_text`,
        [v.id, "CC BY-SA 4.0", "https://creativecommons.org/licenses/by-sa/4.0/", articleUrl(t, opts), revision, historyUrl(t, opts), credit],
      );
      db.run("UPDATE pages SET origin = 'wikipedia', language = COALESCE(language, ?) WHERE id = ?", [t.lang, v.page_id]);
    });
    const images = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM version_resources WHERE version_id = ? AND role = 'image' AND status = 'ok'", [v.id])!.n;
    if (images > 0) {
      this.o.queue.enqueue({ type: "wikipedia_fetch", queue: "crawl", versionId: v.id, payload: { lang: t.lang }, idempotencyKey: `wikipedia_images:${v.id}`, maxAttempts: 6, priority: 0 });
    }
  }

  /** The job that fetches licence details for a version's images (`imageinfo`) and stores `asset_attributions`. */
  async handleImages(job: Job, ctx: { signal: AbortSignal }): Promise<void> {
    if (job.versionId === null) return;
    const { db } = this.o;
    const v = db.get<{ id: number; final_url: string }>("SELECT id, final_url FROM page_versions WHERE id = ? AND status IN ('ready','partial')", [job.versionId]);
    if (!v) return;
    const lang = (job.payload as { lang?: string } | null)?.lang ?? parseWikipediaUrl(v.final_url, this.o.client.urlOptions)?.lang ?? "en";
    const html = await this.documentOf(v.id);
    if (!html) return;
    const imgs = extractWikiImages(html);
    if (!imgs.length) return;
    // Which asset is each image? The version's resource list says what each address was saved as.
    const resources = db.all<{ url: string; asset_id: number }>("SELECT url, asset_id FROM version_resources WHERE version_id = ? AND role = 'image' AND status = 'ok' AND asset_id IS NOT NULL", [v.id]);
    const byUrl = new Map(resources.map((r) => [r.url, r.asset_id]));
    const pairs: { file: string; assetId: number }[] = [];
    for (const im of imgs) {
      let abs: string;
      try { abs = new URL(im.src, v.final_url).href.replace(/#.*$/, ""); } catch { continue; }
      const id = byUrl.get(abs);
      if (id !== undefined) pairs.push({ file: im.file, assetId: id });
    }
    if (!pairs.length) return;
    const files = [...new Set(pairs.map((p) => p.file))].slice(0, 300);
    let info;
    try {
      info = await this.o.client.imageInfo(lang, files, { signal: ctx.signal });
    } catch (e) {
      if (e instanceof WikipediaError && (e.reason === "rate_limited" || e.reason === "maxlag" || e.reason === "circuit_open" || e.reason === "network")) {
        throw new RetryJobLater(e.message, e.retryAfterMs ?? 15_000);
      }
      throw e;
    }
    let stored = 0;
    db.transaction(() => {
      for (const p of pairs) {
        const a = info.get(p.file);
        if (!a) continue;
        db.run(
          `INSERT INTO asset_attributions (asset_id, author, license_name, license_url, source_page_url) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (asset_id) DO UPDATE SET author = excluded.author, license_name = excluded.license_name, license_url = excluded.license_url, source_page_url = excluded.source_page_url`,
          [p.assetId, a.author, a.nonFree && !a.licenseName ? "Non-free media" : a.licenseName, a.licenseUrl, a.sourcePageUrl],
        );
        stored++;
      }
    });
    this.o.activity.write({ level: "info", area: "crawl", message: `Image credits saved for ${stored} image${stored === 1 ? "" : "s"} of ${new URL(v.final_url).pathname}`, details: { versionId: v.id, requested: files.length } });
  }

  handlers(): Record<string, (job: Job, ctx: { signal: AbortSignal }) => Promise<void>> {
    return { wikipedia_fetch: (job, ctx) => this.handleImages(job, ctx) };
  }

  status() {
    const st = this.o.client.state();
    return { ...st, replacementOrigin: this.o.client.urlOptions.origin ?? null, userAgentPreview: st.contactConfigured ? this.o.client.userAgent : null, zimPackages: this.o.zim.hasAny() };
  }
}

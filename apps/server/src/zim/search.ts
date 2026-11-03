import { createHash } from "node:crypto";
import { parseQuery } from "@ncb/search";
import type { Db } from "@ncb/db";
import { languageMatches } from "./languages.js";
import { escapeText, highlightTitle, sanitiseSnippet } from "./snippet.js";
import { ZimError, type ZimSource } from "./source.js";
import type { ZimRow, ZimService } from "./service.js";

/**
 * Federated search over the enabled ZIM packages (task Z-05, docs/research/zim-wikipedia.md section 3). Each package is queried on its own
 * worker in parallel with a time budget; what comes back is a ranked list per package. Scores from different Xapian indexes cannot be
 * compared, so only the rank is kept. A package without a full-text index falls back to title suggestions.
 */

export interface ZimHit {
  key: string;
  zimId: string;
  path: string;
  title: string;
  titleHtml: string;
  /** Sanitised HTML: only `<b>` survives. */
  snippet: string;
  /** 1-based position in the package's own list. */
  rank: number;
  /** Public id of the archived page that is the same Wikipedia article (task Z-06). In a mixed list the archived copy stands for it and this hit is left out. */
  archivedAs?: string;
}

export interface ZimGroup {
  zimId: string;
  title: string;
  language: string | null;
  flavour: string | null;
  mode: "fulltext" | "titles";
  state: "ok" | "partial" | "timeout" | "error";
  /** Why the list is short or empty, in plain words. */
  message?: string;
  estimatedMatches: number;
  tookMs: number;
  hits: ZimHit[];
}

export interface ZimSearchOutput {
  state: "ok" | "none" | "off";
  mode: "unified" | "federated";
  budgetMs: number;
  tookMs: number;
  groups: ZimGroup[];
  /** Packages left out and why. */
  skipped: { zimId: string; title: string; reason: "language" | "cap" | "disabled" | "unavailable" }[];
}

export interface ZimSearchOptions {
  query: string;
  languages?: string[];
  /** Restrict to these packages (`zim_` ids). */
  packages?: string[];
  budgetMs: number;
  maxPackages: number;
  hitsPerPackage: number;
}

export const zimKey = (zimId: string, path: string): string => "k_" + createHash("sha1").update(`zim:${zimId}:${path}`).digest("hex").slice(0, 16);
export const zimUrl = (zimId: string, path: string): string => `zim://${zimId}/${path.split("/").map(encodeURIComponent).join("/")}`;

/** The text sent to Xapian: bare terms and quoted phrases of the parsed query. Operators (`site:`, `-word`) do not apply to a ZIM. */
export function zimQueryText(query: string): { text: string; terms: string[] } {
  const p = parseQuery(query);
  const words = p.terms.map((t) => t.text);
  const phrases = p.phrases.map((ph) => ph.join(" "));
  const text = [...words, ...phrases.map((ph) => `"${ph}"`)].join(" ").trim();
  return { text, terms: [...words, ...phrases.flatMap((ph) => ph.split(" "))] };
}

const TIMEOUT = Symbol("timeout");

export class ZimSearch {
  constructor(private readonly o: { db: Db; zim: ZimService; source: ZimSource }) {}

  /** Packages that can answer, in the order they are asked: higher priority first, then oldest. */
  private candidates(opts: ZimSearchOptions): { rows: ZimRow[]; skipped: ZimSearchOutput["skipped"] } {
    const skipped: ZimSearchOutput["skipped"] = [];
    let rows = this.o.zim.rows();
    if (opts.packages?.length) rows = rows.filter((r) => opts.packages!.includes(r.public_id));
    const ok: ZimRow[] = [];
    for (const r of rows) {
      if (r.enabled_for_search !== 1) { if (opts.packages?.length) skipped.push({ zimId: r.public_id, title: r.title, reason: "disabled" }); continue; }
      if (r.state === "missing" || r.state === "importing") { skipped.push({ zimId: r.public_id, title: r.title, reason: "unavailable" }); continue; }
      if (!languageMatches(r.language, opts.languages)) { skipped.push({ zimId: r.public_id, title: r.title, reason: "language" }); continue; }
      ok.push(r);
    }
    ok.sort((a, b) => a.priority - b.priority || a.id - b.id);
    for (const r of ok.slice(opts.maxPackages)) skipped.push({ zimId: r.public_id, title: r.title, reason: "cap" });
    return { rows: ok.slice(0, opts.maxPackages), skipped };
  }

  async search(opts: ZimSearchOptions, mode: "unified" | "federated"): Promise<ZimSearchOutput> {
    const t0 = performance.now();
    const { text, terms } = zimQueryText(opts.query);
    const { rows, skipped } = this.candidates(opts);
    if (!text || rows.length === 0) return { state: "none", mode, budgetMs: opts.budgetMs, tookMs: 0, groups: [], skipped };
    const groups = await Promise.all(rows.map((r) => this.one(r, text, terms, opts)));
    return { state: "ok", mode, budgetMs: opts.budgetMs, tookMs: Math.round(performance.now() - t0), groups, skipped };
  }

  private async one(r: ZimRow, text: string, terms: string[], opts: ZimSearchOptions): Promise<ZimGroup> {
    const t0 = performance.now();
    const base = { zimId: r.public_id, title: r.title, language: r.language, flavour: r.flavour };
    const fulltext = r.has_fulltext_index === 1;
    const mode = fulltext ? ("fulltext" as const) : ("titles" as const);
    const done = (g: Partial<ZimGroup>): ZimGroup => ({ ...base, mode, state: "ok", estimatedMatches: 0, hits: [], tookMs: Math.round(performance.now() - t0), ...g });
    // The race returns at the budget even when the worker is stuck behind a slow call; the worker itself is restarted by its own watchdog.
    let timer: NodeJS.Timeout | undefined;
    const clock = new Promise<typeof TIMEOUT>((res) => { timer = setTimeout(() => res(TIMEOUT), opts.budgetMs); timer.unref(); });
    try {
      const opened = await Promise.race([this.o.zim.ensureOpen(r), clock]);
      if (opened === TIMEOUT) return done({ state: "timeout", message: `This package did not answer within ${opts.budgetMs} ms.` });
      if (!opened) return done({ state: "error", message: "This package is not available at the moment." });
      const call = fulltext
        ? this.o.source.search(r.public_id, text, { limit: opts.hitsPerPackage, budgetMs: opts.budgetMs }).then((x) => ({ hits: x.hits.map((h) => ({ title: h.title, path: h.path, snippet: h.snippet })), est: x.estimated, partial: x.partial }))
        : this.o.source.suggest(r.public_id, text, { limit: opts.hitsPerPackage, budgetMs: opts.budgetMs }).then((x) => ({ hits: x.hits.map((h) => ({ title: h.title, path: h.path, snippet: h.snippet })), est: x.estimated, partial: x.partial }));
      call.catch(() => undefined); // a late failure after the race is over is not an unhandled rejection
      const res = await Promise.race([call, clock]);
      if (res === TIMEOUT) {
        return done({ state: "timeout", message: `This package did not answer within ${opts.budgetMs} ms.` });
      }
      const hits: ZimHit[] = res.hits.map((h, i) => ({
        key: zimKey(r.public_id, h.path), zimId: r.public_id, path: h.path, title: h.title || h.path, titleHtml: highlightTitle(h.title || h.path, terms),
        snippet: h.snippet ? sanitiseSnippet(h.snippet) : "", rank: i + 1,
      }));
      return done({
        hits, estimatedMatches: res.est, state: res.partial ? "partial" : "ok",
        ...(res.partial ? { message: "Time ran out, so only the best matches found so far are shown." } : {}),
        ...(!fulltext ? { message: "This package has no full-text index, so only titles were searched." } : {}),
      });
    } catch (e) {
      const code = e instanceof ZimError ? e.zimCode : "failed";
      return done({ state: "error", message: code === "worker_hung" || code === "worker_crashed" ? "This package stopped answering and is being restarted." : "This package could not be searched." });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export { escapeText };

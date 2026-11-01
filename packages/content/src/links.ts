import { domList } from "./dom.js";
import { parseHTML } from "linkedom";
import { guardHtml, type HtmlLimits } from "./html.js";
import { registrableDomain, resolveHttpUrl } from "./url.js";

export type LinkRegion = "content" | "heading" | "related" | "nav" | "footer" | "other";

export interface LinkFeatures {
  region: LinkRegion;
  base: number;
  /** link text / all text of the nearest list or block container, 0 to 1. */
  density: number;
  anchorWords: number;
  anchorQuality: "strong" | "ok" | "weak" | "none";
  /** Position among all links, 0 (first) to 1 (last). */
  position: number;
  urlShape: "ok" | "chrome" | "pagination" | "query_heavy" | "download";
  samePrefix: boolean;
  adjust: number;
}

export interface ExtractedLink {
  url: string;
  anchorText: string;
  context: string;
  region: LinkRegion;
  score: number;
  features: LinkFeatures;
  isInternal: boolean;
  relNofollow: boolean;
  /** Order of first appearance in the document. */
  position: number;
}

export const REGION_BASE: Record<LinkRegion, number> = { content: 0.85, heading: 0.65, related: 0.45, nav: 0.28, footer: 0.1, other: 0.2 };
// Adjustments are clamped so a region can never outrank the one above it: the gaps between bases are >= 0.17.
const ADJUST_MIN = -0.08;
const ADJUST_MAX = 0.06;
const MAX_LINKS = 2000;

const NAV_RE = /(?:^|[\s_-])(?:nav|navbar|navigation|menu|breadcrumbs?|topbar|skip)(?:$|[\s_-])/i;
const FOOTER_RE = /(?:^|[\s_-])(?:footer|colophon|site-info|copyright)(?:$|[\s_-])/i;
const RELATED_RE = /(?:^|[\s_-])(?:related|recommended|sidebar|widget|trending|more-like|also-read|promo)(?:$|[\s_-])/i;
const CHROME_URL = /\/(?:login|log-in|logout|signin|sign-in|signup|sign-up|register|cart|checkout|account|share|print|feed|rss|comments?|wp-admin|subscribe)(?:[/?#.]|$)|[?&](?:share|print|replytocom)=/i;
const PAGINATION_URL = /\/(?:page|p)\/\d+\/?$|[?&](?:page|paged|p)=\d+|\/(?:tag|tags|category|categories|archive|archives)\/[^/]+\/?$/i;
const DOWNLOAD_EXT = /\.(?:pdf|zip|gz|tar|7z|rar|exe|dmg|iso|mp3|mp4|avi|mov|docx?|xlsx?|pptx?)(?:[?#]|$)/i;
const WEAK_ANCHOR = /^(?:click here|here|read more|more|continue|continue reading|link|this|learn more|details|…|\.{3}|>>?|»)$/i;

const BLOCK_CONTAINERS = new Set(["p", "li", "dd", "td", "th", "blockquote", "div", "section", "article", "main", "aside", "nav", "footer", "header", "ul", "ol", "table", "figure"]);

type El = NonNullable<ReturnType<typeof parseHTML>["document"]["documentElement"]>;

function ancestors(el: El): El[] {
  const out: El[] = [];
  for (let p = el.parentElement; p; p = p.parentElement) out.push(p);
  return out;
}

const attr = (el: El, k: string) => el.getAttribute(k) ?? "";
const idClass = (el: El) => `${attr(el, "id")} ${attr(el, "class")}`;

function regionOf(el: El, anc: El[], hasLandmarks: boolean): LinkRegion {
  const inMain = anc.some((a) => {
    const t = a.tagName.toLowerCase();
    return t === "main" || t === "article" || attr(a, "role") === "main";
  });
  let nav = false;
  let footer = false;
  let related = false;
  let heading = false;
  for (const a of anc) {
    const t = a.tagName.toLowerCase();
    const role = attr(a, "role").toLowerCase();
    const ic = idClass(a);
    if (/^h[1-6]$/.test(t)) heading = true;
    if (t === "footer" && !inMain) footer = true;
    else if (role === "contentinfo" || (FOOTER_RE.test(ic) && t !== "body" && t !== "html")) footer = true;
    if (t === "nav" || role === "navigation" || role === "banner" || (t === "header" && !inMain) || (NAV_RE.test(ic) && t !== "body" && t !== "html")) nav = true;
    if (t === "aside" || role === "complementary" || (RELATED_RE.test(ic) && t !== "body" && t !== "html")) related = true;
  }
  if (footer) return "footer";
  if (nav) return "nav";
  if (related) return "related";
  if (heading) return "heading";
  if (inMain || !hasLandmarks) return "content";
  return "other";
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

export function extractLinks(html: string, opts: { url: string; limits?: Partial<HtmlLimits>; max?: number }): ExtractedLink[] {
  const guard = guardHtml(html, opts.limits);
  if (!guard.ok) throw new Error(`The page was not parsed: ${guard.reason}`);
  const { document } = parseHTML(html);
  let base = opts.url;
  const baseHref = document.querySelector("base[href]")?.getAttribute("href");
  if (baseHref) base = resolveHttpUrl(baseHref, opts.url) ?? opts.url;
  const pageUrl = new URL(opts.url);
  const pageDomain = registrableDomain(pageUrl.hostname);
  const hasLandmarks = !!document.querySelector("main, article, [role=main]");
  const anchors = domList(document.querySelectorAll("a[href]"));
  const density = new Map<El, number>();
  const containerText = new Map<El, string>();

  const containerOf = (a: El): El | null => {
    let c: El | null = a.parentElement;
    while (c && !BLOCK_CONTAINERS.has(c.tagName.toLowerCase())) c = c.parentElement;
    if (c && c.tagName.toLowerCase() === "li") c = c.parentElement ?? c; // a list of links is judged as a whole
    return c;
  };
  const densityOf = (c: El | null): number => {
    if (!c) return 0;
    const hit = density.get(c);
    if (hit !== undefined) return hit;
    const total = collapse(c.textContent ?? "");
    containerText.set(c, total);
    let linkChars = 0;
    for (const x of domList(c.querySelectorAll("a"))) linkChars += collapse(x.textContent ?? "").length;
    const d = total.length === 0 ? 0 : Math.min(1, linkChars / total.length);
    density.set(c, d);
    return d;
  };

  const out: ExtractedLink[] = [];
  const seen = new Set<string>();
  const max = opts.max ?? MAX_LINKS;
  let index = 0;
  for (const a of anchors) {
    const href = attr(a, "href");
    if (!href || href.startsWith("#")) continue;
    const url = resolveHttpUrl(href, base);
    if (!url) continue;
    const anc = ancestors(a);
    const region = regionOf(a, anc, hasLandmarks);
    const dedupKey = `${region}|${url}`;
    const pos = index++;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    if (out.length >= max) break;

    const text = collapse(a.textContent ?? "") || collapse(attr(a, "aria-label")) || collapse(attr(a, "title")) || collapse(a.querySelector("img")?.getAttribute("alt") ?? "");
    const wordCount = text ? text.split(/\s+/).length : 0;
    const anchorQuality = !text ? "none" : WEAK_ANCHOR.test(text) || text.length < 2 ? "weak" : wordCount >= 3 && wordCount <= 12 ? "strong" : "ok";
    const container = containerOf(a);
    const dens = densityOf(container);
    const target = new URL(url);
    const path = target.pathname + target.search;
    const urlShape: LinkFeatures["urlShape"] = DOWNLOAD_EXT.test(path)
      ? "download"
      : CHROME_URL.test(path)
        ? "chrome"
        : PAGINATION_URL.test(path)
          ? "pagination"
          : target.searchParams.size > 3
            ? "query_heavy"
            : "ok";
    const dir = pageUrl.pathname.replace(/[^/]*$/, "");
    const samePrefix = target.host === pageUrl.host && dir.length > 1 && target.pathname.startsWith(dir);
    const relTokens: string[] = attr(a, "rel").toLowerCase().split(/\s+/);
    const nofollow = relTokens.some((r) => r === "nofollow" || r === "sponsored" || r === "ugc");
    const isInternal = registrableDomain(target.hostname) === pageDomain;

    const frac = anchors.length > 1 ? pos / (anchors.length - 1) : 0;
    let adjust = 0;
    if (dens > 0.6 && region === "content") adjust -= 0.04;
    if (anchorQuality === "strong") adjust += 0.03;
    else if (anchorQuality === "weak" || anchorQuality === "none") adjust -= 0.04;
    if (region === "content" && frac < 0.33) adjust += 0.02;
    if (urlShape !== "ok") adjust -= 0.06;
    if (samePrefix) adjust += 0.02;
    if (nofollow) adjust -= 0.04;
    if (!isInternal) adjust -= 0.03;
    adjust = Math.max(ADJUST_MIN, Math.min(ADJUST_MAX, adjust));
    const baseScore = REGION_BASE[region];
    const score = Math.round((baseScore + adjust) * 1000) / 1000;

    let context = "";
    const ct = container ? containerText.get(container) ?? collapse(container.textContent ?? "") : "";
    if (ct) {
      const at = text ? ct.indexOf(text) : -1;
      const start = Math.max(0, (at < 0 ? 0 : at) - 80);
      context = ct.slice(start, start + 200);
    }
    out.push({
      url, anchorText: text.slice(0, 200), context, region, score,
      features: { region, base: baseScore, density: Math.round(dens * 1000) / 1000, anchorWords: wordCount, anchorQuality, position: Math.round(frac * 1000) / 1000, urlShape, samePrefix, adjust: Math.round(adjust * 1000) / 1000 },
      isInternal, relNofollow: nofollow, position: pos,
    });
  }
  return out;
}

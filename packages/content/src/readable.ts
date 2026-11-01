import { Readability } from "@mozilla/readability";
import { Defuddle } from "defuddle/node";
import { domList } from "./dom.js";
import { parseHTML } from "linkedom";
import { guardHtml, type HtmlLimits } from "./html.js";
import { sanitiseReaderHtml } from "./reader.js";

export type ExtractionMethod = "readability" | "defuddle" | "body_text" | "none";

export interface ReadableOptions {
  url: string;
  limits?: Partial<HtmlLimits>;
  /** Below this many characters an extraction counts as failed. Default 200. */
  minChars?: number;
  /** Readability results shorter than this also get a defuddle second opinion. Default 1200. */
  secondOpinionBelow?: number;
  /** Test hook: which engines may run, in order. Default both. */
  engines?: ("readability" | "defuddle")[];
}

export interface ReadableResult {
  method: ExtractionMethod;
  title: string | null;
  byline: string | null;
  siteName: string | null;
  excerpt: string | null;
  articleHtml: string;
  /** Plain text of the reader-sanitised article (what search and the content hash use). */
  text: string;
  wordCount: number;
  candidates: { method: ExtractionMethod; textLength: number }[];
  /** Set when the page was refused before parsing: too_large, too_many_nodes or too_deep. */
  rejected?: string;
}

export class ExtractionRejected extends Error {
  constructor(readonly reason: string) {
    super(`The page was not parsed: ${reason}`);
  }
}

const words = (t: string) => (t ? t.split(/\s+/).filter(Boolean).length : 0);

/** linkedom + Readability, with defuddle as the second opinion and the body text as the last resort. */
export async function extractReadable(html: string, opts: ReadableOptions): Promise<ReadableResult> {
  const guard = guardHtml(html, opts.limits);
  if (!guard.ok) throw new ExtractionRejected(guard.reason);
  const minChars = opts.minChars ?? 200;
  const below = opts.secondOpinionBelow ?? 1200;
  const engines = opts.engines ?? ["readability", "defuddle"];

  type Cand = { method: ExtractionMethod; articleHtml: string; text: string; title: string | null; byline: string | null; siteName: string | null; excerpt: string | null };
  const cands: Cand[] = [];
  const measure = (articleHtml: string) => sanitiseReaderHtml(articleHtml, opts.url).text;

  if (engines.includes("readability")) {
    try {
      const { document } = parseHTML(html);
      const art = new Readability(document as never, { charThreshold: 100, keepClasses: false }).parse();
      if (art?.content) {
        cands.push({
          method: "readability", articleHtml: art.content, text: measure(art.content), title: art.title?.trim() || null,
          byline: art.byline?.trim() || null, siteName: art.siteName?.trim() || null, excerpt: art.excerpt?.trim() || null,
        });
      }
    } catch {
      /* fall through to the next engine */
    }
  }
  const first = cands[0];
  if (engines.includes("defuddle") && (!first || first.text.length < Math.max(minChars, below))) {
    try {
      const { document } = parseHTML(html);
      const r = await Defuddle(document as never, opts.url, { markdown: false });
      if (r?.content) {
        cands.push({
          method: "defuddle", articleHtml: r.content, text: measure(r.content), title: r.title?.trim() || null,
          byline: r.author?.trim() || null, siteName: r.site?.trim() || null, excerpt: r.description?.trim() || null,
        });
      }
    } catch {
      /* fall through */
    }
  }

  const summary = cands.map((c) => ({ method: c.method, textLength: c.text.length }));
  // Prefer Readability when it is long enough; otherwise the longer of the two; otherwise the body text.
  let best: Cand | undefined = first && first.text.length >= minChars ? first : undefined;
  if (!best) best = [...cands].sort((a, b) => b.text.length - a.text.length).find((c) => c.text.length >= minChars);
  if (!best) {
    const { document } = parseHTML(html);
    for (const el of domList(document.querySelectorAll("script, style, noscript, nav, header, footer, aside, form, iframe, svg, template"))) el.remove();
    const root = document.body ?? document.documentElement;
    let body = root?.innerHTML ?? "";
    let text = measure(body);
    if (!text) {
      // linkedom loses the body of some malformed documents; parse5 follows the HTML spec.
      body = html;
      text = measure(body);
    }
    best = { method: text ? "body_text" : "none", articleHtml: body, text, title: null, byline: null, siteName: null, excerpt: null };
    summary.push({ method: best.method, textLength: text.length });
  }
  return {
    method: best.method, title: best.title, byline: best.byline, siteName: best.siteName, excerpt: best.excerpt,
    articleHtml: best.articleHtml, text: best.text, wordCount: words(best.text), candidates: summary,
  };
}

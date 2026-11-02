import { createHash } from "node:crypto";
import { normaliseUrl, tryNormaliseUrl, TRACKING_PARAMS } from "@ncb/fetch";

/**
 * Provider data is untrusted. Everything an adapter returns passes through here before anything else sees it:
 * HTML becomes plain text, URLs are validated, and the canonical key used for de-duplication is computed.
 */

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "...", lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', copy: "(c)", middot: "·",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,8});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(cp) || cp < 0x20 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return " ";
      return String.fromCodePoint(cp);
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

function stripTags(s: string): string {
  let out = s;
  // Whole blocks whose content is never text.
  out = out.replace(/<(script|style|iframe|object|embed|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  out = out.replace(/<!--[\s\S]*?-->/g, " ").replace(/<![^>]*>/g, " ").replace(/<\?[\s\S]*?\?>/g, " ");
  // Any remaining tag, including unterminated ones at the end of the string.
  for (let i = 0; i < 4 && /<\/?[a-z!][^>]*(>|$)/i.test(out); i++) out = out.replace(/<\/?[a-z!][^>]*(>|$)/gi, " ");
  return out;
}

/** HTML in, plain text out: no tags (even after entity decoding), no control characters, collapsed whitespace, clamped. */
export function htmlToText(input: unknown, max = 400): string {
  if (typeof input !== "string") return "";
  let s = stripTags(input.slice(0, 20_000));
  s = decodeEntities(s);
  // A payload encoded as entities decodes to tags; strip those too so the result is never markup.
  s = stripTags(s);
  // Control and invisible characters go, and so do stray angle brackets: provider text is shown as text, never as markup.
  s = s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]/gu, " ").replace(/\s+/g, " ").trim();
  if (s.length > max) s = s.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
  return s;
}

/** Escapes text for HTML and wraps case-insensitive matches of the terms in <mark>. The only markup it can produce. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function highlight(text: string, terms: string[]): string {
  const clean = [...new Set(terms.map((t) => t.trim()).filter((t) => t.length >= 2))].slice(0, 12);
  if (!clean.length) return escapeHtml(text);
  const re = new RegExp(`(${clean.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.split(re).map((part, i) => (i % 2 === 1 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part))).join("");
}

export interface CheckedUrl {
  /** The address to show and open: http(s), no fragment, no credentials. */
  url: string;
  /** Dedup key: tracking parameters stripped; Wikipedia articles become `wikipedia:<lang>:<Title>`. */
  key: string;
  host: string;
}

/** The address to show: tracking parameters and the fragment removed, so the same page looks the same whichever provider found it. */
function cleanHref(href: string): string {
  const u = new URL(href);
  for (const k of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.some((p) => (typeof p === "string" ? p === k : p.test(k)))) u.searchParams.delete(k);
  }
  u.hash = "";
  return u.href;
}

const WIKI = /^([a-z]{2,3}(?:-[a-z0-9]+)*)(?:\.m)?\.wikipedia\.org$/i;

/** Validates a provider URL. Returns null for anything that is not a plain http(s) address. */
export function checkResultUrl(raw: unknown): CheckedUrl | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 2048 || /[\p{Cc}\s]/u.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password || !u.hostname) return null;
  const n = tryNormaliseUrl(u.href, { queryPolicy: "strip_tracking" });
  if (!n) return null;
  const wiki = WIKI.exec(u.hostname);
  if (wiki && u.pathname.startsWith("/wiki/") && u.pathname.length > 6) {
    let title = u.pathname.slice(6);
    try { title = decodeURIComponent(title); } catch { /* keep */ }
    return { url: cleanHref(n.fetchUrl), key: `wikipedia:${wiki[1]!.toLowerCase()}:${title.replace(/ /g, "_")}`, host: u.hostname.toLowerCase() };
  }
  return { url: cleanHref(n.fetchUrl), key: n.key, host: u.hostname.toLowerCase() };
}

/** The key for a URL already trusted (a local page). */
export function canonicalKey(url: string): string {
  const c = checkResultUrl(url);
  if (c) return c.key;
  try { return normaliseUrl(url, { queryPolicy: "strip_tracking" }).key; } catch { return url; }
}

export const resultKey = (canonical: string): string => "k_" + createHash("sha1").update(canonical).digest("hex").slice(0, 16);

export const displayDomain = (host: string): string => host.replace(/^www\./, "");

export function inferType(url: string): "html" | "pdf" | "image" {
  let p = "";
  try { p = new URL(url).pathname.toLowerCase(); } catch { /* html */ }
  if (p.endsWith(".pdf")) return "pdf";
  if (/\.(png|jpe?g|gif|webp|avif|svg)$/.test(p)) return "image";
  return "html";
}

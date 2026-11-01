/// <reference path="./css-tree.d.ts" />
import { parse } from "parse5";
import type * as csstree from "css-tree";
// The package root pulls in the full lexer, which loads JSON through createRequire and cannot be bundled
// into the worker. The parser and walker entry points have no such dependency.
import cssParse from "css-tree/parser";
import cssWalk from "css-tree/walker";
import { resolveHttpUrl } from "./url.js";

export type AssetRole = "stylesheet" | "image" | "font" | "media" | "icon" | "other";

export interface DiscoveredAsset {
  /** Absolute http(s) URL, fragment removed. */
  url: string;
  role: AssetRole;
  /** Where it was found, for debugging: `img[src]`, `link[stylesheet]`, `css:url`, `css:import`. */
  via: string;
  /** True for a CSS `@import`: the target is a stylesheet and is scanned in turn. */
  isImport?: boolean;
}

interface PNode {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: PNode[];
}

const MAX_CSS_BYTES = 2 * 1024 * 1024;

const FONT_EXT = /\.(woff2?|ttf|otf|eot)(?:[?#]|$)/i;
const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)(?:[?#]|$)/i;

export function roleForCssUrl(url: string, inFontFace: boolean): AssetRole {
  if (inFontFace || FONT_EXT.test(url)) return "font";
  if (IMG_EXT.test(url)) return "image";
  return "other";
}

/** `url()` and `@import` references of a stylesheet, resolved against `baseUrl` (the stylesheet's own URL). */
export function discoverCssRefs(css: string, baseUrl: string): DiscoveredAsset[] {
  if (css.length > MAX_CSS_BYTES) css = css.slice(0, MAX_CSS_BYTES);
  const out: DiscoveredAsset[] = [];
  const seen = new Set<string>();
  const add = (raw: string, role: AssetRole, via: string, isImport = false) => {
    const url = resolveHttpUrl(raw, baseUrl);
    if (!url) return;
    const key = `${isImport ? "i" : "u"}|${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url, role, via, ...(isImport ? { isImport: true } : {}) });
  };
  let ast: csstree.CssNode;
  try {
    ast = cssParse(css, { positions: false, onParseError: () => undefined });
  } catch {
    return out;
  }
  cssWalk(ast, function (node) {
    if (node.type === "Atrule" && node.name.toLowerCase() === "import" && node.prelude && node.prelude.type === "AtrulePrelude") {
      const first = node.prelude.children.first;
      if (first?.type === "Url") add(first.value, "stylesheet", "css:import", true);
      else if (first?.type === "String") add(first.value, "stylesheet", "css:import", true);
      return cssWalk.skip;
    }
    if (node.type === "Url") {
      const inFont = (this as unknown as { atrule?: { name: string } }).atrule?.name.toLowerCase() === "font-face";
      add(node.value, roleForCssUrl(node.value, inFont), "css:url");
    }
    return undefined;
  });
  return out;
}

function parseSrcset(v: string): string[] {
  return v
    .split(/,\s+|,$/)
    .map((c) => c.trim().split(/\s+/)[0]?.replace(/,+$/, "") ?? "")
    .filter(Boolean);
}

/** Sub-resources of an HTML document: img, source, video poster, link, srcset and inline CSS. */
export function discoverHtmlAssets(html: string, pageUrl: string): DiscoveredAsset[] {
  const doc = parse(html) as unknown as PNode;
  const out: DiscoveredAsset[] = [];
  let base = pageUrl;
  const seen = new Set<string>();

  const find = (n: PNode, pred: (x: PNode) => boolean): PNode | undefined => {
    if (pred(n)) return n;
    for (const c of n.childNodes ?? []) {
      const r = find(c, pred);
      if (r) return r;
    }
    return undefined;
  };
  const baseEl = find(doc, (n) => n.tagName === "base" && !!n.attrs?.some((a) => a.name === "href"));
  const bh = baseEl?.attrs?.find((a) => a.name === "href")?.value;
  if (bh) base = resolveHttpUrl(bh, pageUrl) ?? pageUrl;

  const add = (raw: string | undefined, role: AssetRole, via: string) => {
    if (!raw) return;
    const url = resolveHttpUrl(raw, base);
    if (!url) return;
    const key = `${role}|${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url, role, via });
  };
  const addCss = (css: string) => {
    for (const r of discoverCssRefs(css, base)) {
      const key = `${r.role}|${r.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  };

  const text = (n: PNode) => (n.childNodes ?? []).map((c) => c.value ?? "").join("");
  const walk = (n: PNode, parentTag: string | undefined) => {
    const tag = n.tagName;
    if (tag) {
      const a = (k: string) => n.attrs?.find((x) => x.name === k)?.value;
      switch (tag) {
        case "img":
          add(a("src"), "image", "img[src]");
          add(a("data-src"), "image", "img[data-src]");
          for (const s of parseSrcset(a("srcset") ?? "")) add(s, "image", "img[srcset]");
          for (const s of parseSrcset(a("data-srcset") ?? "")) add(s, "image", "img[data-srcset]");
          break;
        case "source":
          if (parentTag === "picture") {
            add(a("src"), "image", "source[src]");
            for (const s of parseSrcset(a("srcset") ?? "")) add(s, "image", "source[srcset]");
          } else {
            add(a("src"), "media", "source[src]");
          }
          break;
        case "video":
          add(a("poster"), "image", "video[poster]");
          add(a("src"), "media", "video[src]");
          break;
        case "audio":
          add(a("src"), "media", "audio[src]");
          break;
        case "link": {
          const rel = (a("rel") ?? "").toLowerCase().split(/\s+/);
          const as = (a("as") ?? "").toLowerCase();
          if (rel.includes("stylesheet")) add(a("href"), "stylesheet", "link[stylesheet]");
          else if (rel.some((r) => r === "icon" || r === "apple-touch-icon" || r === "apple-touch-icon-precomposed" || r === "mask-icon")) add(a("href"), "icon", "link[icon]");
          else if (rel.includes("preload") || rel.includes("prefetch")) {
            if (as === "style") add(a("href"), "stylesheet", "link[preload]");
            else if (as === "font") add(a("href"), "font", "link[preload]");
            else if (as === "image") add(a("href"), "image", "link[preload]");
          }
          break;
        }
        case "style":
          addCss(text(n));
          break;
        default:
      }
      const style = a("style");
      if (style && /url\(|@import/i.test(style)) addCss(style);
    }
    const kids = (n as PNode & { content?: PNode }).content?.childNodes ?? n.childNodes ?? [];
    for (const c of kids) walk(c, tag ?? parentTag);
  };
  walk(doc, undefined);
  return out;
}

import { defaultTreeAdapter, parse, parseFragment, serialize, html as P5, type DefaultTreeAdapterMap, type Token } from "parse5";
import {
  GLOBAL_ATTRS, HTML_DROP, HTML_ELEMENTS, HTML_UNWRAP_ALWAYS, INPUT_TYPES, META_NAMES, SVG_ATTRS, SVG_ELEMENTS, SVG_UNWRAP, linkKind,
} from "./allowlist.js";
import { rewriteCss, rewriteInlineStyle, type CssOptions } from "./css.js";
import type { LinkResolution, LinkState, ResourceKind, RewriteCallbacks, SanitizeStats } from "./types.js";
import { DEFAULT_MAX_DATA_URI_BYTES, TRANSPARENT_PIXEL, isHttp, parseHttpBase, resolveUrl, safeDataImage } from "./url.js";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];
type TextNode = DefaultTreeAdapterMap["textNode"];

const A = defaultTreeAdapter;
const NS = P5.NS;

export interface SanitizeOptions extends RewriteCallbacks {
  /** The page's final URL. Relative references resolve against it (or against a `<base href>`). */
  baseUrl: string;
  maxDataUriBytes?: number;
  /** Trusted markup added after sanitising: `head` at the end of `<head>`, `bodyStart` at the start of `<body>`. */
  inject?: { head?: string; bodyStart?: string };
  /** Return only the children of `<body>` (for reader content that is wrapped by the caller). */
  bodyOnly?: boolean;
  /** Re-parse the output and check it contains no script-capable construct (default true). */
  verify?: boolean;
}

export interface SanitizeResult {
  html: string;
  title: string;
  stats: SanitizeStats;
}

const EMPTY_STATS = (): SanitizeStats => ({ removedElements: 0, removedAttributes: 0, missingResources: 0, rewrittenLinks: 0 });

interface State {
  opts: SanitizeOptions;
  base: URL;
  stats: SanitizeStats;
  cssOpts: CssOptions;
}

// --- attribute helpers ------------------------------------------------------------------------------------------

function getAttr(el: Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

function textOf(el: Element): string {
  let out = "";
  for (const c of el.childNodes) if (A.isTextNode(c)) out += c.value;
  return out;
}

function isSafeUrlFreeValue(v: string): boolean {
  return !/url\s*\(|javascript:|vbscript:|expression\s*\(|@import/i.test(v);
}

/** Splits a `srcset` into candidates without trusting commas inside URLs (a URL ends at whitespace). */
export function parseSrcset(value: string): { url: string; descriptor: string }[] {
  const out: { url: string; descriptor: string }[] = [];
  let i = 0;
  const n = value.length;
  while (i < n) {
    while (i < n && /[\s,]/.test(value[i]!)) i++;
    if (i >= n) break;
    let start = i;
    while (i < n && !/\s/.test(value[i]!)) i++;
    let url = value.slice(start, i);
    let descriptor = "";
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      start = i;
      let depth = 0;
      while (i < n) {
        const ch = value[i]!;
        if (ch === "(") depth++;
        else if (ch === ")") depth = Math.max(0, depth - 1);
        else if (ch === "," && depth === 0) break;
        i++;
      }
      descriptor = value.slice(start, i).trim();
      if (i < n) i++;
    }
    if (url) out.push({ url, descriptor: descriptor.replace(/[^0-9a-zA-Z.\s]/g, "") });
  }
  return out;
}

function resourceHref(raw: string, kind: ResourceKind, st: State, allowData: boolean): string | null {
  const t = raw.trim();
  if (t === "") return null;
  if (/^data:/i.test(t.replace(/[\t\n\r ]/g, ""))) return allowData ? safeDataImage(t, st.opts.maxDataUriBytes ?? DEFAULT_MAX_DATA_URI_BYTES) : null;
  const abs = resolveUrl(t, st.base);
  if (!abs || !isHttp(abs)) return null;
  return st.opts.resource ? st.opts.resource(abs.href, kind) : null;
}

function linkFor(raw: string, st: State, rawFragmentOnly: boolean): { href: string; state?: LinkState } | "unsupported" | null {
  const t = raw.trim();
  if (t.startsWith("#")) return rawFragmentOnly ? { href: t } : null;
  const abs = resolveUrl(t, st.base);
  if (!abs) return null;
  if (!isHttp(abs)) return "unsupported";
  // A link to the page itself with a fragment stays a plain fragment link.
  if (abs.hash && abs.href.slice(0, abs.href.length - abs.hash.length) === st.base.href.replace(/#.*$/, "")) return { href: abs.hash };
  const res: LinkResolution | null = st.opts.link ? st.opts.link(abs.href) : null;
  if (!res) return null;
  return { href: res.href, state: res.state };
}

// --- HTML attribute cleaning -------------------------------------------------------------------------------------

function setAttr(el: Element, name: string, value: string): void {
  const existing = el.attrs.find((a) => a.name === name);
  if (existing) existing.value = value;
  else el.attrs.push({ name, value });
}

function cleanHtmlAttrs(el: Element, tag: string, st: State): void {
  const out: Token.Attribute[] = [];
  let linkState: LinkState | undefined;
  for (const attr of el.attrs) {
    const name = attr.name.toLowerCase();
    const value = attr.value;
    const drop = () => { st.stats.removedAttributes++; };
    if (attr.namespace || name.startsWith("on") || name.startsWith("xmlns") || name.includes(":")) { drop(); continue; }

    if (name.startsWith("data-")) {
      // Inert, but not allowed to carry URLs or to spoof our own link-state attribute.
      if (name.startsWith("data-ncb-") || /[a-z][a-z0-9+.-]*:|\/\/|[<>]/i.test(value) || value.length > 512) { drop(); continue; }
      out.push({ name, value });
      continue;
    }
    if (name.startsWith("aria-")) { out.push({ name, value }); continue; }

    switch (name) {
      case "style": {
        const css = rewriteInlineStyle(value, st.cssOpts);
        if (css) out.push({ name, value: css });
        else drop();
        continue;
      }
      case "href": {
        if (tag === "a" || tag === "area") {
          const r = linkFor(value, st, true);
          if (r === "unsupported") linkState = "unsupported";
          else if (r) {
            out.push({ name, value: r.href });
            if (r.state) { linkState = r.state; st.stats.rewrittenLinks++; }
          } else if (st.opts.link && !value.trim().startsWith("#") && (() => { const u = resolveUrl(value, st.base); return !!u && isHttp(u); })()) {
            linkState = "unavailable";
          }
          if (r === null || r === "unsupported") drop();
          continue;
        }
        drop();
        continue;
      }
      case "src": {
        if (["img", "source", "video", "audio", "track", "input"].includes(tag)) {
          if (tag === "input" && (getAttr(el, "type") ?? "").toLowerCase() !== "image") { drop(); continue; }
          const kind: ResourceKind = tag === "img" || tag === "input" ? "image" : "media";
          const h = resourceHref(value, kind, st, tag === "img");
          if (h) out.push({ name, value: h });
          else {
            st.stats.missingResources++;
            if (tag === "img") out.push({ name, value: TRANSPARENT_PIXEL });
            drop();
          }
          continue;
        }
        drop();
        continue;
      }
      case "poster": {
        const h = tag === "video" ? resourceHref(value, "image", st, true) : null;
        if (h) out.push({ name, value: h });
        else { st.stats.missingResources++; drop(); }
        continue;
      }
      case "srcset": {
        if (tag !== "img" && tag !== "source") { drop(); continue; }
        const kept: string[] = [];
        for (const c of parseSrcset(value)) {
          const h = resourceHref(c.url, "image", st, true);
          if (h) kept.push(c.descriptor ? `${h} ${c.descriptor}` : h);
          else st.stats.missingResources++;
        }
        if (kept.length) out.push({ name, value: kept.join(", ") });
        else drop();
        continue;
      }
      case "rel":
      case "target":
      case "content":
      case "charset":
      case "list":
      case "autoplay":
      case "download":
      case "ping":
      case "formaction":
      case "action":
        drop();
        continue;
      case "type": {
        if (tag === "input") {
          const t = value.trim().toLowerCase();
          if (INPUT_TYPES.has(t)) out.push({ name, value: t });
          else drop();
        } else if (tag === "button") {
          drop();
        } else if (/^[a-z0-9]{1,16}$/i.test(value)) out.push({ name, value });
        else drop();
        continue;
      }
      case "value": {
        if (tag === "input" && (getAttr(el, "type") ?? "").toLowerCase() === "password") { drop(); continue; }
        out.push({ name, value });
        continue;
      }
      default:
        if (GLOBAL_ATTRS.has(name) && isSafeUrlFreeValue(value)) out.push({ name, value });
        else drop();
    }
  }
  el.attrs = out;
  if (linkState) setAttr(el, "data-ncb-link", linkState);
  if (tag === "button") setAttr(el, "type", "button");
}

// --- tree walking ------------------------------------------------------------------------------------------------

function removeNode(n: Node): void {
  A.detachNode(n as DefaultTreeAdapterMap["childNode"]);
}

function replaceWithChildren(parent: ParentNode, el: Element, kids: DefaultTreeAdapterMap["childNode"][]): void {
  const idx = parent.childNodes.indexOf(el as DefaultTreeAdapterMap["childNode"]);
  parent.childNodes.splice(idx, 1);
  for (const k of kids) (k as { parentNode: ParentNode | null }).parentNode = parent;
  parent.childNodes.splice(idx, 0, ...kids);
}

function cleanChildren(parent: ParentNode, st: State, inSvg: boolean): void {
  for (const child of [...parent.childNodes]) {
    if (A.isCommentNode(child)) { removeNode(child); continue; }
    if (A.isTextNode(child)) continue;
    if (!A.isElementNode(child)) { removeNode(child); continue; } // doctype handled by the caller; PI, CDATA gone
    cleanElement(parent, child, st, inSvg);
  }
}

function cleanElement(parent: ParentNode, el: Element, st: State, inSvg: boolean): void {
  const ns = el.namespaceURI;
  if (ns === NS.HTML) return cleanHtmlElement(parent, el, st);
  if (ns === NS.SVG) return cleanSvgElement(parent, el, st);
  st.stats.removedElements++; // MathML and anything else
  removeNode(el);
  void inSvg;
}

function unwrap(parent: ParentNode, el: Element, st: State): void {
  cleanChildren(el, st, false);
  replaceWithChildren(parent, el, [...el.childNodes]);
}

function cleanHtmlElement(parent: ParentNode, el: Element, st: State): void {
  const tag = el.tagName.toLowerCase();
  if (HTML_DROP.has(tag)) { st.stats.removedElements++; removeNode(el); return; }
  if (HTML_UNWRAP_ALWAYS.has(tag)) { unwrap(parent, el, st); return; }
  if (!HTML_ELEMENTS.has(tag)) {
    // Unknown or deprecated elements keep their children (custom elements, <marquee>, <blink>).
    st.stats.removedElements++;
    unwrap(parent, el, st);
    return;
  }

  switch (tag) {
    case "style": {
      const css = rewriteCss(textOf(el), st.cssOpts);
      el.childNodes = [];
      if (!css.trim()) { st.stats.removedElements++; removeNode(el); return; }
      A.insertText(el, css);
      el.attrs = el.attrs.filter((a) => a.name === "media").map((a) => ({ name: "media", value: isSafeUrlFreeValue(a.value) ? a.value : "all" }));
      return;
    }
    case "link": {
      const kind = linkKind(getAttr(el, "rel") ?? "");
      const href = getAttr(el, "href");
      const h = kind && href !== undefined ? resourceHref(href, kind, st, false) : null;
      if (!kind || !h) {
        if (kind) st.stats.missingResources++;
        st.stats.removedElements++;
        removeNode(el);
        return;
      }
      const media = getAttr(el, "media");
      const sizes = getAttr(el, "sizes");
      el.attrs = [
        { name: "rel", value: kind === "css" ? "stylesheet" : "icon" },
        { name: "href", value: h },
        ...(media && isSafeUrlFreeValue(media) ? [{ name: "media", value: media }] : []),
        ...(sizes && /^[0-9x ]+$/i.test(sizes) ? [{ name: "sizes", value: sizes }] : []),
      ];
      return;
    }
    case "meta": {
      const name = (getAttr(el, "name") ?? "").toLowerCase();
      const content = getAttr(el, "content");
      if (!META_NAMES.has(name) || content === undefined || !isSafeUrlFreeValue(content)) {
        st.stats.removedElements++;
        removeNode(el);
        return;
      }
      el.attrs = [{ name: "name", value: name }, { name: "content", value: content }];
      return;
    }
    case "input": {
      const type = (getAttr(el, "type") ?? "text").toLowerCase();
      if (type === "hidden" || type === "image" || !INPUT_TYPES.has(type)) { st.stats.removedElements++; removeNode(el); return; }
      break;
    }
    default:
  }

  cleanHtmlAttrs(el, tag, st);
  if (tag === "head" || tag === "html" || tag === "body") el.attrs = el.attrs.filter((a) => ["class", "id", "lang", "dir", "style", "bgcolor"].includes(a.name));
  cleanChildren(el, st, false);
}

const SVG_NAME = new Map<string, string>();

function cleanSvgElement(parent: ParentNode, el: Element, st: State): void {
  const tag = el.tagName.toLowerCase();
  if (SVG_UNWRAP.has(tag)) { unwrap(parent, el, st); return; }
  if (!SVG_ELEMENTS.has(tag)) { st.stats.removedElements++; removeNode(el); return; }
  void SVG_NAME;

  const out: Token.Attribute[] = [];
  for (const attr of el.attrs) {
    const full = (attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name).toLowerCase();
    const value = attr.value;
    if (full.startsWith("on") || !SVG_ATTRS.has(full)) { st.stats.removedAttributes++; continue; }
    if (full === "style") {
      const css = rewriteInlineStyle(value, st.cssOpts);
      if (css) out.push({ ...attr, value: css });
      continue;
    }
    if (full === "href" || full === "xlink:href") {
      const v = value.trim();
      if (tag === "use" && /^#[\w.:-]+$/.test(v)) out.push({ ...attr, value: v });
      else if (tag === "image") {
        const h = resourceHref(v, "image", st, true);
        if (h) out.push({ ...attr, value: h });
        else st.stats.missingResources++;
      } else st.stats.removedAttributes++;
      continue;
    }
    if (full === "xmlns" || full === "xmlns:xlink") continue; // the serialiser knows the namespaces
    // Paint, clip, mask, filter and marker attributes may only reference things in the same document.
    if (/url\s*\(/i.test(value) && !/^\s*url\(\s*['"]?#[\w.:-]+['"]?\s*\)\s*[\w#()., %-]*$/i.test(value)) { st.stats.removedAttributes++; continue; }
    if (!isSafeUrlFreeValue(value) && !/^\s*url\(\s*['"]?#/i.test(value)) { st.stats.removedAttributes++; continue; }
    out.push(attr);
  }
  el.attrs = out;
  cleanChildren(el, st, true);
}

// --- document level ---------------------------------------------------------------------------------------------

function findFirst(node: ParentNode, test: (e: Element) => boolean): Element | undefined {
  for (const c of node.childNodes) {
    if (A.isElementNode(c)) {
      if (test(c)) return c;
      const r = findFirst(c, test);
      if (r) return r;
    }
  }
  return undefined;
}

/** The effective base: the first `<base href>` with an http(s) URL, resolved against the page URL. */
function effectiveBase(doc: ParentNode, pageUrl: URL): URL {
  const base = findFirst(doc, (e) => e.namespaceURI === NS.HTML && e.tagName === "base" && getAttr(e, "href") !== undefined);
  if (!base) return pageUrl;
  const r = resolveUrl(getAttr(base, "href")!, pageUrl.href);
  return r && isHttp(r) ? r : pageUrl;
}

function injectMarkup(target: Element, markup: string, atStart: boolean): void {
  const frag = parseFragment(markup);
  const nodes = [...frag.childNodes];
  for (const n of nodes) (n as { parentNode: ParentNode | null }).parentNode = target;
  if (atStart) target.childNodes.unshift(...nodes);
  else target.childNodes.push(...nodes);
}

/** Findings of the output verifier. Exported for tests and for defence in depth at the call site. */
export function findViolations(markup: string): string[] {
  const doc = parse(markup, { scriptingEnabled: false });
  const found: string[] = [];
  const walk = (n: ParentNode) => {
    for (const c of n.childNodes) {
      if (!A.isElementNode(c)) {
        if (A.isCommentNode(c)) found.push("comment");
        continue;
      }
      const tag = c.tagName.toLowerCase();
      if (c.namespaceURI !== NS.HTML && c.namespaceURI !== NS.SVG) found.push(`namespace:${tag}`);
      if (c.namespaceURI === NS.HTML && (HTML_DROP.has(tag) || tag === "noscript" || tag === "base")) found.push(`element:${tag}`);
      if (c.namespaceURI === NS.SVG && !SVG_ELEMENTS.has(tag)) found.push(`svg-element:${tag}`);
      if (c.namespaceURI === NS.HTML && tag === "meta" && getAttr(c, "http-equiv") !== undefined) found.push("meta-http-equiv");
      for (const a of c.attrs) {
        const nm = a.name.toLowerCase();
        if (nm.startsWith("on")) found.push(`attr:${nm}`);
        if (nm === "srcdoc" || nm === "formaction" || nm === "action") found.push(`attr:${nm}`);
        if (/^\s*(javascript|vbscript|livescript):/i.test(a.value.replace(/[\t\n\r\u0000-\u001f]/g, ""))) found.push(`js-url:${nm}`);
        if (nm === "target" && /^_(top|parent)$/i.test(a.value)) found.push("target-top");
      }
      walk(c);
    }
  };
  walk(doc);
  return found;
}

const FALLBACK = '<!DOCTYPE html><html><head></head><body><p>This page could not be displayed safely.</p></body></html>';

export function sanitizeHtml(input: string, opts: SanitizeOptions): SanitizeResult {
  const pageUrl = parseHttpBase(opts.baseUrl) ?? new URL("http://invalid.invalid/");
  const stats = EMPTY_STATS();
  const doc = parse(input, { scriptingEnabled: false });
  const title = findFirst(doc, (e) => e.namespaceURI === NS.HTML && e.tagName === "title");
  const titleText = title ? textOf(title).replace(/\s+/g, " ").trim().slice(0, 300) : "";
  const base = effectiveBase(doc, pageUrl);
  const st: State = {
    opts, base, stats,
    cssOpts: { baseUrl: base.href, resource: opts.resource, maxDataUriBytes: opts.maxDataUriBytes },
  };

  doc.childNodes = doc.childNodes.filter((c) => A.isElementNode(c) || A.isDocumentTypeNode(c));
  const root = doc.childNodes.find(A.isElementNode) as Element | undefined;
  if (!root) return { html: FALLBACK, title: titleText, stats };
  // Normalise the doctype so output never depends on the input's (quirks-mode triggers aside, it is always html5).
  doc.childNodes = doc.childNodes.filter((c) => !A.isDocumentTypeNode(c));
  const dt = { nodeName: "#documentType", name: "html", publicId: "", systemId: "", parentNode: doc } as unknown as DefaultTreeAdapterMap["childNode"];
  doc.childNodes.unshift(dt);

  for (const c of [...doc.childNodes]) if (A.isElementNode(c)) cleanElement(doc, c, st, false);
  const htmlEl = doc.childNodes.find(A.isElementNode) as Element | undefined;
  if (!htmlEl) return { html: FALLBACK, title: titleText, stats };
  const head = htmlEl.childNodes.find((c): c is Element => A.isElementNode(c) && c.tagName === "head");
  let body = htmlEl.childNodes.find((c): c is Element => A.isElementNode(c) && c.tagName === "body");
  if (!body) {
    // A frameset document has no body; the browser would add one on parse, so add it here to keep the output a fixpoint.
    const b = A.createElement("body", NS.HTML, []);
    A.appendChild(htmlEl, b);
    body = b;
  }
  if (head) injectMarkup(head, '<meta charset="utf-8">', true);
  if (opts.inject?.head && head) injectMarkup(head, opts.inject.head, false);
  if (opts.inject?.bodyStart && body) injectMarkup(body, opts.inject.bodyStart, true);

  // A parser-built tree does not always survive serialise-then-parse (misnested <p> in tables, forms and so on).
  // Re-parse until the markup is a fixpoint, so what the browser builds is what was checked.
  let out = serialize(doc);
  let settled = false;
  for (let i = 0; i < 4 && !settled; i++) {
    const again = serialize(parse(out, { scriptingEnabled: false }));
    settled = again === out;
    out = again;
  }
  if (!settled) return { html: FALLBACK, title: titleText, stats };
  if (opts.verify !== false && findViolations(out).length) return { html: FALLBACK, title: titleText, stats };
  if (opts.bodyOnly) {
    const final = parse(out, { scriptingEnabled: false });
    const b2 = findFirst(final, (e) => e.namespaceURI === NS.HTML && e.tagName === "body");
    out = b2 ? serialize(b2) : "";
  }
  return { html: out, title: titleText, stats };
}

/** Every http(s) link and sub-resource URL the page refers to, for one batched lookup before `sanitizeHtml`. */
export function collectUrls(input: string, baseUrl: string): { links: string[]; resources: string[] } {
  const links = new Set<string>();
  const resources = new Set<string>();
  sanitizeHtml(input, {
    baseUrl,
    verify: false,
    link: (u) => { links.add(u); return null; },
    resource: (u) => { resources.add(u); return null; },
  });
  return { links: [...links], resources: [...resources] };
}

/**
 * Sanitises a standalone SVG file. Returns null when no `<svg>` element is found. The output is XML-safe enough
 * for `image/svg+xml` (named entities are written numerically).
 */
export function sanitizeSvgDocument(input: string, opts: SanitizeOptions): string | null {
  const pageUrl = parseHttpBase(opts.baseUrl) ?? new URL("http://invalid.invalid/");
  const doc = parse(`<!DOCTYPE html><html><body>${input.replace(/^\s*<\?xml[^>]*>/i, "").replace(/<!DOCTYPE[^>]*(\[[\s\S]*?\])?\s*>/i, "")}`, { scriptingEnabled: false });
  const svg = findFirst(doc, (e) => e.namespaceURI === NS.SVG && e.tagName === "svg");
  if (!svg) return null;
  const st: State = {
    opts, base: pageUrl, stats: EMPTY_STATS(),
    cssOpts: { baseUrl: pageUrl.href, resource: opts.resource, maxDataUriBytes: opts.maxDataUriBytes },
  };
  const holder = A.createDocumentFragment();
  A.appendChild(holder as unknown as ParentNode, svg);
  cleanChildren(holder, st, true);
  const clean = holder.childNodes.find(A.isElementNode) as Element | undefined;
  if (!clean) return null;
  setAttr(clean, "xmlns", "http://www.w3.org/2000/svg");
  if (clean.childNodes.some((c) => A.isElementNode(c) && c.tagName === "use")) setAttr(clean, "xmlns:xlink", "http://www.w3.org/1999/xlink");
  return serialize(holder).replace(/&nbsp;/g, "&#160;");
}

export type { TextNode };

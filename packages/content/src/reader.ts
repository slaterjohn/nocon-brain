import { parseFragment } from "parse5";
import { resolveHttpUrl } from "./url.js";

/**
 * Reader HTML sanitiser (task A-08). A strict allowlist applied to parse5's tree; the output string is
 * written by this module from allowlisted nodes only, so nothing from the source markup is passed through.
 * The full original-mode sanitiser (stage 11, task A-12) is owned by the rendering code and is a separate,
 * larger allowlist. This one is deliberately small: reader mode shows text, headings, lists, tables, links
 * and images, and nothing that can execute, submit, embed or restyle.
 *
 * Allowlist (documented in packages/content/README.md):
 *   elements   p br hr h1-h6 ul ol li dl dt dd blockquote pre code em strong b i u s del ins sub sup small mark
 *              abbr cite q kbd samp var time a img figure figcaption table caption thead tbody tfoot tr th td
 *              div span section article address details summary wbr
 *   attributes a[href] img[src alt width height] td/th[colspan rowspan] ol[start] time[datetime] abbr[title]
 *              h1-h6[id] (the generated anchor) and [lang] [dir] on any element
 *   URLs       only absolute http(s) after resolving against the page URL; everything else is dropped
 * Elements outside the list are unwrapped (children kept) unless they are in DROP, which removes the
 * element and its children (script, style, iframe, object, embed, form controls, svg, math, template, ...).
 */

export const READER_ELEMENTS: ReadonlySet<string> = new Set(
  ("p br hr h1 h2 h3 h4 h5 h6 ul ol li dl dt dd blockquote pre code em strong b i u s del ins sub sup small mark abbr cite q kbd samp var " +
    "time a img figure figcaption table caption thead tbody tfoot tr th td div span section article address details summary wbr").split(" "),
);
const DROP = new Set(
  ("script style iframe frame frameset object embed applet noscript template svg math canvas audio video source track map area " +
    "form input button select option optgroup textarea label fieldset legend datalist output meter progress dialog link meta base head title " +
    "param portal slot nav").split(" "),
);
const VOID = new Set(["br", "hr", "img", "wbr"]);
const BLOCK = new Set(
  ("p h1 h2 h3 h4 h5 h6 ul ol li dl dt dd blockquote pre figure figcaption table caption thead tbody tfoot tr div section article address details summary hr").split(" "),
);
const ATTRS: Record<string, readonly string[]> = {
  a: ["href"], img: ["src", "alt", "width", "height"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan"], ol: ["start"], time: ["datetime"], abbr: ["title"],
};

export interface ReaderHeading {
  level: number;
  text: string;
  anchor: string;
  /** Offset into `text` where the heading starts. */
  offset: number;
}

export interface ReaderResult {
  html: string;
  text: string;
  headings: ReaderHeading[];
  /** Links and images that were kept. */
  stats: { links: number; images: number; droppedElements: number };
}

/** A stable, URL-safe fragment identifier for a heading. */
export function slugify(text: string): string {
  const s = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return s || "section";
}

const MARK = "\uE000";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => esc(s).replace(/"/g, "&quot;");

interface PNode {
  nodeName: string;
  tagName?: string;
  value?: string;
  data?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: PNode[];
  content?: PNode;
}

function textOf(n: PNode): string {
  if (n.nodeName === "#text") return n.value ?? "";
  if (n.tagName && DROP.has(n.tagName)) return "";
  return (n.childNodes ?? []).map(textOf).join("");
}

/** @param baseUrl the page URL that relative links and image sources are resolved against */
export function sanitiseReaderHtml(html: string, baseUrl: string): ReaderResult {
  const root = parseFragment(html) as unknown as PNode;
  const out: string[] = [];
  const text: string[] = [];
  let textLen = 0;
  const headings: ReaderHeading[] = [];
  const used = new Map<string, number>();
  const stats = { links: 0, images: 0, droppedElements: 0 };

  const emitText = (s: string) => {
    if (!s) return;
    text.push(s);
    textLen += s.length;
  };
  const breakBlock = () => {
    const last = text[text.length - 1];
    if (last !== undefined && !last.endsWith("\n\n")) emitText("\n\n");
  };

  const walk = (n: PNode, inPre: boolean) => {
    if (n.nodeName === "#text") {
      const v = n.value ?? "";
      out.push(esc(v));
      if (inPre) emitText(v);
      else {
        const collapsed = v.replace(/\s+/g, " ");
        const last = text[text.length - 1];
        emitText(last === undefined || last === MARK || last.endsWith("\n") || last.endsWith(" ") ? collapsed.replace(/^ /, "") : collapsed);
      }
      return;
    }
    if (n.nodeName === "#comment" || n.nodeName === "#documentType") return;
    const name = n.tagName;
    if (!name) {
      for (const c of n.childNodes ?? []) walk(c, inPre);
      return;
    }
    if (DROP.has(name)) {
      stats.droppedElements++;
      return;
    }
    const children = name === "template" ? n.content?.childNodes ?? [] : n.childNodes ?? [];
    if (!READER_ELEMENTS.has(name)) {
      // unwrap: keep the children, drop the element
      const block = BLOCK.has(name);
      if (block) breakBlock();
      for (const c of children) walk(c, inPre);
      if (block) breakBlock();
      return;
    }

    const attrs: string[] = [];
    const get = (k: string) => n.attrs?.find((a) => a.name === k)?.value;
    for (const k of ATTRS[name] ?? []) {
      let v = get(k);
      if (v === undefined) continue;
      if (k === "href" || k === "src") {
        const abs = resolveHttpUrl(v, baseUrl);
        if (!abs) continue;
        v = abs;
      } else if (k === "colspan" || k === "rowspan" || k === "start" || k === "width" || k === "height") {
        if (!/^\d{1,4}$/.test(v.trim())) continue;
        v = v.trim();
      } else if (k === "datetime") {
        if (!/^[\d\-:TZ+.\s]{4,40}$/.test(v)) continue;
      } else v = v.slice(0, 500);
      attrs.push(`${k}="${escAttr(v)}"`);
    }
    for (const k of ["lang", "dir"]) {
      const v = get(k);
      if (v && /^[A-Za-z0-9\-]{1,16}$/.test(v)) attrs.push(`${k}="${escAttr(v)}"`);
    }
    if (name === "img") {
      if (!attrs.some((a) => a.startsWith("src="))) {
        // lazy-loaded images keep the real URL in data-src or the first srcset candidate
        const lazy = get("data-src") ?? get("data-original") ?? get("srcset")?.trim().split(/[\s,]+/)[0];
        const abs = lazy ? resolveHttpUrl(lazy, baseUrl) : null;
        if (!abs) {
          stats.droppedElements++;
          return;
        }
        attrs.unshift(`src="${escAttr(abs)}"`);
      }
      stats.images++;
    }
    if (name === "a") {
      if (!attrs.some((a) => a.startsWith("href="))) {
        for (const c of children) walk(c, inPre); // an anchor without a safe href is just its text
        return;
      }
      stats.links++;
    }

    let heading: ReaderHeading | undefined;
    if (/^h[1-6]$/.test(name)) {
      const label = textOf(n).replace(/\s+/g, " ").trim();
      if (!label) return; // empty heading: skip entirely
      const base = slugify(label);
      const count = (used.get(base) ?? 0) + 1;
      used.set(base, count);
      const anchor = count === 1 ? base : `${base}-${count}`;
      attrs.push(`id="${escAttr(anchor)}"`);
      breakBlock();
      heading = { level: Number(name[1]), text: label.slice(0, 300), anchor, offset: 0 };
      headings.push(heading);
      emitText(MARK); // position marker, replaced by an offset once the text is normalised
    } else if (BLOCK.has(name)) breakBlock();

    out.push(`<${name}${attrs.length ? " " + attrs.join(" ") : ""}>`);
    if (name === "br") emitText("\n");
    if (!VOID.has(name)) {
      const pre = inPre || name === "pre";
      for (const c of children) walk(c, pre);
      out.push(`</${name}>`);
    }
    if (name === "td" || name === "th") emitText(" ");
    if (BLOCK.has(name) || heading) breakBlock();
  };
  walk(root, false);

  const raw = text
    .join("")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  let plain = "";
  let hi = 0;
  for (const ch of raw) {
    if (ch === MARK) {
      if (hi < headings.length) headings[hi++]!.offset = plain.length;
    } else plain += ch;
  }
  return { html: out.join(""), text: plain, headings, stats };
}

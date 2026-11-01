/** Decoding and size/shape guards for untrusted HTML. */

export interface DecodedText {
  text: string;
  charset: string;
}

function labelFrom(contentType: string | undefined): string | undefined {
  const m = /charset\s*=\s*["']?([\w:.\-]+)/i.exec(contentType ?? "");
  return m?.[1]?.toLowerCase();
}

/** BOM first, then the Content-Type charset, then a `<meta charset>` prescan of the first 2 KiB, then UTF-8. */
export function decodeHtml(bytes: Uint8Array, contentType?: string): DecodedText {
  let label: string | undefined;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) label = "utf-8";
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) label = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) label = "utf-16be";
  label ??= labelFrom(contentType);
  if (!label) {
    const head = Buffer.from(bytes.subarray(0, 2048)).toString("latin1");
    const m = /<meta[^>]+charset\s*=\s*["']?\s*([\w:.\-]+)/i.exec(head);
    label = m?.[1]?.toLowerCase();
  }
  for (const l of [label, "utf-8"]) {
    if (!l) continue;
    try {
      return { text: new TextDecoder(l, { fatal: false }).decode(bytes), charset: l };
    } catch {
      /* unknown label: try the next */
    }
  }
  return { text: Buffer.from(bytes).toString("utf8"), charset: "utf-8" };
}

export interface HtmlLimits {
  /** Largest document handed to a DOM parser. Default 5 MiB. */
  maxBytes: number;
  /** Rough upper bound on element count. Default 400,000. */
  maxNodes: number;
  /** Deepest allowed element nesting. Default 512 (the HTML parser limit in browsers). */
  maxDepth: number;
}

export const DEFAULT_HTML_LIMITS: HtmlLimits = { maxBytes: 5 * 1024 * 1024, maxNodes: 400_000, maxDepth: 512 };

export type HtmlGuardResult = { ok: true; nodes: number; depth: number } | { ok: false; reason: "too_large" | "too_many_nodes" | "too_deep" };

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr", "param"]);
// Elements whose end tag is optional: they are not counted as nesting, or a page of unclosed <p> would look deep.
const OPTIONAL_END = new Set(["p", "li", "dt", "dd", "tr", "td", "th", "thead", "tbody", "tfoot", "option", "optgroup", "colgroup", "caption", "html", "head", "body"]);

/** Scans tags without building a DOM, so a hostile page is rejected before a parser sees it. */
export function guardHtml(html: string, limits: Partial<HtmlLimits> = {}): HtmlGuardResult {
  const l = { ...DEFAULT_HTML_LIMITS, ...limits };
  if (html.length > l.maxBytes) return { ok: false, reason: "too_large" };
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
  let lower: string | undefined;
  let nodes = 0;
  let depth = 0;
  let maxDepth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const name = m[2]!.toLowerCase();
    if (m[1]) {
      if (!OPTIONAL_END.has(name)) depth = Math.max(0, depth - 1);
      continue;
    }
    nodes++;
    if (nodes > l.maxNodes) return { ok: false, reason: "too_many_nodes" };
    if (VOID.has(name) || m[3]!.endsWith("/") || OPTIONAL_END.has(name)) continue;
    if (name === "script" || name === "style") {
      // Skip the raw-text body so markup-looking text inside scripts is not counted.
      lower ??= html.toLowerCase();
      const close = lower.indexOf(`</${name}`, re.lastIndex);
      if (close > 0) re.lastIndex = close;
      continue;
    }
    depth++;
    if (depth > maxDepth) maxDepth = depth;
    if (depth > l.maxDepth) return { ok: false, reason: "too_deep" };
  }
  return { ok: true, nodes, depth: maxDepth };
}

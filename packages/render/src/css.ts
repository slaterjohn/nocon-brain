import { generate, List, parse, type CssNode } from "css-tree";
import type { ResourceKind } from "./types.js";
import { isHttp, resolveUrl, safeDataImage } from "./url.js";

export interface CssOptions {
  /** Absolute URL of the stylesheet (or of the page for `<style>` and `style=""`). Relative URLs resolve against it. */
  baseUrl: string;
  resource?: (absUrl: string, kind: ResourceKind) => string | null;
  maxDataUriBytes?: number;
}

const MAX_CSS_BYTES = 5 * 1024 * 1024;

/** At-rules that are kept. Everything else (`@charset`, `@namespace`, `@document`, unknown) is dropped. */
const KEEP_AT_RULES = new Set([
  "media", "supports", "font-face", "keyframes", "-webkit-keyframes", "-moz-keyframes", "layer", "container", "page",
  "property", "counter-style", "font-feature-values", "scope", "starting-style", "font-palette-values", "position-try",
  "view-transition",
]);

const BLOCKED_PROPERTIES = new Set(["behavior", "-ms-behavior", "-moz-binding", "binding", "-webkit-binding", "-o-link", "-o-link-source"]);

/** Functions that can fetch or run something and are not worth supporting offline. */
const BLOCKED_FUNCTIONS = new Set(["expression", "src", "image", "element", "-moz-element", "paint", "cross-fade", "-webkit-cross-fade", "-moz-image-rect"]);

const IMAGE_SET = new Set(["image-set", "-webkit-image-set"]);

/** Text that must never survive in a value the parser could not understand, or in a custom property. */
const RISKY_RAW = /url\s*\(|expression|javascript|vbscript|behaviou?r|binding|image-set|src\s*\(|image\s*\(|element\s*\(|paint\s*\(|cross-fade|@import|\\|<|&#|data:/i;

interface Ctx extends CssOptions {
  inFontFace: boolean;
}

function lc(s: string): string {
  return s.toLowerCase();
}

function resolveCssUrl(raw: string, kind: ResourceKind, ctx: Ctx): string | null {
  const t = raw.trim();
  if (t === "") return null;
  if (t.startsWith("#")) return t; // same-document reference (SVG filter, clip-path)
  if (/^data:/i.test(t)) return kind === "font" ? null : safeDataImage(t, ctx.maxDataUriBytes);
  const abs = resolveUrl(t, ctx.baseUrl);
  if (!abs || !isHttp(abs)) return null;
  return ctx.resource ? ctx.resource(abs.href, kind) : null;
}

/** Rewrites or fails every URL found anywhere under `node`. Returns false when the segment cannot be kept. */
function cleanNode(node: CssNode, ctx: Ctx, kind: ResourceKind, inImageSet = false): boolean {
  switch (node.type) {
    case "Url": {
      const out = resolveCssUrl(node.value, kind, ctx);
      if (out === null) return false;
      node.value = out;
      return true;
    }
    case "String":
      if (inImageSet) {
        // `image-set("a.png" 1x)`: a bare string is a URL.
        const out = resolveCssUrl(node.value, kind, ctx);
        if (out === null) return false;
        node.value = out;
      }
      return true;
    case "Raw":
      return !RISKY_RAW.test(node.value);
    case "Function": {
      const name = lc(node.name);
      if (BLOCKED_FUNCTIONS.has(name)) return false;
      if (IMAGE_SET.has(name)) return cleanImageSet(node, ctx, kind);
      return cleanChildren(node, ctx, kind, false);
    }
    case "Value":
    case "Parentheses":
    case "Brackets":
      return cleanChildren(node, ctx, kind, inImageSet);
    default:
      return true;
  }
}

function cleanChildren(node: CssNode & { children: List<CssNode> }, ctx: Ctx, kind: ResourceKind, inImageSet: boolean): boolean {
  let ok = true;
  node.children.forEach((child) => {
    if (!cleanNode(child, ctx, kind, inImageSet)) ok = false;
  });
  return ok;
}

/** Splits a list of nodes at top-level commas. */
function splitCommas(nodes: CssNode[]): CssNode[][] {
  const segs: CssNode[][] = [[]];
  for (const n of nodes) {
    if (n.type === "Operator" && n.value === ",") segs.push([]);
    else segs[segs.length - 1]!.push(n);
  }
  return segs;
}

function joinCommas(segs: CssNode[][]): CssNode[] {
  const out: CssNode[] = [];
  segs.forEach((seg, i) => {
    if (i > 0) out.push({ type: "Operator", value: "," });
    out.push(...seg);
  });
  return out;
}

/** Keeps the candidates of `image-set()` that resolve. False when none do. */
function cleanImageSet(fn: CssNode & { type: "Function"; children: List<CssNode> }, ctx: Ctx, kind: ResourceKind): boolean {
  const segs = splitCommas(fn.children.toArray());
  const kept = segs.filter((seg) => seg.length > 0 && seg.every((n) => cleanNode(n, ctx, kind, true)));
  if (kept.length === 0) return false;
  fn.children = new List<CssNode>().fromArray(joinCommas(kept));
  return true;
}

function cleanDeclaration(decl: CssNode & { type: "Declaration" }, ctx: Ctx): boolean {
  const prop = lc(decl.property);
  if (BLOCKED_PROPERTIES.has(prop)) return false;
  const value = decl.value;
  const kind: ResourceKind = ctx.inFontFace ? "font" : "image";
  if (value.type === "Raw") return !RISKY_RAW.test(value.value);
  if (prop.startsWith("--")) return false; // custom properties may smuggle url() through var()
  // Comma-separated lists (multiple backgrounds, font `src` fallbacks) lose only the segments that cannot be kept.
  const segs = splitCommas(value.children.toArray());
  const kept = segs.filter((seg) => seg.length > 0 && seg.every((n) => cleanNode(n, ctx, kind)));
  if (kept.length === 0) return false;
  if (kept.length !== segs.length) value.children = new List<CssNode>().fromArray(joinCommas(kept));
  return true;
}

function cleanBlockChildren(block: CssNode & { children: List<CssNode> }, ctx: Ctx): void {
  const kept: CssNode[] = [];
  block.children.forEach((n) => {
    if (cleanStatement(n, ctx)) kept.push(n);
  });
  block.children = new List<CssNode>().fromArray(kept);
}

/** Cleans one rule, at-rule or declaration in place. Returns false to drop it. */
function cleanStatement(node: CssNode, ctx: Ctx): boolean {
  switch (node.type) {
    case "Declaration":
      return cleanDeclaration(node, ctx);
    case "Rule":
      if (node.prelude.type === "Raw" && /[<\\]|expression|javascript/i.test(node.prelude.value)) return false;
      cleanBlockChildren(node.block, ctx);
      return true;
    case "Atrule": {
      const name = lc(node.name);
      if (name === "import") return cleanImport(node, ctx);
      if (!KEEP_AT_RULES.has(name)) return false;
      if (node.prelude && node.prelude.type === "Raw" && RISKY_RAW.test(node.prelude.value)) return false;
      if (node.block) cleanBlockChildren(node.block, { ...ctx, inFontFace: name === "font-face" });
      return true;
    }
    case "Raw":
      return false;
    default:
      return true;
  }
}

function cleanImport(node: CssNode & { type: "Atrule" }, ctx: Ctx): boolean {
  const prelude = node.prelude;
  if (!prelude || prelude.type !== "AtrulePrelude") return false;
  const first = prelude.children.first;
  if (!first || (first.type !== "Url" && first.type !== "String")) return false;
  const out = resolveCssUrl(first.value, "css", ctx);
  if (out === null || out.startsWith("#") || out.startsWith("data:")) return false;
  first.value = out;
  let ok = true;
  prelude.children.forEach((c) => {
    if (c !== first && !cleanNode(c, ctx, "css")) ok = false;
  });
  return ok;
}

/** `<` can never appear in output that may be placed inside a `<style>` element. */
function finish(css: string): string {
  return css.replace(/</g, "\\3c ");
}

/** Rewrites a stylesheet. Returns "" when it cannot be parsed or is too large. */
export function rewriteCss(css: string, opts: CssOptions): string {
  if (css.length > MAX_CSS_BYTES) return "";
  try {
    const ast = parse(css.replace(/<!--|-->/g, " "), { context: "stylesheet", parseCustomProperty: false, positions: false });
    if (ast.type !== "StyleSheet") return "";
    const ctx: Ctx = { ...opts, inFontFace: false };
    const kept: CssNode[] = [];
    ast.children.forEach((n) => {
      if (cleanStatement(n, ctx)) kept.push(n);
    });
    ast.children = new List<CssNode>().fromArray(kept);
    return finish(generate(ast));
  } catch {
    return "";
  }
}

/** Rewrites the value of a `style=""` attribute. */
export function rewriteInlineStyle(style: string, opts: CssOptions): string {
  if (style.length > 256 * 1024) return "";
  try {
    const ast = parse(style, { context: "declarationList", parseCustomProperty: false, positions: false });
    if (ast.type !== "DeclarationList") return "";
    const ctx: Ctx = { ...opts, inFontFace: false };
    const kept: CssNode[] = [];
    ast.children.forEach((n) => {
      if (n.type === "Declaration" && cleanDeclaration(n, ctx)) kept.push(n);
    });
    ast.children = new List<CssNode>().fromArray(kept);
    return finish(generate(ast));
  } catch {
    return "";
  }
}

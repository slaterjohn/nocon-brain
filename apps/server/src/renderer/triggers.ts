/**
 * When to render (task C-16, docs/research/crawling-rendering.md section 2.4). Pure and deterministic: the same page
 * gives the same answer. Rendering runs only after a normal fetch and extraction, and only if the renderer is on.
 */

export type RenderReason = "source_always" | "little_text" | "empty_mount" | "no_article";
export type RenderSkip = "source_never" | "host_never" | "already_rendered" | "not_html" | "bad_status" | "text_found" | "no_trigger";

export interface TriggerInput {
  /** The fetched document, decoded. */
  html: string;
  /** Characters of extracted reader text. */
  extractedChars: number;
  /** `readability`, `defuddle`, `body_text` or `none`: how the text was found. */
  extractionMethod: string | null;
  httpStatus: number | null;
  mime: string | null;
  /** The source's `renderMode`. A capture with no source counts as `auto`. */
  renderMode: "never" | "auto" | "always";
  host: string;
  /** Hosts that are never rendered (exact or `*.suffix`). */
  neverHosts?: readonly string[];
  /** True for a version that came from the renderer. It is never rendered again. */
  rendered?: boolean;
}

export interface RenderDecision {
  render: boolean;
  reasons: RenderReason[];
  skipped?: RenderSkip;
}

/** Below this many characters of extracted text a page counts as nearly empty. */
export const LITTLE_TEXT_CHARS = 200;
/** Raw HTML larger than this, with external scripts, and almost no text, looks like a script-built page. */
export const SHELL_MIN_HTML_BYTES = 20 * 1024;
/** An empty mount node or a "turn on JavaScript" note only counts while the text stays under this. */
export const MOUNT_TEXT_CEILING = 400;
/** The article finder failed and the page still has little text. */
export const NO_ARTICLE_TEXT_CEILING = 1500;

const MOUNT_IDS = "root|app|__next|__nuxt|__svelte|react-root|q-app|main-app|ember-app|application|appRoot|mount";
// An element with a framework mount id that holds nothing but whitespace and comments.
const EMPTY_MOUNT = new RegExp(`<(div|main|section|span)\\b[^>]*\\bid\\s*=\\s*["']?(?:${MOUNT_IDS})["']?[^>]*>(?:\\s|<!--[\\s\\S]*?-->)*<\\/\\1\\s*>`, "i");
// Angular, Stencil and similar custom-element roots, empty.
const EMPTY_CUSTOM_ROOT = /<(app-root|ion-app|my-app|ng-component|vue-app)\b[^>]*>(?:\s|<!--[\s\S]*?-->)*<\/\1\s*>/i;
const NOSCRIPT_NOTE = /<noscript\b[^>]*>[\s\S]{0,400}?(?:enable|turn on|requires?|need)[^<]{0,60}javascript[\s\S]{0,400}?<\/noscript>/i;
const SCRIPT_SRC = /<script\b[^>]*\bsrc\s*=/i;

/** True when `host` matches an entry of the never-render list (`example.org` or `*.example.org`). */
export function hostIsNever(host: string, list: readonly string[] = []): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return list.some((raw) => {
    const e = raw.trim().toLowerCase();
    if (!e) return false;
    if (e.startsWith("*.")) return h.endsWith(e.slice(1)) && h.length > e.length - 1;
    return h === e;
  });
}

export function decideRender(i: TriggerInput): RenderDecision {
  const no = (skipped: RenderSkip): RenderDecision => ({ render: false, reasons: [], skipped });
  if (i.rendered) return no("already_rendered");
  if (i.renderMode === "never") return no("source_never");
  if (hostIsNever(i.host, i.neverHosts)) return no("host_never");
  const mime = (i.mime ?? "").split(";")[0]!.trim().toLowerCase();
  if (mime !== "text/html" && mime !== "application/xhtml+xml") return no("not_html");
  if (i.httpStatus === null || i.httpStatus < 200 || i.httpStatus > 299) return no("bad_status");
  if (i.renderMode === "always") return { render: true, reasons: ["source_always"] };

  const reasons: RenderReason[] = [];
  const chars = i.extractedChars;
  const bytes = Buffer.byteLength(i.html, "utf8");

  if (chars < LITTLE_TEXT_CHARS && bytes > SHELL_MIN_HTML_BYTES && SCRIPT_SRC.test(i.html)) reasons.push("little_text");
  if (chars < MOUNT_TEXT_CEILING && (EMPTY_MOUNT.test(i.html) || EMPTY_CUSTOM_ROOT.test(i.html) || NOSCRIPT_NOTE.test(i.html))) reasons.push("empty_mount");
  if ((i.extractionMethod === "body_text" || i.extractionMethod === "none") && chars < NO_ARTICLE_TEXT_CEILING && SCRIPT_SRC.test(i.html)) reasons.push("no_article");

  return reasons.length ? { render: true, reasons } : no(chars >= MOUNT_TEXT_CEILING ? "text_found" : "no_trigger");
}

import type { LinkState } from "./types.js";
import { escapeHtml } from "./url.js";

/** Static pages and CSS served by the archive listener. Pure strings; no script anywhere. */

export const BASE_CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1c1c1e;--muted:#5c5c63;--line:#d4d4d8;--accent:#1d4ed8;--warn-bg:#fef3c7;--warn-fg:#78350f}
@media (prefers-color-scheme:dark){:root{--bg:#18181b;--fg:#f4f4f5;--muted:#a1a1aa;--line:#3f3f46;--accent:#93c5fd;--warn-bg:#422006;--warn-fg:#fde68a}}
body.ncb-ui{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
.ncb-card{max-width:40rem;margin:12vh auto 0;padding:1.5rem}
.ncb-card h1{font-size:1.4rem;margin:0 0 .75rem}
.ncb-url{word-break:break-all;font-family:ui-monospace,monospace;font-size:.9rem;padding:.6rem .75rem;border:1px solid var(--line);border-radius:6px}
.ncb-actions{display:flex;flex-wrap:wrap;gap:.6rem;margin-top:1.25rem}
.ncb-btn{display:inline-block;padding:.5rem .9rem;border:1px solid var(--accent);border-radius:6px;color:var(--accent);text-decoration:none}
.ncb-btn[aria-disabled=true]{opacity:.5;border-color:var(--line);color:var(--muted)}
.ncb-muted{color:var(--muted)}
`;

/** Legend for the link states. Injected into archived pages when `browser.showLinkStates` is on. */
export const LINK_STATE_CSS = `
a[data-ncb-link=partial]{text-decoration:underline dotted}
a[data-ncb-link=partial]::after{content:" \\25D0";font-size:.75em}
a[data-ncb-link=queued]{text-decoration:underline dashed}
a[data-ncb-link=queued]::after{content:" \\23F3";font-size:.75em}
a[data-ncb-link=live-only]{text-decoration:underline dotted}
a[data-ncb-link=live-only]::after{content:" \\2197";font-size:.75em}
a[data-ncb-link=unavailable]{text-decoration:line-through;opacity:.7}
a[data-ncb-link=unsupported]{cursor:default;text-decoration:none}
`;

export const BANNER_CSS = `
.ncb-partial-banner{position:sticky;top:0;z-index:2147483647;margin:0;padding:.5rem .9rem;background:#fef3c7;color:#78350f;font:14px/1.4 system-ui,sans-serif;border-bottom:1px solid #d97706}
.ncb-partial-banner a{color:inherit;font-weight:600}
`;

function shell(title: string, body: string, bodyClass = "ncb-ui"): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${BASE_CSS}</style></head><body class="${bodyClass}">${body}</body></html>`;
}

export function linkStateStyleBlock(): string {
  return `<style data-ncb="links">${LINK_STATE_CSS}</style>`;
}

/** The banner shown on a `partial` version. `appHref` opens the app so the Human's own session is used. */
export function partialBannerHtml(missing: number, appHref?: string): string {
  const what = missing > 0 ? `${missing} ${missing === 1 ? "file was" : "files were"} not saved` : "Some files were not saved";
  const action = appHref ? ` <a href="${escapeHtml(appHref)}" target="_blank" rel="noopener noreferrer">Download the rest</a>` : "";
  return `<style data-ncb="banner">${BANNER_CSS}</style><div class="ncb-partial-banner" role="status">Partial copy: ${what}.${action}</div>`;
}

export interface ErrorPageOptions {
  status: number;
  title: string;
  message: string;
  appHref?: string;
}

export function errorPage(o: ErrorPageOptions): string {
  const link = o.appHref ? `<p><a class="ncb-btn" href="${escapeHtml(o.appHref)}" target="_blank" rel="noopener noreferrer">Open NoConBrain</a></p>` : "";
  return shell(o.title, `<main class="ncb-card"><h1>${escapeHtml(o.title)}</h1><p>${escapeHtml(o.message)}</p>${link}</main>`);
}

export interface InterstitialOptions {
  /** The URL the link points to. Shown as text; only used as a link target when http(s). */
  url: string;
  state: LinkState;
  offline: boolean;
  /** App routes (opened in a new tab so the Human's session is used). */
  queueHref?: string;
  saveHref?: string;
  /** Link to go back to the page the Human came from (an archive path). */
  backHref?: string;
}

const STATE_TEXT: Record<LinkState, string> = {
  cached: "This page is saved.",
  partial: "This page is saved, but some files are missing.",
  queued: "This page is waiting in the download queue.",
  "live-only": "This page is not in your archive.",
  unavailable: "This page is not in your archive and cannot be fetched right now.",
  unsupported: "This link cannot be opened from the archive.",
};

export function interstitialPage(o: InterstitialOptions): string {
  let isHttp = false;
  try {
    const u = new URL(o.url);
    isHttp = u.protocol === "http:" || u.protocol === "https:";
  } catch { /* not a URL */ }
  const canLive = isHttp && !o.offline;
  const live = canLive
    ? `<a class="ncb-btn" href="${escapeHtml(o.url)}" target="_blank" rel="noopener noreferrer">Open live in new tab</a>`
    : `<a class="ncb-btn" aria-disabled="true">Open live in new tab</a>`;
  const save = canLive && o.saveHref ? `<a class="ncb-btn" href="${escapeHtml(o.saveHref)}" target="_blank" rel="noopener noreferrer">Save for offline</a>` : "";
  const queue = isHttp && o.queueHref ? `<a class="ncb-btn" href="${escapeHtml(o.queueHref)}" target="_blank" rel="noopener noreferrer">Queue for download</a>` : "";
  const back = o.backHref ? `<a class="ncb-btn" href="${escapeHtml(o.backHref)}">Back</a>` : "";
  const offlineNote = o.offline
    ? `<p class="ncb-muted">NoConBrain is offline. Queue the page and it will download when the connection returns.</p>`
    : "";
  return shell(
    "Not in your archive",
    `<main class="ncb-card"><h1>${escapeHtml(STATE_TEXT[o.state])}</h1><p class="ncb-url" data-ncb-url>${escapeHtml(o.url)}</p>${offlineNote}<div class="ncb-actions">${save}${queue}${live}${back}</div></main>`,
  );
}

// --- reader ---------------------------------------------------------------------------------------------------

export interface ReaderPrefs {
  theme: "auto" | "light" | "dark";
  font: "system" | "serif" | "dyslexic";
  size: 1 | 2 | 3 | 4 | 5;
  width: "narrow" | "medium" | "wide";
}

export const DEFAULT_READER_PREFS: ReaderPrefs = { theme: "auto", font: "system", size: 3, width: "medium" };

/** Validates the allowlisted query parameters; anything else falls back to the default. */
export function parseReaderPrefs(q: URLSearchParams): ReaderPrefs {
  const pick = <T extends string>(v: string | null, allowed: readonly T[], d: T): T => (v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : d);
  const size = Number(q.get("size"));
  return {
    theme: pick(q.get("theme"), ["auto", "light", "dark"] as const, DEFAULT_READER_PREFS.theme),
    font: pick(q.get("font"), ["system", "serif", "dyslexic"] as const, DEFAULT_READER_PREFS.font),
    size: (Number.isInteger(size) && size >= 1 && size <= 5 ? size : DEFAULT_READER_PREFS.size) as ReaderPrefs["size"],
    width: pick(q.get("width"), ["narrow", "medium", "wide"] as const, DEFAULT_READER_PREFS.width),
  };
}

const FONT_STACK = {
  system: 'system-ui,-apple-system,"Segoe UI",sans-serif',
  serif: 'Georgia,"Iowan Old Style","Times New Roman",serif',
  dyslexic: '"OpenDyslexic","Atkinson Hyperlegible",Verdana,sans-serif',
} as const;
const SIZE_REM = { 1: 0.875, 2: 1, 3: 1.125, 4: 1.3, 5: 1.5 } as const;
const WIDTH_CH = { narrow: 52, medium: 68, wide: 90 } as const;

/** Preferences become CSS variables, because no script runs. */
export function readerCss(p: ReaderPrefs): string {
  const light = ":root{--r-bg:#fff;--r-fg:#1c1c1e;--r-muted:#5c5c63;--r-link:#1d4ed8}";
  const dark = ":root{--r-bg:#18181b;--r-fg:#f4f4f5;--r-muted:#a1a1aa;--r-link:#93c5fd}";
  const colours = p.theme === "light" ? light : p.theme === "dark" ? dark : `${light}@media (prefers-color-scheme:dark){${dark}}`;
  return `${colours}
:root{--r-font:${FONT_STACK[p.font]};--r-size:${SIZE_REM[p.size]}rem;--r-width:${WIDTH_CH[p.width]}ch}
body.ncb-reader{margin:0;background:var(--r-bg);color:var(--r-fg);font-family:var(--r-font);font-size:var(--r-size);line-height:1.65}
.ncb-reader main{max-width:var(--r-width);margin:0 auto;padding:2rem 1.25rem 4rem}
.ncb-reader h1{line-height:1.2}.ncb-reader a{color:var(--r-link)}.ncb-reader img{max-width:100%;height:auto}
.ncb-reader pre{overflow:auto}.ncb-reader .ncb-meta{color:var(--r-muted);font-size:.85em}`;
}

export function readerPage(o: { title: string; bodyHtml: string; prefs: ReaderPrefs; sourceUrl?: string }): string {
  const src = o.sourceUrl ? `<p class="ncb-meta">Saved from <span data-ncb-source>${escapeHtml(o.sourceUrl)}</span></p>` : "";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(o.title)}</title><style>${readerCss(o.prefs)}</style><style data-ncb="links">${LINK_STATE_CSS}</style></head><body class="ncb-reader"><main><h1>${escapeHtml(o.title)}</h1>${src}${o.bodyHtml}</main></body></html>`;
}

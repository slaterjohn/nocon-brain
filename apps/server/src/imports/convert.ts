import { marked } from "marked";
import { sanitiseReaderHtml } from "@ncb/content";
import type { PdfText } from "./pdf.js";

/** What the import operations hand back: the HTML document the pipeline will read, plus what they learned. */
export interface DerivedDocument {
  /** A complete HTML document: UTF-8, one `<article>`, nothing that executes. */
  html: string;
  title: string | null;
  /** Format-specific facts for `import_documents.info_json`. */
  info: Record<string, unknown>;
  pageCount?: number;
}

export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface Skeleton {
  title: string;
  lang?: string | null;
  author?: string | null;
  description?: string | null;
  published?: string | null;
  bodyHtml: string;
}

/** The wrapper around converted content. `<title>` and the meta tags feed the metadata stage like any web page. */
export function skeleton(s: Skeleton): string {
  const meta = [
    s.author ? `<meta name="author" content="${esc(s.author)}">` : "",
    s.description ? `<meta name="description" content="${esc(s.description.slice(0, 300))}">` : "",
    s.published ? `<meta property="article:published_time" content="${esc(s.published)}">` : "",
  ].filter(Boolean).join("\n");
  return `<!doctype html>\n<html lang="${esc(s.lang || "en")}">\n<head>\n<meta charset="utf-8">\n<title>${esc(s.title)}</title>\n${meta}\n</head>\n<body>\n<article>\n<h1>${esc(s.title)}</h1>\n${s.bodyHtml}\n</article>\n</body>\n</html>\n`;
}

/** Strips a file extension and tidies the rest into a readable title. */
export function titleFromFilename(filename: string): string {
  const base = filename.replace(/\.[A-Za-z0-9]{1,8}$/, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  return base || "Untitled document";
}

export function decodeUploadedText(data: Uint8Array): string {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2));
  const body = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3) : b;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return new TextDecoder("windows-1252").decode(body);
  }
}

/** Plain text becomes paragraphs (blank lines separate them, single line breaks are kept as `<br>`). */
export function textToDocument(text: string, filename: string): DerivedDocument {
  const normal = text.replace(/\r\n?/g, "\n");
  const blocks = normal.split(/\n{2,}/).map((b) => b.replace(/^\n+|\s+$/g, "")).filter((b) => b.trim());
  const body = blocks.map((b) => `<p>${b.split("\n").map(esc).join("<br>\n")}</p>`).join("\n");
  const title = titleFromFilename(filename);
  return { html: skeleton({ title, bodyHtml: body || "<p></p>" }), title, info: { chars: normal.length, paragraphs: blocks.length } };
}

/** Markdown (GitHub flavoured) to HTML, then through the reader allowlist so nothing active survives. */
export function markdownToDocument(md: string, filename: string, baseUrl: string): DerivedDocument {
  const source = md.replace(/\r\n?/g, "\n").replace(/^---\n([\s\S]*?)\n---\n/, "");
  const raw = marked.parse(source, { gfm: true, async: false, breaks: false }) as string;
  const clean = sanitiseReaderHtml(raw, baseUrl);
  const h1 = clean.headings.find((h) => h.level === 1)?.text?.trim();
  const title = h1 || titleFromFilename(filename);
  // The first <h1> is the title; the skeleton adds it back, so it is not repeated in the body.
  const body = h1 ? clean.html.replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/i, "") : clean.html;
  return { html: skeleton({ title, bodyHtml: body }), title, info: { headings: clean.headings.length, links: clean.stats.links, images: clean.stats.images, chars: md.length } };
}

/** PDF text to HTML: one `<section>` per page so the page number survives, paragraphs inside. */
export function pdfToDocument(pdf: PdfText, filename: string): DerivedDocument {
  const title = pdf.info.title || titleFromFilename(filename);
  const notes: string[] = [];
  if (pdf.truncated) notes.push(`<p><em>This document is long. Only the first part of its text is shown here; download the PDF for the rest.</em></p>`);
  if (pdf.pages.length > 0 && pdf.emptyPages === pdf.pages.length) {
    notes.push(`<p><em>This PDF has no text to extract. It may be scanned pages. Download the PDF to read it.</em></p>`);
  }
  const body = pdf.pages
    .map((paras, i) => (paras.length ? `<section id="page-${i + 1}" data-page="${i + 1}">\n${paras.map((p) => `<p>${esc(p)}</p>`).join("\n")}\n</section>` : ""))
    .filter(Boolean)
    .join("\n");
  const published = pdf.info.createdAt;
  return {
    html: skeleton({ title, author: pdf.info.author, description: pdf.info.subject, published, bodyHtml: [...notes, body].join("\n") }),
    title,
    pageCount: pdf.pageCount,
    info: { ...pdf.info, pageCount: pdf.pageCount, emptyPages: pdf.emptyPages, truncated: pdf.truncated, chars: pdf.chars },
  };
}

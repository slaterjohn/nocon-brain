/**
 * PDF text extraction with pdf.js (pdfjs-dist, Apache-2.0). Spike result and the alternatives that lost are in
 * docs/implementation-plan.md (C-14). It runs inside the `extract` worker thread, whose heap limit is the memory
 * guard, and is pure: bytes in, text and metadata out. Nothing here renders, runs PDF JavaScript or fetches anything.
 */

export interface PdfLimits {
  /** Pages read. More are left out and `truncated` is set. Default 3000. */
  maxPages: number;
  /** Characters of text kept. Default 8,000,000. */
  maxChars: number;
}

export const DEFAULT_PDF_LIMITS: PdfLimits = { maxPages: 3000, maxChars: 8_000_000 };

export interface PdfInfo {
  title: string | null;
  author: string | null;
  subject: string | null;
  keywords: string | null;
  creator: string | null;
  producer: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
  pdfVersion: string | null;
}

export interface PdfText {
  pageCount: number;
  info: PdfInfo;
  /** Paragraphs per page, in reading order. A page without text (a scan) has none. */
  pages: string[][];
  /** Pages with no extractable text; a PDF that is all scans has no searchable text. */
  emptyPages: number;
  truncated: boolean;
  chars: number;
}

/** Why a PDF was refused. The upload route turns these into plain-English messages. */
export type PdfRefusal = "pdf_invalid" | "pdf_encrypted" | "pdf_empty";

type TextItem = { str: string; transform: number[]; height?: number; hasEOL?: boolean };

let pdfjsPromise: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | undefined;

async function loadPdfjs() {
  pdfjsPromise ??= (async () => {
    // pdf.js prints a warning when the optional canvas package is missing. We never render, so the warning is noise.
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      // Hand pdf.js its worker code directly. Without this it would import "./pdf.worker.mjs" relative to itself, which
      // does not exist once everything is bundled into one file.
      // pdf.js ships no types for its worker build.
      // @ts-ignore TS7016 in programs that do not see a declaration for this subpath
      (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
      return await import("pdfjs-dist/legacy/build/pdf.mjs");
    } finally {
      console.warn = warn;
    }
  })();
  return pdfjsPromise;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.replace(/\0/g, "").trim().slice(0, 500) : null);

/** `D:20250106090000+01'00'` to ISO 8601. */
export function parsePdfDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?)?/.exec(v.trim());
  if (!m) return null;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", s = "00", tz] = m;
  let zone = "Z";
  if (tz && tz !== "Z") zone = `${tz.slice(0, 3)}:${tz.replace(/'/g, "").slice(3, 5) || "00"}`;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${zone}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/** Joins the items of one page into paragraphs. A gap taller than about one and a half lines starts a new paragraph. */
export function pageParagraphs(items: readonly TextItem[]): string[] {
  const paras: string[] = [];
  let cur = "";
  let prevY: number | null = null;
  let prevH = 0;
  const flush = () => {
    const t = cur.replace(/[ \t]+/g, " ").trim();
    if (t) paras.push(t);
    cur = "";
  };
  for (const it of items) {
    if (typeof it.str !== "string") continue;
    const y = it.transform?.[5] ?? 0;
    const h = Math.abs(it.height || 0) || prevH || 10;
    if (it.str === "" && !it.hasEOL) continue;
    if (prevY !== null && Math.abs(prevY - y) > h * 0.4 && it.str !== "") {
      const gap = Math.abs(prevY - y);
      if (gap > Math.max(prevH, h) * 1.9) flush();
      else if (cur.endsWith("-") && /^[a-z]/.test(it.str)) cur = cur.slice(0, -1);
      else if (cur && !cur.endsWith(" ")) cur += " ";
    }
    cur += it.str;
    if (it.str !== "") {
      prevY = y;
      prevH = h;
    }
  }
  flush();
  return paras;
}

/** Reads the text and metadata of a PDF. Throws `PdfRefused` for files that cannot be read. */
export async function extractPdfText(data: Uint8Array, limits: Partial<PdfLimits> = {}): Promise<PdfText> {
  const lim = { ...DEFAULT_PDF_LIMITS, ...limits };
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(data), // pdf.js takes ownership of the buffer it is given
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    verbosity: 0,
    stopAtErrors: false,
  });
  try {
    let doc;
    try {
      doc = await task.promise;
    } catch (e) {
      const name = (e as { name?: string }).name ?? "";
      if (name === "PasswordException") throw new PdfRefused("pdf_encrypted", "The PDF is password protected.");
      throw new PdfRefused("pdf_invalid", name === "InvalidPDFException" || name === "FormatError" || name === "MissingPDFException" ? "This is not a readable PDF file." : `The PDF could not be read (${name || "error"}).`);
    }
    const meta = (await doc.getMetadata().catch(() => null)) as { info?: Record<string, unknown>; metadata?: { get(k: string): unknown } | null } | null;
    const info = meta?.info ?? {};
    const xmpTitle = (() => { try { return meta?.metadata?.get("dc:title"); } catch { return null; } })();
    const pageCount = doc.numPages;
    if (!pageCount) throw new PdfRefused("pdf_empty", "The PDF has no pages.");
    const pages: string[][] = [];
    let chars = 0;
    let truncated = false;
    let emptyPages = 0;
    for (let i = 1; i <= Math.min(pageCount, lim.maxPages); i++) {
      const page = await doc.getPage(i);
      try {
        const content = await page.getTextContent();
        const paras = pageParagraphs(content.items as TextItem[]);
        if (paras.length === 0) emptyPages++;
        const kept: string[] = [];
        let used = 0;
        for (const p of paras) {
          if (chars + used + p.length > lim.maxChars) {
            truncated = true;
            break;
          }
          kept.push(p);
          used += p.length;
        }
        chars += used;
        pages.push(kept);
      } finally {
        page.cleanup();
      }
      if (truncated) break;
    }
    if (pageCount > lim.maxPages) truncated = true;
    return {
      pageCount,
      pages,
      emptyPages,
      truncated,
      chars,
      info: {
        title: str(info.Title) ?? str(xmpTitle),
        author: str(info.Author),
        subject: str(info.Subject),
        keywords: str(info.Keywords),
        creator: str(info.Creator),
        producer: str(info.Producer),
        createdAt: parsePdfDate(info.CreationDate),
        modifiedAt: parsePdfDate(info.ModDate),
        pdfVersion: str(info.PDFFormatVersion),
      },
    };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

export class PdfRefused extends Error {
  constructor(readonly reason: PdfRefusal, message: string) {
    super(message);
    this.name = "PdfRefused";
  }
}

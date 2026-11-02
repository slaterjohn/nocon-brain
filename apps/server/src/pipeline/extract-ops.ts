import {
  buildOutline, discoverCssRefs, discoverHtmlAssets, ExtractionRejected, extractLinks, extractMetadata, extractReadable, guardHtml,
  sanitiseReaderHtml, type HtmlLimits,
} from "@ncb/content";
import { decodeUploadedText, markdownToDocument, pdfToDocument, textToDocument } from "../imports/convert.js";
import { extractPdfText, PdfRefused, type PdfLimits } from "../imports/pdf.js";

/**
 * The operations the `extract` worker handler runs. They are pure functions of their payload, so the same
 * code runs in a worker thread (production) or in the main thread (NCB_EXTRACT_WORKERS=0, tests).
 */
export type ExtractPayload =
  | { op: "metadata"; html: string; url: string; headers?: Record<string, string>; limits?: Partial<HtmlLimits> }
  | { op: "readable"; html: string; url: string; limits?: Partial<HtmlLimits>; engines?: ("readability" | "defuddle")[] }
  | { op: "outline"; html: string; url: string }
  | { op: "reader"; html: string; url: string }
  | { op: "links"; html: string; url: string; limits?: Partial<HtmlLimits> }
  | { op: "assets"; html: string; url: string }
  | { op: "css"; css: string; url: string }
  // Document import (C-14). The bytes are the upload; the reply is a DerivedDocument.
  | { op: "import_text"; data: Uint8Array; filename: string }
  | { op: "import_markdown"; data: Uint8Array; filename: string; url: string }
  | { op: "import_pdf"; data: Uint8Array; filename: string; limits?: Partial<PdfLimits> };

export type ExtractReply = { ok: true; value: unknown } | { ok: false; rejected: string; message?: string };

export async function runExtractOp(p: ExtractPayload): Promise<ExtractReply> {
  try {
    switch (p.op) {
      case "metadata": {
        const g = guardHtml(p.html, p.limits);
        if (!g.ok) return { ok: false, rejected: g.reason };
        return { ok: true, value: extractMetadata(p.html, { url: p.url, headers: p.headers }) };
      }
      case "readable":
        return { ok: true, value: await extractReadable(p.html, { url: p.url, limits: p.limits, engines: p.engines }) };
      case "outline":
        return { ok: true, value: buildOutline(p.html, p.url) };
      case "reader":
        return { ok: true, value: sanitiseReaderHtml(p.html, p.url) };
      case "links": {
        const g = guardHtml(p.html, p.limits);
        if (!g.ok) return { ok: false, rejected: g.reason };
        return { ok: true, value: extractLinks(p.html, { url: p.url, limits: p.limits }) };
      }
      case "assets":
        return { ok: true, value: discoverHtmlAssets(p.html, p.url) };
      case "css":
        return { ok: true, value: discoverCssRefs(p.css, p.url) };
      case "import_text":
        return { ok: true, value: textToDocument(decodeUploadedText(p.data), p.filename) };
      case "import_markdown":
        return { ok: true, value: markdownToDocument(decodeUploadedText(p.data), p.filename, p.url) };
      case "import_pdf":
        return { ok: true, value: pdfToDocument(await extractPdfText(p.data, p.limits), p.filename) };
    }
  } catch (e) {
    if (e instanceof ExtractionRejected) return { ok: false, rejected: e.reason };
    if (e instanceof PdfRefused) return { ok: false, rejected: e.reason, message: e.message };
    throw e;
  }
}

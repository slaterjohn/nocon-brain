import type { ImportKind } from "@ncb/db/schema";
import { AppError } from "@ncb/shared";

/** A file the importer refuses, with a message the person can act on. `kind` is machine-readable (`details.kind`). */
export type ImportRefusal = "empty" | "unsupported_type" | "type_mismatch" | "binary_content" | "file_too_large" | "malformed_pdf" | "encrypted_pdf" | "pdf_too_complex" | "invalid_name" | "no_file";

/** An `AppError` (400 `bad_request`) whose `details.kind` says which check failed. */
export class ImportRefused extends AppError {
  constructor(readonly refusal: ImportRefusal, message: string) {
    super("bad_request", message, { kind: refusal });
    this.name = "ImportRefused";
  }
}

const EXT: Record<string, ImportKind> = {
  html: "html", htm: "html", xhtml: "html",
  pdf: "pdf",
  md: "markdown", markdown: "markdown", mdown: "markdown", mkd: "markdown",
  txt: "text", text: "text",
};
const MIME: Record<string, ImportKind> = {
  "text/html": "html", "application/xhtml+xml": "html",
  "application/pdf": "pdf", "application/x-pdf": "pdf",
  "text/markdown": "markdown", "text/x-markdown": "markdown",
  "text/plain": "text",
};
/** Types browsers send when they do not know the file. The extension decides then. */
const GENERIC = new Set(["", "application/octet-stream", "binary/octet-stream"]);

export const ACCEPTED_TYPES_TEXT = "HTML (.html, .htm), PDF (.pdf), Markdown (.md) and plain text (.txt)";

/** Signatures of common binary formats. A text-labelled file that starts with one of these is refused. */
const BINARY_MAGIC: [string, number[]][] = [
  ["a ZIP archive or Office file", [0x50, 0x4b, 0x03, 0x04]],
  ["a PNG image", [0x89, 0x50, 0x4e, 0x47]],
  ["a JPEG image", [0xff, 0xd8, 0xff]],
  ["a GIF image", [0x47, 0x49, 0x46, 0x38]],
  ["a gzip file", [0x1f, 0x8b]],
  ["a program or library", [0x7f, 0x45, 0x4c, 0x46]],
  ["a program", [0x4d, 0x5a]],
  ["a SQLite database", [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]],
  ["a document in an old Office format", [0xd0, 0xcf, 0x11, 0xe0]],
  ["a 7-Zip archive", [0x37, 0x7a, 0xbc, 0xaf]],
  ["an audio or video file", [0x00, 0x00, 0x00]],
];

const startsWith = (b: Uint8Array, sig: number[]) => b.length >= sig.length && sig.every((x, i) => b[i] === x);

/** `%PDF-` within the first 1024 bytes, as the PDF specification allows. */
export function hasPdfHeader(b: Uint8Array): boolean {
  const head = Buffer.from(b.buffer, b.byteOffset, Math.min(b.byteLength, 1024));
  return head.indexOf("%PDF-") !== -1;
}

function looksLikeText(b: Uint8Array): boolean {
  const n = Math.min(b.length, 8192);
  // UTF-16 with a BOM is text even though it has NUL bytes.
  if (n >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) return true;
  let odd = 0;
  for (let i = 0; i < n; i++) {
    const c = b[i]!;
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32 && c !== 27)) odd++;
  }
  return odd / Math.max(1, n) < 0.02;
}

export interface Detected {
  kind: ImportKind;
  /** The type the archive records, from the content and not the label. */
  mime: string;
}

const MIME_OF: Record<ImportKind, string> = { html: "text/html", pdf: "application/pdf", markdown: "text/markdown", text: "text/plain" };

/**
 * Decides what a file is from its content first and its labels second. The declared MIME type and the extension must
 * not contradict the content: a `.pdf` without a PDF header is refused as malformed, a text file that starts with the
 * bytes of a ZIP or an image is refused as binary.
 */
export function detectImport(filename: string, declaredMime: string | undefined, data: Uint8Array): Detected {
  if (data.byteLength === 0) throw new ImportRefused("empty", "That file is empty.");
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(filename)?.[1]?.toLowerCase();
  const mime = (declaredMime ?? "").split(";")[0]!.trim().toLowerCase();
  const byExt = ext ? EXT[ext] : undefined;
  const byMime = MIME[mime];
  let labelled: ImportKind | undefined = byMime ?? byExt;
  if (byMime && byExt && byMime !== byExt) {
    // text/plain is what many systems send for any text file, so the extension refines it (notes.md as text/plain).
    if (byMime === "text") labelled = byExt;
    else if (byMime === "markdown" && byExt === "text") labelled = "markdown";
    else throw new ImportRefused("type_mismatch", `The file name ends in .${ext} but the file says it is ${mime}. Check the file and try again.`);
  }

  if (!labelled) {
    if (mime && !GENERIC.has(mime)) throw new ImportRefused("unsupported_type", `Files of type ${mime} cannot be imported. Use ${ACCEPTED_TYPES_TEXT}.`);
    throw new ImportRefused("unsupported_type", `That file type cannot be imported. Use ${ACCEPTED_TYPES_TEXT}.`);
  }

  const pdf = hasPdfHeader(data);
  if (labelled === "pdf") {
    if (!pdf) throw new ImportRefused("malformed_pdf", "This file is not a readable PDF: it does not start like one.");
    return { kind: "pdf", mime: MIME_OF.pdf };
  }
  if (pdf && Buffer.from(data.buffer, data.byteOffset, 5).toString("latin1") === "%PDF-") {
    // PDF bytes under a text label: believe the bytes.
    return { kind: "pdf", mime: MIME_OF.pdf };
  }
  for (const [what, sig] of BINARY_MAGIC) {
    if (startsWith(data, sig)) throw new ImportRefused("binary_content", `This looks like ${what}, not a ${labelled === "html" ? "web page" : "text file"}.`);
  }
  if (!looksLikeText(data)) throw new ImportRefused("binary_content", "This file contains binary data, so it cannot be imported as text or a web page.");
  return { kind: labelled, mime: MIME_OF[labelled] };
}

/** A safe display name: the last path segment, no control characters, at most 200 characters. */
export function cleanFilename(raw: string | undefined): string {
  let n = (raw ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  // eslint-disable-next-line no-control-regex
  n = n.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (n.length > 200) {
    const ext = /(\.[A-Za-z0-9]{1,8})$/.exec(n)?.[1] ?? "";
    n = n.slice(0, 200 - ext.length) + ext;
  }
  return n && n !== "." && n !== ".." ? n : "";
}

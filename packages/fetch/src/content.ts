import zlib from "node:zlib";
import { Transform } from "node:stream";
import { FetchError } from "./errors";

// ---------- content-type allowlist ----------

export const DEFAULT_ALLOWED_TYPES: readonly string[] = [
  "text/html", "application/xhtml+xml", "text/css", "text/plain", "text/xml", "application/xml", "application/rss+xml",
  "application/atom+xml", "application/json", "application/ld+json", "application/pdf",
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon", "image/bmp",
  "font/*", "application/font-woff", "application/font-woff2", "application/x-font-woff", "application/vnd.ms-fontobject", "application/x-font-ttf",
  "application/gzip", "application/x-gzip",
];

export function typeAllowed(type: string | null, patterns: readonly string[]): boolean {
  if (!type) return false;
  const t = type.toLowerCase();
  return patterns.some((p) => {
    p = p.toLowerCase();
    if (p === "*/*") return true;
    if (p.endsWith("/*")) return t.startsWith(p.slice(0, -1));
    return t === p;
  });
}

export function parseContentType(header: string | undefined): { type: string | null; charset: string | null } {
  if (!header) return { type: null, charset: null };
  const [t, ...params] = header.split(";");
  const type = t!.trim().toLowerCase() || null;
  let charset: string | null = null;
  for (const p of params) {
    const m = p.trim().match(/^charset\s*=\s*"?([^";\s]+)"?$/i);
    if (m) charset = m[1]!;
  }
  return { type, charset };
}

// ---------- sniffing ----------

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, s: string, at = 0) => s.split("").every((c, i) => b[at + i] === c.charCodeAt(0));

/** Binary signatures: confident, beat any header. */
function sniffBinary(b: Uint8Array): string | null {
  if (b.length >= 8 && startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (b.length >= 3 && startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (b.length >= 6 && (ascii(b, "GIF87a") || ascii(b, "GIF89a"))) return "image/gif";
  if (b.length >= 12 && ascii(b, "RIFF") && ascii(b, "WEBP", 8)) return "image/webp";
  if (b.length >= 12 && ascii(b, "ftyp", 4) && (ascii(b, "avif", 8) || ascii(b, "avis", 8))) return "image/avif";
  if (b.length >= 4 && startsWith(b, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  if (b.length >= 2 && ascii(b, "BM") && b.length > 14 && b[6] === 0 && b[7] === 0) return "image/bmp";
  if (b.length >= 5 && ascii(b, "%PDF-")) return "application/pdf";
  if (b.length >= 4 && ascii(b, "wOFF")) return "font/woff";
  if (b.length >= 4 && ascii(b, "wOF2")) return "font/woff2";
  if (b.length >= 4 && startsWith(b, [0x00, 0x01, 0x00, 0x00])) return "font/ttf";
  if (b.length >= 4 && ascii(b, "OTTO")) return "font/otf";
  if (b.length >= 3 && startsWith(b, [0x1f, 0x8b, 0x08])) return "application/gzip";
  return null;
}

function skipBomWs(b: Uint8Array): number {
  let i = 0;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0c || b[i] === 0x0d)) i++;
  return i;
}

function sniffText(b: Uint8Array): "text/html" | "image/svg+xml" | "application/xml" | "application/json" | null {
  const i = skipBomWs(b);
  const head = Buffer.from(b.subarray(i, i + 512)).toString("latin1").toLowerCase();
  if (/^<!doctype\s+html/.test(head) || /^<(html|head|body|script|iframe|h1|div|font|table|a|style|title|b|br|p|!--)[\s>]/.test(head)) return "text/html";
  if (/^<svg[\s>]/.test(head)) return "image/svg+xml";
  if (/^<\?xml/.test(head)) {
    return /<svg[\s>]/.test(head) ? "image/svg+xml" : /<html[\s>]/.test(head) ? "text/html" : "application/xml";
  }
  if (head[0] === "{" || head[0] === "[") return "application/json";
  return null;
}

export interface Sniffed {
  /** Effective type: sniffed when the bytes disagree with a lying or missing header. */
  type: string | null;
  declared: string | null;
  sniffed: string | null;
  overridden: boolean;
}

export function sniffType(head: Uint8Array, declared: string | null): Sniffed {
  const bin = sniffBinary(head);
  const generic = !declared || declared === "application/octet-stream" || declared === "binary/octet-stream" || declared === "unknown/unknown";
  const text = bin ? null : sniffText(head);
  const sniffed = bin ?? text;
  let type = declared;
  if (bin) {
    // gzip is not trusted over a declared type (a gzip payload may be legitimate application/gzip downloads only)
    if (bin !== "application/gzip" || generic) type = bin;
    if (bin === "image/x-icon" && declared?.startsWith("image/")) type = declared;
    if (bin === "font/ttf" && declared?.includes("font")) type = declared;
    if (bin === "image/bmp" && declared?.startsWith("image/")) type = declared;
  } else if (text) {
    const decl = declared ?? "";
    if (generic || decl === "text/plain" || (decl.startsWith("image/") && decl !== "image/svg+xml")) {
      if (text === "text/html" || text === "image/svg+xml") type = text;
      else if (generic) type = text;
    } else if (decl === "text/html" && text === "application/json") {
      type = "application/json";
    } else if (decl === "text/html" && text === "application/xml") {
      type = declared;
    }
  }
  return { type, declared, sniffed, overridden: type !== declared };
}

// ---------- charset ----------

export type CharsetSource = "bom" | "header" | "meta" | "default" | "sniff";

export function canonicalCharset(label: string | null | undefined): string | null {
  if (!label) return null;
  try {
    return new TextDecoder(label.trim()).encoding;
  } catch {
    return null;
  }
}

export function detectBom(b: Uint8Array): string | null {
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return "utf-8";
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return "utf-16le";
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return "utf-16be";
  return null;
}

export function metaCharset(head: Uint8Array): string | null {
  const s = Buffer.from(head.subarray(0, 1024)).toString("latin1");
  const m1 = s.match(/<meta\s[^>]*?charset\s*=\s*["']?\s*([A-Za-z0-9_.:-]+)/i);
  if (m1) return m1[1]!;
  return null;
}

export function detectCharset(head: Uint8Array, headerCharset: string | null, isHtml: boolean): { charset: string | null; source: CharsetSource | null } {
  const bom = detectBom(head);
  if (bom) return { charset: bom, source: "bom" };
  const h = canonicalCharset(headerCharset);
  if (h) return { charset: h, source: "header" };
  if (isHtml) {
    const m = canonicalCharset(metaCharset(head));
    if (m) return { charset: m === "utf-16le" || m === "utf-16be" ? "utf-8" : m, source: "meta" };
  }
  return { charset: null, source: null };
}

/** Decodes bytes to a string, stripping a BOM. Falls back to utf-8. */
export function decodeText(buf: Uint8Array, charset: string | null): string {
  let enc = canonicalCharset(charset) ?? "utf-8";
  try {
    return new TextDecoder(enc).decode(buf);
  } catch {
    enc = "utf-8";
    return new TextDecoder(enc).decode(buf);
  }
}

export function isValidUtf8(buf: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

// ---------- content-encoding ----------

export function parseContentEncoding(header: string | undefined): string[] {
  if (!header) return [];
  return header.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s && s !== "identity");
}

/** Counts bytes. Over `max` it fails the stream, or (truncate mode) ends it after the allowed part and emits `truncated`. */
export class ByteCounter extends Transform {
  count = 0;
  truncated = false;
  constructor(private readonly max: number, private readonly make: () => Error, private readonly truncate = false) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null, d?: Buffer) => void): void {
    if (this.truncated) return cb();
    if (this.count + chunk.length > this.max) {
      if (!this.truncate) {
        this.count += chunk.length;
        return cb(this.make());
      }
      const room = this.max - this.count;
      this.count = this.max;
      this.truncated = true;
      if (room > 0) this.push(chunk.subarray(0, room));
      this.push(null);
      this.emit("truncated");
      return cb();
    }
    this.count += chunk.length;
    cb(null, chunk);
  }
}

/** Decompressors in decoding order (the last-applied encoding is undone first). */
export function decoderStages(encodings: string[], maxLayers: number): Transform[] {
  if (encodings.length > maxLayers) {
    throw new FetchError("too_many_encodings", `Content-Encoding has ${encodings.length} layers (limit ${maxLayers})`);
  }
  const stages: Transform[] = [];
  for (const enc of [...encodings].reverse()) {
    if (enc === "gzip" || enc === "x-gzip") stages.push(zlib.createGunzip());
    else if (enc === "deflate") stages.push(zlib.createInflate());
    else if (enc === "br") stages.push(zlib.createBrotliDecompress());
    else throw new FetchError("unsupported_encoding", `unsupported Content-Encoding ${enc}`);
  }
  return stages;
}

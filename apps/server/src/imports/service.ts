import { createHash } from "node:crypto";
import { registrableDomain } from "@ncb/content";
import { normaliseUrl } from "@ncb/fetch";
import { AppError } from "@ncb/shared";
import { PIPELINE_STAGES, type ImportKind } from "@ncb/db/schema";
import { ExtractionRefused, ExtractionWorkerError } from "../pipeline/extract-client.js";
import { pageByKey } from "../pipeline/stages/links.js";
import { linkPageSource } from "../sources/references.js";
import type { CaptureOptions, PipelineDeps } from "../pipeline/types.js";
import { publishCapture } from "../pipeline/progress.js";
import { DEFAULT_PDF_LIMITS } from "./pdf.js";
import type { DerivedDocument } from "./convert.js";
import { cleanFilename, detectImport, ImportRefused } from "./detect.js";

/** Imported pages live under this host. `.invalid` is reserved (RFC 2606), so it never resolves and is never fetched. */
export const IMPORT_HOST = "imports.noconbrain.invalid";

export interface ImportRequest {
  filename: string;
  /** The MIME type the client sent. Only a hint. */
  mime?: string;
  data: Buffer;
  /** Public id of an `imported_documents` source. Default: the built-in Imports source. */
  sourceId?: string;
  priority?: 1 | 2 | 3 | 4;
}

export interface ImportResult {
  downloadId: string;
  pageId: string;
  versionId: string;
  /** Re-importing the same file gives back the existing version. */
  duplicate: boolean;
  kind: ImportKind;
  filename: string;
  mime: string;
  sizeBytes: number;
  pageCount?: number;
  title: string | null;
  sourceId: string;
}

export interface ImportInfo {
  versionId: string;
  kind: ImportKind;
  filename: string;
  detectedMime: string;
  sizeBytes: number;
  pageCount: number | null;
  info: Record<string, unknown>;
  importedAt: number;
  originalSha256: string;
}

export interface ImportServiceOptions {
  deps: PipelineDeps;
  /** Largest upload, in bytes. */
  maxBytes: number;
  /** The row id of the built-in Imports source. */
  importsSourceId: () => number;
  /** A PDF that takes longer than this to read is refused. Default 60 s. */
  pdfTimeoutMs?: number;
}

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

const slug = (name: string) => encodeURIComponent(name.normalize("NFKC").replace(/\s+/g, "-").slice(0, 80)) || "document";

/**
 * Document import (task C-14). An upload becomes a page (`origin = 'import'`) with a version made by the ordinary
 * pipeline. HTML is stored as it came; Markdown, text and PDF are converted to an HTML document first (`convert.ts`)
 * and that document is what the pipeline reads. The upload's own bytes are kept in `import_documents`, so the PDF
 * can be downloaded and a better converter can re-derive the document later.
 */
export class ImportService {
  constructor(private readonly o: ImportServiceOptions) {}

  private get d(): PipelineDeps {
    return this.o.deps;
  }

  get maxBytes(): number {
    return this.o.maxBytes;
  }

  async importFile(req: ImportRequest): Promise<ImportResult> {
    const d = this.d;
    const filename = cleanFilename(req.filename);
    if (!filename) throw new ImportRefused("invalid_name", "The file has no usable name. Rename it and try again.");
    if (req.data.byteLength > this.o.maxBytes) throw new ImportRefused("file_too_large", `That file is larger than the ${Math.round(this.o.maxBytes / 1048576)} MB limit.`);
    const detected = detectImport(filename, req.mime, req.data);
    const source = this.resolveSource(req.sourceId);

    const originalSha = sha256(req.data);
    const url = `https://${IMPORT_HOST}/${originalSha.slice(0, 16)}/${slug(filename)}`;
    const derived = await this.derive(detected.kind, req.data, filename, url);
    const docBytes = detected.kind === "html" ? req.data : Buffer.from(derived!.html, "utf8");
    const docSha = detected.kind === "html" ? originalSha : sha256(docBytes);

    // Blobs first (content addressed, so a repeat upload writes nothing new). References are counted below.
    const docPut = await d.blobs.put(docBytes, { kind: "document", mime: "text/html", maxBytes: this.o.maxBytes * 2 });
    const origPut = detected.kind === "html"
      ? docPut
      : await d.blobs.put(req.data, { kind: detected.kind === "pdf" ? "pdf" : "document", mime: detected.mime, maxBytes: this.o.maxBytes });

    const key = d.urlKey(url);
    const now = d.clock.now();
    const opts: CaptureOptions = {
      priority: req.priority ?? 3, sourceId: source.id, requestedBy: "user", versioning: { mode: "latest_only" }, userInitiated: true, discoveredVia: "manual",
    };
    const out = d.db.transaction(() => {
      const existing = pageByKey({ deps: d }, key);
      if (existing?.latest_version_id) {
        const latest = d.db.get<{ id: number; public_id: string; raw_hash: string | null; status: string }>(
          "SELECT id, public_id, raw_hash, status FROM page_versions WHERE id = ?", [existing.latest_version_id]);
        if (latest && latest.raw_hash === docSha && (latest.status === "ready" || latest.status === "partial")) {
          linkPageSource(d.db, { pageId: existing.id, sourceId: source.id, now, via: "manual", depth: 0, priority: opts.priority });
          d.db.run("UPDATE pages SET last_checked_at = ? WHERE id = ?", [now, existing.id]);
          const pg = d.db.get<{ public_id: string }>("SELECT public_id FROM pages WHERE id = ?", [existing.id])!;
          const dl = d.db.get<{ public_id: string }>("SELECT d.public_id FROM page_versions v JOIN download_jobs d ON d.id = v.download_job_id WHERE v.id = ?", [latest.id]);
          return { duplicate: true as const, pageId: pg.public_id, versionId: latest.public_id, downloadId: dl?.public_id ?? "" };
        }
      }
      const norm = normaliseUrl(url, { queryPolicy: "keep_all" });
      const dlPublic = d.newId("dl");
      const dl = d.db.run(
        `INSERT INTO download_jobs (public_id, source_id, kind, state, priority, requested_url, requested_by, started_at, created_at) VALUES (?, ?, 'import', 'running', ?, ?, 'user', ?, ?)`,
        [dlPublic, source.id, opts.priority ?? 3, url, now, now]);
      const downloadJobId = Number(dl.lastInsertRowid);
      let pageRowId = existing?.id;
      let pagePublic: string;
      if (pageRowId === undefined) {
        pagePublic = d.newId("pg");
        const created = d.db.run(
          `INSERT INTO pages (public_id, url_key, canonical_url, host, registrable_domain, origin, content_type, availability, created_at) VALUES (?, ?, ?, ?, ?, 'import', ?, 'failed', ?)`,
          [pagePublic, key, norm.fetchUrl, norm.host, registrableDomain(norm.host), detected.kind === "pdf" ? "pdf" : detected.kind === "html" ? "html" : "text", now]);
        pageRowId = Number(created.lastInsertRowid);
      } else {
        pagePublic = d.db.get<{ public_id: string }>("SELECT public_id FROM pages WHERE id = ?", [pageRowId])!.public_id;
      }
      const vno = d.db.get<{ n: number }>("SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM page_versions WHERE page_id = ?", [pageRowId])!.n;
      const verPublic = d.newId("ver");
      const ins = d.db.run(
        `INSERT INTO page_versions (public_id, page_id, version_no, source_id, download_job_id, requested_url, final_url, status, http_status, raw_hash, raw_bytes, mime,
           headers_json, title, fetched_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'capturing', 200, ?, ?, 'text/html', ?, ?, ?, ?)`,
        [verPublic, pageRowId, vno, source.id, downloadJobId, url, url, docSha, docBytes.length, JSON.stringify({ "content-type": "text/html" }), derived?.title ?? filename, now, now]);
      const vid = Number(ins.lastInsertRowid);
      d.db.run(
        `INSERT INTO import_documents (version_id, page_id, source_id, kind, filename, declared_mime, detected_mime, original_blob_id, size_bytes, page_count, info_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [vid, pageRowId, source.id, detected.kind, filename, req.mime?.slice(0, 200) ?? null, detected.mime, origPut.blob.id, req.data.length, derived?.pageCount ?? null,
          derived ? JSON.stringify(derived.info) : null, now]);
      d.blobs.addRef(origPut.blob.id);
      linkPageSource(d.db, { pageId: pageRowId, sourceId: source.id, now, via: "manual", depth: 0, priority: opts.priority });
      for (const s of PIPELINE_STAGES) d.db.run("INSERT INTO pipeline_stage_runs (version_id, stage) VALUES (?, ?) ON CONFLICT DO NOTHING", [vid, s]);
      d.queue.enqueue({
        type: "process", queue: "process", versionId: vid, downloadJobId, payload: { options: opts }, idempotencyKey: `process:${vid}`,
        maxAttempts: 3, priority: 5 - (opts.priority ?? 3),
      });
      return { duplicate: false as const, pageId: pagePublic, versionId: verPublic, downloadId: dlPublic, downloadJobId };
    });
    if (!out.duplicate) {
      publishCapture(d.db, d.events, out.downloadJobId);
      d.activity.write({ level: "info", area: "pipeline", message: `Imported ${filename} (${detected.kind}, ${req.data.length} bytes)`, downloadJobId: out.downloadJobId });
    }
    const srcPublic = d.db.get<{ public_id: string }>("SELECT public_id FROM sources WHERE id = ?", [source.id])!.public_id;
    return {
      downloadId: out.downloadId, pageId: out.pageId, versionId: out.versionId, duplicate: out.duplicate, kind: detected.kind, filename, mime: detected.mime,
      sizeBytes: req.data.length, pageCount: derived?.pageCount, title: derived?.title ?? null, sourceId: srcPublic,
    };
  }

  /** What was imported for a version, or undefined when the version is not an import. */
  info(versionIdOrPublic: number | string): ImportInfo | undefined {
    const where = typeof versionIdOrPublic === "number" ? "v.id = ?" : "v.public_id = ?";
    const r = this.d.db.get<{
      public_id: string; kind: ImportKind; filename: string; detected_mime: string; size_bytes: number; page_count: number | null; info_json: string | null;
      created_at: number; sha256: string;
    }>(
      `SELECT v.public_id, i.kind, i.filename, i.detected_mime, i.size_bytes, i.page_count, i.info_json, i.created_at, b.sha256
       FROM import_documents i JOIN page_versions v ON v.id = i.version_id JOIN blobs b ON b.id = i.original_blob_id WHERE ${where}`, [versionIdOrPublic]);
    if (!r) return undefined;
    return {
      versionId: r.public_id, kind: r.kind, filename: r.filename, detectedMime: r.detected_mime, sizeBytes: r.size_bytes, pageCount: r.page_count,
      info: r.info_json ? (JSON.parse(r.info_json) as Record<string, unknown>) : {}, importedAt: r.created_at, originalSha256: r.sha256,
    };
  }

  /** The uploaded bytes of a version. */
  async original(versionIdOrPublic: number | string): Promise<{ info: ImportInfo; data: Buffer } | undefined> {
    const info = this.info(versionIdOrPublic);
    if (!info) return undefined;
    const { data } = await this.d.blobs.read(info.originalSha256);
    return { info, data };
  }

  private resolveSource(publicId: string | undefined): { id: number } {
    if (!publicId) return { id: this.o.importsSourceId() };
    const r = this.d.db.get<{ id: number; type: string; enabled: number }>("SELECT id, type, enabled FROM sources WHERE public_id = ? AND deleted_at IS NULL", [publicId]);
    if (!r) throw new AppError("not_found", "That source does not exist.");
    if (r.type !== "imported_documents") throw new AppError("bad_request", "Documents can only be imported into an imported-documents source.", { kind: "wrong_source_type" });
    if (r.enabled !== 1) throw new AppError("conflict", "This source is switched off. Turn it on before importing into it.");
    return { id: r.id };
  }

  private async derive(kind: ImportKind, data: Buffer, filename: string, url: string): Promise<DerivedDocument | undefined> {
    if (kind === "html") return undefined;
    const run = async (): Promise<DerivedDocument> => {
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (kind === "text") return this.d.extract.run<DerivedDocument>({ op: "import_text", data: bytes, filename });
      if (kind === "markdown") return this.d.extract.run<DerivedDocument>({ op: "import_markdown", data: bytes, filename, url });
      return this.d.extract.run<DerivedDocument>({ op: "import_pdf", data: bytes, filename, limits: DEFAULT_PDF_LIMITS });
    };
    const timeoutMs = this.o.pdfTimeoutMs ?? 60_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ImportRefused("pdf_too_complex", "Reading this file took too long, so it was stopped. Try a smaller or simpler file.")), timeoutMs);
        }),
      ]);
    } catch (e) {
      if (e instanceof ImportRefused) throw e;
      if (e instanceof ExtractionRefused) {
        if (e.reason === "pdf_encrypted") throw new ImportRefused("encrypted_pdf", "This PDF is password protected. Remove the password and try again.");
        if (e.reason === "pdf_empty") throw new ImportRefused("malformed_pdf", "This PDF has no pages.");
        if (e.reason === "pdf_invalid") throw new ImportRefused("malformed_pdf", e.detail ?? "This file is not a readable PDF.");
        throw new ImportRefused("malformed_pdf", e.message);
      }
      if (e instanceof ExtractionWorkerError) throw new ImportRefused("pdf_too_complex", "This file used too much memory to read, so it was stopped. Try a smaller or simpler file.");
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

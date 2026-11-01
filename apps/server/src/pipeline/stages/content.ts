import { EXTRACTOR_VERSION, type OutlineSection, type PageMetadata, type ReadableResult, type ReaderResult } from "@ncb/content";
import type { StageFn } from "../types.js";
import { ExtractionRefused } from "../extract-client.js";
import { contentHashOf, setContentBlob } from "../store.js";
import { documentHtml, stageDetail, version } from "./shared.js";

export { EXTRACTOR_VERSION };

const reasonText: Record<string, string> = { too_large: "larger than the extraction limit", too_many_nodes: "has too many elements", too_deep: "is nested too deeply" };

/** Stage 4: title, description, language, author, site name and dates (task A-07). */
export const metadata: StageFn = async (ctx) => {
  const { db, extract } = ctx.deps;
  const v = version(ctx);
  const html = await documentHtml(ctx, v);
  let m: PageMetadata | null = null;
  let rejected: string | undefined;
  try {
    m = await extract.run<PageMetadata>({ op: "metadata", html, url: v.finalUrl, headers: v.headers });
  } catch (e) {
    if (!(e instanceof ExtractionRefused)) throw e;
    rejected = e.reason;
  }
  if (!m) {
    // Too hostile to parse: keep what the headers tell us and the URL.
    db.run("UPDATE page_versions SET language = ?, metadata_json = ? WHERE id = ?", [
      (v.headers["content-language"] ?? "").split(",")[0]?.trim() || null, JSON.stringify({ rejected }), v.id,
    ]);
    return { detail: { rejected: rejected ?? "unknown", note: `The page ${reasonText[rejected ?? ""] ?? "was refused"}; metadata skipped.` } };
  }
  db.run(
    `UPDATE page_versions SET title = ?, description = ?, language = ?, author = ?, site_name = ?, published_at = ?, modified_at = ?,
       published_source = ?, published_confidence = ?, metadata_json = ? WHERE id = ?`,
    [
      m.title, m.description, m.language, m.author, m.siteName, m.published?.at ?? null, m.modified?.at ?? null,
      m.published?.source ?? "none", m.published?.confidence ?? null, JSON.stringify(m), v.id,
    ],
  );
  return { detail: { titleSource: m.titleSource, languageSource: m.languageSource, published: m.published?.source ?? "none" } };
};

interface ExtractionBlob {
  v: 1;
  method: string;
  title: string | null;
  byline: string | null;
  siteName: string | null;
  excerpt: string | null;
  articleHtml: string;
  candidates: unknown;
  rejected?: string;
}

async function readExtraction(ctx: Parameters<StageFn>[0]): Promise<ExtractionBlob> {
  const hit = ctx.cache.get("extraction") as ExtractionBlob | undefined;
  if (hit) return hit;
  const row = ctx.deps.db.get<{ sha: string }>(
    "SELECT b.sha256 AS sha FROM version_content vc JOIN blobs b ON b.id = vc.extraction_blob_id WHERE vc.version_id = ?", [ctx.versionId]);
  if (!row) throw new Error("The extraction result is missing; stage 5 has not completed.");
  const { data } = await ctx.deps.blobs.read(row.sha);
  const parsed = JSON.parse(data.toString("utf8")) as ExtractionBlob;
  ctx.cache.set("extraction", parsed);
  return parsed;
}

/** Stage 5: readable content. Readability first, defuddle as second opinion, body text last (task A-08). */
export const readable: StageFn = async (ctx) => {
  const { db, blobs, extract } = ctx.deps;
  const v = version(ctx);
  const html = await documentHtml(ctx, v);
  let r: ReadableResult | null = null;
  let rejected: string | undefined;
  try {
    r = await extract.run<ReadableResult>({ op: "readable", html, url: v.finalUrl });
  } catch (e) {
    if (!(e instanceof ExtractionRefused)) throw e;
    rejected = e.reason;
  }
  const blobData: ExtractionBlob = r
    ? { v: 1, method: r.method, title: r.title, byline: r.byline, siteName: r.siteName, excerpt: r.excerpt, articleHtml: r.articleHtml, candidates: r.candidates }
    : { v: 1, method: "none", title: null, byline: null, siteName: null, excerpt: null, articleHtml: "", candidates: [], rejected };
  const put = await blobs.put(JSON.stringify(blobData), { kind: "json", mime: "application/json" });
  setContentBlob(db, blobs, v.id, "extraction_blob_id", put.blob.id);
  db.run("UPDATE version_content SET extraction_method = ? WHERE version_id = ?", [blobData.method, v.id]);
  const text = r?.text ?? "";
  // Without extractable text the raw hash still lets change detection work.
  const contentHash = text ? contentHashOf(text) : (v.rawHash ?? contentHashOf(""));
  db.run("UPDATE page_versions SET content_hash = ?, word_count = ? WHERE id = ?", [contentHash, r?.wordCount ?? 0, v.id]);
  ctx.cache.set("extraction", blobData);
  return { detail: { method: blobData.method, candidates: blobData.candidates, words: r?.wordCount ?? 0, ...(rejected ? { rejected } : {}) } };
};

/** Stage 6: headings and sections with stable anchors. */
export const sections: StageFn = async (ctx) => {
  const { db, blobs, extract } = ctx.deps;
  const v = version(ctx);
  const ex = await readExtraction(ctx);
  const outline = ex.articleHtml ? await extract.run<{ v: 1; sections: OutlineSection[] }>({ op: "outline", html: ex.articleHtml, url: v.finalUrl }) : { v: 1 as const, sections: [] };
  const put = await blobs.put(JSON.stringify(outline), { kind: "json", mime: "application/json" });
  setContentBlob(db, blobs, v.id, "outline_blob_id", put.blob.id);
  return { detail: { sections: outline.sections.length } };
};

/** Stage 10: reader HTML (strict allowlist) and plain-text blobs. */
export const reader: StageFn = async (ctx) => {
  const { db, blobs, extract } = ctx.deps;
  const v = version(ctx);
  const ex = await readExtraction(ctx);
  const r = ex.articleHtml ? await extract.run<ReaderResult>({ op: "reader", html: ex.articleHtml, url: v.finalUrl }) : { html: "", text: "", headings: [], stats: { links: 0, images: 0, droppedElements: 0 } };
  const rb = await blobs.put(r.html, { kind: "reader", mime: "text/html" });
  const tb = await blobs.put(r.text, { kind: "text", mime: "text/plain" });
  setContentBlob(db, blobs, v.id, "reader_blob_id", rb.blob.id);
  setContentBlob(db, blobs, v.id, "text_blob_id", tb.blob.id);
  const words = r.text ? r.text.split(/\s+/).filter(Boolean).length : 0;
  db.run("UPDATE page_versions SET word_count = ? WHERE id = ?", [words, v.id]);
  return { detail: { readerBytes: rb.blob.sizeBytes, textBytes: tb.blob.sizeBytes, ...stageDetail(ctx, "readable").rejected ? { rejected: stageDetail(ctx, "readable").rejected } : {} } };
};

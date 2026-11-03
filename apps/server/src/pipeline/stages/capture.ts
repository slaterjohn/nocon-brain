import { discoverCssRefs, decodeHtml, type DiscoveredAsset } from "@ncb/content";
import { FetchError } from "@ncb/fetch";
import type { StageContext, StageFn, StageResult } from "../types.js";
import { StageFailure } from "../types.js";
import { setDetail, version, documentHtml, blobKindFor, importKindOf } from "./shared.js";

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

/** Stage 1: status, content type, size and shape of the fetched document. */
export const validate: StageFn = (ctx): StageResult => {
  const v = version(ctx);
  if (v.httpStatus === null || v.httpStatus < 200 || v.httpStatus > 299) {
    throw new StageFailure(`The server answered ${v.httpStatus}.`, v.httpStatus !== null && v.httpStatus >= 500 ? "http_5xx" : "http_4xx");
  }
  const mime = (v.mime ?? "").split(";")[0]!.trim().toLowerCase();
  if (!HTML_TYPES.has(mime)) throw new StageFailure(`Unsupported content type "${mime || "unknown"}". Only web pages can be captured in this version.`, "parse_error");
  if (!v.rawHash || !v.rawBytes) throw new StageFailure("The server sent an empty document.", "parse_error");
  if (v.rawBytes > ctx.caps.maxDocumentBytes) throw new StageFailure(`The document is larger than the ${ctx.caps.maxDocumentBytes} byte limit.`, "size_cap");
  return { detail: { mime, bytes: v.rawBytes } };
};

export interface AssetInsert {
  url: string;
  urlKey: string;
  role: string;
  viaAssetId: number | null;
  status: "ok" | "error" | "blocked" | "skipped";
  blob?: { id: number; kind: string };
  mime?: string | null;
  httpStatus?: number | null;
  sizeBytes?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

/** Inserts the asset (once per url+blob) and this version's reference to it (once), counting the blob reference. */
export function recordAsset(ctx: StageContext, a: AssetInsert, referencedUrl: string): number {
  const { db, blobs, clock } = ctx.deps;
  return db.transaction(() => {
    const now = clock.now();
    const kind = a.blob?.kind ?? "other";
    if (a.blob) {
      db.run(
        `INSERT INTO assets (blob_id, url, url_key, kind, mime, http_status, size_bytes, status, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', ?)
         ON CONFLICT (url_key, blob_id) WHERE blob_id IS NOT NULL DO NOTHING`,
        [a.blob.id, a.url, a.urlKey, kind, a.mime ?? null, a.httpStatus ?? null, a.sizeBytes ?? null, now],
      );
    } else {
      db.run(
        `INSERT INTO assets (blob_id, url, url_key, kind, mime, http_status, size_bytes, status, error_code, error_message, fetched_at) VALUES (NULL, ?, ?, 'other', ?, ?, NULL, ?, ?, ?, ?)
         ON CONFLICT (url_key, status) WHERE blob_id IS NULL DO NOTHING`,
        [a.url, a.urlKey, a.mime ?? null, a.httpStatus ?? null, a.status, a.errorCode ?? null, (a.errorMessage ?? "").slice(0, 500), now],
      );
    }
    const row = a.blob
      ? db.get<{ id: number }>("SELECT id FROM assets WHERE url_key = ? AND blob_id = ?", [a.urlKey, a.blob.id])!
      : db.get<{ id: number }>("SELECT id FROM assets WHERE url_key = ? AND blob_id IS NULL AND status = ?", [a.urlKey, a.status])!;
    const ref = db.run(
      `INSERT INTO asset_references (version_id, asset_id, via_asset_id, role, referenced_url) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (version_id, asset_id, referenced_url) DO NOTHING`,
      [ctx.versionId, row.id, a.viaAssetId, a.role, referencedUrl],
    );
    if (ref.changes === 1 && a.blob) blobs.addRef(a.blob.id);
    return row.id;
  });
}

/** Stage 2: the original bytes become the version's document, referenced like any other asset. */
export const storeOriginal: StageFn = async (ctx) => {
  const { db, blobs } = ctx.deps;
  const v = version(ctx);
  const blob = v.rawHash ? blobs.bySha(v.rawHash) : undefined;
  if (!blob) throw new StageFailure("The fetched document is no longer in the blob store.", "internal");
  const id = recordAsset(ctx, {
    url: v.finalUrl, urlKey: ctx.deps.urlKey(v.finalUrl), role: "document", viaAssetId: null, status: "ok",
    blob: { id: blob.id, kind: "document" }, mime: v.mime, httpStatus: v.httpStatus, sizeBytes: blob.sizeBytes,
  }, v.finalUrl);
  db.run("UPDATE page_versions SET document_blob_id = ? WHERE id = ? AND document_blob_id IS NULL", [blob.id, v.id]);
  return { detail: { blob: blob.sha256, assetId: id, bytes: blob.sizeBytes } };
};

interface Pending extends DiscoveredAsset {
  depth: number;
  viaAssetId: number | null;
}

/** Stage 3: discover, fetch and store sub-resources (img, source, poster, link, srcset, CSS url() and @import). */
export const assets: StageFn = async (ctx) => {
  const { db, blobs, fetcher, urlKey } = ctx.deps;
  const v = version(ctx);
  // An uploaded file has no web address to resolve relative references against, and nothing is fetched on its behalf.
  if (importKindOf(ctx) !== null) {
    db.run("UPDATE page_versions SET total_bytes = ? WHERE id = ?", [v.rawBytes ?? 0, v.id]);
    return { detail: { skipped: "imported document: sub-resources are not fetched" } };
  }
  const html = await documentHtml(ctx, v);
  const discovered = await ctx.deps.extract.run<DiscoveredAsset[]>({ op: "assets", html, url: v.finalUrl }).catch(() => [] as DiscoveredAsset[]);

  const caps = ctx.caps;
  const queue: Pending[] = discovered.map((d) => ({ ...d, depth: 0, viaAssetId: null }));
  const done = new Map<string, number>(); // referenced url -> asset id
  const existing = db.all<{ referenced_url: string; asset_id: number }>("SELECT referenced_url, asset_id FROM asset_references WHERE version_id = ? AND role <> 'document'", [v.id]);
  for (const e of existing) done.set(e.referenced_url, e.asset_id);
  let attempted = done.size;
  let images = 0;
  let totalBytes = db.get<{ n: number }>(
    "SELECT COALESCE(SUM(a.size_bytes), 0) AS n FROM asset_references r JOIN assets a ON a.id = r.asset_id WHERE r.version_id = ? AND r.role <> 'document'", [v.id])!.n;
  const stats = { fetched: 0, reused: existing.length, failed: 0, blocked: 0, skipped: 0, capHit: false as boolean | string };
  const seen = new Set<string>(done.keys());

  const scanCss = async (assetId: number, sha: string, url: string, depth: number) => {
    if (depth >= caps.maxCssDepth) return;
    const { data } = await blobs.read(sha);
    const css = decodeHtml(data, "text/css").text;
    for (const r of discoverCssRefs(css, url)) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      queue.push({ ...r, depth: depth + 1, viaAssetId: assetId });
    }
  };

  // A single page saved by hand is not paced; background captures are (HB-05).
  const byHand = !!db.get("SELECT 1 AS x FROM page_versions v JOIN download_jobs d ON d.id = v.download_job_id WHERE v.id = ? AND d.kind = 'capture' AND d.requested_by = 'user'", [v.id]);

  const processOne = async (p: Pending) => {
    if (ctx.signal?.aborted) return;
    const known = done.get(p.url);
    if (known !== undefined) {
      // Resumed run: the asset exists. Only CSS needs its children rediscovered.
      const a = db.get<{ sha256: string | null; kind: string }>("SELECT b.sha256 AS sha256, a.kind AS kind FROM assets a LEFT JOIN blobs b ON b.id = a.blob_id WHERE a.id = ?", [known]);
      if (a?.sha256 && a.kind === "css") await scanCss(known, a.sha256, p.url, p.depth);
      return;
    }
    const key = urlKey(p.url);
    if (attempted >= caps.maxAssets || totalBytes >= caps.maxTotalAssetBytes) {
      stats.skipped++;
      stats.capHit = attempted >= caps.maxAssets ? "count" : "bytes";
      done.set(p.url, recordAsset(ctx, { url: p.url, urlKey: key, role: p.role, viaAssetId: p.viaAssetId, status: "skipped", errorCode: "cap", errorMessage: `per-capture ${stats.capHit} cap reached` }, p.url));
      return;
    }
    if (p.role === "image" && images >= caps.maxImages) {
      stats.skipped++;
      done.set(p.url, recordAsset(ctx, { url: p.url, urlKey: key, role: p.role, viaAssetId: p.viaAssetId, status: "skipped", errorCode: "images_off", errorMessage: "images are not saved for this capture" }, p.url));
      return;
    }
    attempted++;
    if (p.role === "image") images++;
    try {
      const res = await fetcher.fetch(p.url, { maxBytes: Math.min(caps.maxAssetBytes, caps.maxTotalAssetBytes - totalBytes), accept: ["*/*"], signal: ctx.signal, pace: byHand ? "none" : "asset" });
      if (res.status < 200 || res.status > 299) {
        stats.failed++;
        done.set(p.url, recordAsset(ctx, { url: p.url, urlKey: key, role: p.role, viaAssetId: p.viaAssetId, status: "error", httpStatus: res.status, errorCode: `http_${res.status}`, errorMessage: `The server answered ${res.status}.` }, p.url));
        return;
      }
      const body = Buffer.isBuffer(res.body) ? res.body : Buffer.concat(await collect(res.body));
      const mime = (res.contentType ?? "").split(";")[0]!.trim().toLowerCase() || null;
      const kind = blobKindFor(mime, p.role);
      const put = await blobs.put(body, { kind, mime: mime ?? undefined, maxBytes: caps.maxAssetBytes });
      totalBytes += put.blob.sizeBytes;
      stats.fetched++;
      const id = recordAsset(ctx, { url: p.url, urlKey: key, role: p.role, viaAssetId: p.viaAssetId, status: "ok", blob: { id: put.blob.id, kind }, mime, httpStatus: res.status, sizeBytes: put.blob.sizeBytes }, p.url);
      done.set(p.url, id);
      if (kind === "css") await scanCss(id, put.blob.sha256, p.url, p.depth);
    } catch (e) {
      const code = e instanceof FetchError ? e.code : (e as { code?: string }).code ?? "error";
      const blocked = code === "ssrf_blocked";
      if (ctx.signal?.aborted) throw e;
      if (blocked) stats.blocked++;
      else {
        stats.failed++;
        if (code === "size_cap" || code === "content_length_exceeded") stats.capHit ||= "asset_size";
      }
      done.set(p.url, recordAsset(ctx, { url: p.url, urlKey: key, role: p.role, viaAssetId: p.viaAssetId, status: blocked ? "blocked" : "error", errorCode: String(code), errorMessage: e instanceof Error ? e.message : String(e) }, p.url));
    }
  };

  // Breadth-first with bounded concurrency; CSS children are appended to the queue as they are found.
  for (const p of queue) seen.add(p.url);
  const running = new Set<Promise<void>>();
  let i = 0;
  while (i < queue.length || running.size > 0) {
    while (i < queue.length && running.size < caps.assetConcurrency) {
      const p = queue[i++]!;
      const t: Promise<void> = processOne(p).finally(() => running.delete(t));
      running.add(t);
    }
    if (running.size > 0) await Promise.race(running);
  }
  const total = db.get<{ n: number }>("SELECT COALESCE(SUM(a.size_bytes), 0) AS n FROM asset_references r JOIN assets a ON a.id = r.asset_id WHERE r.version_id = ?", [v.id])!.n;
  db.run("UPDATE page_versions SET total_bytes = ? WHERE id = ?", [total, v.id]);
  const detail = { discovered: discovered.length, ...stats, totalBytes: total };
  setDetail(ctx, "assets", detail);
  return { detail };
};

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const c of stream) out.push(Buffer.from(c as Uint8Array));
  return out;
}

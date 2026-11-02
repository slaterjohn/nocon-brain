import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import type { Clock } from "@ncb/shared";
import { AppError } from "@ncb/shared";
import type { Db } from "@ncb/db";
import { blobPathFor, VolumeUnavailableError, type VolumeRow, type VolumeService } from "./volumes.js";

export type BlobKind = "document" | "css" | "image" | "font" | "media" | "pdf" | "text" | "reader" | "json" | "other";

/** Kinds stored with zstd. Images, fonts, media and PDFs are already compressed. */
export const TEXT_KINDS: ReadonlySet<BlobKind> = new Set(["document", "css", "text", "reader", "json"]);

export interface BlobRow {
  id: number;
  sha256: string;
  sizeBytes: number;
  storedBytes: number;
  compression: "none" | "zstd";
  mime: string | null;
  kind: BlobKind;
  volumeId: number;
  refcount: number;
  zeroSince: number | null;
  state: "writing" | "ready" | "missing" | "quarantined";
  verifiedAt: number | null;
  createdAt: number;
}

interface RawBlob {
  id: number; sha256: string; size_bytes: number; stored_bytes: number; compression: "none" | "zstd"; mime: string | null;
  kind: BlobKind; volume_id: number; refcount: number; zero_since: number | null; state: BlobRow["state"];
  verified_at: number | null; created_at: number;
}

const toBlob = (r: RawBlob): BlobRow => ({
  id: r.id, sha256: r.sha256, sizeBytes: r.size_bytes, storedBytes: r.stored_bytes, compression: r.compression, mime: r.mime,
  kind: r.kind, volumeId: r.volume_id, refcount: r.refcount, zeroSince: r.zero_since, state: r.state, verifiedAt: r.verified_at,
  createdAt: r.created_at,
});

export class BlobNotFoundError extends AppError {
  constructor(sha256: string) {
    super("not_found", "That stored file does not exist.", { kind: "blob_not_found", sha256 });
    this.name = "BlobNotFoundError";
  }
}

export interface PutOptions {
  kind: BlobKind;
  mime?: string;
  /** Abort and clean up if the decoded content exceeds this many bytes. */
  maxBytes?: number;
  /** Expected size, if known, used for the free-space check. */
  sizeHint?: number;
  /** Where to write if that volume can take it (a source's preferred volume, task T-06). Otherwise the volume with most room. */
  volumeId?: number;
}

export interface PutResult {
  blob: BlobRow;
  /** True when the content was already stored and nothing new was written. */
  deduplicated: boolean;
}

export type BlobSource = Buffer | string | Uint8Array | Readable | AsyncIterable<Uint8Array | string>;

export interface BlobStoreOptions {
  db: Db;
  clock: Clock;
  volumes: VolumeService;
  /** Test hook: runs after the temp file is durable and before the rename. Throw to simulate a crash. */
  faultBeforeRename?: () => void | Promise<void>;
}

const ZSTD_LEVEL = 3;

function toReadable(src: BlobSource): Readable {
  if (src instanceof Readable) return src;
  if (typeof src === "string") return Readable.from([Buffer.from(src, "utf8")]);
  if (src instanceof Uint8Array) return Readable.from([Buffer.from(src)]);
  return Readable.from(src as AsyncIterable<Uint8Array | string>);
}

async function fsyncPath(p: string, flags = "r"): Promise<void> {
  const fh = await fsp.open(p, flags);
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Content-addressed blob store on the volumes (docs/data-model.md "blobs"). A write streams through
 * SHA-256 (and zstd for text kinds) into a temp file on the same filesystem, fsyncs it, then renames it to
 * a path derived only from the hash. The row is inserted after the rename, so a crash before the rename
 * leaves a temp file and no row; `cleanTmp` removes the leftover.
 */
export class BlobStore {
  constructor(private readonly o: BlobStoreOptions) {}

  async put(source: BlobSource, opts: PutOptions): Promise<PutResult> {
    const volume = await this.o.volumes.pickWritable(opts.sizeHint ?? 0, { preferredVolumeId: opts.volumeId });
    const tmpDir = path.join(volume.rootPath, "tmp");
    await fsp.mkdir(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, `${randomUUID()}.part`);
    const compress = TEXT_KINDS.has(opts.kind);
    const hash = createHash("sha256");
    let size = 0;

    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (opts.maxBytes !== undefined && size > opts.maxBytes) {
          cb(new AppError("insufficient_storage", `The content is larger than the ${opts.maxBytes} byte limit.`, { kind: "size_cap" }));
          return;
        }
        hash.update(chunk);
        cb(null, chunk);
      },
    });

    try {
      const stages: (NodeJS.ReadableStream | NodeJS.WritableStream)[] = [toReadable(source), tap];
      if (compress) stages.push(zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL } }));
      stages.push(fs.createWriteStream(tmp, { flags: "wx", mode: 0o640 }));
      await pipeline(stages as never);
      await fsyncPath(tmp, "r+");
      const sha = hash.digest("hex");

      // Serialised per hash with the garbage collector, so a blob is never deleted in the middle of being re-used (and the other way round).
      return await this.gate(sha, async () => {
        const existing = this.bySha(sha);
        if (existing && existing.state === "ready") {
          await fsp.rm(tmp, { force: true });
          // About to be referenced: take it off the collector's list until the caller's reference arrives (`addRef` clears it too).
          if (existing.refcount === 0) this.o.db.run("UPDATE blobs SET zero_since = NULL WHERE id = ? AND refcount = 0", [existing.id]);
          return { blob: this.bySha(sha)!, deduplicated: true };
        }

        await this.o.faultBeforeRename?.();

        const finalPath = blobPathFor(volume.rootPath, sha, compress);
        await fsp.mkdir(path.dirname(finalPath), { recursive: true });
        // A file may already be there from a crash after the rename but before the row was written, or from a
        // concurrent identical put. Same hash means same bytes, so keep it and drop ours.
        if (fs.existsSync(finalPath)) await fsp.rm(tmp, { force: true });
        else await fsp.rename(tmp, finalPath);
        await fsyncPath(path.dirname(finalPath));
        const stored = (await fsp.stat(finalPath)).size;

        const now = this.o.clock.now();
        if (existing) {
          // A row that was `missing` (its file was lost) heals when the same bytes are stored again.
          this.o.db.run("UPDATE blobs SET state = 'ready', stored_bytes = ?, volume_id = ?, zero_since = CASE WHEN refcount = 0 THEN NULL ELSE zero_since END WHERE id = ?", [stored, volume.id, existing.id]);
          return { blob: this.bySha(sha)!, deduplicated: false };
        }
        const inserted = this.o.db.run(
          `INSERT INTO blobs (sha256, size_bytes, stored_bytes, compression, mime, kind, volume_id, refcount, zero_since, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'ready', ?) ON CONFLICT(sha256) DO NOTHING`,
          [sha, size, stored, compress ? "zstd" : "none", opts.mime ?? null, opts.kind, volume.id, now, now],
        );
        return { blob: this.bySha(sha)!, deduplicated: inserted.changes === 0 };
      });
    } catch (e) {
      // Unless this is the simulated crash (which must leave the temp file behind), tidy up.
      if (!(e instanceof SimulatedCrash)) await fsp.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  bySha(sha256: string): BlobRow | undefined {
    const r = this.o.db.get<RawBlob>("SELECT * FROM blobs WHERE sha256 = ?", [sha256]);
    return r && toBlob(r);
  }

  /** Decoded content as a stream. Throws `BlobNotFoundError` or `VolumeUnavailableError`. */
  async open(sha256: string): Promise<{ stream: Readable; blob: BlobRow }> {
    const blob = this.bySha(sha256);
    if (!blob || blob.state === "quarantined") throw new BlobNotFoundError(sha256);
    const volume = this.o.volumes.byId(blob.volumeId);
    if (!volume) throw new BlobNotFoundError(sha256);
    await this.o.volumes.assertUsable(volume, "read");
    const file = blobPathFor(volume.rootPath, blob.sha256, blob.compression === "zstd");
    try {
      await fsp.access(file, fs.constants.R_OK);
    } catch {
      this.o.db.run("UPDATE blobs SET state = 'missing' WHERE id = ? AND state = 'ready'", [blob.id]);
      throw new BlobNotFoundError(sha256);
    }
    const raw = fs.createReadStream(file);
    if (blob.compression === "none") return { stream: raw, blob };
    const out = zlib.createZstdDecompress();
    raw.on("error", (e) => out.destroy(e));
    return { stream: raw.pipe(out), blob };
  }

  async read(sha256: string): Promise<{ data: Buffer; blob: BlobRow }> {
    const { stream, blob } = await this.open(sha256);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    return { data: Buffer.concat(chunks), blob };
  }

  /** Deletes the file and the row. Refused while references remain unless `force` is set. */
  async delete(sha256: string, opts: { force?: boolean } = {}): Promise<boolean> {
    const blob = this.bySha(sha256);
    if (!blob) return false;
    if (blob.refcount > 0 && !opts.force) {
      throw new AppError("conflict", "That stored file is still in use.", { kind: "blob_in_use", refcount: blob.refcount });
    }
    const volume = this.o.volumes.byId(blob.volumeId);
    if (volume) {
      await this.o.volumes.assertUsable(volume, "read"); // a missing drive must not look like a successful delete
      await fsp.rm(blobPathFor(volume.rootPath, blob.sha256, blob.compression === "zstd"), { force: true });
    }
    this.o.db.run("DELETE FROM blobs WHERE id = ?", [blob.id]);
    return true;
  }

  // ---- reference counts ----------------------------------------------------------------------
  // refcount is a cache; maintenance re-derives it from references (docs/data-model.md 4.1).

  private readonly gates = new Map<string, Promise<unknown>>();

  /** Runs `fn` after everything queued before it for the same hash. Only this process writes blobs, so this is enough. */
  async gate<T>(sha256: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.gates.get(sha256) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.gates.set(sha256, tail);
    try {
      return await run;
    } finally {
      if (this.gates.get(sha256) === tail) this.gates.delete(sha256);
    }
  }

  /**
   * Deletes a blob only if nothing references it, counted from the reference rows (never the cached `refcount`) inside the same
   * gate that `put` uses. The order is crash safe: the row is marked `quarantined` first (so nothing reads or re-uses it), then the
   * file goes, then the row. A crash in between leaves a quarantined zero-reference row that `finishPendingDeletes` completes; a
   * database row in state `ready` never points at a missing file.
   */
  async deleteIfUnreferenced(
    blobId: number, opts: { minZeroForMs?: number; hooks?: { afterMark?: () => void | Promise<void>; afterUnlink?: () => void | Promise<void> } } = {},
  ): Promise<{ deleted: boolean; bytes: number; reason?: "referenced" | "grace" | "missing" | "volume_unavailable" }> {
    const row = this.o.db.get<RawBlob>("SELECT * FROM blobs WHERE id = ?", [blobId]);
    if (!row) return { deleted: false, bytes: 0, reason: "missing" };
    return this.gate(row.sha256, async () => {
      const fresh = this.o.db.get<RawBlob>("SELECT * FROM blobs WHERE id = ?", [blobId]);
      if (!fresh) return { deleted: false, bytes: 0, reason: "missing" as const };
      const volume = this.o.volumes.byId(fresh.volume_id);
      if (!volume) return { deleted: false, bytes: 0, reason: "missing" as const };
      try {
        await this.o.volumes.assertUsable(volume, "read");
      } catch (e) {
        if (e instanceof VolumeUnavailableError) return { deleted: false, bytes: 0, reason: "volume_unavailable" as const };
        throw e;
      }
      const now = this.o.clock.now();
      const marked = this.o.db.transaction(() => {
        if (blobInUse(this.o.db, fresh.id, fresh.sha256) > 0) return "referenced" as const;
        if (fresh.state !== "quarantined" && (fresh.zero_since === null || now - fresh.zero_since < (opts.minZeroForMs ?? 0))) return "grace" as const;
        this.o.db.run("UPDATE blobs SET state = 'quarantined', refcount = 0 WHERE id = ?", [fresh.id]);
        return "ok" as const;
      });
      if (marked !== "ok") return { deleted: false, bytes: 0, reason: marked === "referenced" ? ("referenced" as const) : ("grace" as const) };
      await opts.hooks?.afterMark?.();
      await fsp.rm(blobPathFor(volume.rootPath, fresh.sha256, fresh.compression === "zstd"), { force: true });
      await opts.hooks?.afterUnlink?.();
      this.o.db.run("DELETE FROM blobs WHERE id = ? AND state = 'quarantined' AND refcount = 0", [fresh.id]);
      return { deleted: true, bytes: fresh.stored_bytes };
    });
  }

  /** Completes deletions a crash interrupted: blobs left `quarantined` with no references. Run at startup before writers. */
  async finishPendingDeletes(): Promise<number> {
    const rows = this.o.db.all<{ id: number }>("SELECT id FROM blobs WHERE state = 'quarantined' AND refcount = 0 ORDER BY id");
    let n = 0;
    for (const r of rows) if ((await this.deleteIfUnreferenced(r.id)).deleted) n++;
    return n;
  }

  addRef(blobId: number, n = 1): void {
    this.o.db.run("UPDATE blobs SET refcount = refcount + ?, zero_since = NULL WHERE id = ?", [n, blobId]);
  }

  /** Drops references; at zero, stamps `zero_since` so GC can remove the blob after the grace period. */
  release(blobId: number, n = 1): number {
    const now = this.o.clock.now();
    const row = this.o.db.get<{ refcount: number }>(
      `UPDATE blobs SET refcount = MAX(refcount - ?, 0),
         zero_since = CASE WHEN MAX(refcount - ?, 0) = 0 THEN COALESCE(zero_since, ?) ELSE NULL END
       WHERE id = ? RETURNING refcount`,
      [n, n, now, blobId],
    );
    return row?.refcount ?? 0;
  }

  /** Deletes blobs unreferenced for longer than `graceMs`. Returns how many were removed. */
  async collectGarbage(graceMs: number, volumeId?: number): Promise<number> {
    const cutoff = this.o.clock.now() - graceMs;
    const rows = this.o.db.all<RawBlob>(
      `SELECT * FROM blobs WHERE refcount = 0 AND zero_since IS NOT NULL AND zero_since <= ? ${volumeId ? "AND volume_id = ?" : ""}`,
      volumeId ? [cutoff, volumeId] : [cutoff],
    );
    let n = 0;
    for (const r of rows) if ((await this.deleteIfUnreferenced(r.id)).deleted) n++;
    return n;
  }

  // ---- temp files ----------------------------------------------------------------------------

  /** Removes `<root>/tmp/*.part` older than `olderThanMs` (0 = all, for use at startup before any writer runs). */
  async cleanTmp(volume: VolumeRow, olderThanMs = 3_600_000): Promise<number> {
    const dir = path.join(volume.rootPath, "tmp");
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return 0;
    }
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;
    for (const n of names) {
      if (!n.endsWith(".part")) continue;
      const p = path.join(dir, n);
      try {
        const st = await fsp.stat(p);
        if (olderThanMs === 0 || st.mtimeMs <= cutoff) {
          await fsp.rm(p, { force: true });
          removed++;
        }
      } catch {
        /* vanished */
      }
    }
    return removed;
  }

  async cleanTmpAll(olderThanMs = 3_600_000): Promise<number> {
    let n = 0;
    for (const v of this.o.volumes.list()) {
      if (v.state === "offline" || v.state === "disabled") continue;
      n += await this.cleanTmp(v, olderThanMs);
    }
    return n;
  }
}

/** Throw from `faultBeforeRename` to simulate a crash that leaves the temp file in place. */
export class SimulatedCrash extends Error {}

/**
 * How many things use a blob, counted from the reference rows: asset references (through assets), the four `version_content`
 * columns, imported originals, and the original bytes of a version that is still being captured. Never the cached `refcount`.
 */
export function blobInUse(db: Db, blobId: number, sha256: string): number {
  return db.get<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM asset_references ar JOIN assets a ON a.id = ar.asset_id WHERE a.blob_id = @b)
          + (SELECT COUNT(*) FROM version_content WHERE text_blob_id = @b)
          + (SELECT COUNT(*) FROM version_content WHERE reader_blob_id = @b)
          + (SELECT COUNT(*) FROM version_content WHERE outline_blob_id = @b)
          + (SELECT COUNT(*) FROM version_content WHERE extraction_blob_id = @b)
          + (SELECT COUNT(*) FROM import_documents WHERE original_blob_id = @b)
          + (SELECT COUNT(*) FROM page_versions WHERE status = 'capturing' AND (raw_hash = @s OR document_blob_id = @b)) AS n`,
    { b: blobId, s: sha256 },
  )!.n;
}

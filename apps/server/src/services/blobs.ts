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
    const volume = await this.o.volumes.pickWritable(opts.sizeHint ?? 0);
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

      const existing = this.bySha(sha);
      if (existing) {
        await fsp.rm(tmp, { force: true });
        return { blob: existing, deduplicated: true };
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
      const inserted = this.o.db.run(
        `INSERT INTO blobs (sha256, size_bytes, stored_bytes, compression, mime, kind, volume_id, refcount, zero_since, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'ready', ?) ON CONFLICT(sha256) DO NOTHING`,
        [sha, size, stored, compress ? "zstd" : "none", opts.mime ?? null, opts.kind, volume.id, now, now],
      );
      return { blob: this.bySha(sha)!, deduplicated: inserted.changes === 0 };
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
    for (const r of rows) {
      try {
        if (await this.delete(r.sha256)) n++;
      } catch (e) {
        if (!(e instanceof VolumeUnavailableError)) throw e;
      }
    }
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

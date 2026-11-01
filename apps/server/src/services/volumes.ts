import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Clock } from "@ncb/shared";
import { AppError, isUnderAllowedRoots, newId } from "@ncb/shared";
import type { Db } from "@ncb/db";

export const MARKER_FILE = ".noconbrain-volume";
export const GIB = 1024 ** 3;

export type VolumeState = "online" | "offline" | "readonly" | "draining" | "disabled";
export type StorageWarning = "on_container_filesystem" | "sd_card_suspected" | "low_free_space";

export interface VolumeRow {
  id: number;
  publicId: string;
  name: string;
  rootPath: string;
  markerUuid: string;
  state: VolumeState;
  quotaBytes: number | null;
  reserveFreeBytes: number;
  softThresholdPct: number;
  evictStartPct: number;
  evictTargetPct: number;
  isDefault: boolean;
  statTotal: number | null;
  statFree: number | null;
  statAt: number | null;
  createdAt: number;
}

/** The `Volume` object of docs/api.md section 10. */
export interface VolumeDto {
  id: string;
  name: string;
  rootPath: string;
  state: VolumeState;
  isDefault: boolean;
  capacityBytes: number;
  quotaBytes?: number;
  usedBytes: number;
  availableBytes: number;
  reservedBytes: number;
  reserveFreeBytes: number;
  thresholds: { softPct: number; evictStartPct: number; evictTargetPct: number };
  usageByPriority: Record<"P1" | "P2" | "P3" | "P4", number>;
}

/** Thrown when a volume cannot be used right now (marker missing or mismatched, disabled, or not writable). */
export class VolumeUnavailableError extends AppError {
  readonly kind = "volume_unavailable" as const;
  constructor(readonly volume: Pick<VolumeRow, "publicId" | "name">, readonly reason: string, message?: string) {
    super(
      "conflict",
      message ?? `The storage volume "${volume.name}" is not available: ${reason}. Reconnect it and check it in Storage settings.`,
      { kind: "volume_unavailable", volumeId: volume.publicId, reason },
    );
    this.name = "VolumeUnavailableError";
  }
}

export interface VolumeProbes {
  statfs?: (p: string) => Promise<{ total: number; free: number }>;
  /** Contents of /proc/self/mountinfo, or null where unavailable. */
  mountinfo?: () => string | null;
  /** True when `p` is on the same filesystem as "/". */
  onRootFilesystem?: (p: string) => boolean;
}

export interface MountInfo {
  mountPoint: string;
  fsType: string;
  source: string;
}

/** Best-effort parse of mountinfo text. Null where there is no match. */
export function mountInfoFor(target: string, text: string | null): MountInfo | null {
  if (!text) return null;
  let real = path.resolve(target);
  try {
    real = fs.realpathSync(real);
  } catch {
    /* use the lexical path */
  }
  let best: MountInfo | null = null;
  for (const line of text.split("\n")) {
    const parts = line.split(" ");
    const dash = parts.indexOf("-");
    if (dash < 0 || parts.length < dash + 3) continue;
    const mountPoint = (parts[4] ?? "").replace(/\\040/g, " ");
    if (real !== mountPoint && !real.startsWith(mountPoint === "/" ? "/" : mountPoint + "/")) continue;
    if (!best || mountPoint.length >= best.mountPoint.length) best = { mountPoint, fsType: parts[dash + 1]!, source: parts[dash + 2]! };
  }
  return best;
}

const defaultProbes: Required<VolumeProbes> = {
  async statfs(p) {
    const s = await fsp.statfs(p);
    return { total: Number(s.blocks) * Number(s.bsize), free: Number(s.bavail) * Number(s.bsize) };
  },
  mountinfo() {
    try {
      return fs.readFileSync("/proc/self/mountinfo", "utf8");
    } catch {
      return null;
    }
  },
  onRootFilesystem(p) {
    try {
      return fs.statSync(p).dev === fs.statSync("/").dev;
    } catch {
      return false;
    }
  },
};

export interface VolumeServiceOptions {
  db: Db;
  clock: Clock;
  allowedRoots: string[];
  /** `NCB_MIN_FREE_DISK_GB` in bytes. The default `reserve_free_bytes` of a new volume. */
  minFreeBytes: number;
  probes?: VolumeProbes;
  /** How long a cached `statfs` stays fresh. Default 30 s. */
  statTtlMs?: number;
}

export interface ValidatedPath {
  path: string;
  realPath: string;
  totalBytes: number;
  freeBytes: number;
  warnings: StorageWarning[];
  /** A marker already on disk (the folder was a NoConBrain volume before). */
  existingMarker?: { uuid: string; name?: string };
}

interface RawRow {
  id: number; public_id: string; name: string; root_path: string; marker_uuid: string; state: VolumeState;
  quota_bytes: number | null; reserve_free_bytes: number; soft_threshold_pct: number; evict_start_pct: number;
  evict_target_pct: number; is_default: number; stat_total: number | null; stat_free: number | null; stat_at: number | null; created_at: number;
}

const toRow = (r: RawRow): VolumeRow => ({
  id: r.id, publicId: r.public_id, name: r.name, rootPath: r.root_path, markerUuid: r.marker_uuid, state: r.state,
  quotaBytes: r.quota_bytes, reserveFreeBytes: r.reserve_free_bytes, softThresholdPct: r.soft_threshold_pct,
  evictStartPct: r.evict_start_pct, evictTargetPct: r.evict_target_pct, isDefault: r.is_default === 1,
  statTotal: r.stat_total, statFree: r.stat_free, statAt: r.stat_at, createdAt: r.created_at,
});

const fieldError = (path: string, message: string) => new AppError("bad_request", message, { fields: [{ in: "body", path, message }] });

export async function probeWritable(dir: string): Promise<void> {
  const probe = path.join(dir, `.ncb-probe-${randomUUID()}`);
  const fh = await fsp.open(probe, "wx");
  try {
    await fh.write("probe");
    await fh.sync();
  } finally {
    await fh.close();
    await fsp.rm(probe, { force: true });
  }
}

export async function readMarker(root: string): Promise<{ uuid: string; name?: string } | null> {
  try {
    const m = JSON.parse(await fsp.readFile(path.join(root, MARKER_FILE), "utf8")) as { uuid?: unknown; name?: unknown };
    return typeof m.uuid === "string" && m.uuid.length > 0 ? { uuid: m.uuid, name: typeof m.name === "string" ? m.name : undefined } : null;
  } catch {
    return null;
  }
}

export class VolumeService {
  private readonly probes: Required<VolumeProbes>;
  private readonly statTtl: number;

  constructor(private readonly o: VolumeServiceOptions) {
    this.probes = { ...defaultProbes, ...(o.probes ?? {}) };
    this.statTtl = o.statTtlMs ?? 30_000;
  }

  // ---- reading rows --------------------------------------------------------------------------

  list(): VolumeRow[] {
    return this.o.db.all<RawRow>("SELECT * FROM volumes ORDER BY is_default DESC, id").map(toRow);
  }

  byPublicId(publicId: string): VolumeRow | undefined {
    const r = this.o.db.get<RawRow>("SELECT * FROM volumes WHERE public_id = ?", [publicId]);
    return r && toRow(r);
  }

  byId(id: number): VolumeRow | undefined {
    const r = this.o.db.get<RawRow>("SELECT * FROM volumes WHERE id = ?", [id]);
    return r && toRow(r);
  }

  require(publicId: string): VolumeRow {
    const v = this.byPublicId(publicId);
    if (!v) throw new AppError("not_found", "That storage volume does not exist.");
    return v;
  }

  defaultVolume(): VolumeRow | undefined {
    const r = this.o.db.get<RawRow>("SELECT * FROM volumes WHERE is_default = 1");
    return r && toRow(r);
  }

  // ---- validation ----------------------------------------------------------------------------

  /**
   * Checks a candidate folder: absolute, inside an allowed root (also after symlinks), an existing
   * directory, writable, not already registered. Returns warnings for things that are allowed but risky.
   * Throws a 400 `bad_request` with a field error on `path` otherwise.
   */
  async validatePath(input: string, opts: { reserveFreeBytes?: number } = {}): Promise<ValidatedPath> {
    if (typeof input !== "string" || input.length === 0 || input.includes("\0")) throw fieldError("path", "Enter a folder path.");
    if (!path.isAbsolute(input)) throw fieldError("path", "Use an absolute path such as /volumes/default.");
    const resolved = path.resolve(input);
    const roots = this.o.allowedRoots;
    if (!isUnderAllowedRoots(resolved, roots)) {
      throw fieldError("path", `Storage folders must be inside one of the allowed locations: ${roots.join(", ")}.`);
    }
    let real: string;
    try {
      real = await fsp.realpath(resolved);
    } catch {
      throw fieldError("path", "That folder does not exist. Create it (or mount the drive) first.");
    }
    const realRoots = await Promise.all(roots.map((r) => fsp.realpath(r).catch(() => path.resolve(r))));
    if (!isUnderAllowedRoots(real, realRoots)) throw fieldError("path", "That folder resolves outside the allowed locations.");
    const st = await fsp.stat(real);
    if (!st.isDirectory()) throw fieldError("path", "That path is not a folder.");

    try {
      await probeWritable(real);
    } catch (e) {
      throw fieldError("path", `That folder is not writable (${(e as NodeJS.ErrnoException).code ?? "error"}). Check its permissions.`);
    }

    for (const v of this.list()) {
      let other = v.rootPath;
      try {
        other = fs.realpathSync(v.rootPath);
      } catch {
        /* an offline volume keeps its stored path */
      }
      if (other === real || real.startsWith(other + path.sep) || other.startsWith(real + path.sep)) {
        throw new AppError("conflict", `That folder overlaps the storage volume "${v.name}".`, { fields: [{ in: "body", path: "path", message: "Already used by another volume." }] });
      }
    }

    const stat = await this.probes.statfs(real);
    const warnings: StorageWarning[] = [];
    if (this.probes.onRootFilesystem(real)) warnings.push("on_container_filesystem");
    const mi = mountInfoFor(real, this.probes.mountinfo());
    if (mi && /(^|\/)mmcblk/.test(mi.source)) warnings.push("sd_card_suspected");
    if (stat.free < (opts.reserveFreeBytes ?? this.o.minFreeBytes)) warnings.push("low_free_space");

    const existing = await readMarker(real);
    return { path: resolved, realPath: real, totalBytes: stat.total, freeBytes: stat.free, warnings, ...(existing ? { existingMarker: existing } : {}) };
  }

  // ---- registering ---------------------------------------------------------------------------

  async register(input: {
    path: string; name: string; quotaBytes?: number; reserveFreeBytes?: number; makeDefault?: boolean;
  }): Promise<{ volume: VolumeRow; warnings: StorageWarning[] }> {
    const reserve = input.reserveFreeBytes ?? this.o.minFreeBytes;
    const v = await this.validatePath(input.path, { reserveFreeBytes: reserve });
    if (input.quotaBytes !== undefined && input.quotaBytes > v.totalBytes) {
      throw fieldError("quotaBytes", "The quota is larger than the drive.");
    }
    if (this.o.db.get("SELECT 1 FROM volumes WHERE name = ?", [input.name])) {
      throw new AppError("conflict", `A volume called "${input.name}" already exists.`, { fields: [{ in: "body", path: "name", message: "Choose a different name." }] });
    }
    // Reuse the marker of a folder that was a volume before, so re-attaching a drive keeps its identity.
    const uuid = v.existingMarker?.uuid ?? randomUUID();
    if (this.o.db.get("SELECT 1 FROM volumes WHERE marker_uuid = ?", [uuid])) {
      throw new AppError("conflict", "That folder is already registered as a storage volume.");
    }
    const now = this.o.clock.now();
    await fsp.mkdir(path.join(v.realPath, "blobs"), { recursive: true });
    await fsp.mkdir(path.join(v.realPath, "tmp"), { recursive: true });
    await fsp.writeFile(
      path.join(v.realPath, MARKER_FILE),
      JSON.stringify({ uuid, name: input.name, createdAt: new Date(now).toISOString(), app: "noconbrain" }, null, 2),
      { mode: 0o644 },
    );

    const isFirst = this.list().length === 0;
    const makeDefault = isFirst || input.makeDefault === true;
    const publicId = newId("vol");
    const id = this.o.db.transaction(
      () => {
        if (makeDefault) this.o.db.run("UPDATE volumes SET is_default = 0 WHERE is_default = 1");
        const r = this.o.db.run(
          `INSERT INTO volumes (public_id, name, root_path, marker_uuid, state, quota_bytes, reserve_free_bytes, is_default, stat_total, stat_free, stat_at, created_at)
           VALUES (?, ?, ?, ?, 'online', ?, ?, ?, ?, ?, ?, ?)`,
          [publicId, input.name, v.realPath, uuid, input.quotaBytes ?? null, reserve, makeDefault ? 1 : 0, v.totalBytes, v.freeBytes, now, now],
        );
        return Number(r.lastInsertRowid);
      },
      { durable: true },
    );
    return { volume: this.byId(id)!, warnings: v.warnings };
  }

  // ---- state ---------------------------------------------------------------------------------

  /**
   * Re-checks a volume: marker present and matching, folder writable, `statfs`. An operator-set state
   * (`readonly`, `draining`, `disabled`) is kept; `online` and `offline` follow the disk. Updates the row.
   */
  async refresh(volume: VolumeRow): Promise<VolumeRow> {
    let state: VolumeState = volume.state;
    let total = volume.statTotal;
    let free = volume.statFree;
    const marker = await readMarker(volume.rootPath);
    const present = marker !== null && marker.uuid === volume.markerUuid;
    if (!present) {
      if (volume.state !== "disabled") state = "offline";
    } else {
      if (state === "offline") state = "online";
      try {
        const s = await this.probes.statfs(volume.rootPath);
        total = s.total;
        free = s.free;
      } catch {
        if (state !== "disabled") state = "offline";
      }
      if (state === "online") {
        try {
          await probeWritable(volume.rootPath);
        } catch {
          state = "readonly";
        }
      }
    }
    const now = this.o.clock.now();
    this.o.db.run("UPDATE volumes SET state = ?, stat_total = ?, stat_free = ?, stat_at = ? WHERE id = ?", [state, total, free, now, volume.id]);
    return this.byId(volume.id)!;
  }

  async refreshAll(): Promise<VolumeRow[]> {
    const out: VolumeRow[] = [];
    for (const v of this.list()) out.push(await this.refresh(v));
    return out;
  }

  /** Cached `statfs`, refreshed when older than the TTL. Never touches the disk if the volume is offline. */
  async stat(volume: VolumeRow): Promise<{ total: number; free: number }> {
    const fresh = volume.statAt !== null && this.o.clock.now() - volume.statAt < this.statTtl;
    if (fresh && volume.statTotal !== null && volume.statFree !== null) return { total: volume.statTotal, free: volume.statFree };
    const v = await this.refresh(volume);
    return { total: v.statTotal ?? 0, free: v.statFree ?? 0 };
  }

  /**
   * For reading and writing blobs: confirms the marker is there before touching files, so a missing
   * drive is reported as a typed error instead of a stray ENOENT (or worse, a write to the mount point).
   */
  async assertUsable(volume: VolumeRow, need: "read" | "write"): Promise<VolumeRow> {
    const marker = await readMarker(volume.rootPath);
    if (!marker || marker.uuid !== volume.markerUuid) {
      if (volume.state !== "offline") this.o.db.run("UPDATE volumes SET state = 'offline' WHERE id = ? AND state <> 'disabled'", [volume.id]);
      throw new VolumeUnavailableError(volume, !marker ? "the volume marker file is missing" : "the volume marker does not match");
    }
    const current = volume.state === "offline" ? await this.refresh(volume) : volume;
    if (current.state === "disabled") throw new VolumeUnavailableError(volume, "the volume is disabled");
    if (current.state === "offline") throw new VolumeUnavailableError(volume, "the volume is offline");
    if (need === "write" && current.state !== "online") throw new VolumeUnavailableError(volume, `the volume is ${current.state}`);
    return current;
  }

  /** Picks where a new blob goes: the default volume if it is writable, otherwise any writable one. */
  async pickWritable(bytesHint = 0): Promise<VolumeRow> {
    const candidates = this.list().filter((v) => v.state !== "disabled");
    if (candidates.length === 0) throw new AppError("setup_required", "No storage volume is set up yet. Add one in Storage settings.");
    let lastError: VolumeUnavailableError | undefined;
    for (const v of candidates) {
      try {
        const u = await this.assertUsable(v, "write");
        const s = await this.stat(u);
        if (s.free - bytesHint < u.reserveFreeBytes) {
          lastError = new VolumeUnavailableError(u, "not enough free space left above the reserve");
          continue;
        }
        return u;
      } catch (e) {
        if (e instanceof VolumeUnavailableError) lastError = e;
        else throw e;
      }
    }
    if (lastError && lastError.reason.includes("free space")) {
      throw new AppError("insufficient_storage", "There is not enough free space on the storage volumes. Free some space or add a volume.");
    }
    throw lastError ?? new AppError("insufficient_storage", "No storage volume is available for writing.");
  }

  // ---- changes -------------------------------------------------------------------------------

  async update(publicId: string, patch: {
    name?: string; quotaBytes?: number | null; reserveFreeBytes?: number;
    thresholds?: Partial<{ softPct: number; evictStartPct: number; evictTargetPct: number }>;
    state?: "online" | "readonly" | "draining" | "disabled"; isDefault?: boolean;
  }): Promise<VolumeRow> {
    const v = this.require(publicId);
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    const add = (col: string, val: string | number | null) => {
      sets.push(`${col} = ?`);
      args.push(val);
    };
    if (patch.name !== undefined && patch.name !== v.name) {
      if (this.o.db.get("SELECT 1 FROM volumes WHERE name = ? AND id <> ?", [patch.name, v.id])) {
        throw new AppError("conflict", `A volume called "${patch.name}" already exists.`, { fields: [{ in: "body", path: "name", message: "Choose a different name." }] });
      }
      add("name", patch.name);
    }
    if (patch.quotaBytes !== undefined) {
      if (patch.quotaBytes !== null && v.statTotal !== null && patch.quotaBytes > v.statTotal) throw fieldError("quotaBytes", "The quota is larger than the drive.");
      add("quota_bytes", patch.quotaBytes);
    }
    if (patch.reserveFreeBytes !== undefined) add("reserve_free_bytes", patch.reserveFreeBytes);
    const t = patch.thresholds;
    if (t) {
      const soft = t.softPct ?? v.softThresholdPct;
      const start = t.evictStartPct ?? v.evictStartPct;
      const target = t.evictTargetPct ?? v.evictTargetPct;
      if (!(target < start && soft <= start)) {
        throw new AppError("bad_request", "Thresholds must satisfy evict target < evict start and soft <= evict start.", {
          fields: [{ in: "body", path: "thresholds", message: "Eviction target must be below the eviction start, and the soft threshold must not exceed it." }],
        });
      }
      add("soft_threshold_pct", soft);
      add("evict_start_pct", start);
      add("evict_target_pct", target);
    }
    if (patch.state !== undefined) {
      if (patch.state === "online" && v.state === "offline") {
        // Cannot be forced online by hand; the refresh below decides from the disk.
      } else add("state", patch.state);
    }
    if (patch.isDefault === false && v.isDefault) throw fieldError("isDefault", "Choose another volume as the default instead.");
    this.o.db.transaction(
      () => {
        if (patch.isDefault === true) {
          if (v.state === "disabled" || patch.state === "disabled") throw fieldError("isDefault", "A disabled volume cannot be the default.");
          this.o.db.run("UPDATE volumes SET is_default = 0 WHERE is_default = 1");
          add("is_default", 1);
        }
        if (sets.length) this.o.db.run(`UPDATE volumes SET ${sets.join(", ")} WHERE id = ?`, [...args, v.id]);
      },
      { durable: true },
    );
    return this.refresh(this.byId(v.id)!);
  }

  /** Removes a volume row. Refused while any blob lives on it. The files on disk are left alone. */
  remove(publicId: string): void {
    const v = this.require(publicId);
    const blobs = this.o.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM blobs WHERE volume_id = ?", [v.id])!.n;
    if (blobs > 0) {
      throw new AppError("conflict", `This volume still holds ${blobs} stored file${blobs === 1 ? "" : "s"}. Set it to draining and wait for it to empty before removing it.`, { blobs });
    }
    if (v.isDefault && this.list().length > 1) {
      throw new AppError("conflict", "This is the default volume. Make another volume the default first.");
    }
    this.o.db.run("DELETE FROM volumes WHERE id = ?", [v.id]);
  }

  // ---- reporting -----------------------------------------------------------------------------

  usedBytes(volumeId: number): number {
    return this.o.db.get<{ n: number }>("SELECT COALESCE(SUM(stored_bytes), 0) AS n FROM blobs WHERE volume_id = ?", [volumeId])!.n;
  }

  reservedBytes(volumeId: number): number {
    return this.o.db.get<{ n: number }>(
      "SELECT COALESCE(SUM(MAX(reserved_bytes - written_bytes, 0)), 0) AS n FROM volume_reservations WHERE volume_id = ? AND expires_at > ?",
      [volumeId, this.o.clock.now()],
    )!.n;
  }

  toDto(v: VolumeRow): VolumeDto {
    const used = this.usedBytes(v.id);
    const capacity = v.statTotal ?? 0;
    const free = v.statFree ?? 0;
    const available = v.quotaBytes !== null ? Math.max(0, Math.min(free, v.quotaBytes - used)) : free;
    return {
      id: v.publicId,
      name: v.name,
      rootPath: v.rootPath,
      state: v.state,
      isDefault: v.isDefault,
      capacityBytes: capacity,
      ...(v.quotaBytes !== null ? { quotaBytes: v.quotaBytes } : {}),
      usedBytes: used,
      availableBytes: available,
      reservedBytes: this.reservedBytes(v.id),
      reserveFreeBytes: v.reserveFreeBytes,
      thresholds: { softPct: v.softThresholdPct, evictStartPct: v.evictStartPct, evictTargetPct: v.evictTargetPct },
      // Priorities are derived from page references, which arrive in Phase 2. Until then nothing is prioritised.
      usageByPriority: { P1: 0, P2: 0, P3: 0, P4: 0 },
    };
  }

  /** Check marker, write test and a scan of blob rows against files. Report only; repairs belong to maintenance. */
  async verify(publicId: string, scanLimit = 5000): Promise<{
    volume: VolumeDto; markerOk: boolean; writable: boolean; checkedBlobs: number; missingBlobs: number; missingExamples: string[];
  }> {
    const before = this.require(publicId);
    const marker = await readMarker(before.rootPath);
    const markerOk = marker !== null && marker.uuid === before.markerUuid;
    const v = await this.refresh(before);
    const writable = v.state === "online";
    let checked = 0;
    let missing = 0;
    const examples: string[] = [];
    if (markerOk) {
      const rows = this.o.db.all<{ sha256: string; compression: string }>(
        "SELECT sha256, compression FROM blobs WHERE volume_id = ? AND state = 'ready' ORDER BY id LIMIT ?",
        [v.id, scanLimit],
      );
      for (const r of rows) {
        checked++;
        if (!fs.existsSync(blobPathFor(v.rootPath, r.sha256, r.compression === "zstd"))) {
          missing++;
          if (examples.length < 5) examples.push(r.sha256);
        }
      }
    }
    return { volume: this.toDto(v), markerOk, writable, checkedBlobs: checked, missingBlobs: missing, missingExamples: examples };
  }
}

const SHA_RE = /^[0-9a-f]{64}$/;

/** `<root>/blobs/ab/cd/<sha256>[.zst]`. The path comes from the hash alone; anything else is refused. */
export function blobPathFor(root: string, sha256: string, compressed: boolean): string {
  if (!SHA_RE.test(sha256)) throw new Error("Not a SHA-256 hex digest");
  return path.join(root, "blobs", sha256.slice(0, 2), sha256.slice(2, 4), compressed ? `${sha256}.zst` : sha256);
}

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "@ncb/db";
import { AppError, isUnderAllowedRoots, newId, parsePriority, priorityToCode, type Clock, type PriorityNumber } from "@ncb/shared";
import { parseOrThrow } from "../lib/zod.js";
import type { ActivityLog } from "../services/activity.js";
import type { VolumeService } from "../services/volumes.js";
import { languageMatches } from "./languages.js";
import { ZimError, type ZimHealth, type ZimMeta, type ZimSource } from "./source.js";

/**
 * Knowledge packages (tasks Z-03 and Z-09): registering ZIM files, reading their metadata, keeping the registry honest, and removing a
 * package safely. A ZIM is read in place by the `zim` worker; nothing here extracts it or copies its text anywhere. A package is never
 * evicted by the storage system: it leaves only through `remove`, which the Human confirms when anything refers to it.
 */

export type ZimState = "importing" | "ready" | "degraded" | "missing" | "removing";

export interface ZimRow {
  id: number; public_id: string; name: string; title: string; description: string | null; language: string | null; creator: string | null; publisher: string | null;
  date: string | null; flavour: string | null; tags: string | null; uuid: string; volume_id: number | null; storage_mode: "in_place" | "copied"; file_path: string;
  relative_path: string | null; size_bytes: number; checksum_sha256: string | null; checksum_state: "pending" | "done" | "failed"; article_count: number;
  media_count: number; entry_count: number; has_fulltext_index: number; has_title_index: number; new_namespace_scheme: number; main_path: string | null;
  has_illustration: number; source_url: string | null; license_name: string | null; license_url: string | null; attribution_text: string | null; priority: number;
  enabled_for_search: number; state: ZimState; state_detail: string | null; imported_at: number; last_verified_at: number | null; updated_at: number;
}

export interface ZimPackageDto {
  id: string;
  name: string;
  title: string;
  description: string | null;
  language: string | null;
  creator: string | null;
  publisher: string | null;
  date: string | null;
  flavour: string | null;
  tags: string[];
  uuid: string;
  state: ZimState;
  stateDetail: string | null;
  storageMode: "in_place" | "copied";
  /** Where the file is. Shown to the Human who manages packages. */
  path: string;
  volumeId: string | null;
  sizeBytes: number;
  checksum: { sha256: string | null; state: "pending" | "done" | "failed" };
  counts: { articles: number; media: number; entries: number };
  hasFulltextIndex: boolean;
  hasTitleIndex: boolean;
  newNamespaceScheme: boolean;
  mainPath: string | null;
  illustrationUrl: string | null;
  license: { name: string | null; url: string | null; known: boolean };
  attribution: string | null;
  sourceUrl: string | null;
  priority: "P1" | "P2" | "P3" | "P4";
  /** Always true in v1: no part of the storage system removes a package by itself. */
  neverAutoEvicted: true;
  enabledForSearch: boolean;
  sourceId: string | null;
  importedAt: string;
  lastVerifiedAt: string | null;
}

export interface RemovalPlan {
  package: { id: string; title: string };
  /** Whether the file itself is deleted. Only a copy made by NoConBrain is; a file left in place is never touched. */
  deletesFile: boolean;
  fileBytes: number;
  references: {
    bookmarks: { count: number; items: { id: string; title: string; path: string }[] };
    collections: { count: number; items: { collectionId: string; name: string; entries: number }[] };
    sources: { count: number; items: { id: string; name: string }[] };
    history: { count: number };
  };
  /** True when anything refers to the package, so removal needs `confirm: true`. */
  needsConfirmation: boolean;
}

const iso = (n: number | null): string | null => (n == null ? null : new Date(n).toISOString());

const KNOWN_LICENCES: [RegExp, string][] = [
  [/^CC[ -]BY[ -]SA[ -]4\.0/i, "https://creativecommons.org/licenses/by-sa/4.0/"],
  [/^CC[ -]BY[ -]SA[ -]3\.0/i, "https://creativecommons.org/licenses/by-sa/3.0/"],
  [/^CC[ -]BY[ -]NC[ -]SA[ -]4\.0/i, "https://creativecommons.org/licenses/by-nc-sa/4.0/"],
  [/^CC[ -]BY[ -]4\.0/i, "https://creativecommons.org/licenses/by/4.0/"],
  [/^CC0/i, "https://creativecommons.org/publicdomain/zero/1.0/"],
];

/** Licence and attribution text from a package's metadata. A Wikipedia package without a licence key is CC BY-SA 4.0. */
export function deriveLicence(meta: Pick<ZimMeta, "name" | "title" | "creator" | "publisher" | "source" | "licenseName">): { name: string | null; url: string | null; attribution: string | null } {
  let name = meta.licenseName.trim() || null;
  if (!name && /wikipedia|wikimedia/i.test(`${meta.name} ${meta.creator} ${meta.publisher}`)) name = "CC BY-SA 4.0";
  const url = name ? (KNOWN_LICENCES.find(([re]) => re.test(name!))?.[1] ?? null) : null;
  const bits = [meta.title || meta.name];
  const by = [meta.creator, meta.publisher].map((x) => x.trim()).filter(Boolean);
  if (by.length) bits.push(`by ${[...new Set(by)].join(" / ")}`);
  if (name) bits.push(`licensed under ${name}`);
  if (meta.source) bits.push(`source: ${meta.source}`);
  const attribution = bits.length > 1 || name ? `${bits[0]}${bits.slice(1).map((b) => `, ${b}`).join("")}.` : null;
  return { name, url, attribution };
}

const registerSchema = z.object({
  path: z.string().min(1, "Enter the path of a .zim file").max(4096),
  /** `false` (default): read the file where it is. `true`: copy it into a volume's `zim/` folder first. */
  copy: z.boolean().default(false),
  /** `copy` only: the volume that receives the copy (a `vol_` id). Default: the one with most room. */
  volumeId: z.string().max(64).optional(),
  priority: z.union([z.enum(["P1", "P2", "P3", "P4"]), z.number().int().min(1).max(4)], { error: "Use P1, P2, P3 or P4" }).optional(),
  enabledForSearch: z.boolean().optional(),
  licenseName: z.string().trim().max(200).optional(),
  licenseUrl: z.string().trim().url().max(2000).optional(),
  attribution: z.string().trim().max(2000).optional(),
  /** Creates the knowledge-package source for it (default true). */
  createSource: z.boolean().default(true),
  /** `copy` only: answer 202 straight away and finish in the background. */
  async: z.boolean().default(false),
});

const patchSchema = z.object({
  priority: z.union([z.enum(["P1", "P2", "P3", "P4"]), z.number().int().min(1).max(4)]).optional(),
  enabledForSearch: z.boolean().optional(),
  licenseName: z.string().trim().max(200).nullable().optional(),
  licenseUrl: z.string().trim().url().max(2000).nullable().optional(),
  attribution: z.string().trim().max(2000).nullable().optional(),
});

const removeSchema = z.object({ confirm: z.boolean().default(false), dryRun: z.boolean().default(false) });

export interface ZimServiceOptions {
  db: Db;
  clock: Clock;
  source: ZimSource;
  volumes: VolumeService;
  activity: ActivityLog;
  /** `NCB_VOLUMES_ALLOWED_ROOTS`: a ZIM may only be registered from under one of these. */
  allowedRoots: string[];
  /** Creates the knowledge_package source row for a new package (SourceService). */
  createSource?: (zim: { rowId: number; publicId: string; title: string; priority: PriorityNumber; description: string | null }) => string | null;
  /** Called after a package is added, changed or removed (usage figures are stale). */
  onChanged?: () => void;
  log?: { warn(o: unknown, m?: string): void; info(o: unknown, m?: string): void };
}

export class ZimService {
  private readonly background = new Set<Promise<unknown>>();
  private readonly opened = new Set<string>();

  constructor(private readonly o: ZimServiceOptions) {}

  private get db(): Db { return this.o.db; }

  // ---- reading -------------------------------------------------------------------------------

  rowByPublic(publicId: string): ZimRow {
    const r = this.db.get<ZimRow>("SELECT * FROM zim_packages WHERE public_id = ? AND state <> 'removing'", [publicId]);
    if (!r) throw new AppError("not_found", "That knowledge package does not exist.");
    return r;
  }

  rows(): ZimRow[] {
    return this.db.all<ZimRow>("SELECT * FROM zim_packages WHERE state <> 'removing' ORDER BY id");
  }

  toDto(r: ZimRow): ZimPackageDto {
    const vol = r.volume_id == null ? null : (this.o.volumes.byId(r.volume_id)?.publicId ?? null);
    const src = this.db.get<{ public_id: string }>("SELECT public_id FROM sources WHERE zim_package_id = ? AND deleted_at IS NULL", [r.id]);
    return {
      id: r.public_id, name: r.name, title: r.title, description: r.description, language: r.language, creator: r.creator, publisher: r.publisher, date: r.date,
      flavour: r.flavour, tags: (r.tags ?? "").split(";").map((t) => t.trim()).filter(Boolean), uuid: r.uuid, state: r.state, stateDetail: r.state_detail,
      storageMode: r.storage_mode, path: r.file_path, volumeId: vol, sizeBytes: r.size_bytes,
      checksum: { sha256: r.checksum_sha256, state: r.checksum_state },
      counts: { articles: r.article_count, media: r.media_count, entries: r.entry_count },
      hasFulltextIndex: r.has_fulltext_index === 1, hasTitleIndex: r.has_title_index === 1, newNamespaceScheme: r.new_namespace_scheme === 1, mainPath: r.main_path,
      illustrationUrl: r.has_illustration === 1 ? `/api/zim/packages/${r.public_id}/illustration` : null,
      license: { name: r.license_name, url: r.license_url, known: r.license_name !== null }, attribution: r.attribution_text, sourceUrl: r.source_url,
      priority: priorityToCode(r.priority as PriorityNumber), neverAutoEvicted: true, enabledForSearch: r.enabled_for_search === 1, sourceId: src?.public_id ?? null,
      importedAt: iso(r.imported_at)!, lastVerifiedAt: iso(r.last_verified_at),
    };
  }

  list(o: { language?: string; enabledForSearch?: boolean; state?: string } = {}): { items: ZimPackageDto[]; total: number } {
    let rs = this.rows();
    if (o.language) rs = rs.filter((r) => languageMatches(r.language, [o.language!]));
    if (o.enabledForSearch !== undefined) rs = rs.filter((r) => (r.enabled_for_search === 1) === o.enabledForSearch);
    if (o.state) rs = rs.filter((r) => r.state === o.state);
    return { items: rs.map((r) => this.toDto(r)), total: rs.length };
  }

  get(publicId: string): ZimPackageDto {
    return this.toDto(this.rowByPublic(publicId));
  }

  // ---- registering ---------------------------------------------------------------------------

  private async checkFile(input: string): Promise<{ real: string; size: number }> {
    const field = (message: string) => new AppError("bad_request", message, { fields: [{ in: "body", path: "path", message }] });
    if (input.includes("\0")) throw field("Enter the path of a .zim file.");
    if (!path.isAbsolute(input)) throw field("Use an absolute path such as /volumes/default/zim/wikipedia.zim.");
    const resolved = path.resolve(input);
    const roots = this.o.allowedRoots;
    if (!isUnderAllowedRoots(resolved, roots)) throw field(`Packages must be inside one of the allowed locations: ${roots.join(", ")}.`);
    let real: string;
    try {
      real = await fsp.realpath(resolved);
    } catch {
      throw field("That file does not exist. Copy it to the server first, or mount the drive.");
    }
    const realRoots = await Promise.all(roots.map((r) => fsp.realpath(r).catch(() => path.resolve(r))));
    if (!isUnderAllowedRoots(real, realRoots)) throw field("That file resolves outside the allowed locations.");
    const st = await fsp.stat(real);
    if (!st.isFile()) throw field("That path is not a file.");
    if (!/\.zim$/i.test(real)) throw field("Only .zim files can be added. Split files (.zimaa, .zimab) are not supported.");
    if (st.size < 80) throw field("That file is too small to be a ZIM package.");
    return { real, size: st.size };
  }

  /**
   * Adds a package. Validation opens the file in a worker, so a damaged file cannot take the server down. `in_place` leaves the file where it
   * is (the usual choice for a large Wikipedia ZIM); `copy` copies it into a volume's `zim/` folder first. The UUID must be new.
   */
  async register(raw: unknown): Promise<{ package: ZimPackageDto; status: 201 | 202 }> {
    const b = parseOrThrow(registerSchema, raw);
    const { real, size } = await this.checkFile(b.path);
    if (this.db.get("SELECT 1 FROM zim_packages WHERE file_path = ? AND state <> 'removing'", [real])) {
      throw new AppError("conflict", "That file is already added.", { fields: [{ in: "body", path: "path", message: "Already added" }] });
    }
    const priority = b.priority === undefined ? 1 : (parsePriority(b.priority) ?? 1);
    const publicId = newId("zim");
    let meta: ZimMeta;
    try {
      meta = await this.o.source.open(publicId, real);
    } catch (e) {
      await this.o.source.close(publicId);
      this.o.activity.write({ level: "warn", area: "zim", message: `Rejected a ZIM file: ${path.basename(real)}`, details: { reason: (e as Error).message } });
      if (e instanceof ZimError && e.zimCode !== "invalid_zim") throw e;
      throw new AppError("bad_request", "That file is not a valid ZIM package, or it is damaged.", { fields: [{ in: "body", path: "path", message: "Not a valid ZIM package" }] });
    }
    const dup = this.db.get<{ public_id: string; title: string }>("SELECT public_id, title FROM zim_packages WHERE uuid = ? AND state <> 'removing'", [meta.uuid]);
    if (dup) {
      await this.o.source.close(publicId);
      throw new AppError("conflict", `A package with the same identity is already added: "${dup.title}". Remove it first to replace it with this file.`, {
        existing: dup.public_id, uuid: meta.uuid, fields: [{ in: "body", path: "path", message: "Same package (UUID) already added" }],
      });
    }
    const lic = deriveLicence(meta);
    const now = this.o.clock.now();
    const copy = b.copy;
    let volume: ReturnType<VolumeService["byId"]> | undefined;
    if (copy) {
      volume = b.volumeId ? this.o.volumes.require(b.volumeId) : await this.o.volumes.pickWritable(size);
      await this.o.volumes.assertUsable(volume, "write");
      if (this.o.volumes.availableFor(volume) < size) {
        await this.o.source.close(publicId);
        throw new AppError("insufficient_storage", "There is not enough free space on that volume to copy the package.");
      }
    } else {
      volume = this.volumeContaining(real);
    }
    const rowId = this.db.transaction(() => {
      const r = this.db.run(
        `INSERT INTO zim_packages (public_id, name, title, description, language, creator, publisher, date, flavour, tags, uuid, volume_id, storage_mode, file_path, relative_path,
           size_bytes, article_count, media_count, entry_count, has_fulltext_index, has_title_index, new_namespace_scheme, main_path, has_illustration, source_url, license_name,
           license_url, attribution_text, priority, enabled_for_search, state, imported_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [publicId, meta.name || path.basename(real, ".zim"), meta.title || meta.name || path.basename(real, ".zim"), meta.description || null, meta.language || null, meta.creator || null,
          meta.publisher || null, meta.date || null, meta.flavour || null, meta.tags || null, meta.uuid, volume?.id ?? null, copy ? "copied" : "in_place", real, null, size,
          meta.articleCount, meta.mediaCount, meta.entryCount, meta.hasFulltextIndex ? 1 : 0, meta.hasTitleIndex ? 1 : 0, meta.newNamespaceScheme ? 1 : 0, meta.mainPath,
          meta.hasIllustration ? 1 : 0, meta.source || null, b.licenseName ?? lic.name, b.licenseUrl ?? lic.url, b.attribution ?? lic.attribution, priority,
          b.enabledForSearch === false ? 0 : 1, copy ? "importing" : "ready", now, now],
      );
      return Number(r.lastInsertRowid);
    }, { durable: true });
    this.opened.add(publicId);

    const finish = async (): Promise<void> => {
      if (copy) await this.copyIn(rowId, publicId, real, volume!, meta);
      else this.trackBackground(this.hashInPlace(rowId, real));
      if (b.createSource) this.attachSource(rowId);
      this.o.activity.write({ level: "info", area: "zim", message: `Knowledge package added: ${meta.title || meta.name}`, details: { mode: b.copy ? "copy" : "in_place", bytes: size } });
      this.o.onChanged?.();
    };
    if (copy && b.async) {
      this.trackBackground(finish().catch((e) => this.failImport(rowId, publicId, e)));
      return { package: this.toDto(this.rowOf(rowId)), status: 202 };
    }
    try {
      await finish();
    } catch (e) {
      await this.failImport(rowId, publicId, e);
      throw e instanceof AppError ? e : new AppError("internal", "The package could not be copied.");
    }
    return { package: this.toDto(this.rowOf(rowId)), status: 201 };
  }

  private rowOf(rowId: number): ZimRow {
    return this.db.get<ZimRow>("SELECT * FROM zim_packages WHERE id = ?", [rowId])!;
  }

  private attachSource(rowId: number): void {
    const r = this.rowOf(rowId);
    try {
      this.o.createSource?.({ rowId, publicId: r.public_id, title: r.title, priority: r.priority as PriorityNumber, description: r.description });
    } catch (e) {
      this.o.log?.warn({ err: String(e) }, "could not create the knowledge-package source");
    }
  }

  /** The registered volume whose folder holds the file, if any (a ZIM in place on a volume still counts towards that volume). */
  private volumeContaining(real: string): ReturnType<VolumeService["byId"]> {
    for (const v of this.o.volumes.list()) {
      let root = v.rootPath;
      try { root = fs.realpathSync(v.rootPath); } catch { /* offline volume keeps its stored path */ }
      if (real.startsWith(root + path.sep)) return v;
    }
    return undefined;
  }

  private async copyIn(rowId: number, publicId: string, from: string, volume: NonNullable<ReturnType<VolumeService["byId"]>>, meta: ZimMeta): Promise<void> {
    const dir = path.join(volume.rootPath, "zim");
    await fsp.mkdir(dir, { recursive: true });
    const base = (meta.name || path.basename(from, ".zim")).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 100) || "package";
    let target = path.join(dir, `${base}.zim`);
    for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${base}-${n}.zim`);
    const partial = `${target}.partial`;
    const hash = createHash("sha256");
    const out = await fsp.open(partial, "wx", 0o644);
    try {
      const input = fs.createReadStream(from, { highWaterMark: 1024 * 1024 });
      for await (const chunk of input) {
        hash.update(chunk as Buffer);
        await out.write(chunk as Buffer);
      }
      await out.sync();
    } finally {
      await out.close();
    }
    await fsp.rename(partial, target);
    // Reopen from the copy so the registry never points at the original again.
    await this.o.source.close(publicId);
    const again = await this.o.source.open(publicId, target);
    if (again.uuid !== meta.uuid) throw new AppError("internal", "The copy does not match the original.");
    const rel = path.relative(volume.rootPath, target);
    this.db.run(
      "UPDATE zim_packages SET file_path = ?, relative_path = ?, checksum_sha256 = ?, checksum_state = 'done', state = 'ready', updated_at = ? WHERE id = ?",
      [target, rel, hash.digest("hex"), this.o.clock.now(), rowId],
    );
  }

  private async failImport(rowId: number, publicId: string, e: unknown): Promise<void> {
    const r = this.db.get<ZimRow>("SELECT * FROM zim_packages WHERE id = ?", [rowId]);
    await this.o.source.close(publicId);
    this.opened.delete(publicId);
    if (r?.storage_mode === "copied") {
      const dir = r.volume_id ? this.o.volumes.byId(r.volume_id)?.rootPath : undefined;
      if (dir) for (const f of await fsp.readdir(path.join(dir, "zim")).catch(() => [] as string[])) if (f.endsWith(".partial")) await fsp.rm(path.join(dir, "zim", f), { force: true });
    }
    this.db.run("DELETE FROM zim_packages WHERE id = ? AND state = 'importing'", [rowId]);
    this.o.activity.write({ level: "error", area: "zim", message: "A package could not be added", details: { reason: e instanceof Error ? e.message : String(e) } });
  }

  /** SHA-256 of an in-place file, read once, sequentially, in the background. Nothing is written but the result. */
  private async hashInPlace(rowId: number, file: string): Promise<void> {
    try {
      const hash = createHash("sha256");
      for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) hash.update(chunk as Buffer);
      this.db.run("UPDATE zim_packages SET checksum_sha256 = ?, checksum_state = 'done', updated_at = ? WHERE id = ?", [hash.digest("hex"), this.o.clock.now(), rowId]);
    } catch {
      try { this.db.run("UPDATE zim_packages SET checksum_state = 'failed', updated_at = ? WHERE id = ?", [this.o.clock.now(), rowId]); } catch { /* shutting down */ }
    }
  }

  private trackBackground(p: Promise<unknown>): void {
    const t = p.finally(() => this.background.delete(t));
    this.background.add(t);
  }

  /** Resolves when background work (checksums, copies) has finished. Tests and graceful shutdown wait on it. */
  async idle(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  // ---- changing ------------------------------------------------------------------------------

  patch(publicId: string, raw: unknown): ZimPackageDto {
    const b = parseOrThrow(patchSchema, raw);
    const r = this.rowByPublic(publicId);
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (b.priority !== undefined) { sets.push("priority = ?"); params.push(parsePriority(b.priority) ?? r.priority); }
    if (b.enabledForSearch !== undefined) { sets.push("enabled_for_search = ?"); params.push(b.enabledForSearch ? 1 : 0); }
    if (b.licenseName !== undefined) { sets.push("license_name = ?"); params.push(b.licenseName); }
    if (b.licenseUrl !== undefined) { sets.push("license_url = ?"); params.push(b.licenseUrl); }
    if (b.attribution !== undefined) { sets.push("attribution_text = ?"); params.push(b.attribution); }
    if (sets.length) {
      this.db.transaction(() => {
        this.db.run(`UPDATE zim_packages SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, [...params, this.o.clock.now(), r.id]);
        // The bound source mirrors the package's priority.
        if (b.priority !== undefined) this.db.run("UPDATE sources SET priority = ?, updated_at = ? WHERE zim_package_id = ?", [parsePriority(b.priority) ?? r.priority, this.o.clock.now(), r.id]);
      });
      this.o.onChanged?.();
    }
    return this.get(publicId);
  }

  // ---- removing ------------------------------------------------------------------------------

  removalPlan(publicId: string): RemovalPlan {
    const r = this.rowByPublic(publicId);
    const bm = this.db.all<{ public_id: string; title: string; zim_path: string | null; original_url: string }>(
      "SELECT public_id, title, zim_path, original_url FROM bookmarks WHERE zim_package_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 50", [r.id]);
    const bmTotal = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM bookmarks WHERE zim_package_id = ? AND deleted_at IS NULL", [r.id])!.n;
    const cols = this.db.all<{ public_id: string; name: string; n: number }>(
      `SELECT c.public_id, c.name, COUNT(*) AS n FROM collection_memberships m JOIN collections c ON c.id = m.collection_id
       WHERE m.zim_package_id = ? AND c.deleted_at IS NULL GROUP BY c.id ORDER BY c.id`, [r.id]);
    const srcs = this.db.all<{ public_id: string; name: string }>("SELECT public_id, name FROM sources WHERE zim_package_id = ? AND deleted_at IS NULL", [r.id]);
    const hist = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM history_entries WHERE zim_package_id = ?", [r.id])!.n;
    const total = bmTotal + cols.length + srcs.length + hist;
    return {
      package: { id: r.public_id, title: r.title },
      deletesFile: r.storage_mode === "copied",
      fileBytes: r.size_bytes,
      references: {
        bookmarks: { count: bmTotal, items: bm.map((x) => ({ id: x.public_id, title: x.title || x.original_url, path: x.zim_path ?? "" })) },
        collections: { count: cols.length, items: cols.map((c) => ({ collectionId: c.public_id, name: c.name, entries: c.n })) },
        sources: { count: srcs.length, items: srcs.map((s) => ({ id: s.public_id, name: s.name })) },
        history: { count: hist },
      },
      // The bound source is created by the package itself, so on its own it is not a reason to ask again.
      needsConfirmation: bmTotal + cols.length + hist > 0 || total > srcs.length,
    };
  }

  /** `dryRun` answers the plan and changes nothing. Otherwise references need `confirm: true`; the plan is returned in the 409. */
  async remove(publicId: string, raw: unknown): Promise<{ removed: boolean; plan: RemovalPlan; fileDeleted: boolean }> {
    const b = parseOrThrow(removeSchema, raw ?? {});
    const plan = this.removalPlan(publicId);
    if (b.dryRun) return { removed: false, plan, fileDeleted: false };
    if (plan.needsConfirmation && !b.confirm) {
      throw new AppError("conflict", "Bookmarks, collections or history still refer to this package. Removing it deletes those references. Send confirm: true to go ahead.", plan);
    }
    const r = this.rowByPublic(publicId);
    // Mark first: if the process stops half way, startup finishes the removal.
    this.db.run("UPDATE zim_packages SET state = 'removing', updated_at = ? WHERE id = ?", [this.o.clock.now(), r.id]);
    await this.o.source.close(publicId);
    this.opened.delete(publicId);
    const fileDeleted = await this.finishRemoval(r);
    this.o.activity.write({ level: "info", area: "zim", message: `Knowledge package removed: ${r.title}`, details: { fileDeleted, references: plan.references.bookmarks.count + plan.references.collections.count } });
    this.o.onChanged?.();
    return { removed: true, plan, fileDeleted };
  }

  private async finishRemoval(r: ZimRow): Promise<boolean> {
    this.db.transaction(() => {
      this.db.run("DELETE FROM collection_memberships WHERE zim_package_id = ?", [r.id]);
      // A bookmark kept only for its ZIM entry has nothing left to open. One that also points at an archived page keeps that.
      this.db.run("DELETE FROM bookmarks WHERE zim_package_id = ? AND page_id IS NULL", [r.id]);
      this.db.run("UPDATE bookmarks SET zim_package_id = NULL, zim_path = NULL WHERE zim_package_id = ?", [r.id]);
      this.db.run("UPDATE history_entries SET zim_package_id = NULL WHERE zim_package_id = ?", [r.id]);
      this.db.run("UPDATE sources SET zim_package_id = NULL, deleted_at = ?, enabled = 0, updated_at = ? WHERE zim_package_id = ? AND deleted_at IS NULL", [this.o.clock.now(), this.o.clock.now(), r.id]);
      this.db.run("DELETE FROM zim_packages WHERE id = ?", [r.id]);
    }, { durable: true });
    if (r.storage_mode !== "copied") return false;
    await fsp.rm(r.file_path, { force: true });
    return true;
  }

  // ---- health and startup --------------------------------------------------------------------

  /** Opens a package in its worker if it is not open yet. Returns false when the file is gone (the package is marked `missing`). */
  async ensureOpen(r: ZimRow): Promise<boolean> {
    if (r.state === "importing" || r.state === "removing") return false;
    if (this.o.source.isOpen(r.public_id)) {
      if (r.state === "missing" && fs.existsSync(r.file_path)) this.setState(r.id, "ready", null);
      return true;
    }
    if (!fs.existsSync(r.file_path)) {
      this.setState(r.id, "missing", "The file is no longer where it was added. Mount the drive or put the file back.");
      return false;
    }
    try {
      await this.o.source.open(r.public_id, r.file_path);
      this.opened.add(r.public_id);
      // A state kept from before a restart (degraded, missing) ends with the first successful open.
      if (r.state === "missing" || r.state === "degraded") this.setState(r.id, "ready", null);
      return true;
    } catch (e) {
      this.setState(r.id, "degraded", e instanceof Error ? e.message : "The package could not be opened.");
      return false;
    }
  }

  private setState(rowId: number, state: ZimState, detail: string | null): void {
    this.db.run("UPDATE zim_packages SET state = ?, state_detail = ?, updated_at = ? WHERE id = ? AND state NOT IN ('removing','importing')", [state, detail, this.o.clock.now(), rowId]);
  }

  /** From the worker: a package became degraded or recovered. */
  onHealth(publicId: string, health: ZimHealth, detail?: string): void {
    const r = this.db.get<ZimRow>("SELECT * FROM zim_packages WHERE public_id = ?", [publicId]);
    if (!r || r.state === "removing" || r.state === "importing") return;
    if (health === "degraded" && r.state !== "degraded") {
      this.setState(r.id, "degraded", detail ?? "The package reader had a problem and was restarted.");
      this.o.activity.write({ level: "warn", area: "zim", message: `Knowledge package degraded: ${r.title}`, details: { detail } });
    } else if (health === "ready" && r.state === "degraded") {
      this.setState(r.id, "ready", null);
      this.o.activity.write({ level: "info", area: "zim", message: `Knowledge package recovered: ${r.title}` });
    }
  }

  /** Startup: finish interrupted removals and imports, mark missing files. Packages open lazily on first use. */
  async recover(): Promise<{ removed: number; missing: number }> {
    let removed = 0;
    for (const r of this.db.all<ZimRow>("SELECT * FROM zim_packages WHERE state IN ('removing','importing')")) {
      if (r.state === "removing") {
        await this.finishRemoval(r);
      } else {
        // An import that never finished: a half-copied file is useless.
        if (r.storage_mode === "copied") {
          const dir = r.volume_id ? this.o.volumes.byId(r.volume_id)?.rootPath : undefined;
          if (dir) for (const f of await fsp.readdir(path.join(dir, "zim")).catch(() => [] as string[])) if (f.endsWith(".partial")) await fsp.rm(path.join(dir, "zim", f), { force: true });
        }
        this.db.run("DELETE FROM zim_packages WHERE id = ?", [r.id]);
      }
      removed++;
    }
    let missing = 0;
    for (const r of this.rows()) {
      if (!fs.existsSync(r.file_path)) {
        this.setState(r.id, "missing", "The file is no longer where it was added. Mount the drive or put the file back.");
        missing++;
      } else if (r.state === "missing") {
        this.setState(r.id, "ready", null);
      }
    }
    return { removed, missing };
  }

  /** Checks the file is there and the size is unchanged, then asks the worker for structural checks (`deep` also checks the embedded checksum). */
  async verify(publicId: string, deep = false): Promise<{ ok: boolean; checks: string[]; package: ZimPackageDto }> {
    const r = this.rowByPublic(publicId);
    const checks: string[] = [];
    if (!fs.existsSync(r.file_path)) {
      this.setState(r.id, "missing", "The file is no longer where it was added.");
      return { ok: false, checks: ["file:missing"], package: this.get(publicId) };
    }
    const st = fs.statSync(r.file_path);
    checks.push(`size:${st.size === r.size_bytes ? "ok" : "changed"}`);
    let ok = st.size === r.size_bytes;
    if (!(await this.ensureOpen(r))) return { ok: false, checks: [...checks, "open:failed"], package: this.get(publicId) };
    const v = await this.o.source.verify(publicId, deep);
    checks.push(...v.checks);
    ok = ok && v.ok;
    this.db.run("UPDATE zim_packages SET last_verified_at = ?, updated_at = ? WHERE id = ?", [this.o.clock.now(), this.o.clock.now(), r.id]);
    if (ok && r.state === "degraded") this.setState(r.id, "ready", null);
    if (!ok) this.setState(r.id, "degraded", `Checks failed: ${checks.filter((c) => !c.endsWith(":ok")).join(", ")}`);
    return { ok, checks, package: this.get(publicId) };
  }

  // ---- storage accounting (Z-03, Z-09) -------------------------------------------------------

  /** One row per package for the storage figures: size, priority, where it lives and the source bound to it. */
  accounting(volumeId?: number): { id: string; title: string; bytes: number; priority: PriorityNumber; mode: "in_place" | "copied"; volumeRowId: number | null; sourceId: string | null }[] {
    return this.db.all<{ public_id: string; title: string; size_bytes: number; priority: number; storage_mode: "in_place" | "copied"; volume_id: number | null; src: string | null }>(
      `SELECT z.public_id, z.title, z.size_bytes, z.priority, z.storage_mode, z.volume_id,
              (SELECT s.public_id FROM sources s WHERE s.zim_package_id = z.id AND s.deleted_at IS NULL) AS src
       FROM zim_packages z WHERE z.state <> 'removing' ORDER BY z.id`)
      .filter((r) => volumeId === undefined || r.volume_id === volumeId)
      .map((r) => ({ id: r.public_id, title: r.title, bytes: r.size_bytes, priority: r.priority as PriorityNumber, mode: r.storage_mode, volumeRowId: r.volume_id, sourceId: r.src }));
  }

  /** Bytes of packages by priority, for the storage figures. Copied packages sit on a volume; in-place files are outside the volumes. */
  usage(volumeId?: number): { total: number; count: number; byPriority: Record<"P1" | "P2" | "P3" | "P4", number>; copiedBytes: number; inPlaceBytes: number } {
    const rows = this.db.all<{ priority: number; size_bytes: number; storage_mode: string; volume_id: number | null }>(
      "SELECT priority, size_bytes, storage_mode, volume_id FROM zim_packages WHERE state <> 'removing'");
    const out = { total: 0, count: 0, byPriority: { P1: 0, P2: 0, P3: 0, P4: 0 }, copiedBytes: 0, inPlaceBytes: 0 };
    for (const r of rows) {
      if (volumeId !== undefined && r.volume_id !== volumeId) continue;
      out.total += r.size_bytes;
      out.count++;
      out.byPriority[priorityToCode(r.priority as PriorityNumber)] += r.size_bytes;
      if (r.storage_mode === "copied") out.copiedBytes += r.size_bytes;
      else out.inPlaceBytes += r.size_bytes;
    }
    return out;
  }
}

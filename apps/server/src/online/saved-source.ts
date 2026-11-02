import { z } from "zod";
import type { Db } from "@ncb/db";
import { AppError, newId, type Clock, type PriorityNumber } from "@ncb/shared";
import { parseOrThrow } from "../lib/zod.js";
import type { ActivityLog } from "../services/activity.js";
import type { PipelineService } from "../pipeline/service.js";
import type { RunResult, SourceService, SourceOut } from "../sources/service.js";
import { priorityInput } from "../sources/schema.js";
import { checkResultUrl } from "./normalise.js";
import type { ProviderService } from "./providers.js";
import type { ProviderRunner } from "./runner.js";
import { fuse } from "./rrf.js";
import type { StorageKind } from "./types.js";

const createBody = z.object({
  onResult: z.enum(["candidates", "downloads"]).default("candidates"),
  maxResults: z.number().int().min(1).max(50).default(20),
  priority: priorityInput.default(3),
  schedule: z.unknown().optional(),
  enabled: z.boolean().default(true),
});
const idsBody = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(100), priority: priorityInput.optional() });
const TRANSIENT_TTL_MS = 24 * 3600_000;

const hostOf = (url: string): string | null => { try { return new URL(url).hostname.toLowerCase(); } catch { return null; } };

interface Transient { id: string; url: string; key: string; seenAt: number; priority?: number }

export interface SavedSourceDeps {
  db: Db; clock: Clock; providers: ProviderService; runner: ProviderRunner; sources: SourceService; pipeline: PipelineService; activity: ActivityLog;
  isOffline: () => boolean;
  /** Discovery (Phase 7): called with the row id of a candidate this source stored, so it can be scored. */
  onCandidate?: (candidateId: number) => void;
}

/**
 * A saved search as a source (task O-11). A run asks the enabled providers, fuses the lists, and turns new addresses into discovery
 * candidates or capture downloads. Provider text is never stored: a candidate has the address only. For a provider whose storage policy
 * is `none` (Brave) not even the address is stored until the Human approves it: those candidates live in memory.
 */
export class SavedSearchSources {
  private readonly transient = new Map<string, Transient[]>();
  constructor(private readonly o: SavedSourceDeps) {}
  private get db(): Db { return this.o.db; }

  private saved(userId: number, publicId: string): { id: number; public_id: string; name: string; query: string; source_id: number | null; on_result: "candidates" | "downloads"; max_results: number } {
    const r = this.db.get<any>("SELECT id, public_id, name, query, source_id, on_result, max_results FROM saved_searches WHERE public_id = ? AND user_id = ?", [publicId, userId]);
    if (!r) throw new AppError("not_found", "That saved search does not exist.");
    return r;
  }

  create(userId: number, publicId: string, raw: unknown): SourceOut {
    const s = this.saved(userId, publicId);
    const b = parseOrThrow(createBody, raw ?? {});
    if (s.source_id != null) throw new AppError("conflict", "This saved search is already a source.");
    this.db.run("UPDATE saved_searches SET on_result = ?, max_results = ? WHERE id = ?", [b.onResult, b.maxResults, s.id]);
    return this.o.sources.createSavedSearchSource({ name: s.name, savedSearchRowId: s.id, priority: b.priority as PriorityNumber, schedule: b.schedule, enabled: b.enabled });
  }

  /** Called by the source service for a manual or scheduled run. */
  async run(src: { id: number; publicId: string; priority: PriorityNumber }, o: { signal?: AbortSignal } = {}): Promise<RunResult> {
    const s = this.db.get<{ id: number; query: string; on_result: "candidates" | "downloads"; max_results: number }>("SELECT id, query, on_result, max_results FROM saved_searches WHERE source_id = ?", [src.id]);
    if (!s) throw new AppError("conflict", "The saved search behind this source no longer exists.");
    if (this.o.isOffline()) throw new AppError("offline", "The server is working offline, so the saved search cannot run now.", { canQueue: false });
    if (!this.o.providers.onlineAllowed()) throw new AppError("conflict", "Online search is switched off, so this saved search cannot run. Turn it on in the settings first.");
    const runtimes = this.o.providers.enabledRuntimes();
    if (!runtimes.length) throw new AppError("conflict", "No search provider is switched on.");
    const warnings: string[] = [];
    const lists = await Promise.all(runtimes.map(async (rt) => {
      const out = await this.o.runner.run(rt, { query: s.query, page: 1, pageSize: Math.min(rt.adapter.info.maxPageSize, s.max_results) }, { signal: o.signal });
      if (!out.ok) { warnings.push(`${rt.name}: ${out.error.message}`); this.o.activity.write({ level: "warn", area: "provider", message: `Saved search run: provider ${rt.id} failed`, details: { code: out.error.code } }); return undefined; }
      return { rt, results: out.response.results };
    }));
    const got = lists.filter((l): l is NonNullable<typeof l> => !!l);
    if (!got.length) throw new AppError("provider_error", warnings[0] ?? "No provider answered.");
    const urls = new Map<string, { url: string; title: string; storage: StorageKind; ttl: number }>();
    for (const l of got) for (const r of l.results) {
      const u = checkResultUrl(r.url);
      if (u && !urls.has(u.key)) urls.set(u.key, { url: u.url, title: r.title, storage: l.rt.storage.kind, ttl: l.rt.storage.ttlSeconds });
    }
    const fused = fuse(got.map((l) => ({ kind: "provider" as const, id: l.rt.id, name: l.rt.name, weight: l.rt.weight, keys: l.results.map((r) => checkResultUrl(r.url)?.key).filter((k): k is string => !!k) })), { k: 60, topN: s.max_results });
    const now = this.o.clock.now();
    this.sweepExpired();
    const downloadIds: string[] = [];
    const memory: Transient[] = [];
    let fresh = 0;
    for (const f of fused.slice(0, s.max_results)) {
      const info = urls.get(f.key)!;
      let urlKey: string;
      try { urlKey = this.o.pipeline.urlKey(info.url); } catch { continue; }
      if (this.db.get("SELECT 1 AS x FROM pages WHERE url_key = ? AND deleted_at IS NULL AND availability IN ('archived','partial')", [urlKey])) continue;
      if (info.storage === "none") {
        // Transient provider: held in memory for the Human to approve; nothing is written.
        memory.push({ id: newId("tmp"), url: info.url, key: urlKey, seenAt: now });
        fresh++;
        continue;
      }
      if (s.on_result === "downloads" && info.storage === "unrestricted") {
        if (this.db.get("SELECT 1 AS x FROM download_jobs WHERE source_id = ? AND requested_url = ?", [src.id, info.url])) continue;
        downloadIds.push(this.o.pipeline.captureUrl(info.url, { priority: src.priority, requestedBy: "search", userInitiated: false, sourceId: src.id, discoveredVia: "search", depth: 0 }).downloadId);
        fresh++;
        continue;
      }
      // Candidate: the address, plus the title only when the provider allows storing it. A time-limited provider's candidate expires with its cache time.
      const ttl = info.storage === "ttl" ? Math.max(60, info.ttl) : 0;
      const exists = this.db.get<{ id: number }>("SELECT id FROM discovery_candidates WHERE url_key = ?", [urlKey]);
      if (exists) { this.db.run("UPDATE discovery_candidates SET last_seen_at = ? WHERE id = ?", [now, exists.id]); continue; }
      const res = this.db.run(
        `INSERT INTO discovery_candidates (public_id, url, url_key, host, title_hint, state, score, suggested_source_id, origin_storage, first_seen_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?)`,
        [newId("cand"), info.url, urlKey, hostOf(info.url), info.storage === "unrestricted" ? info.title.slice(0, 300) : null, Number(f.score.toFixed(6)), src.id, info.storage, now, now, ttl ? now + ttl * 1000 : null]);
      this.db.run("INSERT INTO candidate_provenance (candidate_id, kind, ref_source_id, weight, seen_at) VALUES (?, 'saved_search', ?, ?, ?) ON CONFLICT DO NOTHING", [Number(res.lastInsertRowid), src.id, f.score, now]);
      try { this.o.onCandidate?.(Number(res.lastInsertRowid)); } catch { /* scoring never breaks a saved-search run */ }
      fresh++;
    }
    this.transient.set(String(src.id), memory);
    if (memory.length && s.on_result === "downloads") warnings.push("Results from a provider that allows no storage are held for approval instead of being saved automatically.");
    return { downloadIds, found: fused.length, newItems: fresh, warnings };
  }

  /** Ties the candidate to the download it started, so discovery can follow it to the end (Phase 7). */
  private link(candidateId: number, downloadPublicId: string): void {
    const dj = this.db.get<{ id: number }>("SELECT id FROM download_jobs WHERE public_id = ?", [downloadPublicId]);
    if (!dj) return;
    this.db.run("UPDATE discovery_candidates SET download_job_id = ? WHERE id = ?", [dj.id, candidateId]);
    this.db.run("UPDATE download_jobs SET candidate_id = ? WHERE id = ?", [candidateId, dj.id]);
  }

  private sweepExpired(): void {
    const now = this.o.clock.now();
    this.db.run("DELETE FROM discovery_candidates WHERE origin_storage = 'ttl' AND state = 'new' AND expires_at <= ?", [now]);
    for (const [k, list] of this.transient) {
      const keep = list.filter((t) => now - t.seenAt < TRANSIENT_TTL_MS);
      if (keep.length) this.transient.set(k, keep); else this.transient.delete(k);
    }
  }

  private sourceIdOf(userId: number, publicId: string): number {
    const s = this.saved(userId, publicId);
    if (s.source_id == null) throw new AppError("conflict", "This saved search is not a source yet.");
    return s.source_id;
  }

  candidates(userId: number, publicId: string): { items: unknown[] } {
    const sid = this.sourceIdOf(userId, publicId);
    this.sweepExpired();
    const rows = this.db.all<{ public_id: string; url: string; title_hint: string | null; state: string; last_seen_at: number }>(
      "SELECT public_id, url, title_hint, state, last_seen_at FROM discovery_candidates WHERE suggested_source_id = ? AND state <> 'expired' ORDER BY last_seen_at DESC, id DESC LIMIT 200", [sid]);
    return {
      items: [
        ...(this.transient.get(String(sid)) ?? []).map((t) => ({ id: t.id, url: t.url, title: null, state: "new", transient: true, seenAt: new Date(t.seenAt).toISOString() })),
        ...rows.map((r) => ({ id: r.public_id, url: r.url, title: r.title_hint, state: r.state, transient: false, seenAt: new Date(r.last_seen_at).toISOString() })),
      ],
    };
  }

  approve(userId: number, publicId: string, raw: unknown): { queued: number; downloadIds: string[] } {
    const sid = this.sourceIdOf(userId, publicId);
    const b = parseOrThrow(idsBody, raw);
    const prio = (b.priority ?? (this.db.get<{ priority: number }>("SELECT priority FROM sources WHERE id = ?", [sid])?.priority ?? 3)) as PriorityNumber;
    const now = this.o.clock.now();
    const downloadIds: string[] = [];
    const mem = this.transient.get(String(sid)) ?? [];
    for (const id of b.ids) {
      const t = mem.find((x) => x.id === id);
      if (t) {
        // The Human approved this address: it is stored now, without a title or any provider text.
        let cid: number | undefined;
        const res = this.db.run(
          `INSERT INTO discovery_candidates (public_id, url, url_key, title_hint, state, suggested_source_id, origin_storage, first_seen_at, last_seen_at, decided_by, decided_at)
           VALUES (?, ?, ?, NULL, 'queued', ?, 'none', ?, ?, 'user', ?) ON CONFLICT(url_key) DO UPDATE SET state = 'queued', decided_by = 'user', decided_at = excluded.decided_at`,
          [newId("cand"), t.url, t.key, sid, t.seenAt, now, now]);
        void res;
        cid = this.db.get<{ id: number }>("SELECT id FROM discovery_candidates WHERE url_key = ?", [t.key])?.id;
        // Provenance (no provider text) and a score, so the approved address shows in the discovery list.
        if (cid !== undefined) {
          this.db.run("INSERT INTO candidate_provenance (candidate_id, kind, ref_source_id, seen_at) VALUES (?, 'saved_search', ?, ?) ON CONFLICT DO NOTHING", [cid, sid, now]);
          this.db.run("UPDATE discovery_candidates SET host = COALESCE(host, ?) WHERE id = ?", [hostOf(t.url), cid]);
          try { this.o.onCandidate?.(cid); } catch { /* scoring never breaks an approval */ }
        }
        const dlId = this.o.pipeline.captureUrl(t.url, { priority: prio, requestedBy: "search", userInitiated: false, sourceId: sid, discoveredVia: "search", depth: 0 }).downloadId;
        downloadIds.push(dlId);
        if (cid !== undefined) this.link(cid, dlId);
        this.transient.set(String(sid), (this.transient.get(String(sid)) ?? []).filter((x) => x.id !== id));
        continue;
      }
      const c = this.db.get<{ id: number; url: string; state: string }>("SELECT id, url, state FROM discovery_candidates WHERE public_id = ? AND suggested_source_id = ?", [id, sid]);
      if (!c) throw new AppError("not_found", "One of those candidates does not exist any more.");
      if (c.state === "queued" || c.state === "archived") continue;
      const dlId = this.o.pipeline.captureUrl(c.url, { priority: prio, requestedBy: "search", userInitiated: false, sourceId: sid, discoveredVia: "search", depth: 0 }).downloadId;
      downloadIds.push(dlId);
      this.db.run("UPDATE discovery_candidates SET state = 'queued', decided_by = 'user', decided_at = ? WHERE id = ?", [now, c.id]);
      this.link(c.id, dlId);
    }
    return { queued: downloadIds.length, downloadIds };
  }

  dismiss(userId: number, publicId: string, raw: unknown): { dismissed: number } {
    const sid = this.sourceIdOf(userId, publicId);
    const b = parseOrThrow(idsBody.omit({ priority: true }), raw);
    let n = 0;
    const mem = this.transient.get(String(sid)) ?? [];
    for (const id of b.ids) {
      if (mem.some((x) => x.id === id)) { this.transient.set(String(sid), (this.transient.get(String(sid)) ?? []).filter((x) => x.id !== id)); n++; continue; }
      n += this.db.run("UPDATE discovery_candidates SET state = 'dismissed', decided_by = 'user', decided_at = ? WHERE public_id = ? AND suggested_source_id = ?", [this.o.clock.now(), id, sid]).changes;
    }
    return { dismissed: n };
  }
}

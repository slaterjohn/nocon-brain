import type { Db, JobQueue } from "@ncb/db";
import { AppError, newId, parsePriority, priorityToCode, type Clock, type PriorityNumber } from "@ncb/shared";
import { parseOrThrow, RequestValidationError } from "../lib/zod.js";
import type { ScheduleOut, ScheduleService } from "../schedule/service.js";
import type { ActivityLog } from "../services/activity.js";
import type { EventBus } from "../services/events.js";
import type { SettingsService } from "../services/settings.js";
import type { RobotsService } from "@ncb/fetch";
import type { PipelineService } from "../pipeline/service.js";
import { parseVersioning } from "../pipeline/policy.js";
import type { VersioningPolicy } from "../pipeline/types.js";
import type { CrawlPort } from "./crawl-port.js";
import { readFeed, readSitemap, type DiscoveryFetcher } from "./discovery/fetch.js";
import { toCrawlConfig } from "./crawl-port.js";
import { previewCrawl, type PreviewEstimate } from "./preview.js";
import { ceilingsFor, type ResourceProfile } from "./limits.js";
import { linkPageSource } from "./references.js";
import {
  defaultRetention, defaultStrategy, resolveConfig, retentionSpecSchema, sourceInputSchema, sourcePatchSchema, WEB_TYPES,
  type RetentionSpec, type SourceConfig, type SourceInput, type SourceType,
} from "./schema.js";

export type SystemKind = "quick_saves" | "browsing_cache" | "imports";

const SYSTEM_DEFS: Record<SystemKind, { name: string; description: string; priority: PriorityNumber; automaticEviction: boolean }> = {
  quick_saves: { name: "Quick saves", description: "Pages saved one at a time from the browser or the address bar.", priority: 3, automaticEviction: true },
  browsing_cache: { name: "Browsing cache", description: "Pages kept automatically while you browse. They are the first to go when space runs short.", priority: 4, automaticEviction: true },
  imports: { name: "Imports", description: "Documents and packages you add from files.", priority: 3, automaticEviction: false },
};

export interface SourceOut {
  id: string;
  name: string;
  description: string | null;
  type: SourceType;
  adapter: string;
  startUrl: string | null;
  strategy: string;
  profile: string;
  config: SourceConfig;
  configVersion: number;
  priority: "P1" | "P2" | "P3" | "P4";
  retention: RetentionSpec;
  automaticEviction: boolean;
  storageBudgetBytes: number | null;
  preferredVolumeId: string | null;
  discoveryEnabled: boolean;
  enabled: boolean;
  paused: boolean;
  system: boolean;
  systemKind: SystemKind | null;
  collections: string[];
  schedule: ScheduleOut | null;
  pageCount: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: number; public_id: string; name: string; description: string | null; type: SourceType; adapter: string; start_url: string | null; strategy: string; profile: string;
  current_config_id: number | null; priority: number; retention_mode: string; retention_json: string; automatic_eviction: number; storage_budget_bytes: number | null;
  preferred_volume_id: number | null; discovery_enabled: number; enabled: number; system_kind: SystemKind | null; paused_at: number | null; last_run_at: number | null;
  next_run_at: number | null; last_status: string | null; created_at: number; updated_at: number; deleted_at: number | null;
}

export interface RunResult {
  /** Public ids of the download jobs the run created. */
  downloadIds: string[];
  /** Sitemap and feed runs: addresses found, how many were new, and how many captures were queued. */
  found?: number;
  newItems?: number;
  excluded?: number;
  warnings?: string[];
}

export interface SourceServiceOptions {
  db: Db;
  clock: Clock;
  settings: Pick<SettingsService, "internal">;
  schedules: ScheduleService;
  pipeline: Pick<PipelineService, "captureUrl" | "urlKey">;
  crawl: CrawlPort;
  fetcher: DiscoveryFetcher;
  queue: Pick<JobQueue, "cancelByDownloadJob">;
  activity: ActivityLog;
  events: EventBus;
  /** Public volume id to row id. */
  volumeId?: (publicId: string) => number | undefined;
  /** Explicit deletion of a page (library service), used by `deletePages=true`. */
  deletePage?: (pageId: string) => void;
  /** Crawl engine controls, used when a source is paused, resumed or deleted. */
  crawlControl?: { pause(id: string): unknown; resume(id: string): unknown; cancel(id: string): unknown };
  /** Called after a source's collection list changed, to add its existing pages to the new collections. */
  onCollectionsChanged?: (sourceRowId: number) => void;
  /** Called with the pages whose references changed (a source's priority, retention or flag changed, or the source was deleted), so cached priorities are refreshed. */
  onReferencesChanged?: (pageIds: number[]) => void;
  /** Checks a source's saved pages for changes. Scheduled runs of a source that has pages use it (task C-11). */
  refresh?: { refreshSource(sourceRowId: number, o: { requestedBy: "user" | "schedule" | "system" }): Promise<{ downloadId: string; pages: number }>; pageCount(sourceRowId: number): number };
  /** robots.txt for the preview's sample (`robots.check`); without it the preview does not look at robots.txt. */
  previewRobots?: Pick<RobotsService, "check">;
  /** Free bytes on the best writable volume, for the preview's size warning. */
  freeBytes?: () => number | undefined;
  /** Runs a saved-search source (Phase 5, task O-11): the search, then candidates or downloads. */
  runSavedSearch?: (source: { id: number; publicId: string; priority: PriorityNumber }, o: { requestedBy: "user" | "schedule" | "system"; signal?: AbortSignal }) => Promise<RunResult>;
}

const iso = (n: number | null): string | null => (n == null ? null : new Date(n).toISOString());

export class SourceService {
  constructor(private readonly o: SourceServiceOptions) {}

  private get db(): Db {
    return this.o.db;
  }

  get resourceProfile(): ResourceProfile {
    return (this.o.settings.internal("resources") as { profile: ResourceProfile }).profile;
  }

  /** Connects the saved-search runner (it needs the search services, which are built after this one). */
  attachSavedSearchRunner(fn: NonNullable<SourceServiceOptions["runSavedSearch"]>): void {
    this.o.runSavedSearch = fn;
  }

  // ---- system sources ------------------------------------------------------------------------

  /**
   * Creates the three system sources if they are missing. Quick saves takes its priority from `browser.quickSavePriority`
   * the first time only; after that the source row is the setting (the API can change it). Safe to call at every start.
   */
  ensureSystemSources(): void {
    const quick = (this.o.settings.internal("browser") as { quickSavePriority?: number }).quickSavePriority ?? 3;
    for (const kind of Object.keys(SYSTEM_DEFS) as SystemKind[]) {
      if (this.db.get("SELECT 1 AS x FROM sources WHERE system_kind = ?", [kind])) continue;
      const def = SYSTEM_DEFS[kind];
      const priority = (kind === "quick_saves" ? quick : def.priority) as PriorityNumber;
      const config = resolveConfig({ versioning: { mode: "on_change" } }, "single_page", "focused", this.resourceProfile);
      const now = this.o.clock.now();
      this.db.transaction(() => {
        const res = this.db.run(
          `INSERT INTO sources (public_id, name, description, type, adapter, strategy, profile, priority, retention_mode, retention_json, automatic_eviction, system_kind, created_at, updated_at, last_status)
           VALUES (?, ?, ?, ?, 'http', 'capture', 'focused', ?, 'latest', '{"count":1}', ?, ?, ?, ?, 'never')`,
          [newId("src"), def.name, def.description, kind === "imports" ? "imported_documents" : "single_page", priority, def.automaticEviction ? 1 : 0, kind, now, now],
        );
        const sid = Number(res.lastInsertRowid);
        const cfg = this.db.run("INSERT INTO source_configs (source_id, version, config_json, created_at) VALUES (?, 1, ?, ?)", [sid, JSON.stringify(config), now]);
        this.db.run("UPDATE sources SET current_config_id = ? WHERE id = ?", [Number(cfg.lastInsertRowid), sid]);
      });
    }
  }

  /** Row id of a system source (always exists after `ensureSystemSources`). */
  systemId(kind: SystemKind): number {
    const r = this.db.get<{ id: number }>("SELECT id FROM sources WHERE system_kind = ?", [kind]);
    if (!r) throw new AppError("internal", "The built-in sources have not been created yet.");
    return r.id;
  }

  // ---- reading -------------------------------------------------------------------------------

  rowByPublic(publicId: string, opts: { includeDeleted?: boolean } = {}): Row {
    const r = this.db.get<Row>("SELECT * FROM sources WHERE public_id = ?", [publicId]);
    if (!r || (r.deleted_at !== null && !opts.includeDeleted)) throw new AppError("not_found", "That source does not exist.");
    return r;
  }

  rowId(publicId: string): number {
    return this.rowByPublic(publicId).id;
  }

  private config(r: Row): { config: SourceConfig; version: number } {
    const c = this.db.get<{ config_json: string; version: number }>("SELECT config_json, version FROM source_configs WHERE id = ?", [r.current_config_id]);
    if (!c) throw new AppError("internal", "This source has lost its settings. Re-save it to repair it.");
    return { config: JSON.parse(c.config_json) as SourceConfig, version: c.version };
  }

  private out(r: Row): SourceOut {
    const { config, version } = this.config(r);
    const vol = r.preferred_volume_id == null ? null : (this.db.get<{ public_id: string }>("SELECT public_id FROM volumes WHERE id = ?", [r.preferred_volume_id])?.public_id ?? null);
    const schedule = this.o.schedules.list({ sourceId: r.id })[0] ?? null;
    return {
      id: r.public_id, name: r.name, description: r.description, type: r.type, adapter: r.adapter, startUrl: r.start_url, strategy: r.strategy, profile: r.profile,
      config, configVersion: version, priority: priorityToCode(r.priority as PriorityNumber),
      retention: r.retention_mode === "all" ? { mode: "all" } : ({ mode: r.retention_mode, ...JSON.parse(r.retention_json) } as RetentionSpec),
      automaticEviction: r.automatic_eviction === 1, storageBudgetBytes: r.storage_budget_bytes, preferredVolumeId: vol, discoveryEnabled: r.discovery_enabled === 1,
      enabled: r.enabled === 1, paused: r.paused_at !== null, system: r.system_kind !== null, systemKind: r.system_kind,
      collections: this.db.all<{ public_id: string }>("SELECT c.public_id FROM source_collections sc JOIN collections c ON c.id = sc.collection_id WHERE sc.source_id = ? AND c.deleted_at IS NULL", [r.id]).map((x) => x.public_id),
      schedule, pageCount: this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_sources WHERE source_id = ?", [r.id])!.n,
      lastRunAt: iso(r.last_run_at), nextRunAt: iso(r.next_run_at), lastStatus: r.last_status, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
    };
  }

  get(publicId: string): SourceOut {
    return this.out(this.rowByPublic(publicId));
  }

  list(o: { type?: string; enabled?: boolean; system?: boolean; limit: number; offset: number }): { items: SourceOut[]; nextCursor?: string; total: number } {
    const where = ["deleted_at IS NULL"];
    const params: (string | number)[] = [];
    if (o.type) { where.push("type = ?"); params.push(o.type); }
    if (o.enabled !== undefined) { where.push("enabled = ?"); params.push(o.enabled ? 1 : 0); }
    if (o.system !== undefined) where.push(o.system ? "system_kind IS NOT NULL" : "system_kind IS NULL");
    const w = where.join(" AND ");
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sources WHERE ${w}`, params)!.n;
    const rows = this.db.all<Row>(`SELECT * FROM sources WHERE ${w} ORDER BY (system_kind IS NULL), id LIMIT ? OFFSET ?`, [...params, o.limit, o.offset]);
    const next = o.offset + rows.length;
    return { items: rows.map((r) => this.out(r)), total, ...(next < total ? { nextCursor: String(next) } : {}) };
  }

  // ---- creating and editing ------------------------------------------------------------------

  private collectionIds(publicIds: string[] | undefined): number[] {
    const ids: number[] = [];
    (publicIds ?? []).forEach((p, i) => {
      const c = this.db.get<{ id: number }>("SELECT id FROM collections WHERE public_id = ? AND deleted_at IS NULL", [p]);
      if (!c) throw new AppError("bad_request", "A collection does not exist.", { fields: [{ in: "body", path: `collections.${i}`, message: "Choose a collection that exists" }] });
      ids.push(c.id);
    });
    return ids;
  }

  private volume(publicId: string | null | undefined): number | null | undefined {
    if (publicId === undefined) return undefined;
    if (publicId === null) return null;
    const id = this.o.volumeId?.(publicId);
    if (id === undefined) throw new AppError("bad_request", "That storage volume does not exist.", { fields: [{ in: "body", path: "preferredVolumeId", message: "Choose a volume that exists" }] });
    return id;
  }

  /** Creates the source behind a saved search (task O-11). The type is not offered by `create`, which is for web sources. */
  createSavedSearchSource(input: { name: string; savedSearchRowId: number; priority: PriorityNumber; schedule?: unknown; enabled?: boolean }): SourceOut {
    const now = this.o.clock.now();
    const config = resolveConfig({}, "single_page", "focused", this.resourceProfile);
    const sid = this.db.transaction(() => {
      const res = this.db.run(
        `INSERT INTO sources (public_id, name, type, adapter, strategy, profile, priority, retention_mode, retention_json, automatic_eviction, saved_search_id, enabled, last_status, created_at, updated_at)
         VALUES (?, ?, 'saved_search', 'http', 'capture', 'focused', ?, 'latest', '{"count":1}', ?, ?, ?, 'never', ?, ?)`,
        [newId("src"), input.name, input.priority, input.priority >= 3 ? 1 : 0, input.savedSearchRowId, input.enabled === false ? 0 : 1, now, now]);
      const id = Number(res.lastInsertRowid);
      const cfg = this.db.run("INSERT INTO source_configs (source_id, version, config_json, created_at) VALUES (?, 1, ?, ?)", [id, JSON.stringify(config), now]);
      this.db.run("UPDATE sources SET current_config_id = ? WHERE id = ?", [Number(cfg.lastInsertRowid), id]);
      this.db.run("UPDATE saved_searches SET source_id = ? WHERE id = ?", [id, input.savedSearchRowId]);
      if (input.schedule) this.o.schedules.create(id, input.schedule as never);
      return id;
    }, { durable: true });
    this.o.activity.write({ level: "info", area: "crawl", message: `Source created: ${input.name}`, details: { type: "saved_search" } });
    return this.out(this.db.get<Row>("SELECT * FROM sources WHERE id = ?", [sid])!);
  }

  create(body: unknown): SourceOut {
    const v = parseOrThrow(sourceInputSchema(this.resourceProfile), body) as unknown as SourceInput;
    const now = this.o.clock.now();
    const strategy = v.strategy ?? defaultStrategy(v.type);
    const config = resolveConfig(v.config, v.type, v.profile, this.resourceProfile, v.startUrl);
    const retention = v.retention ?? defaultRetention(config);
    const evict = v.automaticEviction ?? v.priority >= 3;
    const cols = this.collectionIds(v.collections);
    const vol = this.volume(v.preferredVolumeId) ?? null;
    const { mode, ...retentionRest } = retention;
    const id = this.db.transaction(() => {
      const res = this.db.run(
        `INSERT INTO sources (public_id, name, description, type, adapter, start_url, strategy, profile, priority, retention_mode, retention_json, automatic_eviction,
           storage_budget_bytes, preferred_volume_id, discovery_enabled, enabled, last_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'http', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'never', ?, ?)`,
        [newId("src"), v.name, v.description ?? null, v.type, v.startUrl ?? null, strategy, v.profile, v.priority, mode, JSON.stringify(retentionRest), evict ? 1 : 0,
          v.storageBudgetBytes ?? null, vol, v.discoveryEnabled ? 1 : 0, v.enabled ? 1 : 0, now, now],
      );
      const sid = Number(res.lastInsertRowid);
      const cfg = this.db.run("INSERT INTO source_configs (source_id, version, config_json, created_at) VALUES (?, 1, ?, ?)", [sid, JSON.stringify(config), now]);
      this.db.run("UPDATE sources SET current_config_id = ? WHERE id = ?", [Number(cfg.lastInsertRowid), sid]);
      for (const c of cols) this.db.run("INSERT INTO source_collections (source_id, collection_id) VALUES (?, ?)", [sid, c]);
      if (v.schedule) this.o.schedules.create(sid, v.schedule);
      return sid;
    }, { durable: true });
    this.o.activity.write({ level: "info", area: "crawl", message: `Source created: ${v.name}`, details: { type: v.type, priority: priorityToCode(v.priority) } });
    return this.out(this.db.get<Row>("SELECT * FROM sources WHERE id = ?", [id])!);
  }

  /**
   * Edits a source. A change to the crawl settings stores a new `source_configs` version (jobs keep the version they ran
   * with); other fields are updated in place. System sources can change priority, retention and enabled only.
   */
  update(publicId: string, body: unknown): SourceOut {
    const cur = this.rowByPublic(publicId);
    const patch = parseOrThrow(sourcePatchSchema(this.resourceProfile), body);
    if (cur.system_kind) {
      const forbidden = (["name", "description", "startUrl", "strategy", "profile", "config", "collections"] as const).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
      if (forbidden.length) {
        throw new AppError("conflict", "This is a built-in source. You can change its priority, how long it keeps copies and whether it is on, but not its other settings.", {
          fields: forbidden.map((f) => ({ in: "body", path: f, message: "Not editable on a built-in source" })),
        });
      }
    }
    const { config: storedConfig } = this.config(cur);
    const profile = (patch.profile ?? cur.profile) as SourceInput["profile"];
    const startUrl = patch.startUrl ?? cur.start_url ?? undefined;
    if (!cur.system_kind && WEB_TYPES.has(cur.type) && !startUrl) throw new RequestValidationError([{ in: "body", path: "startUrl", message: "Enter the address to start from" }]);
    const baseInput = patch.config ? { ...storedConfig, ...patch.config } : patch.profile && patch.profile !== cur.profile ? {} : storedConfig;
    const nextConfig = cur.system_kind ? storedConfig : resolveConfig(baseInput, cur.type, profile, this.resourceProfile, startUrl);
    if (nextConfig.queryParamPolicy === "allowlist" && nextConfig.queryParamAllowlist.length === 0) {
      throw new RequestValidationError([{ in: "body", path: "config.queryParamAllowlist", message: "List the query parameters to keep" }]);
    }
    const changed = JSON.stringify(nextConfig) !== JSON.stringify(storedConfig);
    const priority = (patch.priority ?? cur.priority) as PriorityNumber;
    const retention = patch.retention;
    const vol = this.volume(patch.preferredVolumeId);
    const cols = patch.collections ? this.collectionIds(patch.collections) : undefined;
    const now = this.o.clock.now();

    this.db.transaction(() => {
      let configId = cur.current_config_id;
      if (changed) {
        const next = (this.db.get<{ v: number }>("SELECT MAX(version) AS v FROM source_configs WHERE source_id = ?", [cur.id])?.v ?? 0) + 1;
        configId = Number(this.db.run("INSERT INTO source_configs (source_id, version, config_json, created_at) VALUES (?, ?, ?, ?)", [cur.id, next, JSON.stringify(nextConfig), now]).lastInsertRowid);
      }
      const { mode, ...rest } = retention ?? { mode: cur.retention_mode as RetentionSpec["mode"] };
      const keepRetention = retention === undefined;
      this.db.run(
        `UPDATE sources SET name = ?, description = ?, start_url = ?, strategy = ?, profile = ?, current_config_id = ?, priority = ?, retention_mode = ?, retention_json = ?,
           automatic_eviction = ?, storage_budget_bytes = ?, preferred_volume_id = ?, discovery_enabled = ?, enabled = ?, updated_at = ? WHERE id = ?`,
        [patch.name ?? cur.name, patch.description === undefined ? cur.description : patch.description, startUrl ?? null, patch.strategy ?? cur.strategy, profile, configId, priority,
          keepRetention ? cur.retention_mode : mode, keepRetention ? cur.retention_json : JSON.stringify(rest),
          (patch.automaticEviction ?? cur.automatic_eviction === 1) ? 1 : 0,
          patch.storageBudgetBytes === undefined ? cur.storage_budget_bytes : patch.storageBudgetBytes, vol === undefined ? cur.preferred_volume_id : vol,
          (patch.discoveryEnabled ?? cur.discovery_enabled === 1) ? 1 : 0, (patch.enabled ?? cur.enabled === 1) ? 1 : 0, now, cur.id],
      );
      if (cols) {
        this.db.run("DELETE FROM source_collections WHERE source_id = ?", [cur.id]);
        for (const c of cols) this.db.run("INSERT INTO source_collections (source_id, collection_id) VALUES (?, ?)", [cur.id, c]);
      }
    }, { durable: true });
    if (cols) this.o.onCollectionsChanged?.(cur.id);
    if (this.o.onReferencesChanged && (patch.priority !== undefined || patch.retention !== undefined || patch.automaticEviction !== undefined || patch.storageBudgetBytes !== undefined)) {
      this.o.onReferencesChanged(this.db.all<{ page_id: number }>("SELECT page_id FROM page_sources WHERE source_id = ?", [cur.id]).map((r) => r.page_id));
    }
    return this.get(publicId);
  }

  setEnabled(publicId: string, enabled: boolean): SourceOut {
    const r = this.rowByPublic(publicId);
    this.db.run("UPDATE sources SET enabled = ?, updated_at = ? WHERE id = ?", [enabled ? 1 : 0, this.o.clock.now(), r.id]);
    this.o.activity.write({ level: "info", area: "crawl", message: `Source ${enabled ? "enabled" : "disabled"}: ${r.name}` });
    return this.get(publicId);
  }

  /** Pauses or resumes scheduled work. A paused source keeps its pages and references, and can still be run by hand. */
  setPaused(publicId: string, paused: boolean): SourceOut {
    const r = this.rowByPublic(publicId);
    this.db.run("UPDATE sources SET paused_at = ?, updated_at = ? WHERE id = ?", [paused ? this.o.clock.now() : null, this.o.clock.now(), r.id]);
    // Crawls in progress follow: pausing holds their queued frontier, resuming releases it.
    const ctl = this.o.crawlControl;
    if (ctl) {
      const states = paused ? "('running')" : "('paused')";
      for (const j of this.db.all<{ public_id: string }>(`SELECT public_id FROM download_jobs WHERE source_id = ? AND kind IN ('explore','mirror') AND state IN ${states} AND paused_by_window = 0`, [r.id])) {
        try { paused ? ctl.pause(j.public_id) : ctl.resume(j.public_id); } catch { /* a crawl that already ended needs no change */ }
      }
    }
    this.o.activity.write({ level: "info", area: "crawl", message: `Source ${paused ? "paused" : "resumed"}: ${r.name}` });
    return this.get(publicId);
  }

  /**
   * Soft delete. The source row stays (hidden, `deleted_at` set) so old download jobs and page versions still name it, but:
   *  - every `page_sources` row of the source is removed, so no page keeps a reference to it;
   *  - its schedules and windows are deleted and its queued or running downloads are cancelled;
   *  - the pages themselves stay in the archive. A page left with no reference at all counts as priority 4 and surplus, and
   *    storage management (Phase 6) removes it by policy when space is needed; nothing is orphaned silently.
   * With `deletePages` the archive also deletes pages that have no other source and no bookmark.
   */
  remove(publicId: string, opts: { deletePages?: boolean } = {}): { referencesRemoved: number; pagesDeleted: number; pagesUnreferenced: number; downloadsCancelled: number } {
    const cur = this.rowByPublic(publicId);
    if (cur.system_kind) throw new AppError("conflict", "Built-in sources cannot be deleted. You can turn one off instead.");
    const now = this.o.clock.now();
    const pageIds = this.db.all<{ page_id: number }>("SELECT page_id FROM page_sources WHERE source_id = ?", [cur.id]).map((r) => r.page_id);
    const jobs = this.db.all<{ id: number; public_id: string; kind: string }>("SELECT id, public_id, kind FROM download_jobs WHERE source_id = ? AND state IN ('queued','running','paused')", [cur.id]);
    for (const j of jobs) {
      if (j.kind === "explore" || j.kind === "mirror") {
        try { this.o.crawlControl?.cancel(j.public_id); } catch { /* already finished */ }
      }
    }
    const out = this.db.transaction(() => {
      for (const j of jobs) {
        this.o.queue.cancelByDownloadJob(j.id);
        this.db.run("UPDATE download_jobs SET state = 'cancelled', failure_code = 'cancelled_by_user', finished_at = ? WHERE id = ?", [now, j.id]);
      }
      const refs = this.db.run("DELETE FROM page_sources WHERE source_id = ?", [cur.id]).changes;
      this.db.run("DELETE FROM source_collections WHERE source_id = ?", [cur.id]);
      this.db.run("DELETE FROM source_discovered_urls WHERE source_id = ?", [cur.id]);
      this.db.run("DELETE FROM schedules WHERE source_id = ?", [cur.id]);
      this.db.run("DELETE FROM download_windows WHERE source_id = ?", [cur.id]);
      this.db.run("UPDATE sources SET deleted_at = ?, enabled = 0, paused_at = NULL, next_run_at = NULL, updated_at = ? WHERE id = ?", [now, now, cur.id]);
      return refs;
    }, { durable: true });

    this.o.onReferencesChanged?.(pageIds);
    let pagesDeleted = 0;
    let unreferenced = 0;
    for (const pid of pageIds) {
      const stillRef = this.db.get("SELECT 1 AS x FROM page_sources WHERE page_id = ? LIMIT 1", [pid]) || this.db.get("SELECT 1 AS x FROM bookmarks WHERE page_id = ? AND deleted_at IS NULL LIMIT 1", [pid]);
      if (stillRef) continue;
      if (opts.deletePages && this.o.deletePage) {
        const pub = this.db.get<{ public_id: string }>("SELECT public_id FROM pages WHERE id = ?", [pid])?.public_id;
        if (pub) {
          try {
            this.o.deletePage(pub);
            pagesDeleted++;
            continue;
          } catch {
            /* fall through: the page stays and is counted as unreferenced */
          }
        }
      }
      unreferenced++;
    }
    this.o.activity.write({
      level: "info", area: "crawl", message: `Source deleted: ${cur.name}`,
      details: { referencesRemoved: out, pagesDeleted, pagesUnreferenced: unreferenced, downloadsCancelled: jobs.length, deletePages: !!opts.deletePages },
    });
    return { referencesRemoved: out, pagesDeleted, pagesUnreferenced: unreferenced, downloadsCancelled: jobs.length };
  }

  // ---- pages and stats -----------------------------------------------------------------------

  pages(publicId: string, o: { limit: number; offset: number }): { items: unknown[]; nextCursor?: string; total: number } {
    const s = this.rowByPublic(publicId);
    const total = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_sources WHERE source_id = ?", [s.id])!.n;
    const rows = this.db.all<{ public_id: string; canonical_url: string; host: string; title: string | null; availability: string; effective_priority: number | null; first_seen_at: number; last_seen_at: number; discovered_via: string; depth: number; priority_override: number | null }>(
      `SELECT p.public_id, p.canonical_url, p.host, p.title, p.availability, p.effective_priority, ps.first_seen_at, ps.last_seen_at, ps.discovered_via, ps.depth, ps.priority_override
       FROM page_sources ps JOIN pages p ON p.id = ps.page_id WHERE ps.source_id = ? ORDER BY ps.last_seen_at DESC, p.id DESC LIMIT ? OFFSET ?`, [s.id, o.limit, o.offset]);
    const items = rows.map((r) => ({
      pageId: r.public_id, url: r.canonical_url, host: r.host, title: r.title, availability: r.availability,
      effectivePriority: r.effective_priority == null ? null : priorityToCode(r.effective_priority as PriorityNumber),
      firstSeenAt: iso(r.first_seen_at), lastSeenAt: iso(r.last_seen_at), discoveredVia: r.discovered_via, depth: r.depth,
      priorityOverride: r.priority_override == null ? null : priorityToCode(r.priority_override as PriorityNumber),
    }));
    const next = o.offset + rows.length;
    return { items, total, ...(next < total ? { nextCursor: String(next) } : {}) };
  }

  stats(publicId: string) {
    const s = this.rowByPublic(publicId);
    const byPriority = this.db.all<{ p: number; n: number }>(
      `SELECT COALESCE(ps.priority_override, ?) AS p, COUNT(*) AS n FROM page_sources ps WHERE ps.source_id = ? GROUP BY p ORDER BY p`, [s.priority, s.id]);
    const totals = this.db.get<{ pages: number; versions: number; bytes: number }>(
      `SELECT COUNT(DISTINCT ps.page_id) AS pages,
              (SELECT COUNT(*) FROM page_versions v WHERE v.page_id IN (SELECT page_id FROM page_sources WHERE source_id = ?) AND v.status IN ('ready','partial')) AS versions,
              (SELECT COALESCE(SUM(v.total_bytes), 0) FROM page_versions v JOIN pages p ON p.latest_version_id = v.id WHERE p.id IN (SELECT page_id FROM page_sources WHERE source_id = ?)) AS bytes
       FROM page_sources ps WHERE ps.source_id = ?`, [s.id, s.id, s.id])!;
    const runs = this.db.all<{ public_id: string; kind: string; state: string; requested_by: string; pages_done: number; pages_failed: number; bytes_done: number; started_at: number | null; finished_at: number | null; created_at: number; failure_code: string | null; failure_message: string | null }>(
      `SELECT public_id, kind, state, requested_by, pages_done, pages_failed, bytes_done, started_at, finished_at, created_at, failure_code, failure_message
       FROM download_jobs WHERE source_id = ? ORDER BY id DESC LIMIT 10`, [s.id]);
    const failed = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM download_jobs WHERE source_id = ? AND state = 'failed'", [s.id])!.n;
    return {
      pages: totals.pages, versions: totals.versions, latestBytes: totals.bytes,
      byPriority: byPriority.map((r) => ({ priority: priorityToCode(r.p as PriorityNumber), pages: r.n })),
      lastRuns: runs.map((r) => ({
        id: r.public_id, kind: r.kind, state: r.state, requestedBy: r.requested_by, pagesDone: r.pages_done, pagesFailed: r.pages_failed, bytesDone: r.bytes_done,
        createdAt: iso(r.created_at), startedAt: iso(r.started_at), finishedAt: iso(r.finished_at),
        ...(r.failure_message ? { failure: { code: r.failure_code, message: r.failure_message } } : {}),
      })),
      failedRuns: failed, lastRunAt: iso(s.last_run_at), lastStatus: s.last_status,
    };
  }

  // ---- running -------------------------------------------------------------------------------

  /**
   * Starts a run now. Single pages are captured directly. Sitemaps and feeds are read through the guarded fetcher and every
   * address not seen on an earlier run is captured. Websites, sections and linked collections go to the crawl engine.
   */
  async run(publicId: string, opts: { requestedBy?: "user" | "schedule" | "system"; signal?: AbortSignal } = {}): Promise<RunResult> {
    return this.runRow(this.rowByPublic(publicId), opts);
  }

  async runById(rowId: number, opts: { requestedBy?: "user" | "schedule" | "system"; signal?: AbortSignal } = {}): Promise<RunResult> {
    const r = this.db.get<Row>("SELECT * FROM sources WHERE id = ? AND deleted_at IS NULL", [rowId]);
    if (!r) throw new AppError("not_found", "That source does not exist.");
    return this.runRow(r, opts);
  }

  /** Checks the source's saved pages for changes now (a `refresh` download). */
  async refresh(publicId: string, opts: { requestedBy?: "user" | "schedule" | "system"; signal?: AbortSignal } = {}): Promise<RunResult> {
    return this.runRow(this.rowByPublic(publicId), { ...opts, mode: "refresh" });
  }

  private async runRow(r: Row, opts: { requestedBy?: "user" | "schedule" | "system"; signal?: AbortSignal; mode?: "refresh" }): Promise<RunResult> {
    if (r.enabled !== 1) throw new AppError("conflict", "This source is switched off. Turn it on before running it.");
    if (r.type === "imported_documents") throw new AppError("conflict", "This source holds files you upload. There is nothing to run; add documents with an import instead.");
    const requestedBy = opts.requestedBy ?? "user";
    if (r.type === "saved_search") {
      if (!this.o.runSavedSearch) throw new AppError("not_implemented", "Saved-search sources are not available.");
      const now = this.o.clock.now();
      try {
        const res = await this.o.runSavedSearch({ id: r.id, publicId: r.public_id, priority: r.priority as PriorityNumber }, { requestedBy, signal: opts.signal });
        this.db.run("UPDATE sources SET last_run_at = ?, last_status = ? WHERE id = ?", [now, res.downloadIds.length ? "running" : "ok", r.id]);
        this.o.events.publish("source", { sourceId: r.public_id, state: "run_started", downloads: res.downloadIds });
        return res;
      } catch (e) {
        this.db.run("UPDATE sources SET last_run_at = ?, last_status = 'failed' WHERE id = ?", [now, r.id]);
        throw e;
      }
    }
    if (!WEB_TYPES.has(r.type) || !r.start_url) throw new AppError("not_implemented", "This kind of source cannot be run yet.");
    const { config, version } = this.config(r);
    const now = this.o.clock.now();
    const priority = r.priority as PriorityNumber;
    const common = { priority, requestedBy, sourceId: r.id, versioning: parseVersioning(config.versioning) } as const;
    // A scheduled run of a source that already has pages checks them for changes instead of fetching everything again.
    const refreshing = !!this.o.refresh && (opts.mode === "refresh" || (requestedBy === "schedule" && this.o.refresh.pageCount(r.id) > 0));
    if (opts.mode === "refresh" && !this.o.refresh) throw new AppError("not_implemented", "Checking for changes is not available.");
    let result: RunResult;
    try {
      if (refreshing) {
        const ids: string[] = [];
        let extra: Partial<RunResult> = {};
        if (r.type === "sitemap" || r.type === "feed") {
          // New items are still picked up; the pages already saved are checked.
          extra = await this.runDiscovery(r, config, common, opts.signal);
          ids.push(...extra.downloadIds!);
        }
        if (this.o.refresh!.pageCount(r.id) > 0) ids.unshift((await this.o.refresh!.refreshSource(r.id, { requestedBy })).downloadId);
        else if (opts.mode === "refresh" && ids.length === 0) throw new AppError("conflict", "This source has no saved pages to check yet. Run it first.");
        result = { ...extra, downloadIds: ids };
      } else switch (r.type) {
        case "single_page": {
          const { downloadId } = this.o.pipeline.captureUrl(r.start_url, { ...common, discoveredVia: "seed", depth: 0, userInitiated: requestedBy === "user", force: false });
          result = { downloadIds: [downloadId] };
          break;
        }
        case "sitemap":
        case "feed":
          result = await this.runDiscovery(r, config, common, opts.signal);
          break;
        default: {
          const { downloadId } = await this.o.crawl.start({
            sourceId: r.id, sourcePublicId: r.public_id, configId: r.current_config_id!, configVersion: version, mode: r.strategy === "mirror" ? "mirror" : "explore",
            seeds: [r.start_url], priority, requestedBy, config,
          });
          result = { downloadIds: [downloadId] };
        }
      }
    } catch (e) {
      this.db.run("UPDATE sources SET last_run_at = ?, last_status = 'failed' WHERE id = ?", [now, r.id]);
      this.o.activity.write({ level: "warn", area: "crawl", message: `Source run failed to start: ${r.name}: ${e instanceof Error ? e.message : String(e)}` });
      throw e;
    }
    this.db.run("UPDATE sources SET last_run_at = ?, last_status = 'running' WHERE id = ?", [now, r.id]);
    this.o.events.publish("source", { sourceId: r.public_id, state: "run_started", downloads: result.downloadIds });
    return result;
  }

  private async runDiscovery(
    r: Row, config: SourceConfig,
    common: { priority: PriorityNumber; requestedBy: "user" | "schedule" | "system"; sourceId: number; versioning: VersioningPolicy },
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const via = r.type === "sitemap" ? ("sitemap" as const) : ("feed" as const);
    let items: { url: string; date?: number }[];
    const warnings: string[] = [];
    if (via === "sitemap") {
      const sm = await readSitemap(this.o.fetcher, r.start_url!, { maxDepth: config.sitemapMaxDepth, signal });
      items = sm.urls.map((u) => ({ url: u.loc, date: u.lastmod }));
      warnings.push(...sm.warnings);
    } else {
      const feed = await readFeed(this.o.fetcher, r.start_url!, { signal });
      items = feed.items.map((i) => ({ url: i.url, date: i.updated ?? i.published }));
    }
    const now = this.o.clock.now();
    const fresh: { url: string; key: string; date?: number }[] = [];
    let excluded = 0;
    this.db.transaction(() => {
      for (const it of items) {
        let key: string;
        try { key = this.o.pipeline.urlKey(it.url); } catch { continue; }
        const known = this.db.get("SELECT 1 AS x FROM source_discovered_urls WHERE source_id = ? AND url_key = ?", [r.id, key]);
        if (known) {
          this.db.run("UPDATE source_discovered_urls SET last_seen_at = ? WHERE source_id = ? AND url_key = ?", [now, r.id, key]);
          continue;
        }
        if (this.db.get("SELECT 1 AS x FROM url_exclusions WHERE url_key = ? AND (source_id IS NULL OR source_id = ?)", [key, r.id])) {
          excluded++;
          continue;
        }
        if (fresh.length >= config.maxPages) {
          // Not recorded as seen: it is picked up by a later run once earlier items are done.
          continue;
        }
        this.db.run("INSERT INTO source_discovered_urls (source_id, url_key, url, via, item_date, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [r.id, key, it.url, via, it.date ?? null, now, now]);
        fresh.push({ url: it.url, key, date: it.date });
      }
    });
    const downloadIds: string[] = [];
    for (const f of fresh) {
      try {
        downloadIds.push(this.o.pipeline.captureUrl(f.url, { ...common, discoveredVia: via, depth: 0, userInitiated: false }).downloadId);
      } catch (e) {
        warnings.push(`Skipped ${f.url}: ${e instanceof Error ? e.message : String(e)}`);
        this.db.run("DELETE FROM source_discovered_urls WHERE source_id = ? AND url_key = ?", [r.id, f.key]);
      }
    }
    return { downloadIds, found: items.length, newItems: fresh.length, excluded, warnings };
  }

  // ---- preview -------------------------------------------------------------------------------

  /**
   * Dry run for a new source (task C-15): validates it, explains its scope in plain words and gives a sampled estimate of pages and
   * bytes. Crawl types fetch the start page and a small sample of in-scope links (at most `PREVIEW_MAX_REQUESTS` requests,
   * robots.txt honoured, nothing saved); sitemaps and feeds are read and counted. The estimate is always labelled as one.
   */
  async preview(body: unknown, signal?: AbortSignal) {
    const v = parseOrThrow(sourceInputSchema(this.resourceProfile), body) as unknown as SourceInput;
    const config = resolveConfig(v.config, v.type, v.profile, this.resourceProfile, v.startUrl);
    const warnings: string[] = [];
    const ceilings = ceilingsFor(this.resourceProfile);
    const n = (x: number) => x.toLocaleString("en-GB");
    if (config.maxPages >= ceilings.maxPages * 0.8) warnings.push(`This source may save up to ${n(config.maxPages)} pages, close to the ${n(ceilings.maxPages)} limit for your device.`);
    if (config.assets === "all" && config.maxBytes > 10 * 1024 ** 3) warnings.push("Saving every asset with a large size limit can fill the disk quickly.");
    const free = this.o.freeBytes?.();
    const scope: string[] = [];
    const host = (() => { try { return new URL(v.startUrl!).host; } catch { return "the start page's site"; } })();
    const links = `${config.depth} link${config.depth === 1 ? "" : "s"}`;
    let scopeSummary: string;
    let estimate: PreviewEstimate;
    let sample: unknown;
    let robots: unknown = { checked: false, allowed: true, message: "robots.txt was not checked." };
    let requests = 0;
    switch (v.type) {
      case "single_page": {
        scope.push("Saves this one page and nothing it links to.");
        scopeSummary = `Saves only ${v.startUrl}, with its images and styles, and nothing it links to.`;
        const r = await this.crawlSample(v, config, { singlePage: true, free, signal });
        ({ estimate, sample, robots, requests } = r);
        warnings.push(...r.warnings);
        break;
      }
      case "sitemap":
      case "feed": {
        scope.push(v.type === "sitemap" ? "Saves the pages listed in the sitemap that have not been saved before." : "Saves the items in the feed. Later runs save only new items.");
        scopeSummary = v.type === "sitemap"
          ? `Saves the pages listed in the sitemap at ${host}, up to ${n(config.maxPages)} per run. Later runs save only pages that are new.`
          : `Saves the items in the feed at ${host}, up to ${n(config.maxPages)} per run. Later runs save only new items.`;
        try {
          const list = v.type === "sitemap"
            ? (await readSitemap(this.o.fetcher, v.startUrl!, { maxDepth: config.sitemapMaxDepth, signal }))
            : (await readFeed(this.o.fetcher, v.startUrl!, { signal }));
          requests += 1;
          const found = "urls" in list ? list.urls.length : list.items.length;
          const firstUrl = "urls" in list ? list.urls[0]?.loc : list.items[0]?.url;
          if ("warnings" in list) warnings.push(...list.warnings);
          sample = { found, sampledFrom: v.startUrl! };
          const pages = Math.min(found, config.maxPages);
          let avg = 0;
          let basis = `${n(found)} addresses found`;
          if (firstUrl) {
            // One listed page tells roughly how big they are.
            try {
              const one = await this.crawlSample({ ...v, startUrl: firstUrl, type: "single_page" }, config, { singlePage: true, free, signal });
              requests += one.requests;
              avg = one.sample.averageBytes;
              robots = one.robots;
              warnings.push(...one.warnings.filter((w) => !w.startsWith("The crawl may")));
              basis += `; page size taken from ${firstUrl.replace(/^https?:\/\//, "").slice(0, 60)}`;
            } catch { /* the sizes stay unknown */ }
          }
          estimate = {
            estimate: true, label: "Estimate", pages: { low: pages, high: pages },
            bytes: { low: Math.round(avg * pages * 0.7), high: Math.min(config.maxBytes, Math.round(avg * pages * 2.5)) },
            basis, confidence: avg > 0 ? "medium" : "low",
          };
          if (found > config.maxPages) warnings.push(`The ${v.type} lists ${n(found)} addresses but this source is limited to ${n(config.maxPages)} pages per run.`);
        } catch (e) {
          warnings.push(`The address could not be read now: ${e instanceof Error ? e.message : String(e)}`);
          estimate = { estimate: true, label: "Estimate", pages: { low: 0, high: config.maxPages }, bytes: { low: 0, high: config.maxBytes }, basis: "Could not read the address", confidence: "low" };
        }
        break;
      }
      default: {
        scope.push(
          v.type === "section" ? `Saves pages under ${config.allowedPaths.join(", ") || "the same folder"}, up to ${links} deep.`
            : v.type === "linked_collection" ? `Saves the start page and the pages it links to, ${config.includeExternal ? "including other sites, " : ""}up to ${links} deep.`
            : `Saves pages on the same site, up to ${links} deep.`,
        );
        scopeSummary = v.type === "section"
          ? `Pages under ${config.allowedPaths.join(", ") || "the same folder as the start page"} on ${host}, up to ${links} from the start page, ${n(config.maxPages)} pages at most.`
          : v.type === "linked_collection"
            ? `The start page and the pages it links to${config.includeExternal ? `, including other sites up to ${config.externalDepth} link${config.externalDepth === 1 ? "" : "s"} away` : " on the same site"}, up to ${links} deep, ${n(config.maxPages)} pages at most.`
            : `Pages on ${host}, up to ${links} from the start page, ${n(config.maxPages)} pages at most.`;
        const r = await this.crawlSample(v, config, { free, signal });
        ({ estimate, sample, robots, requests } = r);
        warnings.push(...r.warnings);
      }
    }
    if (!config.respectRobots && !warnings.some((w) => w.includes("ignores robots.txt"))) warnings.push("This source ignores robots.txt. Sites may block you if you crawl them without it.");
    return { valid: true, type: v.type, config, scope, scopeSummary, estimate, sample, robots, warnings, ceilings, requests };
  }

  private async crawlSample(v: SourceInput, config: SourceConfig, o: { singlePage?: boolean; free?: number; signal?: AbortSignal }) {
    const mode = v.type === "single_page" ? "explore" : v.strategy === "mirror" ? "mirror" : "explore";
    const crawlConfig = toCrawlConfig(
      { mode, seeds: [v.startUrl!], priority: v.priority, requestedBy: "user", config: o.singlePage ? { ...config, depth: 0, maxPages: 1 } : config },
      this.resourceProfile,
    );
    try {
      return await previewCrawl(
        { fetcher: this.o.fetcher, robots: this.o.previewRobots },
        { config: crawlConfig, assets: config.assets, respectRobots: config.respectRobots, singlePage: o.singlePage, signal: o.signal, freeBytes: o.free },
      );
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError("internal", "The preview could not be worked out. Try again.", undefined, { cause: e });
    }
  }

  /**
   * Marks the outcome of a run from its download jobs. While any download of the source is still queued or running it stays
   * "running" (a sitemap run has many); otherwise the newest download decides. The downloads service calls this whenever a
   * download linked to a source ends, whatever its kind.
   */
  refreshStatus(rowId: number): void {
    const open = this.db.get<{ state: string }>(
      "SELECT state FROM download_jobs WHERE source_id = ? AND state IN ('queued','running','paused') ORDER BY CASE state WHEN 'paused' THEN 1 ELSE 0 END, id DESC LIMIT 1", [rowId]);
    const last = open ?? this.db.get<{ state: string }>("SELECT state FROM download_jobs WHERE source_id = ? ORDER BY id DESC LIMIT 1", [rowId]);
    if (!last) return;
    const map: Record<string, string> = { completed: "ok", failed: "failed", running: "running", queued: "running", paused: "paused", cancelled: "cancelled" };
    this.db.run("UPDATE sources SET last_status = ? WHERE id = ? AND deleted_at IS NULL AND last_status IS NOT ?", [map[last.state] ?? last.state, rowId, map[last.state] ?? last.state]);
  }

  /**
   * Sources whose stored status disagrees with their downloads: still "running" with nothing open, or "never"/"ok" while the newest
   * download ended differently (an import, a failure inside a pipeline stage, a crash repaired at start). Their status is recomputed.
   * "failed" set because a run could not start, and "cancelled" and "paused", are left alone. Returns how many were checked.
   */
  reconcileStatuses(): number {
    const stale = this.db.all<{ id: number }>(
      `SELECT s.id FROM sources s WHERE s.deleted_at IS NULL AND s.last_status IN ('running','never','ok')
         AND EXISTS (SELECT 1 FROM download_jobs d WHERE d.source_id = s.id)
         AND (CASE WHEN EXISTS (SELECT 1 FROM download_jobs d WHERE d.source_id = s.id AND d.state IN ('queued','running','paused')) THEN 'running'
                   ELSE (SELECT CASE d.state WHEN 'completed' THEN 'ok' WHEN 'failed' THEN 'failed' WHEN 'cancelled' THEN 'cancelled' END
                         FROM download_jobs d WHERE d.source_id = s.id ORDER BY d.id DESC LIMIT 1) END) IS NOT s.last_status`);
    for (const r of stale) this.refreshStatus(r.id);
    return stale.length;
  }

  linkCapture(pageId: number, sourceId: number, o: { via?: "seed" | "link" | "sitemap" | "feed" | "search" | "manual"; depth?: number; priority?: number }): void {
    linkPageSource(this.db, { pageId, sourceId, now: this.o.clock.now(), ...o });
  }

  resolvePublicId(publicId: string): number {
    return this.rowByPublic(publicId).id;
  }
}

export { retentionSpecSchema };

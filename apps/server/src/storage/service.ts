import type { Db } from "@ncb/db";
import type { Clock } from "@ncb/shared";
import { AppError, newId, priorityToCode, steadyClock, type PriorityNumber } from "@ncb/shared";
import {
  explainVersion, forecastStorage, planEviction, type EvictionPlan, type ForecastSource, type PlanItem, type Priority, type StorageForecast, type VersionExplanation,
} from "@ncb/storage-planner";
import type { ActivityLog } from "../services/activity.js";
import type { BlobStore } from "../services/blobs.js";
import type { SettingsService } from "../services/settings.js";
import type { VolumeRow, VolumeService } from "../services/volumes.js";
import { AdmissionService } from "./admission.js";
import { EvictionExecutor, type ExecuteResult, type FaultHook } from "./executor.js";
import { StorageInventory } from "./inventory.js";
import { MaintenanceService, type MaintenanceOptions } from "./maintenance.js";
import { PriorityCache } from "./priority-cache.js";
import { UsageService } from "./usage.js";

const DAY_MS = 86_400_000;
const PLAN_TTL_MS = 30 * 60_000;
const ITEMS_LISTED = 200;

export interface StorageServiceOptions {
  db: Db;
  clock: Clock;
  volumes: VolumeService;
  blobs: BlobStore;
  settings: SettingsService;
  activity: ActivityLog;
  fault?: FaultHook;
  indexCheck?: MaintenanceOptions["indexCheck"];
  onPageChanged?: (pageId: number) => void;
  /** A download started or stopped waiting because of the P4 throttle. */
  onThrottleChange?: (downloadJobId: number) => void;
  log?: { warn(o: unknown, m?: string): void };
}

/** The `EvictionPlan` object of the API (docs/api.md, "Storage (Phase 6, as built)"). */
export interface ApiEvictionPlan {
  planId: string;
  createdAt: string;
  expiresAt: string;
  mode: "pressure" | "prune";
  incomingPriority: "P1" | "P2" | "P3" | "P4";
  bytesNeeded: number;
  volumeId?: string;
  reclaimableBytes: number;
  sufficient: boolean;
  /** True means nothing would be removed if this plan were run: it cannot cover the need. */
  insufficient: boolean;
  throttleOpportunistic: boolean;
  steps: EvictionPlan["steps"];
  itemsTotal: number;
  items: {
    versionId: string; pageId: string; pageUrl: string; versionNo: number; priority: "P1" | "P2" | "P3" | "P4"; surplus: boolean; step: PlanItem["step"];
    reason: string; exclusiveBytes: number; lastAccessedAt?: string;
  }[];
  unreferencedBlobs: { count: number; bytes: number };
  skipped: { versionId: string; pageId: string; pageUrl: string; reason: string }[];
  skippedCounts: Record<string, number>;
  summary: string;
}

export interface AuditRecord {
  id: number;
  kind: "evicted" | "deleted";
  at: string;
  pageId: string | null;
  pageUrl: string;
  versionId: string | null;
  versionNo: number | null;
  priority: "P1" | "P2" | "P3" | "P4" | null;
  surplus: boolean;
  step: string | null;
  reason: string;
  trigger: string | null;
  exclusiveBytes: number;
  references: unknown[];
  confirmedProtected: boolean;
  runId?: string;
}

interface StoredPlan {
  plan: EvictionPlan;
  api: ApiEvictionPlan;
  volumeId?: number;
  expiresMono: number;
}

/** Everything Phase 6 adds to the server, behind one object: planning, execution, usage, forecast, explanation, maintenance. */
export class StorageService {
  readonly inventory: StorageInventory;
  readonly priority: PriorityCache;
  readonly usage: UsageService;
  readonly executor: EvictionExecutor;
  readonly admission: AdmissionService;
  readonly maintenance: MaintenanceService;
  private readonly plans = new Map<string, StoredPlan>();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  /** Monotonic time of the last quick_check pass (elapsed-time logic: never the wall clock). */
  private lastQuickCheckMono = -Infinity;

  constructor(private readonly o: StorageServiceOptions) {
    this.inventory = new StorageInventory({ db: o.db, settings: o.settings });
    this.priority = new PriorityCache({ db: o.db, clock: o.clock, inventory: this.inventory });
    this.usage = new UsageService({ db: o.db, clock: o.clock, inventory: this.inventory, volumes: o.volumes });
    this.executor = new EvictionExecutor({
      db: o.db, clock: o.clock, blobs: o.blobs, inventory: this.inventory, activity: o.activity, fault: o.fault,
      onPageChanged: (id) => {
        this.priority.recomputePage(id);
        o.onPageChanged?.(id);
      },
      onUsageChanged: () => this.usage.invalidate(),
      orphanGraceMs: () => o.settings.internal("storage").orphanGraceSeconds * 1000,
      log: o.log,
    });
    this.admission = new AdmissionService({
      // Reservations expire after an interval: that is elapsed time, so it follows the steady clock (a wall-clock jump cannot expire them).
      db: o.db, clock: steadyClock(o.clock), volumes: o.volumes, usage: this.usage, settings: o.settings, activity: o.activity, executor: this.executor, onThrottleChange: o.onThrottleChange,
      plan: (a) => this.buildPlan({ bytesNeeded: a.bytesNeeded, incomingPriority: a.incomingPriority as Priority, volumeId: a.volumeId }).plan,
    });
    this.maintenance = new MaintenanceService({
      db: o.db, clock: o.clock, volumes: o.volumes, blobs: o.blobs, activity: o.activity, indexCheck: o.indexCheck,
      onPageChanged: (id) => this.priority.recomputePage(id), onUsageChanged: () => this.usage.invalidate(),
    });
  }

  // ---- planning ------------------------------------------------------------------------------

  /** The room NoConBrain has on a volume: the quota, or its own bytes plus the free space. The thresholds are percentages of this. */
  private capacityOf(v: VolumeRow): number {
    return v.quotaBytes ?? this.o.volumes.usedBytes(v.id) + (v.statFree ?? 0);
  }

  /** How many bytes must go for this volume to fall to its eviction-target level (0 when it is below it). */
  bytesToTarget(v: VolumeRow): number {
    const { volumes } = this.o;
    const capacity = this.capacityOf(v);
    if (capacity <= 0) return 0;
    return Math.max(0, Math.round(volumes.usedBytes(v.id) + volumes.reservedBytes(v.id) - (v.evictTargetPct / 100) * capacity));
  }

  usedPct(v: VolumeRow): number {
    const capacity = this.capacityOf(v);
    if (capacity <= 0) return 0;
    return ((this.o.volumes.usedBytes(v.id) + this.o.volumes.reservedBytes(v.id)) / capacity) * 100;
  }

  /** A dry-run plan. Reads the archive; changes nothing. */
  buildPlan(a: { bytesNeeded: number; incomingPriority: Priority; volumeId?: number; mode?: "pressure" | "prune" }): { plan: EvictionPlan } {
    const { clock, volumes, settings } = this.o;
    const pages = this.inventory.loadPages(this.inventory.allPageIds());
    const blobs = this.inventory.blobsFor(pages);
    const policy = this.inventory.policy();
    const graceMs = settings.internal("storage").orphanGraceSeconds * 1000;
    const vol = a.volumeId !== undefined ? volumes.byId(a.volumeId) : undefined;
    const unavailable = volumes.list().filter((v) => v.state === "offline" || v.state === "disabled").map((v) => v.id);
    const plan = planEviction({
      pages, blobs, policy, incomingPriority: a.incomingPriority, bytesNeeded: a.bytesNeeded, mode: a.mode, volumeId: a.volumeId, unavailableVolumeIds: unavailable,
      unreferencedBlobs: this.inventory.unreferencedBlobs(graceMs, clock.now()), now: clock.now(),
      throttle: vol ? { enabled: settings.internal("storage").throttleOpportunistic, usedPct: this.usedPct(vol), softPct: vol.softThresholdPct } : undefined,
    });
    return { plan };
  }

  /** Stores a plan so `run` can execute it later, and returns the API shape. */
  planAndStore(a: { bytesNeeded?: number; incomingPriority?: Priority; volumeId?: string; mode?: "pressure" | "prune" }): ApiEvictionPlan {
    const { volumes, clock } = this.o;
    const vol = a.volumeId ? volumes.require(a.volumeId) : volumes.defaultVolume();
    const mode = a.mode ?? "pressure";
    const need = mode === "prune" ? 0 : (a.bytesNeeded ?? (vol ? this.bytesToTarget(vol) : 0));
    const incoming = a.incomingPriority ?? 1;
    const { plan } = this.buildPlan({ bytesNeeded: need, incomingPriority: incoming, volumeId: vol?.id, mode });
    const api = this.toApiPlan(plan, vol);
    this.plans.set(api.planId, { plan, api, volumeId: vol?.id, expiresMono: clock.monotonic() + PLAN_TTL_MS });
    for (const [id, p] of this.plans) if (p.expiresMono < clock.monotonic()) this.plans.delete(id);
    return api;
  }

  private versionPublic(ids: number[]): Map<number, { pv: string; pg: string }> {
    const out = new Map<number, { pv: string; pg: string }>();
    for (let i = 0; i < ids.length; i += 400) {
      const c = ids.slice(i, i + 400);
      for (const r of this.o.db.all<{ id: number; pv: string; pg: string }>(
        `SELECT v.id, v.public_id AS pv, p.public_id AS pg FROM page_versions v JOIN pages p ON p.id = v.page_id WHERE v.id IN (${c.map(() => "?").join(",")})`, c)) out.set(r.id, { pv: r.pv, pg: r.pg });
    }
    return out;
  }

  private toApiPlan(plan: EvictionPlan, vol?: VolumeRow): ApiEvictionPlan {
    const { clock } = this.o;
    const pub = this.versionPublic([...plan.items.map((i) => i.versionId), ...plan.skipped.map((s) => s.versionId)]);
    const code = (p: number) => priorityToCode(p as PriorityNumber);
    const unrefBytes = plan.unreferencedBlobs.reduce((n, b) => n + b.storedBytes, 0);
    const summary = plan.mode === "prune"
      ? `Tidy-up: ${plan.items.length} older cop${plan.items.length === 1 ? "y" : "ies"} that nothing keeps any more and ${plan.unreferencedBlobs.length} unused file${plan.unreferencedBlobs.length === 1 ? "" : "s"}, freeing about ${plan.reclaimableBytes.toLocaleString("en-GB")} bytes.`
      : plan.sufficient
        ? `Frees ${plan.reclaimableBytes.toLocaleString("en-GB")} of the ${plan.bytesNeeded.toLocaleString("en-GB")} bytes needed by removing ${plan.items.length} saved cop${plan.items.length === 1 ? "y" : "ies"}.`
        : `Cannot free enough: everything that may be removed would give ${plan.reclaimableBytes.toLocaleString("en-GB")} of the ${plan.bytesNeeded.toLocaleString("en-GB")} bytes needed. Nothing would be removed.`;
    return {
      planId: newId("plan"), createdAt: new Date(clock.now()).toISOString(), expiresAt: new Date(clock.now() + PLAN_TTL_MS).toISOString(), mode: plan.mode,
      incomingPriority: code(plan.incomingPriority), bytesNeeded: plan.bytesNeeded, ...(vol ? { volumeId: vol.publicId } : {}), reclaimableBytes: plan.reclaimableBytes,
      sufficient: plan.sufficient, insufficient: !plan.sufficient, throttleOpportunistic: plan.throttleOpportunistic, steps: plan.steps, itemsTotal: plan.items.length,
      items: plan.items.slice(0, ITEMS_LISTED).map((i) => ({
        versionId: pub.get(i.versionId)?.pv ?? String(i.versionId), pageId: pub.get(i.versionId)?.pg ?? String(i.pageId), pageUrl: i.pageUrl, versionNo: i.versionNo,
        priority: code(i.priority), surplus: i.surplus, step: i.step, reason: i.reason, exclusiveBytes: i.exclusiveBytes,
        ...(i.lastAccessedAt !== null ? { lastAccessedAt: new Date(i.lastAccessedAt).toISOString() } : {}),
      })),
      unreferencedBlobs: { count: plan.unreferencedBlobs.length, bytes: unrefBytes },
      skipped: plan.skipped.map((s) => ({ versionId: pub.get(s.versionId)?.pv ?? String(s.versionId), pageId: pub.get(s.versionId)?.pg ?? String(s.pageId), pageUrl: s.pageUrl, reason: s.reason })),
      skippedCounts: plan.skippedCounts as Record<string, number>, summary,
    };
  }

  /** Executes a stored plan. The executor re-derives every decision, so a plan that went stale removes less, never more. */
  async runPlan(planId: string, userId?: number): Promise<ExecuteResult> {
    const p = this.plans.get(planId);
    if (!p || p.expiresMono < this.o.clock.monotonic()) {
      this.plans.delete(planId);
      throw new AppError("not_found", "That plan has expired. Make a new one and review it.");
    }
    if (p.plan.mode === "pressure" && !p.plan.sufficient) throw new AppError("conflict", "That plan cannot free enough space, so nothing was removed.", { kind: "plan_insufficient" });
    this.plans.delete(planId);
    return this.executor.execute(p.plan, { trigger: p.plan.mode === "prune" ? "prune" : "manual", volumeId: p.volumeId, userId });
  }

  /** An execution result with public ids, for the API. */
  publicResult(r: ExecuteResult): Omit<ExecuteResult, "skipped" | "evictedVersionIds"> & { skipped: { versionId: string; reason: string }[]; evictedVersionIds: string[] } {
    const pub = this.versionPublic([...r.evictedVersionIds, ...r.skipped.map((s) => s.versionId)]);
    return {
      ...r, evictedVersionIds: r.evictedVersionIds.map((id) => pub.get(id)?.pv ?? String(id)),
      skipped: r.skipped.map((s) => ({ versionId: pub.get(s.versionId)?.pv ?? String(s.versionId), reason: s.reason })),
    };
  }

  /** One maintenance pass of eviction: bring volumes above their start threshold down to target, then prune surplus versions. */
  async runMaintenanceEviction(userId?: number): Promise<{ runs: ExecuteResult[]; notes: string[] }> {
    const { volumes, settings } = this.o;
    const runs: ExecuteResult[] = [];
    const notes: string[] = [];
    const st = settings.internal("storage");
    for (const v0 of volumes.list()) {
      if (v0.state !== "online" && v0.state !== "readonly") continue;
      await volumes.statNow(v0);
      const v = volumes.byId(v0.id)!;
      if (this.usedPct(v) < v.evictStartPct) continue;
      const need = this.bytesToTarget(v);
      const { plan } = this.buildPlan({ bytesNeeded: need, incomingPriority: 1, volumeId: v.id });
      if (!plan.sufficient) {
        notes.push(`"${v.name}" is above ${v.evictStartPct}% but nothing eligible would free enough (${plan.reclaimableBytes} of ${need} bytes). Nothing was removed.`);
        this.o.activity.write({ level: "warn", area: "storage", message: notes.at(-1)!, details: { volumeId: v.publicId, need, reclaimable: plan.reclaimableBytes } });
        continue;
      }
      runs.push(await this.executor.execute(plan, { trigger: "threshold", volumeId: v.id, userId }));
    }
    if (st.pruneSurplusVersions) {
      const { plan } = this.buildPlan({ bytesNeeded: 0, incomingPriority: 1, mode: "prune" });
      if (plan.items.length > 0 || plan.unreferencedBlobs.length > 0) runs.push(await this.executor.execute(plan, { trigger: "prune", userId }));
    }
    return { runs, notes };
  }

  // ---- reading -------------------------------------------------------------------------------

  /** Volume object of the API with usage by priority filled in. */
  volumeDto(v: VolumeRow): ReturnType<VolumeService["toDto"]> {
    return this.o.volumes.toDto(v, this.usage.byPriorityForVolume(v.id));
  }

  forecast(a: { sourceId?: string; horizonDays?: number } = {}): StorageForecast & { sourceId?: string } {
    const { db, clock, volumes, settings } = this.o;
    const horizon = a.horizonDays ?? settings.internal("storage").forecastHorizonDays;
    let srcFilter: number | undefined;
    if (a.sourceId) {
      const s = db.get<{ id: number }>("SELECT id FROM sources WHERE public_id = ? AND deleted_at IS NULL", [a.sourceId]);
      if (!s) throw new AppError("not_found", "That source does not exist.");
      srcFilter = s.id;
    }
    const sources: ForecastSource[] = db.all<{ id: number; public_id: string; name: string; pages: number; bytes: number | null; cfg: string | null }>(
      `SELECT s.id, s.public_id, s.name,
              (SELECT COUNT(*) FROM page_sources ps WHERE ps.page_id IS NOT NULL AND ps.source_id = s.id) AS pages,
              (SELECT SUM(pv.total_bytes) FROM page_sources ps JOIN pages p ON p.id = ps.page_id JOIN page_versions pv ON pv.id = p.latest_version_id WHERE ps.source_id = s.id) AS bytes,
              (SELECT c.config_json FROM source_configs c WHERE c.id = s.current_config_id) AS cfg
       FROM sources s WHERE s.deleted_at IS NULL ${srcFilter !== undefined ? "AND s.id = ?" : ""} ORDER BY s.id`, srcFilter !== undefined ? [srcFilter] : [])
      .map((r) => {
        let planned = 0;
        try {
          const maxPages = (JSON.parse(r.cfg ?? "{}") as { limits?: { maxPages?: number } }).limits?.maxPages;
          if (typeof maxPages === "number") planned = Math.max(0, maxPages - r.pages);
        } catch { /* a config without limits plans nothing */ }
        return { id: r.public_id, name: r.name, observedPages: r.pages, observedBytes: r.bytes ?? 0, plannedPages: planned };
      });
    const rows = db.all<{ day: number; bytes: number }>(
      `SELECT (created_at / ${DAY_MS}) AS day, SUM(stored_bytes) AS bytes FROM blobs WHERE created_at >= ? GROUP BY day ORDER BY day`, [clock.now() - 30 * DAY_MS]);
    const byDay = new Map(rows.map((r) => [r.day, r.bytes] as const));
    const today = Math.floor(clock.now() / DAY_MS);
    const first = rows.length ? Math.max(rows[0]!.day, today - 29) : today;
    const history: { dayStart: number; bytesAdded: number }[] = [];
    // Whole days only: today is still going, so it would pull the average down.
    if (rows.length) for (let d = first; d < today; d++) history.push({ dayStart: d * DAY_MS, bytesAdded: byDay.get(d) ?? 0 });
    const online = volumes.list().filter((v) => v.state === "online");
    const available = online.reduce((n, v) => n + volumes.availableFor(v), 0);
    const used = online.reduce((n, v) => n + volumes.usedBytes(v.id), 0);
    const f = forecastStorage({ now: clock.now(), horizonDays: horizon, usedBytes: used, availableBytes: available, history, sources });
    return { ...f, ...(a.sourceId ? { sourceId: a.sourceId } : {}) };
  }

  // ---- why was this kept or evicted ----------------------------------------------------------

  auditFor(filter: { pageDbId?: number; versionDbId?: number; kind?: "evicted" | "deleted"; limit?: number; cursor?: number }): { items: AuditRecord[]; nextCursor?: string } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.pageDbId !== undefined) { where.push("a.page_id = ?"); args.push(filter.pageDbId); }
    if (filter.versionDbId !== undefined) { where.push("a.version_id = ?"); args.push(filter.versionDbId); }
    if (filter.kind) { where.push("a.kind = ?"); args.push(filter.kind); }
    if (filter.cursor !== undefined) { where.push("a.id < ?"); args.push(filter.cursor); }
    const limit = Math.min(200, filter.limit ?? 50);
    const rows = this.o.db.all<{
      id: number; kind: "evicted" | "deleted"; at: number; page_id: number; page_url: string; version_id: number | null; version_no: number | null; priority: number | null;
      surplus: number; step: string | null; reason: string; trigger: string | null; exclusive_bytes: number; refs_json: string | null; confirmed_protected: number;
      page_public: string | null; version_public: string | null; run_public: string | null;
    }>(
      `SELECT a.*, p.public_id AS page_public, v.public_id AS version_public, r.public_id AS run_public FROM storage_audit a
       LEFT JOIN pages p ON p.id = a.page_id LEFT JOIN page_versions v ON v.id = a.version_id LEFT JOIN eviction_runs r ON r.id = a.run_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY a.id DESC LIMIT ?`, [...args, limit + 1]);
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: r.id, kind: r.kind, at: new Date(r.at).toISOString(), pageId: r.page_public, pageUrl: r.page_url, versionId: r.version_public, versionNo: r.version_no,
        priority: r.priority === null ? null : priorityToCode(r.priority as PriorityNumber), surplus: r.surplus === 1, step: r.step, reason: r.reason, trigger: r.trigger,
        exclusiveBytes: r.exclusive_bytes, references: r.refs_json ? (JSON.parse(r.refs_json) as unknown[]) : [], confirmedProtected: r.confirmed_protected === 1,
        ...(r.run_public ? { runId: r.run_public } : {}),
      })),
      ...(rows.length > limit ? { nextCursor: String(page.at(-1)!.id) } : {}),
    };
  }

  /** "Why was this kept or evicted?" for a page, its copies, and everything that was ever removed from it. */
  explainPage(pagePublicId: string): {
    page: { id: string; url: string; availability: string; effectivePriority: "P1" | "P2" | "P3" | "P4"; cachedPriority: "P1" | "P2" | "P3" | "P4" | null };
    pin: { priority: "P1" | "P2" | "P3" | "P4"; reason: string | null } | null;
    references: VersionExplanation["references"];
    versions: (Omit<VersionExplanation, "versionId"> & { versionId: string; versionNo: number; fetchedAt: string; evictedAt?: string; audit?: AuditRecord })[];
    history: AuditRecord[];
  } {
    const { db, clock } = this.o;
    const p = db.get<{ id: number; url: string; availability: string; effective_priority: number | null }>(
      "SELECT id, canonical_url AS url, availability, effective_priority FROM pages WHERE public_id = ?", [pagePublicId]);
    if (!p) throw new AppError("not_found", "That page is not in the archive.");
    const info = this.inventory.loadPages([p.id])[0]!;
    const policy = this.inventory.policy();
    const now = clock.now();
    const vrows = db.all<{ id: number; public_id: string; version_no: number; fetched_at: number; status: string; evicted_at: number | null }>(
      "SELECT id, public_id, version_no, fetched_at, status, evicted_at FROM page_versions WHERE page_id = ? ORDER BY version_no DESC", [p.id]);
    const history = this.auditFor({ pageDbId: p.id, limit: 100 }).items;
    const versions = vrows.map((v) => {
      const audit = history.find((h) => h.versionId === v.public_id && h.kind === "evicted");
      if (v.status === "evicted" || v.status === "evicting") {
        return {
          versionId: v.public_id, versionNo: v.version_no, fetchedAt: new Date(v.fetched_at).toISOString(), ...(v.evicted_at ? { evictedAt: new Date(v.evicted_at).toISOString() } : {}),
          status: v.status, isLatest: false, priority: (audit?.priority ? Number(audit.priority.slice(1)) : 4) as Priority, surplus: audit?.surplus ?? false,
          decision: "evictable" as const, references: (audit?.references ?? []) as VersionExplanation["references"],
          reasons: audit ? [`Removed ${audit.at}: ${audit.reason}`] : ["Removed; no record of why was found."], ...(audit ? { audit } : {}),
        };
      }
      const e = explainVersion(info, v.id, policy, now, 1);
      return { ...e, versionId: v.public_id, versionNo: v.version_no, fetchedAt: new Date(v.fetched_at).toISOString() };
    });
    const pin = db.get<{ priority: number; reason: string | null }>("SELECT priority, reason FROM page_pins WHERE page_id = ? ORDER BY id LIMIT 1", [p.id]);
    const latest = versions.find((v) => v.isLatest) ?? versions[0];
    return {
      page: {
        id: pagePublicId, url: p.url, availability: p.availability, effectivePriority: priorityToCode((latest?.priority ?? 4) as PriorityNumber),
        cachedPriority: p.effective_priority === null ? null : priorityToCode(p.effective_priority as PriorityNumber),
      },
      pin: pin ? { priority: priorityToCode(pin.priority as PriorityNumber), reason: pin.reason } : null,
      references: latest?.references ?? [], versions: versions as never, history,
    };
  }

  /** Keeps the `storage_policies` global row in step with the `storage` settings group (the group is the source of truth). */
  mirrorPolicy(): void {
    const st = this.o.settings.internal("storage");
    this.o.db.run(
      `INSERT INTO storage_policies (scope, volume_id, permit_important_eviction, throttle_opportunistic, prune_surplus_versions, orphan_grace_seconds, max_eviction_batch_bytes, updated_at)
       VALUES ('global', NULL, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (scope) WHERE scope = 'global' DO UPDATE SET permit_important_eviction = excluded.permit_important_eviction, throttle_opportunistic = excluded.throttle_opportunistic,
         prune_surplus_versions = excluded.prune_surplus_versions, orphan_grace_seconds = excluded.orphan_grace_seconds, max_eviction_batch_bytes = excluded.max_eviction_batch_bytes, updated_at = excluded.updated_at`,
      [st.permitImportantEviction ? 1 : 0, st.throttleOpportunistic ? 1 : 0, st.pruneSurplusVersions ? 1 : 0, st.orphanGraceSeconds, st.maxEvictionBatchBytes, this.o.clock.now()],
    );
  }

  // ---- pins ----------------------------------------------------------------------------------

  setPin(pagePublicId: string, userId: number, priority: PriorityNumber, reason?: string): void {
    const { db, clock } = this.o;
    const p = db.get<{ id: number }>("SELECT id FROM pages WHERE public_id = ?", [pagePublicId]);
    if (!p) throw new AppError("not_found", "That page is not in the archive.");
    db.run(
      `INSERT INTO page_pins (page_id, user_id, priority, reason, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (page_id, user_id) DO UPDATE SET priority = excluded.priority, reason = excluded.reason`, [p.id, userId, priority, reason?.slice(0, 300) ?? null, clock.now()]);
    this.priority.recomputePage(p.id);
    this.usage.invalidate();
  }

  removePin(pagePublicId: string, userId: number): boolean {
    const { db } = this.o;
    const p = db.get<{ id: number }>("SELECT id FROM pages WHERE public_id = ?", [pagePublicId]);
    if (!p) throw new AppError("not_found", "That page is not in the archive.");
    const n = db.run("DELETE FROM page_pins WHERE page_id = ? AND user_id = ?", [p.id, userId]).changes;
    this.priority.recomputePage(p.id);
    this.usage.invalidate();
    return n > 0;
  }

  // ---- overview and the periodic pass --------------------------------------------------------

  /** The pass the timer runs: tidy reservations, evict above the start threshold, prune, collect garbage, refresh caches, check. */
  async tick(): Promise<{ notes: string[] }> {
    if (this.ticking) return { notes: ["A pass is already running."] };
    this.ticking = true;
    const notes: string[] = [];
    const { settings, volumes, blobs, clock } = this.o;
    try {
      this.admission.sweep();
      const st = settings.internal("storage");
      if (st.autoEviction) {
        const r = await this.runMaintenanceEviction();
        notes.push(...r.notes);
      }
      await blobs.collectGarbage(st.orphanGraceSeconds * 1000);
      this.usage.refreshCache();
      const day = 24 * 3_600_000;
      if (clock.monotonic() - this.lastQuickCheckMono >= day) {
        // Once a day by elapsed time since the last pass in this process; after a restart the stored run is consulted instead.
        const first = this.lastQuickCheckMono === -Infinity;
        this.lastQuickCheckMono = clock.monotonic();
        const last = first ? this.o.db.get<{ started_at: number }>("SELECT started_at FROM maintenance_runs WHERE kind = 'integrity_check' ORDER BY id DESC LIMIT 1") : undefined;
        if (!last || clock.now() - last.started_at >= day) await this.maintenance.verify({ checks: ["I-12"], kind: "integrity_check" });
      }
      if (st.scrubMegabytesPerRun > 0) {
        const r = await this.maintenance.scrubSome(volumes.list(), { maxBlobs: 200, maxBytes: st.scrubMegabytesPerRun * 1_048_576, repair: false });
        if (r.bad.length > 0) {
          this.o.activity.write({ level: "error", area: "storage", message: `${r.bad.length} stored file${r.bad.length === 1 ? " does" : "s do"} not match ${r.bad.length === 1 ? "its" : "their"} checksum. Run a repair from Storage settings.`, details: { examples: r.bad.slice(0, 5).map((b) => b.sha256) } });
          notes.push(`${r.bad.length} stored file(s) failed the checksum scrub.`);
        }
      }
    } catch (e) {
      this.o.log?.warn({ err: String(e) }, "storage pass failed");
      notes.push(`The storage pass failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.ticking = false;
    }
    return { notes };
  }

  start(intervalMs: number): void {
    if (intervalMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

import { z } from "zod";
import type { Db } from "@ncb/db";
import { AppError, newId, type Clock } from "@ncb/shared";
import { decryptSecret, encryptSecret } from "../lib/secrets.js";
import { parseOrThrow, RequestValidationError, type FieldIssue } from "../lib/zod.js";
import type { ActivityLog } from "../services/activity.js";
import { DISCLOSURE_TEXT, type SettingsService } from "../services/settings.js";
import { ADAPTERS } from "./adapters.js";
import type { ProviderHttp } from "./http.js";
import type { ProviderRuntime, ProviderRunner } from "./runner.js";
import type { AdapterId, StorageKind } from "./types.js";

const iso = (n: number | null | undefined): string | undefined => (n == null ? undefined : new Date(n).toISOString());
const RANK: Record<StorageKind, number> = { none: 0, ttl: 1, unrestricted: 2 };
const MAX_USER_TTL = 7 * 86_400;

interface Row {
  id: number; public_id: string; adapter: AdapterId; name: string; enabled: number; priority: number; base_url: string | null; credentials_enc: string | null;
  timeout_ms: number; rate_limit_per_sec: number; monthly_cap: number | null; daily_cap: number | null; fallback_provider_id: number | null;
  language: string | null; region: string | null; safe_search: "off" | "moderate" | "strict"; storage_kind: StorageKind; storage_ttl_seconds: number | null;
  weight: number; health_state: string; last_ok_at: number | null; last_error_code: string | null; circuit_open_until: number | null; created_at: number; updated_at: number;
}

const nullableInt = z.number().int().min(0).max(100_000_000).nullable();
const providerFields = {
  name: z.string().trim().min(1, "Enter a name").max(80, "Use at most 80 characters"),
  enabled: z.boolean(),
  priority: z.number().int().min(1).max(1000),
  baseUrl: z.string().trim().max(500).nullable(),
  apiKey: z.string().min(1, "Enter the key or leave it out").max(512).nullable(),
  timeoutMs: z.number().int().min(500, "Use at least 500").max(30_000, "Use at most 30000"),
  rateLimitPerSec: z.number().min(0.1).max(50),
  monthlyCap: nullableInt,
  dailyCap: nullableInt,
  fallbackProviderId: z.string().max(64).nullable(),
  language: z.string().trim().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "Use a language code such as en-GB").max(20).nullable(),
  region: z.string().trim().regex(/^[A-Za-z]{2}$/, "Use a two-letter country code such as GB").nullable(),
  safeSearch: z.enum(["off", "moderate", "strict"]),
  weight: z.number().min(0).max(10),
  storage: z.object({ policy: z.enum(["none", "ttl", "unrestricted"]).optional(), ttlSeconds: z.number().int().min(0).max(MAX_USER_TTL).nullable().optional() }),
  acknowledged: z.literal(true),
};
export const providerCreateSchema = z.object({ adapter: z.enum(["searxng", "brave", "mojeek"]), ...providerFields }).partial({
  enabled: true, priority: true, baseUrl: true, apiKey: true, timeoutMs: true, rateLimitPerSec: true, monthlyCap: true, dailyCap: true, fallbackProviderId: true,
  language: true, region: true, safeSearch: true, weight: true, storage: true, acknowledged: true,
});
export const providerPatchSchema = z.object(providerFields).partial().strict();

export interface ProviderOut {
  id: string; adapter: AdapterId; name: string; enabled: boolean; priority: number; baseUrl: string | null; hasCredentials: boolean;
  timeoutMs: number; rateLimitPerSec: number; monthlyCap: number | null; dailyCap: number | null; fallbackProviderId: string | null;
  language: string | null; region: string | null; safeSearch: string; weight: number;
  storage: { policy: StorageKind; ttlSeconds: number | null; adapterPolicy: StorageKind; maxTtlSeconds: number | null; note: string };
  health: { state: string; lastOkAt?: string; lastErrorCode?: string; circuitOpenUntil?: string };
  usage: { month: { period: string; requests: number; cap: number | null }; day: { period: string; requests: number; cap: number | null } };
  createdAt: string; updatedAt: string;
}

export interface ProviderServiceOptions {
  db: Db; clock: Clock; settings: SettingsService; activity: ActivityLog; secretKey: Buffer; runner: ProviderRunner; http: ProviderHttp;
  isOffline: () => boolean;
}

/** Provider rows: CRUD, validation, encrypted credentials, the disclosure rule, and the snapshots the runner needs. */
export class ProviderService {
  constructor(private readonly o: ProviderServiceOptions) {}
  private get db(): Db { return this.o.db; }

  // ---- reading -------------------------------------------------------------------------------

  private rowByPublic(publicId: string): Row {
    const r = this.db.get<Row>("SELECT * FROM search_providers WHERE public_id = ?", [publicId]);
    if (!r) throw new AppError("not_found", "That search provider does not exist.");
    return r;
  }
  private publicOf(rowId: number | null): string | null {
    return rowId == null ? null : this.db.get<{ public_id: string }>("SELECT public_id FROM search_providers WHERE id = ?", [rowId])?.public_id ?? null;
  }
  private rowOfPublic(publicId: string, path: string): number {
    const r = this.db.get<{ id: number }>("SELECT id FROM search_providers WHERE public_id = ?", [publicId]);
    if (!r) throw new RequestValidationError([{ in: "body", path, message: "Choose a provider that exists" }]);
    return r.id;
  }

  private usage(publicId: string): ProviderOut["usage"] extends infer U ? U : never {
    const now = this.o.clock.now();
    const m = new Date(now).toISOString().slice(0, 7), d = new Date(now).toISOString().slice(0, 10);
    const n = (p: string) => this.db.get<{ count: number }>("SELECT count FROM usage_counters WHERE kind = 'provider_requests' AND subject = ? AND period = ?", [publicId, p])?.count ?? 0;
    const r = this.db.get<{ monthly_cap: number | null; daily_cap: number | null }>("SELECT monthly_cap, daily_cap FROM search_providers WHERE public_id = ?", [publicId]);
    return { month: { period: m, requests: n(m), cap: r?.monthly_cap ?? null }, day: { period: d, requests: n(d), cap: r?.daily_cap ?? null } };
  }

  private out(r: Row): ProviderOut {
    const a = ADAPTERS[r.adapter].info;
    const open = r.circuit_open_until && r.circuit_open_until > this.o.clock.now() ? r.circuit_open_until : undefined;
    return {
      id: r.public_id, adapter: r.adapter, name: r.name, enabled: r.enabled === 1, priority: r.priority, baseUrl: r.base_url, hasCredentials: !!r.credentials_enc,
      timeoutMs: r.timeout_ms, rateLimitPerSec: r.rate_limit_per_sec, monthlyCap: r.monthly_cap, dailyCap: r.daily_cap, fallbackProviderId: this.publicOf(r.fallback_provider_id),
      language: r.language, region: r.region, safeSearch: r.safe_search, weight: r.weight,
      storage: { policy: r.storage_kind, ttlSeconds: r.storage_ttl_seconds, adapterPolicy: a.storage.policy, maxTtlSeconds: a.storage.maxTtlSeconds, note: a.storage.note },
      health: {
        state: r.health_state, ...(r.last_ok_at ? { lastOkAt: iso(r.last_ok_at) } : {}), ...(r.last_error_code ? { lastErrorCode: r.last_error_code } : {}),
        ...(open ? { circuitOpenUntil: iso(open) } : {}),
      },
      usage: this.usage(r.public_id), createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
    };
  }

  list(): ProviderOut[] {
    return this.db.all<Row>("SELECT * FROM search_providers ORDER BY priority, id").map((r) => this.out(r));
  }
  get(publicId: string): ProviderOut { return this.out(this.rowByPublic(publicId)); }

  onlineInfo(): { enabled: boolean; acknowledgedAt: string | null; disclosure: string; state: "off" | "offline" | "ready" } {
    const p = this.o.settings.internal("privacy").onlineSearch;
    return { enabled: p.enabled, acknowledgedAt: p.acknowledgedAt, disclosure: DISCLOSURE_TEXT, state: !p.enabled || !p.acknowledgedAt ? "off" : this.o.isOffline() ? "offline" : "ready" };
  }

  /** True when the master switch is on and acknowledged. */
  onlineAllowed(): boolean {
    const p = this.o.settings.internal("privacy").onlineSearch;
    return p.enabled && !!p.acknowledgedAt;
  }

  // ---- runtime snapshots ---------------------------------------------------------------------

  runtimeOf(r: Row): ProviderRuntime {
    const adapter = ADAPTERS[r.adapter];
    let apiKey: string | undefined;
    if (r.credentials_enc) { try { apiKey = decryptSecret(this.o.secretKey, r.credentials_enc); } catch { apiKey = undefined; } }
    return {
      rowId: r.id, id: r.public_id, name: r.name, adapter, config: { baseUrl: r.base_url ?? adapter.info.defaultBaseUrl, apiKey },
      timeoutMs: r.timeout_ms, ratePerSec: r.rate_limit_per_sec, monthlyCap: r.monthly_cap, dailyCap: r.daily_cap,
      language: r.language ?? undefined, region: r.region ?? undefined, safeSearch: r.safe_search,
      storage: { kind: r.storage_kind, ttlSeconds: r.storage_ttl_seconds ?? 0 },
    };
  }
  /** Enabled providers in run order (priority, then id), optionally limited to `ids`. */
  enabledRuntimes(ids?: string[]): (ProviderRuntime & { priority: number; weight: number; fallbackId: string | null; adapterId: AdapterId })[] {
    return this.db.all<Row>("SELECT * FROM search_providers WHERE enabled = 1 ORDER BY priority, id")
      .filter((r) => !ids || ids.includes(r.public_id))
      .map((r) => ({ ...this.runtimeOf(r), priority: r.priority, weight: r.weight, fallbackId: this.publicOf(r.fallback_provider_id), adapterId: r.adapter }));
  }
  runtimeById(publicId: string): (ProviderRuntime & { priority: number; weight: number; fallbackId: string | null; adapterId: AdapterId }) | undefined {
    const r = this.db.get<Row>("SELECT * FROM search_providers WHERE public_id = ? AND enabled = 1", [publicId]);
    return r ? { ...this.runtimeOf(r), priority: r.priority, weight: r.weight, fallbackId: this.publicOf(r.fallback_provider_id), adapterId: r.adapter } : undefined;
  }
  storageOf(publicId: string): StorageKind {
    return this.db.get<{ storage_kind: StorageKind }>("SELECT storage_kind FROM search_providers WHERE public_id = ?", [publicId])?.storage_kind ?? "none";
  }

  // ---- writing -------------------------------------------------------------------------------

  private requireAck(enabling: boolean, acknowledged: boolean | undefined, userId?: number): void {
    if (!enabling) return;
    const ack = this.o.settings.internal("privacy").onlineSearch.acknowledgedAt;
    if (ack) return;
    if (acknowledged === true) {
      this.o.settings.patch({ privacy: { onlineSearch: { acknowledgedAt: new Date(this.o.clock.now()).toISOString() } } }, userId);
      return;
    }
    throw new AppError("bad_request", "Read the disclosure and confirm before turning on a search provider.", {
      fields: [{ in: "body", path: "acknowledged", message: "Read the disclosure and confirm before turning on a search provider." }], disclosure: DISCLOSURE_TEXT,
    });
  }

  private resolveStorage(adapter: AdapterId, input: { policy?: StorageKind; ttlSeconds?: number | null } | undefined, cur?: { kind: StorageKind; ttl: number | null }, fields: FieldIssue[] = []): { kind: StorageKind; ttl: number | null } {
    const a = ADAPTERS[adapter].info.storage;
    let kind = input?.policy ?? cur?.kind ?? a.policy;
    let ttl = input?.ttlSeconds !== undefined ? input.ttlSeconds : cur?.ttl ?? (adapter === "mojeek" ? 3600 : adapter === "searxng" ? 0 : null);
    if (RANK[kind] > RANK[a.policy]) {
      fields.push({ in: "body", path: "storage.policy", message: a.policy === "none" ? "This provider's terms allow no storage at all" : `This provider allows at most "${a.policy}"` });
      kind = a.policy;
    }
    if (kind === "none") ttl = 0;
    else {
      if (kind === "ttl" && (ttl === null || ttl === undefined)) ttl = adapter === "mojeek" ? 3600 : 0;
      if (ttl !== null && ttl !== undefined && a.maxTtlSeconds !== null && ttl > a.maxTtlSeconds) {
        fields.push({ in: "body", path: "storage.ttlSeconds", message: `Use at most ${a.maxTtlSeconds} seconds for this provider` });
        ttl = a.maxTtlSeconds;
      }
    }
    return { kind, ttl: ttl ?? 0 };
  }

  private check(adapter: AdapterId, v: { baseUrl?: string | null; hasKey: boolean; enabled: boolean }, fields: FieldIssue[]): string | null {
    const info = ADAPTERS[adapter].info;
    let base = v.baseUrl?.trim() || null;
    if (base) {
      try {
        const u = new URL(base);
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
        if (u.username || u.password) throw new Error("credentials");
        if (/^(169\.254\.|\[?fe80:|0\.0\.0\.0)/i.test(u.hostname) || u.hostname === "metadata.google.internal") {
          fields.push({ in: "body", path: "baseUrl", message: "Link-local and cloud-metadata addresses are not allowed" });
        }
        base = u.origin + u.pathname.replace(/\/+$/, "");
      } catch { fields.push({ in: "body", path: "baseUrl", message: "Enter an address such as http://searxng:8080 (no username or password)" }); }
    }
    if (info.needsBaseUrl && !base) fields.push({ in: "body", path: "baseUrl", message: "Enter the address of the SearXNG server, for example http://searxng:8080" });
    if (v.enabled && info.needsKey && !v.hasKey) fields.push({ in: "body", path: "apiKey", message: `Enter the ${info.label} API key before turning this provider on` });
    return base;
  }

  create(body: unknown, userId?: number): ProviderOut {
    const v = parseOrThrow(providerCreateSchema, body);
    const info = ADAPTERS[v.adapter].info;
    const fields: FieldIssue[] = [];
    const enabled = v.enabled ?? false;
    const base = this.check(v.adapter, { baseUrl: v.baseUrl, hasKey: !!v.apiKey, enabled }, fields);
    const storage = this.resolveStorage(v.adapter, v.storage, undefined, fields);
    const fb = v.fallbackProviderId ? this.rowOfPublic(v.fallbackProviderId, "fallbackProviderId") : null;
    if (fields.length) throw new RequestValidationError(fields);
    this.requireAck(enabled, v.acknowledged, userId);
    const now = this.o.clock.now();
    const prio = v.priority ?? ((this.db.get<{ m: number | null }>("SELECT MAX(priority) AS m FROM search_providers")?.m ?? 0) + 1);
    const pid = newId("prv");
    const weight = v.weight ?? (this.o.settings.internal("search").rrfProviderWeight as number);
    this.db.transaction(() => this.db.run(
      `INSERT INTO search_providers (public_id, adapter, name, enabled, priority, base_url, credentials_enc, timeout_ms, rate_limit_per_sec, monthly_cap, daily_cap, fallback_provider_id,
         language, region, safe_search, storage_kind, storage_ttl_seconds, weight, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [pid, v.adapter, v.name ?? info.label, enabled ? 1 : 0, prio, base, v.apiKey ? encryptSecret(this.o.secretKey, v.apiKey) : null, v.timeoutMs ?? 4000,
        v.rateLimitPerSec ?? info.defaultRatePerSec, v.monthlyCap ?? null, v.dailyCap ?? null, fb, v.language ?? null, v.region?.toUpperCase() ?? null,
        v.safeSearch ?? "moderate", storage.kind, storage.ttl, weight, now, now]), { durable: true });
    this.o.activity.write({ level: "info", area: "provider", message: `Search provider added: ${v.name ?? info.label}`, details: { adapter: v.adapter, enabled }, userId });
    return this.get(pid);
  }

  update(publicId: string, body: unknown, userId?: number): ProviderOut {
    const cur = this.rowByPublic(publicId);
    const v = parseOrThrow(providerPatchSchema, body);
    const fields: FieldIssue[] = [];
    const enabled = v.enabled ?? cur.enabled === 1;
    const hasKey = v.apiKey !== undefined ? v.apiKey !== null : !!cur.credentials_enc;
    const base = v.baseUrl !== undefined ? this.check(cur.adapter, { baseUrl: v.baseUrl, hasKey, enabled }, fields) : this.check(cur.adapter, { baseUrl: cur.base_url, hasKey, enabled }, fields);
    const storage = this.resolveStorage(cur.adapter, v.storage, { kind: cur.storage_kind, ttl: cur.storage_ttl_seconds }, fields);
    let fb = cur.fallback_provider_id;
    if (v.fallbackProviderId !== undefined) {
      fb = v.fallbackProviderId ? this.rowOfPublic(v.fallbackProviderId, "fallbackProviderId") : null;
      if (fb === cur.id) fields.push({ in: "body", path: "fallbackProviderId", message: "A provider cannot be its own fallback" });
    }
    if (fields.length) throw new RequestValidationError(fields);
    this.requireAck(enabled && cur.enabled !== 1, v.acknowledged, userId);
    const cred = v.apiKey === undefined ? cur.credentials_enc : v.apiKey === null ? null : encryptSecret(this.o.secretKey, v.apiKey);
    this.db.transaction(() => this.db.run(
      `UPDATE search_providers SET name = ?, enabled = ?, priority = ?, base_url = ?, credentials_enc = ?, timeout_ms = ?, rate_limit_per_sec = ?, monthly_cap = ?, daily_cap = ?,
         fallback_provider_id = ?, language = ?, region = ?, safe_search = ?, storage_kind = ?, storage_ttl_seconds = ?, weight = ?, updated_at = ? WHERE id = ?`,
      [v.name ?? cur.name, enabled ? 1 : 0, v.priority ?? cur.priority, base, cred, v.timeoutMs ?? cur.timeout_ms, v.rateLimitPerSec ?? cur.rate_limit_per_sec,
        v.monthlyCap !== undefined ? v.monthlyCap : cur.monthly_cap, v.dailyCap !== undefined ? v.dailyCap : cur.daily_cap, fb,
        v.language !== undefined ? v.language : cur.language, v.region !== undefined ? v.region?.toUpperCase() ?? null : cur.region, v.safeSearch ?? cur.safe_search,
        storage.kind, storage.ttl, v.weight ?? cur.weight, this.o.clock.now(), cur.id]), { durable: true });
    this.o.runner.resetState(cur.id);
    this.o.activity.write({ level: "info", area: "provider", message: `Search provider changed: ${v.name ?? cur.name}`, userId });
    return this.get(publicId);
  }

  remove(publicId: string, userId?: number): void {
    const cur = this.rowByPublic(publicId);
    this.db.transaction(() => {
      this.db.run("DELETE FROM search_providers WHERE id = ?", [cur.id]);
      this.db.run("DELETE FROM usage_counters WHERE kind = 'provider_requests' AND subject = ?", [publicId]);
    }, { durable: true });
    this.o.runner.resetState(cur.id);
    this.o.activity.write({ level: "info", area: "provider", message: `Search provider removed: ${cur.name}`, userId });
  }

  usageDetail(publicId: string): { month: unknown; day: unknown; history: { period: string; requests: number }[] } {
    this.rowByPublic(publicId);
    const u = this.usage(publicId);
    const history = this.db.all<{ period: string; count: number }>(
      "SELECT period, count FROM usage_counters WHERE kind = 'provider_requests' AND subject = ? AND length(period) = 7 ORDER BY period DESC LIMIT 12", [publicId]);
    return { month: u.month, day: u.day, history: history.map((h) => ({ period: h.period, requests: h.count })) };
  }

  /** One small query now. Counts against the caps, ignores the circuit and the cache. */
  async test(publicId: string): Promise<{ ok: boolean; latencyMs: number; resultCount?: number; errorCode?: string; message?: string; partial?: { failedEngines: string[] } }> {
    const row = this.rowByPublic(publicId);
    if (this.o.isOffline()) throw new AppError("offline", "The server is working offline, so the provider cannot be tested now.", { canQueue: false });
    const rt = this.runtimeOf(row);
    const out = await this.o.runner.run(rt, { query: "test", page: 1, pageSize: 1 }, { purpose: "test" });
    if (out.ok) return { ok: true, latencyMs: out.tookMs, resultCount: out.response.results.length, ...(out.response.partial ? { partial: out.response.partial } : {}) };
    return { ok: false, latencyMs: out.tookMs, errorCode: out.error.code, message: out.error.message };
  }
}

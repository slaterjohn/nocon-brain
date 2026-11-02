import { z } from "zod";
import type { Db } from "@ncb/db";
import { AppError, newId, type Clock, type PriorityNumber } from "@ncb/shared";
import type { CrawlConfig } from "@ncb/crawl";
import { parseOrThrow, RequestValidationError } from "../lib/zod.js";
import type { CollectionService } from "../collections/service.js";
import type { SourceService } from "../sources/service.js";
import { priorityInput, resolveConfig, retentionSpecSchema, type RetentionSpec } from "../sources/schema.js";
import { ceilingsFor } from "../sources/limits.js";
import { toCrawlConfig } from "../sources/crawl-port.js";
import type { PipelineService } from "../pipeline/service.js";
import type { ActivityLog } from "../services/activity.js";
import type { OnlineSearch } from "./session.js";

const MAX_URLS = 200;
const DEFAULT_PAGE_BYTES = 600 * 1024;
const PLAN_TTL_MS = 30 * 60_000;

const planBody = z.object({
  searchId: z.string().min(1).max(64),
  resultKeys: z.union([z.literal("all_uncached"), z.array(z.string().min(1).max(64)).min(1).max(400)]),
  strategy: z.enum(["capture", "explore", "mirror"]).default("capture"),
  depth: z.number().int().min(0).max(3).default(1),
  priority: priorityInput.default(3),
  retention: retentionSpecSchema.optional(),
  asCollection: z.union([z.object({ name: z.string().trim().min(1).max(120), icon: z.string().max(40).optional() }), z.object({ collectionId: z.string().min(1).max(64) })]).optional(),
});
const queueBody = z.object({ planId: z.string().min(1).max(64), name: z.string().trim().min(1).max(120).optional() });

interface Plan {
  id: string; at: number; used: boolean; searchId: string; query: string; urls: string[]; keys: string[]; strategy: "capture" | "explore" | "mirror"; depth: number;
  priority: PriorityNumber; retention?: RetentionSpec; asCollection?: z.infer<typeof planBody>["asCollection"];
}

export interface CoverageDeps {
  db: Db; clock: Clock; online: OnlineSearch; sources: SourceService; collections: CollectionService; pipeline: PipelineService; activity: ActivityLog;
  startCrawl: (cfg: CrawlConfig) => { downloadId: string };
  profile: () => "pi-lite" | "standard";
  isOffline: () => boolean;
}

/** "Improve offline coverage" (task O-08): estimate for the chosen results, then queue them. Counts and estimates only; never a share of the internet. */
export class CoverageService {
  private readonly plans = new Map<string, Plan>();
  constructor(private readonly o: CoverageDeps) {}

  plan(raw: unknown): Record<string, unknown> {
    const b = parseOrThrow(planBody, raw);
    const s = this.o.online.get(b.searchId);
    if (!s) throw new AppError("not_found", "That search has expired. Run it again.");
    const items = this.o.online.onlineResults(s);
    const warnings: string[] = [];
    let chosen: Record<string, any>[];
    if (b.resultKeys === "all_uncached") chosen = items.filter((i) => i.availability === "online_only");
    else {
      const byKey = new Map(items.map((i) => [String(i.key), i]));
      chosen = [];
      let missing = 0, done = 0;
      for (const k of b.resultKeys) {
        const i = byKey.get(k);
        if (!i) { if (s.local.results.some((r) => r.key === k)) done++; else missing++; continue; }
        if (i.availability !== "online_only") { done++; continue; }
        chosen.push(i);
      }
      if (missing) warnings.push(`${missing} chosen result${missing === 1 ? " is" : "s are"} not part of this search and ${missing === 1 ? "was" : "were"} skipped.`);
      if (done) warnings.push(`${done} chosen result${done === 1 ? " is" : "s are"} already saved or queued and ${done === 1 ? "was" : "were"} skipped.`);
    }
    const urls = [...new Set(chosen.map((i) => String(i.url)))];
    if (!urls.length) throw new RequestValidationError([{ in: "body", path: "resultKeys", message: "Choose at least one result that is not saved yet" }]);
    if (urls.length > MAX_URLS) throw new RequestValidationError([{ in: "body", path: "resultKeys", message: `Choose at most ${MAX_URLS} results at a time` }]);
    const depth = b.strategy === "capture" ? 0 : Math.max(1, b.depth);
    const estimate = this.estimate(urls, b.strategy, depth, warnings);
    const now = this.o.clock.now();
    for (const [id, p] of this.plans) if (now - p.at > PLAN_TTL_MS) this.plans.delete(id);
    const plan: Plan = {
      id: newId("plan"), at: now, used: false, searchId: s.id, query: s.query, urls, keys: urls.map((u) => String(chosen.find((i) => String(i.url) === u)!.key)), strategy: b.strategy, depth, priority: b.priority as PriorityNumber, retention: b.retention, asCollection: b.asCollection,
    };
    this.plans.set(plan.id, plan);
    return { planId: plan.id, urls: urls.length, estimate, warnings, expiresAt: new Date(now + PLAN_TTL_MS).toISOString() };
  }

  private estimate(urls: string[], strategy: Plan["strategy"], depth: number, warnings: string[]): Record<string, unknown> {
    const hosts = [...new Set(urls.map((u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } }).filter(Boolean))].slice(0, 50);
    let avg = DEFAULT_PAGE_BYTES, n = 0;
    if (hosts.length) {
      const r = this.o.db.get<{ a: number | null; n: number }>(
        `SELECT AVG(v.total_bytes) AS a, COUNT(*) AS n FROM pages p JOIN page_versions v ON v.id = p.latest_version_id
         WHERE p.host IN (SELECT value FROM json_each(?)) AND v.total_bytes IS NOT NULL AND p.deleted_at IS NULL`, [JSON.stringify(hosts)]);
      if (r && r.n > 0 && r.a) { avg = r.a; n = r.n; }
    }
    const ceil = ceilingsFor(this.o.profile());
    const count = urls.length;
    const spread = strategy === "capture" ? 0 : strategy === "explore" ? 8 : 25;
    const pagesLow = Math.max(1, Math.floor(count * (strategy === "capture" ? 0.8 : 1)));
    const pagesHigh = Math.min(ceil.maxPages, Math.max(count, count * (1 + spread * depth)));
    const bytesLow = Math.round(pagesLow * avg * 0.7), bytesHigh = Math.min(ceil.maxBytes, Math.round(pagesHigh * avg * 1.6));
    const rate = this.o.profile() === "pi-lite" ? 0.7 : 2;
    if (strategy !== "capture") warnings.push(`${strategy === "explore" ? "Exploring" : "Mirroring"} follows links, so the number of pages could be up to ${pagesHigh.toLocaleString("en-GB")}. The queue stops at the limits of this device.`);
    return {
      estimate: true, pages: { low: pagesLow, high: pagesHigh }, bytes: { low: bytesLow, high: bytesHigh },
      durationSeconds: { low: Math.round((pagesLow / rate) * 0.7), high: Math.round((pagesHigh / rate) * 1.6) + 5 },
      basis: n > 0 ? `average of ${n} archived page${n === 1 ? "" : "s"} from ${hosts.length === 1 ? "this domain" : "these domains"}` : `default of ${Math.round(DEFAULT_PAGE_BYTES / 1024)} KiB per page: no archived pages from ${hosts.length === 1 ? "this domain" : "these domains"} yet`,
      confidence: strategy !== "capture" ? "low" : n >= 50 ? "high" : n >= 10 ? "medium" : "low",
    };
  }

  queue(raw: unknown): Record<string, unknown> {
    const b = parseOrThrow(queueBody, raw);
    const plan = this.plans.get(b.planId);
    if (!plan || this.o.clock.now() - plan.at > PLAN_TTL_MS) throw new AppError("not_found", "That plan has expired. Make a new plan.");
    if (plan.used) throw new AppError("conflict", "That plan was already queued.");
    const { sources, collections, pipeline } = this.o;
    let collectionId: string | undefined;
    if (plan.asCollection) {
      collectionId = "collectionId" in plan.asCollection ? plan.asCollection.collectionId : collections.create({ name: plan.asCollection.name, icon: plan.asCollection.icon, kind: "manual" }).id;
      if ("collectionId" in plan.asCollection) collections.get(collectionId); // 404 when unknown
    }
    const type = plan.strategy === "capture" ? "single_page" : plan.strategy === "explore" ? "linked_collection" : "website";
    const src = sources.create({
      name: b.name ?? `Search: ${plan.query}`.slice(0, 120), type, startUrl: plan.urls[0], strategy: plan.strategy, profile: "focused", priority: plan.priority,
      ...(plan.retention ? { retention: plan.retention } : {}), ...(collectionId ? { collections: [collectionId] } : {}),
      ...(plan.strategy === "capture" ? {} : { config: { depth: plan.depth } }),
    });
    const row = this.o.db.get<{ id: number; current_config_id: number }>("SELECT id, current_config_id FROM sources WHERE public_id = ?", [src.id])!;
    const offline = this.o.isOffline();
    const downloadIds: string[] = [];
    if (plan.strategy === "capture") {
      for (const url of plan.urls) {
        const r = pipeline.captureUrl(url, { priority: plan.priority, requestedBy: "search", userInitiated: false, sourceId: row.id, discoveredVia: "search", depth: 0 });
        if (offline) pipeline.holdCapture(r.downloadId);
        downloadIds.push(r.downloadId);
      }
    } else {
      const config = resolveConfig({ depth: plan.depth }, type, "focused", this.o.profile(), plan.urls[0]);
      const cfg = toCrawlConfig({ mode: plan.strategy, seeds: plan.urls, priority: plan.priority, requestedBy: "user", sourceId: row.id, configId: row.current_config_id, config }, this.o.profile());
      downloadIds.push(this.o.startCrawl(cfg).downloadId);
    }
    plan.used = true;
    this.o.online.markQueued(plan.searchId, plan.keys, downloadIds);
    this.o.activity.write({ level: "info", area: "search", message: `Offline coverage queued: ${plan.urls.length} address${plan.urls.length === 1 ? "" : "es"} (${plan.strategy})` });
    return { planId: plan.id, queued: plan.urls.length, downloadIds, sourceId: src.id, ...(collectionId ? { collectionId } : {}) };
  }
}

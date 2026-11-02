import type { Db } from "@ncb/db";
import type { Clock, PriorityNumber } from "@ncb/shared";
import { newId } from "@ncb/shared";
import { CrawlConfigError, resolveCrawlConfig, type CrawlConfig } from "@ncb/crawl";
import { AppError } from "@ncb/shared";
import type { SourceConfig } from "./schema.js";

/**
 * What a source run asks of the crawl engine. The engine (tasks C-01 to C-05, apps/server/src/crawl) exposes
 * `startCrawl(config: CrawlConfig)`; the server wires an adapter from this request to that call. Until then the stub below is used.
 */
export interface CrawlRequest {
  sourceId: number;
  sourcePublicId: string;
  configId: number;
  configVersion: number;
  mode: "explore" | "mirror";
  seeds: string[];
  priority: PriorityNumber;
  requestedBy: "user" | "schedule" | "system";
  config: SourceConfig;
}

export interface CrawlPort {
  start(req: CrawlRequest): Promise<{ downloadId: string }>;
}

/**
 * Stand-in used when no crawl engine is connected. It records the run as a failed download job with a plain explanation, so the
 * source's history shows what happened instead of a job that waits forever.
 */
export class StubCrawlPort implements CrawlPort {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  async start(req: CrawlRequest): Promise<{ downloadId: string }> {
    const now = this.clock.now();
    const publicId = newId("dl");
    this.db.run(
      `INSERT INTO download_jobs (public_id, source_id, config_id, kind, state, priority, requested_url, requested_by, failure_code, failure_message, started_at, finished_at, created_at)
       VALUES (?, ?, ?, ?, 'failed', ?, ?, ?, 'internal', ?, ?, ?, ?)`,
      [publicId, req.sourceId, req.configId, req.mode, req.priority, req.seeds[0] ?? null, req.requestedBy,
        "Crawling websites is not available in this build yet. Single pages, sitemaps and feeds can be run now.", now, now, now],
    );
    return { downloadId: publicId };
  }
}

/** The part of the crawl engine this adapter calls (apps/server/src/crawl/README.md). */
export interface CrawlEngine {
  startCrawl(config: CrawlConfig): { downloadId: string };
  pause(id: string | number): boolean;
  resume(id: string | number): boolean;
  cancel(id: string | number): boolean;
}

/**
 * Turns a source run into `startCrawl(config)`. The source's stored config becomes a `custom`-profile crawl with explicit limits,
 * so the engine applies exactly the numbers the Human saw. The engine's own hard ceilings are a second check.
 */
export class EngineCrawlPort implements CrawlPort {
  constructor(private readonly engine: () => CrawlEngine, private readonly resource: () => "pi-lite" | "standard") {}

  async start(req: CrawlRequest): Promise<{ downloadId: string }> {
    const c = req.config;
    let config: CrawlConfig;
    try {
      config = resolveCrawlConfig({
      startUrls: req.seeds,
      mode: req.mode,
      profile: "custom",
      resource: this.resource(),
      sourceId: req.sourceId,
      configId: req.configId,
      priority: req.priority,
      requestedBy: req.requestedBy,
      capture: { priority: req.priority, versioning: c.versioning },
      overrides: {
        limits: { maxPages: c.maxPages, maxBytes: c.maxBytes, maxDurationMs: c.maxDurationSeconds * 1000 },
        scope: {
          maxDepth: c.depth, externalDepth: c.includeExternal ? c.externalDepth : 0,
          allowedDomains: c.allowedDomains, excludedDomains: c.excludedDomains, allowedPaths: c.allowedPaths, excludedPaths: c.excludedPaths,
        },
        query: { policy: c.queryParamPolicy, allowParams: c.queryParamAllowlist },
        links: {
          maxLinksPerPage: c.maxLinksPerPage,
          weights: { region: Object.fromEntries(Object.entries(c.linkWeights).map(([k, v]) => [k === "main" ? "content" : k, v])) },
        },
        politeness: { minDelayMs: c.perDomainDelayMs, assetConcurrency: Math.min(8, c.concurrency) },
      },
      });
    } catch (e) {
      // Field errors in the same shape as the validator, so the client can show them next to the source's settings.
      if (e instanceof CrawlConfigError) {
        throw new AppError("bad_request", "This source's settings are not valid for the crawler.", { fields: e.issues.map((i) => ({ in: "body", path: i.path, message: i.message })) });
      }
      throw e;
    }
    return { downloadId: this.engine().startCrawl(config).downloadId };
  }
}

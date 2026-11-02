import { systemClock } from "@ncb/shared";
import { resolveCrawlConfig, type CrawlConfig, type CrawlRequest } from "@ncb/crawl";
import type { CrawlStatus } from "@ncb/server";
import { startPipelineServer, until, useFixtures, type Fixtures } from "../pipeline/helpers.js";
import type { StartOptions } from "../server/helpers.js";

export { until, useFixtures };
export type { Fixtures };
export type CT = Awaited<ReturnType<typeof startCrawlServer>>;

/**
 * A server on the real clock (the queue's per-host delay is measured in real time, which the fake test clock would freeze)
 * with the loopback fixture hosts allowed.
 */
export function startCrawlServer(opts: StartOptions & { allow?: string } = {}) {
  return startPipelineServer({ ...opts, server: { clock: systemClock, runnerPollMs: 15, ...(opts.server ?? {}) } });
}

/** A fast config for tests: no politeness delay unless a test asks for one. */
export function testConfig(req: CrawlRequest): CrawlConfig {
  return resolveCrawlConfig({ ...req, overrides: { ...req.overrides, politeness: { minDelayMs: 0, ...(req.overrides?.politeness ?? {}) } } });
}

export async function waitFinished(t: Pick<CT, "svc">, id: string | number, ms = 120_000): Promise<CrawlStatus> {
  return until(() => {
    const s = t.svc.crawl.get(id);
    return s && s.finishedAt !== null ? s : undefined;
  }, ms);
}

export async function graph(fx: Fixtures) {
  const g = (await (await fetch(`${fx.urls.linkGraph}/__graph.json`)).json()) as {
    root: string; homeAlias: string; countsByDepth: Record<string, number>; brokenTargets: string[];
    nodes: { id: number; url: string; depth: number; children: number[]; kind: string }[];
    edges: { from: string; to: string; region: string; broken: boolean; external: boolean }[];
  };
  return g;
}

export const fetchedUrls = (t: Pick<CT, "svc">, downloadJobId: number): string[] =>
  t.svc.db.all<{ requested_url: string }>("SELECT requested_url FROM page_versions WHERE download_job_id = ? ORDER BY id", [downloadJobId]).map((r) => r.requested_url);

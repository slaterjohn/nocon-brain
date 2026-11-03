import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CrawlRequest } from "@ncb/crawl";
import { tempDir } from "../integration/server/helpers.js";
import { fetchedUrls, graph, startCrawlServer, useFixtures, waitFinished } from "../integration/crawl/helpers.js";
import { CHILD, expectKilled, integrity, startChild, verifyAll } from "./helpers.js";

const fixtures = useFixtures();

/** Small seeded generator, so a failing run can be repeated: RELIABILITY_SEED=123 pnpm test:reliability. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("power-loss simulation: kill -9 in the middle of writes, with WAL", () => {
  const seed = Number(process.env.RELIABILITY_SEED ?? 20261103);
  it(`six kills at random moments during a crawl (seed ${seed}); the database is intact after each, and the final state passes the app's own verify`, async () => {
    const rand = rng(seed);
    const g = await graph(fixtures());
    const dataDir = tempDir("ncb-pl-data-");
    const rootsDir = tempDir("ncb-pl-roots-");
    const request: CrawlRequest = { startUrls: [g.root], mode: "explore", profile: "comprehensive", overrides: { scope: { maxDepth: 2 }, politeness: { minDelayMs: 0 } } };

    for (let round = 0; round < 6; round++) {
      const child = startChild(CHILD, { MODE: "crawl", CHILD_DATA_DIR: dataDir, CHILD_ROOTS_DIR: rootsDir, CRAWL_REQUEST: JSON.stringify(request) });
      // Let it get going (a different amount each round), then pull the plug at a random moment.
      const need = 2 + Math.floor(rand() * 5) + round * 3;
      const exitedEarly = await Promise.race([child.waitFor(new RegExp(`^PAGES (${need}|[${need}-9]\\d*|\\d{2,})$`), 30_000).then(() => false), child.exited.then(() => true)]).catch(() => false);
      if (exitedEarly) break; // never happens: the child only exits when killed
      await new Promise((r) => setTimeout(r, Math.floor(rand() * 120)));
      await child.kill();
      expectKilled(await child.exited);
      expect(integrity(path.join(dataDir, "db", "main.db")), `main.db after kill ${round + 1}`).toEqual([]);
      expect(integrity(path.join(dataDir, "index", "index.db")), `index.db after kill ${round + 1}`).toEqual([]);
    }

    const t = await startCrawlServer({ dataDir, rootsDir });
    const first = t.svc.crawl.list()[0]!;
    const s = await waitFinished(t, first.crawlJobId);
    expect(["max_depth", "completed"]).toContain(s.stopReason);
    await t.svc.search.drain();
    const urls = fetchedUrls(t, first.downloadJobId);
    expect(new Set(urls).size).toBe(urls.length); // no page fetched twice across six restarts
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_versions WHERE status NOT IN ('ready','partial')")!.n).toBe(0);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued','running','held')")!.n).toBe(0);
    expect(integrity(path.join(dataDir, "db", "main.db"))).toEqual([]);
    expect(await verifyAll(t.svc)).toEqual([]);
  });
});

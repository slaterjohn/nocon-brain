import { systemClock, type Clock } from "@ncb/shared";
import { describe, expect, it } from "vitest";
import { graph, startCrawlServer, testConfig, until, useFixtures, waitFinished } from "../crawl/helpers.js";

const fixtures = useFixtures();

/** The system clock with a wall-clock offset a test can move: monotonic time is untouched, like an NTP step on a Pi without an RTC. */
function steppingClock(): Clock & { step(ms: number): void } {
  let offset = 0;
  return { now: () => systemClock.now() + offset, monotonic: () => systemClock.monotonic(), step: (ms: number) => { offset += ms; } };
}

describe("HB-04 the crawl deadline is measured with the steady clock", () => {
  it("a wall-clock jump forward does not end the crawl early", async () => {
    const g = await graph(fixtures());
    const clock = steppingClock();
    const t = await startCrawlServer({ server: { clock } });
    const started = systemClock.monotonic();
    const run = t.svc.crawl.startCrawl(testConfig({
      startUrls: [g.root], mode: "explore", profile: "comprehensive", overrides: { limits: { maxDurationMs: 2500 }, politeness: { minDelayMs: 200 } },
    }));
    await until(() => (t.svc.crawl.get(run.downloadId)?.pagesFetched ?? 0) >= 1);
    clock.step(3_600_000); // NTP arrives and the clock jumps an hour ahead
    await new Promise((r) => setTimeout(r, 1200));
    const mid = t.svc.crawl.get(run.downloadId)!;
    expect(mid.finishedAt, "still running after a one hour wall-clock jump").toBeNull();
    const s = await waitFinished(t, run.downloadId);
    expect(s.stopReason).toBe("deadline");
    expect(systemClock.monotonic() - started).toBeGreaterThanOrEqual(2200);
  });

  it("a wall-clock jump backward does not extend it", async () => {
    const g = await graph(fixtures());
    const clock = steppingClock();
    const t = await startCrawlServer({ server: { clock } });
    const started = systemClock.monotonic();
    const run = t.svc.crawl.startCrawl(testConfig({
      startUrls: [g.root], mode: "explore", profile: "comprehensive", overrides: { limits: { maxDurationMs: 1500 }, politeness: { minDelayMs: 200 } },
    }));
    await until(() => (t.svc.crawl.get(run.downloadId)?.pagesFetched ?? 0) >= 1);
    clock.step(-3_600_000);
    const s = await waitFinished(t, run.downloadId, 15_000);
    expect(s.stopReason).toBe("deadline");
    expect(systemClock.monotonic() - started).toBeLessThan(6000);
  });
});

describe("HB-06 maxBytes is never overshot", () => {
  it.each([3000, 6000, 12_000])("maxBytes %i: the bytes fetched stay within the budget, with several pages in flight", async (maxBytes) => {
    const g = await graph(fixtures());
    const t = await startCrawlServer();
    const run = t.svc.crawl.startCrawl(testConfig({
      startUrls: [g.root], mode: "explore", profile: "comprehensive", overrides: { limits: { maxBytes }, politeness: { perHostConcurrency: 4 } },
    }));
    const s = await waitFinished(t, run.downloadId);
    expect(s.stopReason).toBe("max_bytes");
    expect(s.bytesFetched).toBeLessThanOrEqual(maxBytes);
    const stored = t.svc.db.get<{ n: number }>("SELECT COALESCE(SUM(total_bytes), 0) AS n FROM page_versions WHERE download_job_id = ? AND status IN ('ready','partial')", [run.downloadJobId])!.n;
    expect(stored).toBeLessThanOrEqual(maxBytes);
  });
});

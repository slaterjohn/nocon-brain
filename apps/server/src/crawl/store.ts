import type { Db } from "@ncb/db";
import type { TrapStore } from "@ncb/crawl";

/** `TrapStore` on `crawl_counters`: the trap budgets survive a restart with the rest of the crawl. */
export class DbTrapStore implements TrapStore {
  constructor(private readonly db: Db, private readonly crawlJobId: number) {}

  get(kind: string, key: string): number {
    return this.db.get<{ value: number }>("SELECT value FROM crawl_counters WHERE crawl_job_id = ? AND kind = ? AND key = ?", [this.crawlJobId, kind, key])?.value ?? 0;
  }

  has(kind: string, key: string): boolean {
    return this.db.get("SELECT 1 AS x FROM crawl_counters WHERE crawl_job_id = ? AND kind = ? AND key = ?", [this.crawlJobId, kind, key]) !== undefined;
  }

  add(kind: string, key: string, delta: number): number {
    return this.db.get<{ value: number }>(
      `INSERT INTO crawl_counters (crawl_job_id, kind, key, value) VALUES (?, ?, ?, ?)
       ON CONFLICT (crawl_job_id, kind, key) DO UPDATE SET value = value + excluded.value RETURNING value`,
      [this.crawlJobId, kind, key, delta],
    )!.value;
  }

  set(kind: string, key: string, value: number): void {
    this.db.run(
      `INSERT INTO crawl_counters (crawl_job_id, kind, key, value) VALUES (?, ?, ?, ?)
       ON CONFLICT (crawl_job_id, kind, key) DO UPDATE SET value = excluded.value`,
      [this.crawlJobId, kind, key, value],
    );
  }
}

/** Adds to the per-reason tally of links that were not followed, keeping up to five sample URLs. */
export function tallySkip(db: Db, crawlJobId: number, reason: string, url: string, n = 1): void {
  db.run(
    `INSERT INTO crawl_skips (crawl_job_id, reason, count, sample_urls_json) VALUES (?, ?, ?, json_array(?))
     ON CONFLICT (crawl_job_id, reason) DO UPDATE SET
       count = count + excluded.count,
       sample_urls_json = CASE WHEN json_array_length(sample_urls_json) < 5 THEN json_insert(sample_urls_json, '$[#]', ?) ELSE sample_urls_json END`,
    [crawlJobId, reason, n, url.slice(0, 500), url.slice(0, 500)],
  );
}

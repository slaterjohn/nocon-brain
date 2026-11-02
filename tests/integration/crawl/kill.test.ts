import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CrawlRequest } from "@ncb/crawl";
import { tempDir } from "../server/helpers.js";
import { fetchedUrls, graph, startCrawlServer, useFixtures, waitFinished } from "./helpers.js";

const fixtures = useFixtures();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function runChild(env: Record<string, string>): Promise<{ signal: NodeJS.Signals | null; code: number | null }> {
  return new Promise((resolve, reject) => {
    const c = spawn(path.join(root, "node_modules/.bin/tsx"), [path.join(root, "tests/integration/crawl/crawl-child.ts")], {
      cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "inherit"],
    });
    c.on("error", reject);
    c.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

describe("C-01 SIGKILL mid-crawl and resume", () => {
  it.each([[undefined], ["assets"], ["links"]])("killed %s: the next run finishes the same crawl with no duplicates", async (stage) => {
    const g = await graph(fixtures());
    const dataDir = tempDir("ncb-ck-data-");
    const rootsDir = tempDir("ncb-ck-roots-");
    const request: CrawlRequest = {
      startUrls: [g.root], mode: "explore", profile: "comprehensive",
      overrides: { scope: { maxDepth: 2 }, politeness: { minDelayMs: 20 } },
    };
    const { signal, code } = await runChild({
      CHILD_DATA_DIR: dataDir, CHILD_ROOTS_DIR: rootsDir, CRAWL_REQUEST: JSON.stringify(request), KILL_AFTER_PAGES: "7", ...(stage ? { KILL_IN_STAGE: stage } : {}),
    });
    expect(signal === "SIGKILL" || code === 137, `child exited with code ${code} signal ${signal}`).toBe(true);

    const t = await startCrawlServer({ dataDir, rootsDir });
    const first = t.svc.crawl.list()[0]!;
    expect(first.finishedAt).toBeNull();
    const s = await waitFinished(t, first.crawlJobId);
    expect(s.stopReason).toBe("max_depth");
    const urls = fetchedUrls(t, first.downloadJobId);
    expect(new Set(urls).size).toBe(urls.length);
    const content = new Set(g.nodes.filter((n) => n.kind === "content" && n.depth <= 2).map((n) => n.url));
    expect(urls.filter((u) => content.has(u)).length).toBe(37);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) - COUNT(DISTINCT url_key) AS n FROM jobs WHERE crawl_job_id = ?", [s.crawlJobId])!.n).toBe(0);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_versions WHERE status NOT IN ('ready','partial')")!.n).toBe(0);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE crawl_job_id = ? AND state IN ('queued','running','held')", [s.crawlJobId])!.n).toBe(0);
    expect(s.pagesFetched).toBe(urls.length);
  });
});

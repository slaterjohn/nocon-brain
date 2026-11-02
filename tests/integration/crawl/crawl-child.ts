// Run by kill.test.ts in a separate process: starts a crawl and kills itself (SIGKILL) once KILL_AFTER_PAGES pages are stored.
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "@ncb/shared";
import { createSsrfGuard } from "@ncb/fetch";
import { resolveCrawlConfig, type CrawlRequest } from "@ncb/crawl";
import { createServer } from "@ncb/server";

const env = process.env;
const volDir = path.join(env.CHILD_ROOTS_DIR!, "vol");
fs.mkdirSync(volDir, { recursive: true });
const config = loadConfig({
  NCB_DATA_DIR: env.CHILD_DATA_DIR!, NCB_VOLUMES_ALLOWED_ROOTS: env.CHILD_ROOTS_DIR!, NCB_APP_URL: "http://localhost:3000", NCB_PROXY_SECRET: "p".repeat(32),
  NCB_LOG_LEVEL: "fatal", NCB_EXTRACT_WORKERS: "0", NCB_MIN_FREE_DISK_GB: "0", NCB_API_HOST: "127.0.0.1", NCB_ARCHIVE_HOST: "127.0.0.1",
} as NodeJS.ProcessEnv);
const server = await createServer({
  config, archive: false, runnerPollMs: 15, captureFetcherOptions: { ssrf: createSsrfGuard({ allow: "127.0.0.1" }) },
  // Die in the middle of a page as well as between pages: the stage hook fires inside runVersion.
  pipelineFaults: env.KILL_IN_STAGE ? { afterStage: (stage) => { if (stage === env.KILL_IN_STAGE && killArmed) process.kill(process.pid, "SIGKILL"); } } : undefined,
});
let killArmed = false;
const svc = await server.initialize();
if (svc.volumes.list().length === 0) await svc.volumes.register({ path: volDir, name: "Main" });
const req = JSON.parse(env.CRAWL_REQUEST!) as CrawlRequest;
const run = svc.crawl.startCrawl(resolveCrawlConfig(req));
const after = Number(env.KILL_AFTER_PAGES ?? 5);
const timer = setInterval(() => {
  const n = svc.crawl.get(run.downloadId)?.pagesFetched ?? 0;
  if (n >= after) {
    killArmed = true;
    if (!env.KILL_IN_STAGE) process.kill(process.pid, "SIGKILL");
  }
}, 5);
timer.unref();
setTimeout(() => process.exit(3), 60_000); // the kill point was never reached

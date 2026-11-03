// A server process the reliability tests start and kill (SIGKILL). MODE chooses what it does after it has started; it prints one-word status
// lines on stdout that the parent waits for. Nothing here cleans up: the point is that the parent kills it at an awkward moment.
//   crawl      starts the crawl in CRAWL_REQUEST and prints "PAGES <n>" as the count grows
//   rebuild    waits for the (slowed) index rebuild and prints "REBUILD <docsDone>"
//   zim-copy   imports ZIM_PATH with copy=true and kills itself at ZIM_FAULT (copy-chunk | after-rename)
//   backup     writes a backup and kills itself at BACKUP_FAULT (after-main | before-rename)
//   blob       stores a blob and kills itself between writing the temp file and renaming it
//   capture    saves CAPTURE_URL as a single page and prints "CAPTURE <download id>"
//   idle       just serves, after printing READY
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "@ncb/shared";
import { createSsrfGuard } from "@ncb/fetch";
import { resolveCrawlConfig, type CrawlRequest } from "@ncb/crawl";
import { createServer, type ServerOptions } from "@ncb/server";

const env = process.env;
const say = (s: string) => process.stdout.write(`${s}\n`);
const volDir = path.join(env.CHILD_ROOTS_DIR!, "vol");
fs.mkdirSync(volDir, { recursive: true });
const config = loadConfig({
  NCB_DATA_DIR: env.CHILD_DATA_DIR!, NCB_VOLUMES_ALLOWED_ROOTS: env.CHILD_ROOTS_DIR!, NCB_APP_URL: "http://localhost:3000", NCB_PROXY_SECRET: "p".repeat(32),
  NCB_LOG_LEVEL: "fatal", NCB_EXTRACT_WORKERS: "0", NCB_MIN_FREE_DISK_GB: "0", NCB_API_HOST: "127.0.0.1", NCB_ARCHIVE_HOST: "127.0.0.1",
  NCB_BACKUP_INTERVAL_HOURS: "0", NCB_VERIFY_INTERVAL_HOURS: "0",
} as NodeJS.ProcessEnv);
const kill = () => process.kill(process.pid, "SIGKILL");
const mode = env.MODE ?? "idle";

const extra: Partial<ServerOptions> = {};
if (mode === "backup") extra.backupFault = (step) => { if (step === env.BACKUP_FAULT) kill(); };
if (mode === "zim-copy") extra.zim = { testHooks: true, fault: (step) => { if (step === env.ZIM_FAULT) kill(); } };
if (mode === "blob") extra.blobFault = () => { kill(); };
if (mode === "rebuild") extra.search = { testFlags: { rebuildBatch: 3, slowBatchMs: 300 } };
const server = await createServer({
  config: { ...config, NCB_API_PORT: 0, NCB_ARCHIVE_PORT: 0 }, archive: false, runnerPollMs: 15, storageTickMs: 0,
  captureFetcherOptions: { ssrf: createSsrfGuard({ allow: "127.0.0.1" }) },
  ...extra,
});
const svc = await server.initialize();
if (svc.volumes.list().length === 0) await svc.volumes.register({ path: volDir, name: "Main" });

if (mode === "crawl") {
  const existing = svc.crawl.list()[0];
  const id = existing ? existing.downloadId : svc.crawl.startCrawl(resolveCrawlConfig(JSON.parse(env.CRAWL_REQUEST!) as CrawlRequest)).downloadId;
  let last = -1;
  setInterval(() => {
    const n = svc.crawl.get(id)?.pagesFetched ?? 0;
    if (n !== last) { last = n; say(`PAGES ${n}`); }
  }, 5);
} else if (mode === "capture") {
  say(`CAPTURE ${svc.pipeline.captureUrl(env.CAPTURE_URL!).downloadId}`);
} else if (mode === "rebuild") {
  setInterval(() => {
    const r = svc.db.get<{ d: number }>("SELECT docs_done AS d FROM indexing_jobs WHERE kind = 'rebuild' AND state = 'running' ORDER BY id DESC LIMIT 1");
    if (r) say(`REBUILD ${r.d}`);
  }, 20);
} else if (mode === "zim-copy") {
  say("READY");
  await svc.zim.register({ path: env.ZIM_PATH!, copy: true });
  say("DONE"); // the fault point was never reached
} else if (mode === "backup") {
  say("READY");
  svc.storage.runBackup({ includeIndex: true });
  say("DONE");
} else if (mode === "blob") {
  say("READY");
  await svc.blobs.put(Buffer.from("half-written?".repeat(1000)), { kind: "other" }).catch(() => undefined);
  say("DONE");
} else {
  say("READY");
}
setTimeout(() => process.exit(3), 90_000); // the parent never killed us

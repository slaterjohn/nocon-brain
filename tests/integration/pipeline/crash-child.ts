// Run by crash.test.ts in a separate process: captures one URL and kills itself (SIGKILL) right after a stage.
import fs from "node:fs";
import path from "node:path";
import { FakeClock, loadConfig } from "@ncb/shared";
import { createSsrfGuard } from "@ncb/fetch";
import { createServer } from "@ncb/server";

const env = process.env;
const dataDir = env.CHILD_DATA_DIR!;
const rootsDir = env.CHILD_ROOTS_DIR!;
const crashAfter = env.CRASH_AFTER;
const crashBeforeDone = env.CRASH_BEFORE_DONE;
const volDir = path.join(rootsDir, "vol");
fs.mkdirSync(volDir, { recursive: true });
const config = loadConfig({
  NCB_DATA_DIR: dataDir, NCB_VOLUMES_ALLOWED_ROOTS: rootsDir, NCB_APP_URL: "http://localhost:3000", NCB_PROXY_SECRET: "p".repeat(32),
  NCB_LOG_LEVEL: "fatal", NCB_EXTRACT_WORKERS: "0", NCB_MIN_FREE_DISK_GB: "0", NCB_API_HOST: "127.0.0.1", NCB_ARCHIVE_HOST: "127.0.0.1",
} as NodeJS.ProcessEnv);
const server = await createServer({
  config, clock: new FakeClock(), archive: false, runnerPollMs: 25,
  captureFetcherOptions: { ssrf: createSsrfGuard({ allow: "127.0.0.1" }) },
  pipelineFaults: {
    afterStage: (stage) => { if (stage === crashAfter) process.kill(process.pid, "SIGKILL"); },
    beforeStageDone: (stage) => { if (stage === crashBeforeDone) process.kill(process.pid, "SIGKILL"); },
  },
});
const svc = await server.initialize();
if (svc.volumes.list().length === 0) await svc.volumes.register({ path: volDir, name: "Main" });
svc.pipeline.captureUrl(env.CAPTURE_URL!);
setTimeout(() => process.exit(3), 60_000); // the crash point was never reached

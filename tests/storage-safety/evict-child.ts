// Run by interrupted-eviction.test.ts in a separate process: runs one eviction against an existing data directory and kills itself
// (SIGKILL) the Nth time the executor reaches FAULT_POINT.
import fs from "node:fs";
import path from "node:path";
import { FakeClock, loadConfig } from "@ncb/shared";
import { createServer } from "@ncb/server";

const env = process.env;
const dataDir = env.CHILD_DATA_DIR!;
const rootsDir = env.CHILD_ROOTS_DIR!;
fs.mkdirSync(path.join(rootsDir, "vol"), { recursive: true });
const point = env.FAULT_POINT!;
const nth = Number(env.FAULT_NTH ?? "1");
let seen = 0;
const config = loadConfig({
  NCB_DATA_DIR: dataDir, NCB_VOLUMES_ALLOWED_ROOTS: rootsDir, NCB_APP_URL: "http://localhost:3000", NCB_PROXY_SECRET: "p".repeat(32),
  NCB_LOG_LEVEL: "fatal", NCB_EXTRACT_WORKERS: "0", NCB_MIN_FREE_DISK_GB: "0", NCB_API_HOST: "127.0.0.1", NCB_ARCHIVE_HOST: "127.0.0.1",
} as NodeJS.ProcessEnv);
const server = await createServer({
  config, clock: new FakeClock(), archive: false, runnerPollMs: 25, storageTickMs: 0,
  storageFault: (p) => {
    if (p === point && ++seen === nth) process.kill(process.pid, "SIGKILL");
  },
});
const svc = await server.initialize();
const plan = svc.storage.planAndStore({ bytesNeeded: Number(env.NEED_BYTES), incomingPriority: 1 });
if (!plan.sufficient) throw new Error("the plan is not sufficient");
await svc.storage.runPlan(plan.planId);
// the fault point was never reached
process.exit(3);

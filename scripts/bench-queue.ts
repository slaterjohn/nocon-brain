// Queue benchmark for docs/benchmarks.md. Run: pnpm bench:queue [--cycles=50000] [--hosts=500]
// Uses the real JobQueue on a temp file with the production pragmas. Prints one JSON object.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobQueue, migrate, openDb } from "@ncb/db";

const arg = (name: string, d: number) => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? d);
const TOTAL = arg("total", 50_000);
const CYCLES = arg("cycles", TOTAL);
const HOSTS = arg("hosts", 500);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ncb-bench-"));
const db = openDb(path.join(dir, "main.db"));
migrate(db);
const q = new JobQueue(db, { leaseMs: 60_000 });

let t = performance.now();
q.enqueueMany(
  Array.from({ length: TOTAL }, (_, i) => ({
    type: "fetch" as const, queue: "crawl" as const, priority: i % 5, host: `h${i % HOSTS}.example`,
    url: `https://h${i % HOSTS}.example/p/${i}`, urlKey: `https://h${i % HOSTS}.example/p/${i}`,
  })),
);
const insertMs = performance.now() - t;

t = performance.now();
let done = 0;
for (let i = 0; i < CYCLES; i++) {
  const job = q.claim("crawl", "bench");
  if (!job) break;
  q.complete(job.id, "bench");
  done++;
}
const cycleMs = performance.now() - t;

const walMb = fs.existsSync(db.path + "-wal") ? fs.statSync(db.path + "-wal").size / 1048576 : 0;
const sqliteVersion = db.get<{ v: string }>("SELECT sqlite_version() v")!.v;
console.log(
  JSON.stringify(
    {
      hardware: `${os.cpus()[0]?.model ?? "unknown"} x${os.cpus().length}, ${(os.totalmem() / 2 ** 30).toFixed(0)} GiB RAM`,
      os: `${os.type()} ${os.release()} ${process.arch}`,
      node: process.version,
      sqlite: sqliteVersion,
      note: "not a Pi",
      total: TOTAL, hosts: HOSTS, cyclesRun: done,
      insertMs: Math.round(insertMs), insertPerJobUs: Math.round((insertMs / TOTAL) * 1000),
      claimCompleteMs: Math.round(cycleMs), msPerCycle: Number((cycleMs / Math.max(done, 1)).toFixed(3)), cyclesPerSecond: Math.round(done / (cycleMs / 1000)),
      walMb: Number(walMb.toFixed(1)),
    },
    null,
    2,
  ),
);
db.close();
fs.rmSync(dir, { recursive: true, force: true });

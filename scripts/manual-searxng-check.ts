// Manual check of the SearXNG adapter against a real SearXNG (docs/api.md 6.2, task O-02). Not part of the test suites: it needs
// a running instance and the internet.
//   docker compose --profile searxng up -d --wait searxng      (publish a port with an override file, see docs/deployment.md)
//   SEARXNG_URL=http://127.0.0.1:18080 node --import tsx scripts/manual-searxng-check.ts "aromaticity"
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "@ncb/shared";
import { createServer } from "@ncb/server";

const url = process.env.SEARXNG_URL;
if (!url) { console.error("Set SEARXNG_URL, for example http://127.0.0.1:18080"); process.exit(2); }
const query = process.argv[2] ?? "aromaticity";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ncb-manual-"));
const config = loadConfig({ NCB_DATA_DIR: dir, NCB_VOLUMES_ALLOWED_ROOTS: dir, NCB_APP_URL: "http://localhost:3000", NCB_PROXY_SECRET: "p".repeat(32), NCB_LOG_LEVEL: "fatal", NCB_EXTRACT_WORKERS: "0", NCB_MIN_FREE_DISK_GB: "0", NCB_API_HOST: "127.0.0.1", NCB_ARCHIVE_HOST: "127.0.0.1" } as NodeJS.ProcessEnv);
const server = await createServer({ config: { ...config, NCB_API_PORT: 0, NCB_ARCHIVE_PORT: 0 }, archive: false });
const svc = await server.initialize();
try {
  const call = async (method: string, u: string, body?: unknown, cookie?: string) => {
    const res = await server.app.inject({ method: method as "GET", url: u, payload: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", "x-nocon-csrf": "1", origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) } });
    return { status: res.statusCode, body: res.body ? res.json() : undefined, res };
  };
  const setup = await call("POST", "/api/setup/admin", { username: "admin", password: "correct horse battery" });
  const cookie = `ncb_session=${setup.res.cookies.find((c) => c.name === "ncb_session")!.value}`;
  await call("PATCH", "/api/settings", { privacy: { onlineSearch: { enabled: true, acknowledged: true } } }, cookie);
  const p = await call("POST", "/api/search/providers", { adapter: "searxng", name: "Real SearXNG", baseUrl: url, enabled: true, acknowledged: true }, cookie);
  console.log("provider:", p.status, p.body.id);
  const test = await call("POST", `/api/search/providers/${p.body.id}/test`, undefined, cookie);
  console.log("test:", JSON.stringify(test.body));
  const t0 = Date.now();
  const s = await call("POST", "/api/search", { query }, cookie);
  console.log("local answer after", Date.now() - t0, "ms; online:", s.body.online.state);
  let poll: any;
  for (let i = 0; i < 200; i++) {
    poll = (await call("GET", `/api/search/${s.body.searchId}?after=0`, undefined, cookie)).body;
    if (poll.done) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const ev = poll.events.find((e: any) => e.type === "provider_results");
  console.log("events:", poll.events.map((e: any) => e.type).join(", "));
  console.log("provider_results:", ev ? `${ev.append.length} results, ${ev.dropped} dropped, partial=${JSON.stringify(ev.partial ?? null)}, ${ev.tookMs} ms` : "none");
  for (const r of (ev?.append ?? []).slice(0, 5)) console.log(" -", r.title, "|", r.url, "|", r.attribution[0].name);
  const more = await call("POST", `/api/search/${s.body.searchId}/more`, {}, cookie);
  console.log("more:", more.status, JSON.stringify(more.body.started));
  await new Promise((r) => setTimeout(r, 4000));
  const snap = (await call("GET", `/api/search/${s.body.searchId}`, undefined, cookie)).body;
  console.log("snapshot results:", snap.results.length, "coverage:", JSON.stringify(snap.coverage));
} finally {
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  void svc;
}

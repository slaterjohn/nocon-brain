import http from "node:http";
import { startSearchServer, until, type BrowserTest } from "../search/helpers.js";
import type { StartOptions } from "../server/helpers.js";
import { startFake, results, type FakeProvider } from "./fakes.js";

export { startFake, results, until };
export type { BrowserTest, FakeProvider };

/** A search server with a fast retry pause and online search switched on and acknowledged. */
export async function startOnlineServer(opts: StartOptions & { online?: boolean } = {}): Promise<BrowserTest> {
  const t = await startSearchServer({ ...opts, server: { online: { retryDelayMs: [5, 10] }, ...(opts.server ?? {}) } });
  await t.svc.search.waitForRebuild();
  if (opts.online !== false) {
    const r = await t.api("PATCH", "/api/settings", { privacy: { onlineSearch: { enabled: true, acknowledged: true } } });
    if (r.status !== 200) throw new Error(`could not enable online search: ${JSON.stringify(r.body)}`);
  }
  return t;
}

export async function addProvider(t: BrowserTest, fake: FakeProvider, extra: Record<string, unknown> = {}) {
  const body: Record<string, unknown> = {
    adapter: fake.kind, name: `Fake ${fake.kind}`, baseUrl: fake.url, enabled: true, acknowledged: true,
    ...(fake.kind === "brave" ? { apiKey: "brave-key" } : fake.kind === "mojeek" ? { apiKey: "mojeek-key" } : {}),
    rateLimitPerSec: 50, ...extra,
  };
  const r = await t.api("POST", "/api/search/providers", body);
  if (r.status !== 201) throw new Error(`could not add provider: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { id: string } & Record<string, any>;
}

/** Reads the whole SSE stream of a search over real HTTP. */
export async function readEvents(t: BrowserTest, searchId: string, o: { lastEventId?: number; timeoutMs?: number } = {}): Promise<{ status: number; events: any[]; raw: string; headers: http.IncomingHttpHeaders }> {
  const apiPort = (t.server.app.server.address() as { port: number }).port;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: apiPort, path: `/api/search/${searchId}/events`, method: "GET",
      headers: { cookie: t.cookie, accept: "text/event-stream", ...(o.lastEventId !== undefined ? { "last-event-id": String(o.lastEventId) } : {}) },
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { raw += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, events: parseSse(raw), raw, headers: res.headers }));
      res.on("error", reject);
    });
    req.on("error", reject);
    setTimeout(() => { req.destroy(); reject(new Error("event stream did not end in time")); }, o.timeoutMs ?? 20_000).unref();
    req.end();
  });
}

export function parseSse(raw: string): any[] {
  const out: any[] = [];
  for (const block of raw.split("\n\n")) {
    const lines = block.split("\n");
    const data = lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
    if (!data) continue;
    out.push({ id: Number(lines.find((l) => l.startsWith("id: "))?.slice(4)), event: lines.find((l) => l.startsWith("event: "))?.slice(7), ...JSON.parse(data) });
  }
  return out;
}

export async function search(t: BrowserTest, body: Record<string, unknown>) {
  return t.api("POST", "/api/search", { query: "turbines", ...body });
}

/** Waits for the online run of a search to finish and returns the polled events. */
export async function finished(t: BrowserTest, searchId: string) {
  const end = Date.now() + 20_000;
  for (;;) {
    const p = await t.api("GET", `/api/search/${searchId}?after=0`);
    if (p.body.done) return p.body;
    if (Date.now() > end) throw new Error("the online run did not finish");
    await new Promise((r) => setTimeout(r, 20));
  }
}

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach } from "vitest";

/** A local stand-in for a search provider. No real network is ever used in the tests. */
export interface FakeResult { url: string; title: string; snippet?: string }
export interface FakeProvider {
  kind: "searxng" | "brave" | "mojeek";
  url: string;
  host: string;
  /** Requests received, with the headers and the parsed query string. */
  requests: { path: string; query: URLSearchParams; headers: http.IncomingHttpHeaders }[];
  connections: number;
  /** Results returned for every request (per page: `results` is sliced by the `page` parameter). */
  results: FakeResult[];
  delayMs: number;
  /** When set, replaces the normal answer: status, body and headers. */
  override?: { status: number; body?: string; headers?: Record<string, string>; contentType?: string };
  /** Fail the next N requests with this override before behaving normally. */
  failTimes: number;
  failWith?: { status: number; body?: string; headers?: Record<string, string>; contentType?: string };
  /** Destroy the socket instead of answering. */
  hangUp: boolean;
  unresponsiveEngines: [string, string][];
  pageSize: number;
  close(): Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

export async function startFake(kind: FakeProvider["kind"], results: FakeResult[] = []): Promise<FakeProvider> {
  const f: FakeProvider = {
    kind, url: "", host: "", requests: [], connections: 0, results, delayMs: 0, failTimes: 0, hangUp: false, unresponsiveEngines: [], pageSize: kind === "mojeek" ? 10 : 10,
    close: async () => undefined,
  };
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    f.requests.push({ path: u.pathname, query: u.searchParams, headers: req.headers });
    const answer = () => {
      if (f.hangUp) { req.socket.destroy(); return; }
      let o = f.override;
      if (f.failTimes > 0) { f.failTimes--; o = f.failWith ?? { status: 500, body: "boom", contentType: "text/plain" }; }
      if (o) {
        res.writeHead(o.status, { "content-type": o.contentType ?? "application/json", ...(o.headers ?? {}) });
        res.end(o.body ?? "{}");
        return;
      }
      const page = Number(u.searchParams.get(kind === "searxng" ? "pageno" : kind === "brave" ? "offset" : "s") ?? "1");
      const index = kind === "searxng" ? page - 1 : kind === "brave" ? page : Math.floor((page - 1) / f.pageSize);
      const slice = f.results.slice(index * f.pageSize, (index + 1) * f.pageSize);
      let body: unknown;
      if (kind === "searxng") {
        if (u.searchParams.get("format") !== "json") { res.writeHead(403, { "content-type": "text/html" }); res.end("<html>forbidden</html>"); return; }
        body = { query: u.searchParams.get("q"), results: slice.map((r) => ({ url: r.url, title: r.title, content: r.snippet ?? "", engines: ["fake"] })), unresponsive_engines: f.unresponsiveEngines };
      } else if (kind === "brave") {
        if (req.headers["x-subscription-token"] !== "brave-key") { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "bad token" })); return; }
        body = { web: { results: slice.map((r) => ({ url: r.url, title: r.title, description: r.snippet ?? "" })) } };
      } else {
        if (u.searchParams.get("api_key") !== "mojeek-key") { res.writeHead(403, { "content-type": "application/json" }); res.end("{}"); return; }
        body = { response: { status: "OK", results: slice.map((r) => ({ url: r.url, title: r.title, desc: r.snippet ?? "" })) } };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (f.delayMs > 0) setTimeout(answer, f.delayMs); else answer();
  });
  server.on("connection", (s) => { f.connections++; sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  f.url = `http://127.0.0.1:${port}`;
  f.host = `127.0.0.1:${port}`;
  f.close = () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); });
  cleanups.push(f.close);
  return f;
}

export const results = (n: number, host = "example.org", prefix = "Result"): FakeResult[] =>
  Array.from({ length: n }, (_, i) => ({ url: `https://${host}/p/${i + 1}`, title: `${prefix} ${i + 1} about turbines`, snippet: `${prefix} ${i + 1} snippet about turbines and energy` }));

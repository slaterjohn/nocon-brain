import http from "node:http";
import type { AddressInfo } from "node:net";

/** A fake SearXNG for the browser tests: answers the JSON API with results the test chooses, and can be slow or fail. */
export interface FakeResult { url: string; title: string; content?: string }
export interface FakeSearx {
  url: string;
  /** Searches received, in order. */
  requests: { q: string; pageno: number }[];
  results: FakeResult[];
  /** Results per page. */
  pageSize: number;
  delayMs: number;
  /** When set, every answer is this status (with `body` and `headers`) instead of results. */
  fail?: { status: number; body?: string; headers?: Record<string, string> };
  close(): Promise<void>;
}

export async function startFakeSearx(init: Partial<Pick<FakeSearx, "results" | "pageSize" | "delayMs" | "fail">> = {}): Promise<FakeSearx> {
  const f: FakeSearx = { url: "", requests: [], results: [], pageSize: 10, delayMs: 0, close: async () => undefined, ...init };
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname !== "/search") {
      res.writeHead(404).end();
      return;
    }
    const pageno = Math.max(1, Number(u.searchParams.get("pageno") ?? "1"));
    f.requests.push({ q: u.searchParams.get("q") ?? "", pageno });
    const answer = () => {
      if (f.fail) {
        res.writeHead(f.fail.status, { "content-type": "application/json", ...(f.fail.headers ?? {}) });
        res.end(f.fail.body ?? "{}");
        return;
      }
      if (u.searchParams.get("format") !== "json") {
        res.writeHead(403, { "content-type": "text/html" }).end("forbidden");
        return;
      }
      const slice = f.results.slice((pageno - 1) * f.pageSize, pageno * f.pageSize);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ query: u.searchParams.get("q"), results: slice.map((r) => ({ url: r.url, title: r.title, content: r.content ?? "", engines: ["fake"] })), unresponsive_engines: [] }));
    };
    if (f.delayMs > 0) setTimeout(answer, f.delayMs);
    else answer();
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  f.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  f.close = () => new Promise<void>((r) => {
    for (const s of sockets) s.destroy();
    server.close(() => r());
  });
  return f;
}

/** `n` distinct web results about a topic, at addresses that are never fetched. */
export const webResults = (n: number, topic = "astronomy", host = "news.example.test", prefix = "Web"): FakeResult[] =>
  Array.from({ length: n }, (_, i) => ({ url: `https://${host}/${topic}/${prefix.toLowerCase()}-${i + 1}`, title: `${prefix} result ${i + 1} about ${topic}`, content: `${prefix} snippet ${i + 1} about ${topic} and the night sky.` }));

import http from "node:http";
import { call, setupAdmin, type StartOptions } from "../server/helpers.js";
import { startPipelineServer, until } from "../pipeline/helpers.js";

export { until, useFixtures } from "../pipeline/helpers.js";

export async function startSourcesServer(opts: StartOptions & { allow?: string } = {}) {
  const t = await startPipelineServer(opts);
  const cookie = await setupAdmin(t);
  const api = async <T = any>(method: string, url: string, body?: unknown) => {
    const res = await call(t, { method, url, body, cookie });
    let parsed: unknown;
    try {
      parsed = res.body ? res.json() : undefined;
    } catch {
      parsed = res.body;
    }
    return { status: res.statusCode, body: parsed as T };
  };
  /** Waits until every download job of a source has finished. */
  const settled = (sourcePublicId?: string, ms = 30_000) =>
    until(() => {
      const rows = t.svc.db.all<{ state: string }>(
        sourcePublicId
          ? "SELECT d.state FROM download_jobs d JOIN sources s ON s.id = d.source_id WHERE s.public_id = ?"
          : "SELECT state FROM download_jobs",
        sourcePublicId ? [sourcePublicId] : [],
      );
      return rows.length > 0 && rows.every((r) => ["completed", "failed", "cancelled"].includes(r.state)) ? rows : undefined;
    }, ms);
  return Object.assign(t, { cookie, api, settled });
}
export type SourcesTest = Awaited<ReturnType<typeof startSourcesServer>>;

/** A tiny site whose body can be swapped between requests (feeds that grow). */
export async function mutableSite(initial: Record<string, { type: string; body: string }>) {
  const routes = new Map(Object.entries(initial));
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    hits.push(path);
    const r = routes.get(path);
    if (!r) { res.writeHead(404).end("missing"); return; }
    res.writeHead(200, { "content-type": r.type }).end(r.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    origin, hits,
    set: (path: string, type: string, body: string) => routes.set(path, { type, body }),
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

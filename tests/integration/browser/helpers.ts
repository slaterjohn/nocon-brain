import { call, setupAdmin, type TestServer } from "../server/helpers.js";
import { startPipelineServer, until } from "../pipeline/helpers.js";
import type { StartOptions } from "../server/helpers.js";

export { until, useFixtures } from "../pipeline/helpers.js";
export { call } from "../server/helpers.js";

export interface BrowserTest extends Awaited<ReturnType<typeof startPipelineServer>> {
  cookie: string;
  archivePort: number;
  /** Fetch from the archive listener using an address returned by the API (token included). */
  archiveFetch(frameUrl: string, init?: RequestInit): Promise<Response>;
  api<T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; body: T; headers: Record<string, unknown> }>;
}

/** A pipeline server with an administrator, the archive listener on a free port and the loopback fixtures allowed. */
export async function startBrowserServer(opts: StartOptions & { allow?: string } = {}): Promise<BrowserTest> {
  const t = await startPipelineServer({ ...opts, server: { archive: true, ...(opts.server ?? {}) } });
  const { archivePort } = await t.server.listen();
  const cookie = await setupAdmin(t);
  const api = async (method: string, url: string, body?: unknown) => {
    const res = await call(t, { method, url, body, cookie });
    let parsed: unknown = undefined;
    try {
      parsed = res.body ? res.json() : undefined;
    } catch {
      parsed = res.body;
    }
    return { status: res.statusCode, body: parsed as never, headers: res.headers as Record<string, unknown> };
  };
  return Object.assign(t, {
    cookie, archivePort: archivePort!, api,
    archiveFetch: (frameUrl: string, init?: RequestInit) => {
      const u = new URL(frameUrl);
      return fetch(`http://127.0.0.1:${archivePort}${u.pathname}${u.search}`, init);
    },
  }) as BrowserTest;
}

/** Saves a URL through the API and waits for the download job to finish. */
export async function saveAndWait(t: BrowserTest, url: string, ms = 30_000) {
  const res = await t.api("POST", "/api/browser/save", { url });
  if (res.status !== 202) throw new Error(`save failed: ${res.status} ${JSON.stringify(res.body)}`);
  const id = res.body.downloadId as string;
  return until(() => {
    const r = t.pipeline.getCapture(id);
    return r && (r.state === "completed" || r.state === "failed") ? r : undefined;
  }, ms);
}
export type { TestServer };

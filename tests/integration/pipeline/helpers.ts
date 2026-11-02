import { createSsrfGuard } from "@ncb/fetch";
import type { PipelineService } from "@ncb/server";
import { startFixtures } from "../../fixtures/sites/index.mjs";
import { startServer, type StartOptions, type TestServer } from "../server/helpers.js";
import { afterAll } from "vitest";

export type Fixtures = Awaited<ReturnType<typeof startFixtures>>;

/** Polls `fn` (sync or async) until it returns a truthy value. Async results are awaited, never treated as truthy promises. */
export async function until<T>(fn: () => T | undefined | false | null | Promise<T | undefined | false | null>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

export function useFixtures(opts: Record<string, unknown> = {}): () => Fixtures {
  let fx: Fixtures | undefined;
  const ready = startFixtures(opts as never).then((f: Fixtures) => (fx = f));
  afterAll(async () => {
    await ready;
    await fx?.close();
  });
  return () => {
    if (!fx) throw new Error("fixtures not started");
    return fx;
  };
}

/** A server wired to the real @ncb/fetch fetcher, with the loopback fixture hosts allowed. */
export async function startPipelineServer(opts: StartOptions & { allow?: string } = {}): Promise<TestServer & { pipeline: PipelineService }> {
  const { allow, ...rest } = opts;
  const t = await startServer({
    ...rest,
    server: {
      captureFetcherOptions: { ssrf: createSsrfGuard({ allow: allow ?? "127.0.0.1" }) },
      ...(rest.server ?? {}),
    },
  });
  if (t.svc.volumes.list().length === 0) await t.svc.volumes.register({ path: t.volDir, name: "Main" });
  return Object.assign(t, { pipeline: t.svc.pipeline });
}

/** Captures a URL and waits for the download job to finish. */
export async function capture(t: { pipeline: PipelineService; svc: TestServer["svc"] }, url: string, options: Parameters<PipelineService["captureUrl"]>[1] = {}, ms = 30_000) {
  const { downloadId } = t.pipeline.captureUrl(url, options);
  const res = await until(() => {
    const r = t.pipeline.getCapture(downloadId);
    return r && (r.state === "completed" || r.state === "failed") ? r : undefined;
  }, ms);
  return res;
}

import http from "node:http";
import { describe, expect, it } from "vitest";
import { capture, startPipelineServer, useFixtures } from "./helpers.js";

const fixtures = useFixtures();

async function serve(routes: Record<string, { body: string | Buffer; type?: string }>) {
  const srv = http.createServer((req, res) => {
    const r = routes[req.url ?? ""];
    if (!r) return void res.writeHead(404).end("no");
    res.writeHead(200, { "content-type": r.type ?? "text/html" }).end(r.body);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return { origin: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => srv.close() };
}

describe("A-05 stage retry and failure", () => {
  it("retries a failing stage, then succeeds", async () => {
    let calls = 0;
    const t = await startPipelineServer({
      server: {
        stageOverrides: {
          sections: () => {
            if (++calls < 3) throw new Error("transient trouble");
            return { detail: { ok: true } };
          },
        },
      },
    });
    const r = await capture(t, `${fixtures().urls.article}/tide-pools`);
    expect(r.outcome).toBe("created");
    const v = t.pipeline.getVersion(r.versionId!)!;
    expect(v.stages.find((s) => s.stage === "sections")).toMatchObject({ state: "done", attempts: 3 });
  });

  it("marks the version failed with the stage name after the attempts are used up", async () => {
    const t = await startPipelineServer({ server: { stageOverrides: { links: () => { throw new Error("always broken"); } } } });
    const r = await capture(t, `${fixtures().urls.article}/tide-pools`);
    expect(r).toMatchObject({ state: "failed", outcome: "failed" });
    expect(r.failureMessage).toContain("links");
    const v = t.svc.db.get<{ status: string; failure_stage: string; failure_message: string }>("SELECT status, failure_stage, failure_message FROM page_versions")!;
    expect(v).toMatchObject({ status: "failed", failure_stage: "links" });
    const run = t.svc.db.get<{ state: string; attempts: number }>("SELECT state, attempts FROM pipeline_stage_runs WHERE stage='links'")!;
    expect(run).toEqual({ state: "failed", attempts: 3 });
    // the page never gained a latest version, so readers see nothing
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pages WHERE latest_version_id IS NOT NULL")!.n).toBe(0);
  });

  it("readers never see a capturing version (the latest pointer moves only in the last stage)", async () => {
    const seen: (number | null)[] = [];
    let t: Awaited<ReturnType<typeof startPipelineServer>>;
    t = await startPipelineServer({
      server: { pipelineFaults: { afterStage: (stage) => { seen.push(t.svc.db.get<{ l: number | null }>("SELECT latest_version_id AS l FROM pages")?.l ?? null); void stage; } } },
    });
    await capture(t, `${fixtures().urls.article}/tide-pools`);
    expect(seen.slice(0, -1).every((x) => x === null)).toBe(true);
    expect(seen.at(-1)).not.toBeNull();
  });
});

describe("A-08 extraction limits and the worker pool", () => {
  it("rejects a pathological document without taking the server down (on a worker thread)", async () => {
    const huge = `<!doctype html><html><head><title>Huge</title></head><body>${"<p>word word word word word word word word</p>".repeat(160_000)}</body></html>`;
    const deep = `<!doctype html><html><head><title>Deep</title></head><body>${"<div>".repeat(5000)}text${"</div>".repeat(5000)}</body></html>`;
    const s = await serve({ "/huge": { body: huge }, "/deep": { body: deep }, "/ok": { body: `<!doctype html><title>Ok</title><body><article>${"<p>Plenty of sensible prose lives on this page for the extractor to find and keep.</p>".repeat(10)}</article></body>` } });
    try {
      const t = await startPipelineServer({ env: { NCB_EXTRACT_WORKERS: "1" } });
      expect(huge.length).toBeGreaterThan(5 * 1024 * 1024);
      const a = await capture(t, `${s.origin}/huge`);
      expect(t.pipeline.getVersion(a.versionId!)).toMatchObject({ status: "partial", partialReason: "size_cap" });
      const b = await capture(t, `${s.origin}/deep`);
      expect(t.pipeline.getVersion(b.versionId!)).toMatchObject({ status: "partial", partialReason: "truncated" });
      const c = await capture(t, `${s.origin}/ok`);
      expect(t.pipeline.getVersion(c.versionId!)).toMatchObject({ status: "ready", title: "Ok" });
      expect(t.svc.runner.poolStatus().every((p) => p.state === "idle" || p.state === "busy")).toBe(true);
    } finally {
      s.close();
    }
  });

  it("extracts an article identically on a worker thread and in-thread", async () => {
    const a = await startPipelineServer({ env: { NCB_EXTRACT_WORKERS: "1" } });
    const b = await startPipelineServer();
    const url = `${fixtures().urls.article}/black-holes`;
    const ra = await capture(a, url);
    const rb = await capture(b, url);
    const va = a.pipeline.getVersion(ra.versionId!)!;
    const vb = b.pipeline.getVersion(rb.versionId!)!;
    expect(va.contentHash).toBe(vb.contentHash);
    expect(va.content.readerSha256).toBe(vb.content.readerSha256);
    expect(va.content.outlineSha256).toBe(vb.content.outlineSha256);
  });

  it("falls back to defuddle and then body text for pages Readability cannot use", async () => {
    const s = await serve({ "/tiny": { body: "<!doctype html><title>Tiny</title><body><div>Just a handful of words in a div.</div></body>" } });
    try {
      const t = await startPipelineServer();
      const r = await capture(t, `${s.origin}/tiny`);
      const v = t.pipeline.getVersion(r.versionId!)!;
      expect(v.content.extractionMethod).toBe("body_text");
      expect(v).toMatchObject({ status: "partial", partialReason: "reader_only" });
      expect(Buffer.from((await t.svc.blobs.read(v.content.textSha256!)).data).toString()).toContain("handful of words");
    } finally {
      s.close();
    }
  });
});

describe("A-04 robots.txt on single-page saves", () => {
  it("bypasses robots for a user-initiated save and logs it", async () => {
    const t = await startPipelineServer();
    const r = await capture(t, `${fixtures().urls.robots}/noconbrain-blocked/page`);
    expect(r.outcome).toBe("created");
    const log = t.svc.db.all<{ message: string }>("SELECT message FROM activity_log WHERE message LIKE '%robots.txt was overridden%'");
    expect(log).toHaveLength(1);
  });

  it("honours robots for a non-user save", async () => {
    const t = await startPipelineServer();
    const r = await capture(t, `${fixtures().urls.robots}/noconbrain-blocked/page`, { requestedBy: "schedule", userInitiated: false });
    expect(r).toMatchObject({ state: "failed", failureCode: "robots_blocked" });
  });
});

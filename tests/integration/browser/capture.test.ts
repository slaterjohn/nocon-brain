import { describe, expect, it } from "vitest";
import { saveAndWait, startBrowserServer, until, useFixtures } from "./helpers.js";

const fixtures = useFixtures();

interface CaptureEv { downloadId: string; state: string; outcome: string; label: string; percent: number; held: boolean; stage?: string; pageId?: string; versionId?: string }

describe("A-15 single-page capture end to end", () => {
  it("POST /api/browser/save creates a download job at P3 and reports progress as capture events", async () => {
    const t = await startBrowserServer();
    const events: CaptureEv[] = [];
    t.svc.events.subscribe((e) => { if (e.type === "capture") events.push(e.data as CaptureEv); });
    const url = `${fixtures().urls.article}/astronomy`;

    const res = await t.api("POST", "/api/browser/save", { url });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ state: "queued", held: false, priority: 3, url });
    expect(res.body.downloadId).toMatch(/^dl_/);

    const done = await until(() => {
      const c = t.pipeline.getCapture(res.body.downloadId);
      return c && c.state === "completed" ? c : undefined;
    });
    expect(done.outcome).toBe("created");

    // The default priority of a quick save is stored on the download job (there is no sources table before Phase 3).
    expect(t.svc.db.get<{ priority: number; requested_by: string }>("SELECT priority, requested_by FROM download_jobs WHERE public_id = ?", [res.body.downloadId]))
      .toEqual({ priority: 3, requested_by: "user" });
    expect(t.svc.db.get<{ p: number }>("SELECT effective_priority AS p FROM pages WHERE public_id = ?", [done.pageId!])!.p).toBe(3);

    const mine = events.filter((e) => e.downloadId === res.body.downloadId);
    expect(mine[0]!.state).toBe("queued");
    const states = [...new Set(mine.map((e) => e.state))];
    expect(states).toEqual(["queued", "running", "completed"]);
    expect(mine.some((e) => e.stage === "assets" && e.label === "Saving images and styles")).toBe(true);
    const percents = mine.map((e) => e.percent);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    const last = mine[mine.length - 1]!;
    expect(last).toMatchObject({ state: "completed", outcome: "created", percent: 100, label: "Saved", pageId: done.pageId, versionId: done.versionId });

    // The same figures are available by polling.
    const poll = await t.api("GET", `/api/archive/captures/${res.body.downloadId}`);
    expect(poll.body).toMatchObject({ state: "completed", outcome: "created", percent: 100 });
    const list = await t.api("GET", "/api/archive/captures");
    expect(list.body.items[0].downloadId).toBe(res.body.downloadId);
  });

  it("the open copy is served offline: no outbound request once saved, and a link leads to another saved page", async () => {
    const t = await startBrowserServer();
    const base = fixtures().urls.article;
    await saveAndWait(t, `${base}/solar-system`);
    await saveAndWait(t, `${base}/astronomy`);
    t.svc.connectivity.setForced(true);
    const mark = (fixtures().log("article") as { entries: unknown[] }).entries.length;

    const r = await t.api("POST", "/api/browser/resolve", { input: `${base}/astronomy` });
    expect(r.body.resolution.kind).toBe("archive");
    const res = await t.archiveFetch(r.body.resolution.frame.url, { headers: { "sec-fetch-dest": "iframe" } });
    const html = await res.text();
    expect(html).not.toContain(base);
    const href = html.match(/<a[^>]*href="([^"]*\/p\/pg_[^"]*)"[^>]*data-ncb-link="cached"/)?.[1] ?? html.match(/<a[^>]*data-ncb-link="cached"[^>]*href="([^"]*\/p\/pg_[^"]*)"/)?.[1];
    expect(href).toBeTruthy();
    const next = await t.archiveFetch(`http://x${href}`, { headers: { "sec-fetch-dest": "iframe" } });
    expect(next.status).toBe(200);
    expect(await next.text()).toContain("Solar");
    expect((fixtures().log("article") as { entries: unknown[] }).entries.length).toBe(mark);
  });

  it("a second save of an unchanged page creates no version", async () => {
    const t = await startBrowserServer();
    const url = `${fixtures().urls.article}/astronomy`;
    const first = await saveAndWait(t, url);
    expect(first.outcome).toBe("created");
    const second = await saveAndWait(t, url);
    expect(second.outcome).toBe("unchanged");
    expect(t.pipeline.listVersions(first.pageId!)).toHaveLength(1);
    const ev = t.pipeline.captureProgress(second.downloadId)!;
    expect(ev).toMatchObject({ outcome: "unchanged", label: "Already saved, nothing has changed" });
  });

  it("POST /api/archive/capture is the same flow, honours an explicit priority and Idempotency-Key", async () => {
    const t = await startBrowserServer();
    const url = `${fixtures().urls.article}/renewable-energy`;
    const a = await t.api("POST", "/api/archive/capture", { url, priority: "P2" });
    expect(a.status).toBe(202);
    expect(t.svc.db.get<{ priority: number }>("SELECT priority FROM download_jobs WHERE public_id = ?", [a.body.downloadId])!.priority).toBe(2);
    const { call } = await import("./helpers.js");
    const k1 = await call(t, { url: "/api/archive/capture", body: { url: `${fixtures().urls.article}/about` }, cookie: t.cookie, headers: { "idempotency-key": "abc" } });
    const k2 = await call(t, { url: "/api/archive/capture", body: { url: `${fixtures().urls.article}/about` }, cookie: t.cookie, headers: { "idempotency-key": "abc" } });
    expect(k1.json().downloadId).toBe(k2.json().downloadId);
    expect((await t.api("POST", "/api/archive/capture", { url: "ftp://example.org/x" })).status).toBe(400);
    expect((await t.api("POST", "/api/archive/capture", { url: `${fixtures().urls.article}/x`, priority: "P9" })).status).toBe(400);
  });

  it("a failing page reports a plain failure and a failed capture event", async () => {
    const t = await startBrowserServer();
    const events: CaptureEv[] = [];
    t.svc.events.subscribe((e) => { if (e.type === "capture") events.push(e.data as CaptureEv); });
    const done = await saveAndWait(t, `${fixtures().urls.article}/definitely-missing-page`);
    expect(done.state).toBe("failed");
    const last = events[events.length - 1]!;
    expect(last).toMatchObject({ state: "failed", outcome: "failed", label: "Could not be saved" });
  });
});

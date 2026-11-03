import { describe, expect, it } from "vitest";
import { WikipediaClient } from "@ncb/server";
import { CONTACT, apiRequests, fakeControl, fakeLog, startFakeWiki } from "./helpers.js";

/** Z-07: the Wikipedia client against a fake Wikimedia server that enforces the User-Agent policy, a request rate and maxlag. */
describe("WikipediaClient against a fake Wikimedia server", () => {
  it("never starts more than one request a second and never has two in flight (the real one-second pace)", async () => {
    const f = await startFakeWiki(50);
    const c = new WikipediaClient({ contact: CONTACT, origin: f.origin });
    const titles = ["Astronomy", "Planet", "Star", "Galaxy"];
    const t0 = Date.now();
    const results = await Promise.all(titles.map((t) => c.pageHtml("en", t)));
    const took = Date.now() - t0;
    expect(results.every((r) => r.kind === "ok")).toBe(true);
    const log = await fakeLog(f);
    const reqs = apiRequests(log);
    expect(reqs).toHaveLength(4);
    expect(log.maxInFlight).toBe(1);
    for (let i = 1; i < reqs.length; i++) expect(reqs[i]!.t - reqs[i - 1]!.t, `gap ${i}`).toBeGreaterThanOrEqual(985);
    expect(took).toBeGreaterThanOrEqual(2900);
    // and the server never counted a window of one second with more than one request
    const times = reqs.map((r) => r.t);
    for (const t of times) expect(times.filter((x) => x >= t && x < t + 1000).length).toBe(1);
  }, 30_000);

  it("sends the contact in the User-Agent of every request", async () => {
    const f = await startFakeWiki(50);
    const c = new WikipediaClient({ contact: CONTACT, origin: f.origin, minIntervalMs: 30 });
    await c.pageHtml("en", "Astronomy");
    await c.imageInfo("en", ["File:Sun_illustration.png"]);
    await c.titleInfo("en", ["Sun", "Moon"]);
    const log = await fakeLog(f);
    const reqs = apiRequests(log);
    expect(reqs.length).toBe(3);
    for (const r of reqs) expect(r.ua).toMatch(/^NoConBrain\/\S+ \(https:\/\/github\.com\/slaterjohn\/nocon-brain\)$/);
  });

  it("refuses to run without a contact: nothing is sent", async () => {
    const f = await startFakeWiki(50);
    for (const contact of [undefined, "", "not a contact"]) {
      const c = new WikipediaClient({ contact, origin: f.origin, minIntervalMs: 10 });
      await expect(c.pageHtml("en", "Astronomy")).rejects.toMatchObject({ reason: "no_contact" });
      await expect(c.imageInfo("en", ["File:X.png"])).rejects.toMatchObject({ reason: "no_contact" });
      await expect(c.media(`${f.origin}/images/x.png`)).rejects.toMatchObject({ reason: "no_contact" });
    }
    expect((await fakeLog(f)).total).toBe(0);
  });

  it("the fake server itself rejects a request with no contact in the agent (sanity check of the fixture)", async () => {
    const f = await startFakeWiki(50);
    const bad = await fetch(`${f.origin}/w/rest.php/v1/page/Astronomy/html`, { headers: { "user-agent": "curl/8" } });
    expect(bad.status).toBe(403);
    const good = await fetch(`${f.origin}/w/rest.php/v1/page/Astronomy/html`, { headers: { "user-agent": `NoConBrain/0 (${CONTACT})` } });
    expect(good.status).toBe(200);
  });

  it("honours Retry-After on a 429 and carries on", async () => {
    const f = await startFakeWiki(1); // the fake allows one request in any second and answers 429 with Retry-After: 1 otherwise
    const c = new WikipediaClient({ contact: CONTACT, origin: f.origin, minIntervalMs: 100, minBackoffMs: 100 });
    const [a, b] = await Promise.all([c.pageHtml("en", "Astronomy"), c.pageHtml("en", "Planet")]);
    expect(a.kind).toBe("ok");
    expect(b.kind).toBe("ok");
    const log = await fakeLog(f);
    const ctl = await fakeControl(f, "");
    expect(ctl.rateLimited).toBeGreaterThanOrEqual(1);
    const reqs = apiRequests(log);
    expect(reqs.length).toBeGreaterThanOrEqual(3);
    // the retry came at least a second after the request that was refused: Retry-After was obeyed, not the 100 ms backoff
    const refusedAt = reqs[1]!.t;
    const retryAt = reqs[2]!.t;
    expect(retryAt - refusedAt).toBeGreaterThanOrEqual(950);
    expect(c.state().rateLimited).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("adds maxlag=5 to Action API calls and reports a lagged server instead of hammering it", async () => {
    const f = await startFakeWiki(50);
    const c = new WikipediaClient({ contact: CONTACT, origin: f.origin, minIntervalMs: 20, maxInlineWaitMs: 500, maxAttempts: 2 });
    await c.imageInfo("en", ["File:Sun_illustration.png"]);
    let log = await fakeLog(f);
    expect(new URL(apiRequests(log)[0]!.url, "http://x").searchParams.get("maxlag")).toBe("5");
    await fakeControl(f, "lag=9");
    await expect(c.imageInfo("en", ["File:Sun_illustration.png"])).rejects.toMatchObject({ reason: "maxlag", retryAfterMs: 5000, code: "rate_limited" });
    log = await fakeLog(f);
    expect(apiRequests(log)).toHaveLength(2); // the lagged call was asked once and not repeated inside the wait it would not sit through
    await fakeControl(f, "lag=0");
    expect((await c.imageInfo("en", ["File:Sun_illustration.png"])).size).toBe(1);
  });

  it("makes conditional requests: a 304 for an unchanged revision, a full page after the article changes", async () => {
    const f = await startFakeWiki(50);
    const c = new WikipediaClient({ contact: CONTACT, origin: f.origin, minIntervalMs: 20 });
    const first = await c.pageHtml("en", "Planet");
    expect(first.kind === "ok" && first.etag).toBeTruthy();
    const etag = first.kind === "ok" ? first.etag : undefined;
    expect(await c.pageHtml("en", "Planet", { etag })).toMatchObject({ kind: "not_modified" });
    await fakeControl(f, "bump=Planet");
    const changed = await c.pageHtml("en", "Planet", { etag });
    expect(changed.kind).toBe("ok");
    expect(changed.kind === "ok" && changed.revisionId).not.toBe(first.kind === "ok" ? first.revisionId : "");
  });

  it("follows the fake's redirects, reports missing articles and reads the revision, licence and history link", async () => {
    const f = await startFakeWiki(50);
    const c = new WikipediaClient({ contact: CONTACT, origin: f.origin, minIntervalMs: 20 });
    const r = await c.pageHtml("en", "Blackhole");
    expect(r).toMatchObject({
      kind: "ok", requestedTitle: "Blackhole", redirectedFrom: "Blackhole", target: { title: "Black_hole" },
      licence: { name: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/" },
    });
    if (r.kind !== "ok") throw new Error("unreachable");
    expect(r.revisionId).toMatch(/^\d+$/);
    expect(r.articleUrl).toBe(`${f.origin}/wiki/Black_hole`);
    expect(r.historyUrl).toBe(`${f.origin}/w/index.php?title=Black_hole&action=history`);
    expect(await c.pageHtml("en", "No_such_article")).toMatchObject({ kind: "missing" });
  });

  it("reads image credits (author, licence, non-free) with imageinfo extmetadata", async () => {
    const f = await startFakeWiki(50);
    const c = new WikipediaClient({ contact: CONTACT, origin: f.origin, minIntervalMs: 20 });
    const info = await c.imageInfo("en", ["File:Sun_illustration.png", "File:Black_hole_illustration.png", "File:Moon_illustration.png", "File:Nope.png"]);
    expect(info.get("File:Sun_illustration.png")).toMatchObject({ licenseName: "Public domain", nonFree: false });
    expect(info.get("File:Black_hole_illustration.png")).toMatchObject({ licenseName: "Fair use", nonFree: true });
    expect(info.get("File:Moon_illustration.png")).toMatchObject({
      author: "Fixture Moon Photographer", licenseName: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0", nonFree: false,
    });
    expect(info.has("File:Nope.png")).toBe(false);
  });

  it("reports which titles exist and which are disambiguation pages", async () => {
    const f = await startFakeWiki(50);
    const c = new WikipediaClient({ contact: CONTACT, origin: f.origin, minIntervalMs: 20 });
    const info = await c.titleInfo("en", ["Sun", "Nothing_here"]);
    expect(info.get("Sun")).toMatchObject({ exists: true, disambiguation: false });
    expect(info.get("Nothing_here")).toMatchObject({ exists: false });
  });
});

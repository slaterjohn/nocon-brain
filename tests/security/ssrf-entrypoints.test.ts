import http from "node:http";
import net from "node:net";
import { describe, expect, it } from "vitest";
import { systemClock } from "@ncb/shared";
import { createFetcher, createSsrfGuard, FetchError, type Resolver } from "@ncb/fetch";
import { GuardedProxy } from "../../apps/server/src/renderer/proxy.js";
import { WikipediaClient, WikipediaError } from "../../apps/server/src/wikipedia/client.js";
import { parseWikipediaUrl } from "../../apps/server/src/wikipedia/url.js";
import { startSourcesServer } from "../integration/sources/helpers.js";
import { startCrawlServer, testConfig, waitFinished } from "../integration/crawl/helpers.js";
import { startOnlineServer } from "../integration/online/helpers.js";
import { startZimServer } from "../integration/zim/helpers.js";
import { until } from "../integration/pipeline/helpers.js";
import { FAKE_DNS, directTargets, redirectLocations, type Target } from "./ssrf-corpus.js";
import { SAME_HOST, closers, listen, makeGuard, resolver, startCanary, startHostileSite, stride, type SiteMode } from "./hostile.js";

/**
 * H-03 SSRF fuzzing, part 2: every place the server fetches a URL somebody else chose.
 *
 *   save page / browser save / live check   POST /api/archive/capture, /api/browser/save, /api/browser/live-check
 *   downloads / first source                POST /api/downloads, /api/setup/first-source
 *   crawl seeds, sitemaps, feeds            POST /api/sources (website, sitemap, feed) and run
 *   redirects, robots.txt, sitemap lines    served by a hostile local site
 *   assets (img, css, iframe, srcset, base) a hostile page that names the corpus everywhere
 *   renderer                                the guarded forward proxy, plain requests and CONNECT
 *   Wikipedia                               host allowlist, redirects off Wikimedia, address parsing
 *   ZIM                                     registration takes a path only: nothing to fetch
 *   search providers                        redirects cannot leave the configured host and port
 *
 * All servers are on 127.0.0.1; "good.test" is a fake DNS name for the hostile site; the canary counts requests that should never arrive.
 */

/** The queue's per-host delays are measured in real time; the fake test clock would freeze every crawl after its first page. */
const REAL = { clock: systemClock, runnerPollMs: 15 };

describe("the whole corpus against the real fetcher", () => {
  it("every direct target is refused before a connection, and the canary stays at zero", async () => {
    const canary = await startCanary();
    const f = createFetcher({ ssrf: makeGuard(), timeouts: { connectMs: 500, totalMs: 3000 } });
    closers.push(() => f.close());
    const leaks: string[] = [];
    for (const t of directTargets(canary.port)) {
      const e = await f.fetch(t.url).then(() => null, (err) => err as FetchError);
      if (!(e instanceof FetchError) || e.code !== "ssrf_blocked") leaks.push(`${t.name}: ${e ? `${(e as FetchError).code}: ${e.message}` : "fetched"}`);
    }
    expect(leaks).toEqual([]);
    expect(canary.hits).toEqual([]);
  });

  it("every redirect Location is refused at the hop, from an allowed host", async () => {
    const canary = await startCanary();
    const site = await startHostileSite(canary.port);
    const f = createFetcher({ ssrf: makeGuard(), timeouts: { connectMs: 500, totalMs: 3000 } });
    closers.push(() => f.close());
    const bad: string[] = [];
    for (const [i, r] of redirectLocations(canary.port).entries()) {
      const e = await f.fetch(`${site.origin}/redir/${i}`).then(() => null, (err) => err as FetchError);
      // `http:/127.0.0.1:1/x` and `http:127.0.0.1:1/x` are RELATIVE references when the base is also http (WHATWG): they stay on the allowed host.
      if (SAME_HOST.has(r.name)) continue;
      if (!(e instanceof FetchError) || e.code !== "ssrf_blocked") bad.push(`${r.name}: ${e ? `${(e as FetchError).code}` : "fetched"}`);
    }
    expect(bad).toEqual([]);
    const chain = await f.fetch(`${site.origin}/chain`).then(() => null, (err) => err as FetchError);
    expect(chain?.code).toBe("ssrf_blocked");
    expect(canary.hits).toEqual([]);
    // control: the allowed host itself works, so the refusals above are not a broken test rig
    expect((await f.fetch(`${site.origin}/page-ok`)).status).toBe(200);
    expect((await f.fetch(`${site.origin}/good-then-private`)).status).toBe(200);
  });

  it("a name that resolves to a disallowed address is refused in the connect lookup, every time", async () => {
    const canary = await startCanary();
    let lookups = 0;
    const counting: Resolver = async (h) => { lookups++; return resolver(h); };
    const f = createFetcher({ ssrf: createSsrfGuard({ allow: "good.test", resolver: counting }), timeouts: { connectMs: 500 } });
    closers.push(() => f.close());
    for (const host of Object.keys(FAKE_DNS)) {
      const e = await f.fetch(`http://${host}:${canary.port}/canary`).then(() => null, (err) => err as FetchError);
      expect(e?.code, host).toBe("ssrf_blocked");
      expect(e?.ssrfReason, host).toBe("resolved_address");
    }
    expect(lookups).toBe(Object.keys(FAKE_DNS).length); // one resolution per connection: the checked address is the used address
    expect(canary.hits).toEqual([]);
  });
});

describe("through the API: save page, live check, downloads, first source", () => {
  it("rejects or fails every corpus URL, creates no page, and the canary stays at zero", async () => {
    const canary = await startCanary();
    const t = await startSourcesServer({ server: { ...REAL, captureFetcherOptions: { ssrf: makeGuard(), timeouts: { connectMs: 500, totalMs: 3000 } } } });
    const targets: Target[] = stride(directTargets(canary.port), 140);
    const bad: string[] = [];
    for (const [i, target] of targets.entries()) {
      for (const [route, body] of [
        ["/api/archive/capture", { url: target.url }],
        ["/api/browser/save", { url: target.url }],
        ["/api/downloads", { kind: "capture", url: target.url }],
      ] as const) {
        const r = await t.api("POST", route, body);
        if (r.status >= 500) bad.push(`${route} ${target.name}: ${r.status}`);
      }
      if (i % 3 === 0) {
        const live = await t.api("POST", "/api/browser/live-check", { url: target.url });
        if (live.status >= 500) bad.push(`live-check ${target.name}: ${live.status}`);
        if (live.status === 200 && (live.body?.reachable === true || live.body?.ok === true)) bad.push(`live-check ${target.name} reported reachable`);
        const prev = await t.api("POST", "/api/sources/preview", { name: "x", type: "single_page", startUrl: target.url });
        if (prev.status >= 500) bad.push(`preview ${target.name}: ${prev.status}`);
      }
    }
    expect(bad).toEqual([]);
    // let every queued job finish (they all fail at the guard), then look at what was stored
    await until(() => t.svc.db.get<{ n: number }>("SELECT count(*) AS n FROM download_jobs WHERE state IN ('queued','running','pending')")!.n === 0, 90_000);
    expect(t.svc.db.get<{ n: number }>("SELECT count(*) AS n FROM page_versions")!.n).toBe(0);
    expect(canary.hits).toEqual([]);
  }, 180_000);

  it("the first-source wizard step refuses private addresses the same way", async () => {
    const canary = await startCanary();
    const t = await startSourcesServer({ server: { ...REAL, captureFetcherOptions: { ssrf: makeGuard(), timeouts: { connectMs: 500 } } } });
    for (const target of stride(directTargets(canary.port), 25)) {
      const r = await t.api("POST", "/api/setup/first-source", { url: target.url, kind: "page" });
      expect(r.status, target.name).toBeLessThan(500);
    }
    await until(() => t.svc.db.get<{ n: number }>("SELECT count(*) AS n FROM download_jobs WHERE state IN ('queued','running','pending')")!.n === 0, 60_000);
    expect(canary.hits).toEqual([]);
  }, 120_000);

  it("a malformed or oversized URL is a 400, never a 500", async () => {
    const t = await startSourcesServer({ server: { ...REAL, captureFetcherOptions: { ssrf: makeGuard() } } });
    for (const url of ["", " ", "http://", "http://[::1", "http://exa mple.com", "x".repeat(5000), "http://\u0000", "http://example.com:99999/"]) {
      for (const route of ["/api/archive/capture", "/api/browser/save", "/api/browser/live-check", "/api/browser/resolve"]) {
        const body = route === "/api/browser/resolve" ? { input: url } : { url };
        const r = await t.api("POST", route, body);
        expect(r.status, `${route} ${JSON.stringify(url).slice(0, 40)}`).toBeLessThan(500);
      }
    }
  });
});

describe("through a hostile page, site and feed: links, assets, robots, sitemaps", () => {
  async function runHostile(mode: SiteMode, work: (t: Awaited<ReturnType<typeof startSourcesServer>>, site: Awaited<ReturnType<typeof startHostileSite>>) => Promise<void>) {
    const canary = await startCanary();
    const site = await startHostileSite(canary.port, mode);
    const t = await startSourcesServer({ server: { ...REAL, captureFetcherOptions: { ssrf: makeGuard(), timeouts: { connectMs: 500, totalMs: 5000 } } } });
    await work(t, site);
    await until(() => t.svc.db.get<{ n: number }>("SELECT count(*) AS n FROM download_jobs WHERE state IN ('queued','running','pending')")!.n === 0, 120_000);
    expect(canary.hits).toEqual([]);
    return { canary, site, t };
  }

  it("saving a page whose links, images, styles, frames and base all name private addresses fetches none of them", async () => {
    const { t, site } = await runHostile({ robots: "normal" }, async (t, site) => {
      expect((await t.api("POST", "/api/archive/capture", { url: `${site.origin}/page` })).status).toBe(202);
      expect((await t.api("POST", "/api/archive/capture", { url: `${site.origin}/page-base` })).status).toBe(202);
    });
    expect(site.served).toContain("/page");
    // the page itself was saved (control), so the assets that failed are the hostile ones
    expect(t.svc.db.get<{ n: number }>("SELECT count(*) AS n FROM page_versions WHERE status IN ('ready','partial')")!.n).toBeGreaterThanOrEqual(1);
  }, 180_000);

  it("saving a URL that redirects to every corpus Location stores nothing from the target", async () => {
    const { t } = await runHostile({ robots: "normal" }, async (t, site) => {
      for (const i of stride(redirectLocations(1).map((_, n) => n), 25)) await t.api("POST", "/api/archive/capture", { url: `${site.origin}/redir/${i}` });
      await t.api("POST", "/api/archive/capture", { url: `${site.origin}/chain` });
    });
    expect(t.svc.db.get<{ n: number }>("SELECT count(*) AS n FROM page_versions")!.n).toBe(0);
  }, 180_000);

  /** The crawl engine with no politeness delay (the API's floor is 1.5 s a page, which would make this test minutes long). */
  async function crawl(mode: SiteMode, maxDepth = 2) {
    const canary = await startCanary();
    const site = await startHostileSite(canary.port, mode);
    const t = await startCrawlServer({ server: { captureFetcherOptions: { ssrf: makeGuard(), timeouts: { connectMs: 500, totalMs: 5000 } } } });
    const run = t.svc.crawl.startCrawl(testConfig({ startUrls: [`${site.origin}/page`], mode: "explore", profile: "comprehensive", overrides: { scope: { maxDepth, externalDepth: 1 }, limits: { maxPages: 60 } } as never }));
    const done = await waitFinished(t, run.downloadId, 120_000);
    expect(canary.hits).toEqual([]);
    return { t, site, done, canary };
  }

  it("a website crawl that follows links to private hosts and external hosts reaches none of them", async () => {
    const { t, site, done } = await crawl({ robots: "normal" });
    expect(done.state).toBe("completed");
    expect(site.served).toContain("/page");
    expect(site.served.filter((p) => p.startsWith("/redir/")).length).toBeGreaterThan(0); // the crawler really did try the hostile redirects
    expect(t.svc.db.get<{ n: number }>("SELECT count(*) AS n FROM page_versions WHERE final_url LIKE '%127.0.0.1%' OR final_url LIKE '%169.254%' OR final_url LIKE '%//10.%'")!.n).toBe(0);
  }, 240_000);

  it("a robots.txt that redirects inside is not followed, and Sitemap lines pointing inside are not fetched", async () => {
    for (const robots of ["redirect", "sitemaps"] as const) {
      const { site } = await crawl({ robots }, 1);
      expect(site.served, robots).toContain("/robots.txt"); // it was asked for ...
    }
  }, 240_000);

  it("sitemap and sitemap-index sources list private URLs: none is fetched, the public one is", async () => {
    const { t } = await runHostile({ robots: "normal" }, async (t, site) => {
      for (const file of ["sitemap.xml", "sitemap-index.xml"]) {
        const s = (await t.api("POST", "/api/sources", { name: file, type: "sitemap", startUrl: `${site.origin}/${file}`, config: { maxPages: 200 } })).body;
        expect(s.id, file).toBeTruthy();
        const run = await t.api("POST", `/api/sources/${s.id}/run`);
        expect(run.status, JSON.stringify(run.body)).toBeLessThan(500);
        if (run.body?.downloadIds?.length) await t.settled(s.id, 120_000);
      }
    });
    expect(t.svc.db.get<{ n: number }>("SELECT count(*) AS n FROM page_versions WHERE final_url LIKE '%127.0.0.1%' OR final_url LIKE '%169.254%'")!.n).toBe(0);
  }, 240_000);

  it("a feed whose items point inside fetches none of them", async () => {
    await runHostile({ robots: "normal" }, async (t, site) => {
      const s = (await t.api("POST", "/api/sources", { name: "feed", type: "feed", startUrl: `${site.origin}/feed.xml` })).body;
      expect(s.id).toBeTruthy();
      const run = await t.api("POST", `/api/sources/${s.id}/run`);
      expect(run.status, JSON.stringify(run.body)).toBeLessThan(500);
      await t.settled(s.id, 120_000);
    });
  }, 240_000);

  it("the source preview reads a hostile sitemap and feed without fetching what they list", async () => {
    await runHostile({ robots: "normal" }, async (t, site) => {
      for (const [type, file] of [["sitemap", "sitemap.xml"], ["feed", "feed.xml"], ["website", "page"]] as const) {
        const r = await t.api("POST", "/api/sources/preview", { name: type, type, startUrl: `${site.origin}/${file}` });
        expect(r.status, `${type} ${JSON.stringify(r.body).slice(0, 200)}`).toBeLessThan(500);
      }
    });
  }, 120_000);
});

describe("the renderer's forward proxy", () => {
  async function proxyFor(canary: number) {
    const token = "r".repeat(32);
    const proxy = new GuardedProxy({
      guard: makeGuard(), token, host: "127.0.0.1", port: 0,
      politeness: { maxConcurrentPerHost: 2, minIntervalMs: 0, maxWaitMs: 2000 },
    });
    const { port } = await proxy.listen();
    closers.push(() => proxy.close());
    const auth = `Basic ${Buffer.from(`renderer:${token}`).toString("base64")}`;
    const plain = (url: string) => new Promise<number>((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => s.write(`GET ${url} HTTP/1.1\r\nHost: x\r\nProxy-Authorization: ${auth}\r\nConnection: close\r\n\r\n`));
      let buf = "";
      const done = () => { s.destroy(); resolve(Number(/^HTTP\/1\.\d (\d{3})/.exec(buf)?.[1] ?? 0)); };
      s.on("data", (c) => { buf += c.toString("latin1"); if (buf.includes("\r\n")) done(); });
      s.on("error", done);
      s.on("close", done);
      s.setTimeout(4000, done);
    });
    const connect = (target: string) => new Promise<number>((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${auth}\r\n\r\n`));
      let buf = "";
      const done = () => { s.destroy(); resolve(Number(/^HTTP\/1\.\d (\d{3})/.exec(buf)?.[1] ?? 0)); };
      s.on("data", (c) => { buf += c.toString("latin1"); if (buf.includes("\r\n\r\n")) done(); });
      s.on("error", done);
      s.on("close", done);
      s.setTimeout(4000, done);
    });
    return { plain, connect, proxy, canary };
  }

  it("refuses every corpus URL as a plain request (403 or 400), and every host:port as CONNECT (403 or 400)", async () => {
    const canary = await startCanary();
    const { plain, connect } = await proxyFor(canary.port);
    const bad: string[] = [];
    for (const t of directTargets(canary.port)) {
      if (/^[\x21-\x7e]+$/.test(t.url)) {
        const code = await plain(t.url); // a request line cannot carry spaces or control characters; those targets are covered by the fetcher test
        if (code !== 403 && code !== 400) bad.push(`plain ${t.name}: ${code}`);
      }
      let hp: string | null = null;
      try {
        const u = new URL(t.url);
        if (u.protocol === "http:" || u.protocol === "https:") hp = `${u.hostname}:${u.port || (u.protocol === "https:" ? 443 : 80)}`;
      } catch { /* not a URL */ }
      if (hp) {
        const c = await connect(hp);
        if (c !== 403 && c !== 400) bad.push(`connect ${t.name} (${hp}): ${c}`);
      }
    }
    expect(bad).toEqual([]);
    expect(canary.hits).toEqual([]);
  }, 240_000);
});

describe("Wikipedia features contact Wikimedia hosts only", () => {
  const client = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
    new WikipediaClient({ contact: "https://example.org/contact", fetch: fetchImpl, minIntervalMs: 0, sleep: async () => undefined, ...extra } as never);

  it("never calls fetch for a corpus URL or a look-alike host", async () => {
    const canary = await startCanary();
    let calls = 0;
    const c = client((async () => { calls++; return new Response("x"); }) as typeof fetch);
    const lookalikes = [
      "https://wikipedia.org.evil.example/", "https://evilwikipedia.org/", "https://en.wikipedia.org.evil.example/wiki/X", "https://en.wikipedia.org@127.0.0.1/",
      "http://en.wikipedia.org/wiki/X", "https://en.wikipedia.org./wiki/X", "https://en.wikipedia.org:8443@evil.example/",
      "https://en.wikipedia.org%2f@127.0.0.1/", "https://xn--wikipedia-x.org/", "https://en-wikipedia.org/",
    ];
    for (const t of directTargets(canary.port).map((x) => x.url).concat(lookalikes)) {
      const e = await c.get(t).then(() => null, (err) => err as WikipediaError);
      expect(e, t).toBeInstanceOf(Error);
      if (e instanceof WikipediaError) expect(["blocked_host", "bad_response"], `${t}: ${e.reason}`).toContain(e.reason);
    }
    expect(calls).toBe(0);
    expect(canary.hits).toEqual([]);
  });

  it("does not follow a redirect off Wikimedia (corpus Locations, scheme downgrade, look-alikes)", async () => {
    const canary = await startCanary();
    const seen: string[] = [];
    for (const r of [...redirectLocations(canary.port).map((x) => x.location), "http://en.wikipedia.org/wiki/X", "https://wikipedia.org.evil.example/"]) {
      let n = 0;
      const c = client((async (url: string) => { seen.push(String(url)); n++; return new Response(null, { status: 302, headers: { location: r } }); }) as unknown as typeof fetch);
      const e = await c.get("https://en.wikipedia.org/wiki/Test").then(() => null, (err) => err as WikipediaError);
      expect(e, r).toBeInstanceOf(WikipediaError);
      expect(n, `${r} was requested after the redirect`).toBe(1);
    }
    expect(seen.every((u) => u === "https://en.wikipedia.org/wiki/Test")).toBe(true);
  });

  it("only reads an article address from a Wikipedia host or the one configured replacement origin", () => {
    for (const t of directTargets(1).map((x) => x.url)) expect(parseWikipediaUrl(t), t).toBeUndefined();
    for (const u of ["https://wikipedia.org.evil.example/wiki/X", "https://en.wikipedia.org.evil.example/wiki/X", "https://evil.example/wiki/X", "https://en.wikipedia.org@evil.example/wiki/X", "https://127.0.0.1/wiki/X"]) {
      expect(parseWikipediaUrl(u), u).toBeUndefined();
    }
    expect(parseWikipediaUrl("https://en.wikipedia.org/wiki/Black_hole")).toEqual({ lang: "en", title: "Black_hole" });
    // the replacement origin is the operator's choice and counts only for itself
    const o = { origin: "http://127.0.0.1:9999" };
    expect(parseWikipediaUrl("http://127.0.0.1:9999/wiki/X", o)).toEqual({ lang: "en", title: "X" });
    expect(parseWikipediaUrl("http://127.0.0.1:9998/wiki/X", o)).toBeUndefined();
    expect(parseWikipediaUrl("http://127.0.0.2:9999/wiki/X", o)).toBeUndefined();
  });

  it("the API refuses a non-Wikipedia address with a 400 and fetches nothing", async () => {
    const canary = await startCanary();
    const t = await startSourcesServer({ server: { ...REAL, captureFetcherOptions: { ssrf: makeGuard() } } });
    for (const target of stride(directTargets(canary.port), 40)) {
      for (const route of ["/api/wikipedia/preview", "/api/wikipedia/crawl"]) {
        const r = await t.api("POST", route, { url: target.url });
        expect(r.status, `${route} ${target.name}`).toBeLessThan(500);
        expect(r.status, `${route} ${target.name}`).toBeGreaterThanOrEqual(400);
      }
    }
    expect(canary.hits).toEqual([]);
  }, 120_000);
});

describe("ZIM registration takes a path on this machine, never an address", () => {
  it("rejects URLs, traversal and anything outside the allowed folders without opening a connection", async () => {
    const canary = await startCanary();
    const t = await startZimServer();
    for (const p of [
      `http://127.0.0.1:${canary.port}/x.zim`, `https://example.com/x.zim`, "file:///etc/passwd", "ftp://example.com/x.zim", "//127.0.0.1/share/x.zim", "\\\\127.0.0.1\\share\\x.zim",
      "../../etc/passwd.zim", "/etc/passwd", "/etc/passwd.zim", `${t.rootsDir}/../x.zim`, `${t.rootsDir}/library/../../x.zim`, "x.zim", "", "a\u0000.zim", "/proc/self/environ.zim",
    ]) {
      const r = await t.api("POST", "/api/zim/packages/import", { path: p });
      expect(r.status, JSON.stringify(p)).toBeGreaterThanOrEqual(400);
      expect(r.status, JSON.stringify(p)).toBeLessThan(500);
    }
    expect(canary.hits).toEqual([]);
    // a symbolic link inside the allowed folder that points outside it
    const fs = await import("node:fs");
    const path = await import("node:path");
    const outside = path.join(t.dataDir, "outside.zim");
    fs.writeFileSync(outside, Buffer.alloc(4096, 1));
    const lib = path.join(t.rootsDir, "library");
    fs.mkdirSync(lib, { recursive: true });
    fs.symlinkSync(outside, path.join(lib, "link.zim"));
    const r = await t.api("POST", "/api/zim/packages/import", { path: path.join(lib, "link.zim") });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/outside the allowed/);
  }, 120_000);

  it("licence addresses must be http(s): a javascript: or data: address is refused (regression)", async () => {
    const t = await startZimServer();
    const added = await t.add("wiki");
    expect(added.status, JSON.stringify(added.body)).toBeLessThan(300);
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>1</script>", "file:///etc/passwd", "vbscript:x"]) {
      const r = await t.api("PATCH", `/api/zim/packages/${added.body.id}`, { licenseUrl: bad });
      expect(r.status, bad).toBe(400);
    }
    expect((await t.api("PATCH", `/api/zim/packages/${added.body.id}`, { licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/" })).status).toBe(200);
    const fresh = await startZimServer();
    const p = await fresh.place("chem");
    const r = await fresh.api("POST", "/api/zim/packages/import", { path: p, licenseUrl: "javascript:alert(1)" });
    expect(r.status).toBe(400);
  }, 120_000);
});

describe("search providers and the connectivity probe", () => {
  it("a provider that redirects off its configured host and port is not followed", async () => {
    const canary = await startCanary();
    const hits: string[] = [];
    const provider = await listen((req, res) => {
      hits.push(req.url ?? "");
      res.writeHead(302, { location: `http://127.0.0.1:${canary.port}/canary` }).end();
    });
    const t = await startOnlineServer();
    const add = await t.api("POST", "/api/search/providers", { adapter: "searxng", name: "Redirecting", baseUrl: `http://127.0.0.1:${provider.port}`, enabled: true, acknowledged: true, rateLimitPerSec: 50 });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    const test = await t.api("POST", `/api/search/providers/${add.body.id}/test`);
    expect(test.status).toBeLessThan(500);
    expect(hits.length).toBeGreaterThan(0); // the configured host itself is reached (it is the operator's choice) ...
    expect(canary.hits).toEqual([]); // ... but not anything it points to
  }, 120_000);

  it("the probe address must be http or https", async () => {
    const t = await startSourcesServer();
    for (const bad of ["ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)", "gopher://127.0.0.1:6379/_PING"]) {
      const r = await t.api("PATCH", "/api/settings", { offline: { probeUrl: bad } });
      expect(r.status, bad).toBe(400);
    }
    expect((await t.api("PATCH", "/api/settings", { offline: { probeUrl: "https://connectivity.example/ping" } })).status).toBe(200);
  });
});

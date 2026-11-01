import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFetcher, createSsrfGuard, FetchError, RobotsService, type Fetcher } from "../../../packages/fetch/src";
import { getJson, localServer, startFixtures, type Fixtures } from "./helpers";

let fx: Fixtures;
let fetcher: Fetcher;
const guard = () => createSsrfGuard({ allow: "127.0.0.1" });
const robotsHits = async (base: string) =>
  (await getJson<{ entries: { url: string }[] }>(`${base}/__log`)).entries.filter((e) => e.url.includes("robots.txt")).length;

beforeAll(async () => {
  fx = await startFixtures({ robotsTimeoutMs: 8000 });
  fetcher = createFetcher({ ssrf: guard(), timeouts: { headersMs: 600 } });
});
afterAll(async () => {
  await fetcher.close();
  await fx.close();
});

describe("robots fixture variants", () => {
  it("200: our UA group applies (specific group wins over *), Crawl-delay and sitemaps exposed", async () => {
    const base = fx.urls.robots!;
    const svc = new RobotsService({ fetcher });
    const ok = await svc.check(`${base}/public/page-1`);
    expect(ok).toMatchObject({ allowed: true, reason: "allowed", bypassed: false, crawlDelayMs: 1000, robotsStatus: 200, fromCache: false });
    expect(ok.sitemaps).toEqual([`${base}/sitemap.xml`]);
    expect((await svc.check(`${base}/noconbrain-blocked/page`)).allowed).toBe(false);
    // The `*` rules do not apply to a crawler that has its own group (RFC 9309 2.2.1).
    expect((await svc.check(`${base}/private/secret`)).allowed).toBe(true);
    expect((await svc.check(`${base}/allowed/page`)).allowed).toBe(true);
    expect((await svc.check(`${base}/robots.txt`)).allowed).toBe(true);
    expect((await svc.check(`${base}/noconbrain-blocked/page`)).reason).toBe("disallowed_by_rule");
  });

  it("200: wildcard group for another token (Disallow, Allow override, $ and * patterns)", async () => {
    const base = fx.urls.robots!;
    const svc = new RobotsService({ fetcher, userAgentToken: "SomeOtherBot" });
    expect((await svc.check(`${base}/private/secret`)).allowed).toBe(false);
    expect((await svc.check(`${base}/private/public-note`)).allowed).toBe(true);
    expect((await svc.check(`${base}/search?q=x`)).allowed).toBe(false);
    expect((await svc.check(`${base}/files/doc.pdf`)).allowed).toBe(false);
    expect((await svc.check(`${base}/tmp1/scratch/`)).allowed).toBe(false);
    expect((await svc.check(`${base}/public/page-1`)).allowed).toBe(true);
    expect((await svc.check(`${base}/public/page-1`)).crawlDelayMs).toBe(2000);
  });

  it("200: BadBot is disallowed everywhere; SlowBot's Crawl-delay 100 is capped at 30 s", async () => {
    const base = fx.urls.robots!;
    expect((await new RobotsService({ fetcher, userAgentToken: "BadBot" }).check(`${base}/public/page-1`)).allowed).toBe(false);
    expect((await new RobotsService({ fetcher, userAgentToken: "SlowBot" }).check(`${base}/public/page-1`)).crawlDelayMs).toBe(30_000);
    expect((await new RobotsService({ fetcher, userAgentToken: "noconbrain" }).check(`${base}/noconbrain-blocked/x`)).allowed).toBe(false);
  });

  it("404: allow all", async () => {
    const base = fx.urls.robots404!;
    const d = await new RobotsService({ fetcher }).check(`${base}/private/secret`);
    expect(d).toMatchObject({ allowed: true, reason: "robots_unavailable_allow", robotsStatus: 404, crawlDelayMs: null });
  });

  it("500: disallow all, retried after a short TTL", async () => {
    const base = fx.urls.robots500!;
    let now = 1_000_000;
    const svc = new RobotsService({ fetcher, now: () => now });
    const before = await robotsHits(base);
    const d = await svc.check(`${base}/public/page-1`);
    expect(d).toMatchObject({ allowed: false, reason: "robots_unreachable_disallow", robotsStatus: 500 });
    expect((await svc.check(`${base}/allowed/page`)).fromCache).toBe(true);
    expect(await robotsHits(base)).toBe(before + 1);
    now += 6 * 60_000;
    const again = await svc.check(`${base}/public/page-1`);
    expect(again.fromCache).toBe(false);
    expect(await robotsHits(base)).toBe(before + 2);
  });

  it("301 to /real-robots.txt is followed", async () => {
    const base = fx.urls.robotsRedirect!;
    const svc = new RobotsService({ fetcher });
    const d = await svc.check(`${base}/noconbrain-blocked/page`);
    expect(d).toMatchObject({ allowed: false, reason: "disallowed_by_rule", robotsStatus: 200, crawlDelayMs: 1000 });
    expect((await svc.check(`${base}/public/page-1`)).allowed).toBe(true);
  });

  it("timeout: temporarily disallow all", async () => {
    const base = fx.urls.robotsTimeout!;
    const t = Date.now();
    const d = await new RobotsService({ fetcher }).check(`${base}/public/page-1`);
    expect(d).toMatchObject({ allowed: false, reason: "robots_unreachable_disallow", robotsStatus: null });
    expect(Date.now() - t).toBeLessThan(3000);
  });
});

describe("per-save bypass", () => {
  it("allows but flags the override so the caller can log it", async () => {
    const base = fx.urls.robots!;
    const svc = new RobotsService({ fetcher });
    const d = await svc.check(`${base}/noconbrain-blocked/page`, { bypass: true });
    expect(d).toMatchObject({ allowed: true, bypassed: true, reason: "bypassed", wouldBlockReason: "disallowed_by_rule" });
    const free = await svc.check(`${base}/public/page-1`, { bypass: true });
    expect(free).toMatchObject({ allowed: true, bypassed: false, reason: "allowed" });
    const down = await new RobotsService({ fetcher }).check(`${fx.urls.robots500}/x`, { bypass: true });
    expect(down).toMatchObject({ allowed: true, bypassed: true, wouldBlockReason: "robots_unreachable_disallow" });
  });
});

describe("RFC 9309 behaviour on a scripted server", () => {
  const scripted = async (handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void) => localServer(handler);

  it("caches for 24 h and refetches after", async () => {
    const srv = await scripted((_q, res) => res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow: /x\n"));
    let now = 0;
    const svc = new RobotsService({ fetcher, now: () => now });
    await svc.check(`${srv.url}/a`);
    now = 23 * 3600_000;
    expect((await svc.check(`${srv.url}/a`)).fromCache).toBe(true);
    now = 24 * 3600_000 + 1;
    expect((await svc.check(`${srv.url}/a`)).fromCache).toBe(false);
    expect(srv.requests.filter((r) => r.url === "/robots.txt")).toHaveLength(2);
    await srv.close();
  });

  it("parses only the first 500 KiB", async () => {
    const pad = "# pad\n".repeat(Math.ceil((500 * 1024) / 6));
    const srv = await scripted((_q, res) => res.writeHead(200, { "content-type": "text/plain" }).end(`User-agent: *\nDisallow: /early\n${pad}Disallow: /late\n`));
    const svc = new RobotsService({ fetcher });
    expect((await svc.check(`${srv.url}/early`)).allowed).toBe(false);
    expect((await svc.check(`${srv.url}/late`)).allowed).toBe(true);
    await srv.close();
  });

  it("an endless robots.txt is truncated, not fatal", async () => {
    const srv = await scripted((_q, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("User-agent: *\nDisallow: /nope\n");
      const t = setInterval(() => res.write("# x".repeat(10_000) + "\n"), 1);
      res.on("close", () => clearInterval(t));
    });
    const svc = new RobotsService({ fetcher });
    expect((await svc.check(`${srv.url}/nope`)).allowed).toBe(false);
    await srv.close();
  });

  it("follows up to five redirects, even across hosts; treats more as unavailable", async () => {
    const target = await scripted((_q, res) => res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow: /\n"));
    // 5 hops: /robots.txt -> ?n=1 ... reaches target
    const five = new RobotsService({ fetcher: createFetcher({ ssrf: guard() }), });
    const viaFive = await scripted((req, res) => {
      const n = Number(new URL(req.url!, "http://x").searchParams.get("n") ?? 0);
      res.writeHead(302, { location: n >= 4 ? `${target.url}/robots.txt` : `/robots.txt?n=${n + 1}` }).end();
    });
    expect((await five.check(`${viaFive.url}/p`)).allowed).toBe(false);
    const viaSeven = await scripted((req, res) => {
      const n = Number(new URL(req.url!, "http://x").searchParams.get("n") ?? 0);
      res.writeHead(302, { location: n >= 6 ? `${target.url}/robots.txt` : `/robots.txt?n=${n + 1}` }).end();
    });
    const seven = await new RobotsService({ fetcher: createFetcher({ ssrf: guard() }) }).check(`${viaSeven.url}/p`);
    expect(seven).toMatchObject({ allowed: true, reason: "robots_unavailable_allow" });
    await Promise.all([target.close(), viaFive.close(), viaSeven.close()]);
  });

  it("keeps a good stale copy when the refetch fails (5xx), and treats 429 as temporary disallow", async () => {
    let mode: "ok" | "500" | "429" = "ok";
    const srv = await scripted((_q, res) => {
      if (mode === "ok") res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow: /x\n");
      else if (mode === "500") res.writeHead(503).end();
      else res.writeHead(429, { "retry-after": "60" }).end();
    });
    let now = 0;
    const svc = new RobotsService({ fetcher, now: () => now });
    expect((await svc.check(`${srv.url}/ok`)).allowed).toBe(true);
    mode = "500";
    now = 25 * 3600_000;
    const stale = await svc.check(`${srv.url}/ok`);
    expect(stale).toMatchObject({ allowed: true, stale: true });
    expect((await svc.check(`${srv.url}/x`)).allowed).toBe(false);
    const fresh = new RobotsService({ fetcher, now: () => now });
    mode = "429";
    expect(await fresh.check(`${srv.url}/ok`)).toMatchObject({ allowed: false, reason: "robots_unreachable_disallow" });
    await srv.close();
  });

  it("401 and 403 count as unavailable (allow all)", async () => {
    for (const code of [401, 403, 410]) {
      const srv = await scripted((_q, res) => res.writeHead(code).end());
      expect((await new RobotsService({ fetcher }).check(`${srv.url}/x`)).reason).toBe("robots_unavailable_allow");
      await srv.close();
    }
  });

  it("a robots.txt redirected to a private host is unreachable (SSRF guard applies)", async () => {
    const srv = await scripted((_q, res) => res.writeHead(302, { location: "http://169.254.169.254/robots.txt" }).end());
    const strict = createFetcher({ ssrf: createSsrfGuard({ allow: "127.0.0.1" }) });
    expect(await new RobotsService({ fetcher: strict }).check(`${srv.url}/x`)).toMatchObject({ allowed: false, reason: "robots_unreachable_disallow" });
    await strict.close();
    await srv.close();
  });

  it("concurrent checks share one fetch", async () => {
    const srv = await scripted((_q, res) => setTimeout(() => res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\n"), 100));
    const svc = new RobotsService({ fetcher });
    await Promise.all([1, 2, 3, 4].map((i) => svc.check(`${srv.url}/p${i}`)));
    expect(srv.requests).toHaveLength(1);
    await srv.close();
  });
});

describe("offline", () => {
  it("throws offline, makes no request and caches nothing", async () => {
    const srv = await localServer((_q, res) => res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow: /x\n"));
    let offline = true;
    const f = createFetcher({ ssrf: guard(), isOffline: () => offline });
    const svc = new RobotsService({ fetcher: f });
    const e = await svc.check(`${srv.url}/a`).catch((x) => x as FetchError);
    expect((e as FetchError).code).toBe("offline");
    expect(srv.requests).toHaveLength(0);
    offline = false;
    expect((await svc.check(`${srv.url}/x`)).allowed).toBe(false);
    await f.close();
    await srv.close();
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { createFetcher, createSsrfGuard, FetchError, buildUserAgent, type Fetcher } from "../../../packages/fetch/src";
import { getJson, localServer, startFixtures, type Fixtures } from "./helpers";

let fx: Fixtures;
let edge: string;
let fetcher: Fetcher;
const UA = buildUserAgent({ version: "9.9.9", contact: "ops@example.test" });

async function edgeLog() {
  return getJson<{ entries: { url: string; ua: string }[]; total: number }>(`${edge}/__log`);
}
async function control(q: string) {
  return getJson(`${edge}/__control?${q}`);
}
async function failure(p: Promise<unknown>): Promise<FetchError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(FetchError);
    return e as FetchError;
  }
  throw new Error("expected a FetchError");
}

beforeAll(async () => {
  fx = await startFixtures({ edgeSlowMs: 200 });
  edge = fx.urls.edge!;
  fetcher = createFetcher({ userAgent: UA, ssrf: createSsrfGuard({ allow: "127.0.0.1" }), maxBytes: 5 * 1024 * 1024 });
});
afterAll(async () => {
  await fetcher.close();
  await fx.close();
});

describe("basic fetch", () => {
  it("fetches a page and reports metadata", async () => {
    const r = await fetcher.fetch(`${edge}/final`);
    expect(r.status).toBe(200);
    expect(r.finalUrl).toBe(`${edge}/final`);
    expect(r.redirects).toEqual([]);
    expect(r.contentType).toBe("text/html");
    expect(r.charset).toBe("utf-8");
    expect(r.notModified).toBe(false);
    expect(Buffer.isBuffer(r.body)).toBe(true);
    expect((r.body as Buffer).toString()).toContain("Final destination");
    expect(r.bytes.decoded).toBe((r.body as Buffer).length);
    expect(r.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(r.timings.hops).toHaveLength(1);
  });
  it("sends the configured UA and no cookies, and drops set-cookie", async () => {
    const srv = await localServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html", "set-cookie": ["a=1; Path=/"] });
      res.end("<p>hi</p>");
    });
    try {
      const a = await fetcher.fetch(`${srv.url}/`);
      await fetcher.fetch(`${srv.url}/again`);
      expect(a.headers["set-cookie"]).toBeUndefined();
      for (const req of srv.requests) {
        expect(req.headers["user-agent"]).toBe(UA);
        expect(req.headers.cookie).toBeUndefined();
        expect(req.headers["accept-encoding"]).toBe("gzip, deflate, br");
      }
    } finally {
      await srv.close();
    }
  });
  it("records the UA in the fixture log", async () => {
    await fetcher.fetch(`${edge}/final`);
    const log = await edgeLog();
    expect(log.entries.at(-1)!.ua).toBe(UA);
  });
  it("returns error statuses as results", async () => {
    const r = await fetcher.fetch(`${edge}/status/404`);
    expect(r.status).toBe(404);
    const g = await fetcher.fetch(`${edge}/status/410`);
    expect(g.status).toBe(410);
  });
  it("handles chunked and empty bodies", async () => {
    const c = await fetcher.fetch(`${edge}/chunked`);
    expect((c.body as Buffer).toString()).toContain("the end");
    const s = await fetcher.fetch(`${edge}/chunked-slow`);
    expect((s.body as Buffer).toString()).toContain("part four");
    const e = await fetcher.fetch(`${edge}/empty`);
    expect(e.status).toBe(200);
    expect((e.body as Buffer).length).toBe(0);
  });
  it("supports HEAD", async () => {
    const r = await fetcher.fetch(`${edge}/final`, { method: "HEAD" });
    expect(r.status).toBe(200);
    expect((r.body as Buffer).length).toBe(0);
  });
  it("streams on request and keeps live byte counts", async () => {
    const r = await fetcher.fetch(`${edge}/chunked`, { bodyMode: "stream" });
    expect(r.body).toBeInstanceOf(Readable);
    let text = "";
    for await (const c of r.body as Readable) text += c.toString();
    expect(text).toContain("Chunked response");
    expect(r.bytes.decoded).toBe(Buffer.byteLength(text));
  });
  it("reports a reset connection as a network error", async () => {
    expect((await failure(fetcher.fetch(`${edge}/reset`))).code).toBe("network");
  });
  it("rejects invalid input", async () => {
    expect((await failure(fetcher.fetch("not a url"))).code).toBe("ssrf_blocked");
  });
});

describe("redirects", () => {
  it("follows up to five hops and records them", async () => {
    const r = await fetcher.fetch(`${edge}/redirect/chain/5`);
    expect(r.status).toBe(200);
    expect(r.redirects).toHaveLength(5);
    expect([301, 302, 307, 308]).toContain(r.redirects[0]!.status);
    expect(r.finalUrl).toBe(`${edge}/final`);
    expect(r.timings.hops).toHaveLength(6);
  });
  it("stops after more than five", async () => {
    const e = await failure(fetcher.fetch(`${edge}/redirect/chain/6`));
    expect(e.code).toBe("too_many_redirects");
    expect(e.redirects).toHaveLength(5);
  });
  it("detects loops", async () => {
    expect((await failure(fetcher.fetch(`${edge}/redirect/loop-a`))).code).toBe("redirect_loop");
    expect((await failure(fetcher.fetch(`${fx.urls.trap}/redirect/self`))).code).toBe("redirect_loop");
  });
  it("handles every status code, relative and missing Location", async () => {
    for (const code of [301, 302, 303, 307, 308]) expect((await fetcher.fetch(`${edge}/redirect/${code}`)).finalUrl).toBe(`${edge}/final`);
    // the fixture sends `Location: final`, which resolves against /redirect/ to /redirect/final
    expect((await fetcher.fetch(`${edge}/redirect/relative`)).finalUrl).toBe(`${edge}/redirect/final`);
    expect((await failure(fetcher.fetch(`${edge}/redirect/no-location`))).code).toBe("bad_redirect");
  });
  it("runs hooks per hop and lets them abort", async () => {
    const seen: string[] = [];
    await fetcher.fetch(`${edge}/redirect/chain/2`, { hooks: { beforeHop: (i) => void seen.push(`${i.hop}:${i.host}`) } });
    expect(seen).toHaveLength(3);
    const e = await failure(fetcher.fetch(`${edge}/redirect/chain/2`, { hooks: { beforeHop: (i) => { if (i.hop === 1) throw new FetchError("aborted", "politeness"); } } }));
    expect(e.message).toBe("politeness");
  });
});

describe("size caps and encodings", () => {
  it("stops a 100 MiB gzip bomb at the decoded cap", async () => {
    const t = Date.now();
    const e = await failure(fetcher.fetch(`${edge}/bomb.gz?mb=100`, { maxBytes: 1024 * 1024 }));
    expect(e.code).toBe("size_cap");
    expect(Date.now() - t).toBeLessThan(5000);
  });
  it("stops a deflate bomb", async () => {
    expect((await failure(fetcher.fetch(`${edge}/bomb.deflate`, { maxBytes: 1024 * 1024 }))).code).toBe("size_cap");
  });
  it("decodes a legitimate gzip body under the cap", async () => {
    const r = await fetcher.fetch(`${edge}/bomb.gz?mb=1`, { maxBytes: 2 * 1024 * 1024 });
    expect((r.body as Buffer).length).toBe(1024 * 1024);
    expect(r.bytes.wire).toBeLessThan(10_000);
  });
  it("rejects too many nested encodings, accepts two", async () => {
    expect((await failure(fetcher.fetch(`${edge}/bomb-layers?n=7`))).code).toBe("too_many_encodings");
    const ok = await fetcher.fetch(`${edge}/bomb-layers?n=2`);
    expect((ok.body as Buffer).length).toBe(1024 * 1024);
  });
  it("pre-checks Content-Length without reading", async () => {
    const t = Date.now();
    expect((await failure(fetcher.fetch(`${edge}/huge-length`))).code).toBe("content_length_exceeded");
    expect((await failure(fetcher.fetch(`${edge}/huge?bytes=2000000`, { maxBytes: 1_000_000 }))).code).toBe("content_length_exceeded");
    expect(Date.now() - t).toBeLessThan(3000);
  });
  it("caps an endless body without Content-Length", async () => {
    const e = await failure(fetcher.fetch(`${edge}/huge`, { maxBytes: 256 * 1024 }));
    expect(e.code).toBe("size_cap");
  });
  it("truncates instead of failing when asked", async () => {
    const r = await fetcher.fetch(`${edge}/huge`, { maxBytes: 100_000, truncateAtCap: true });
    expect(r.truncated).toBe(true);
    expect((r.body as Buffer).length).toBe(100_000);
    const d = await fetcher.fetch(`${edge}/bomb.gz?mb=50`, { maxBytes: 100_000, truncateAtCap: true });
    expect(d.truncated).toBe(true);
    expect((d.body as Buffer).length).toBe(100_000);
  });
});

describe("content types", () => {
  const cases: [string, string, string][] = [
    ["html-as-plain", "text/html", "text/plain"],
    ["html-as-image", "text/html", "image/png"],
    ["png-as-html", "image/png", "text/html"],
    ["octet-html", "text/html", "application/octet-stream"],
    ["pdf-as-html", "application/pdf", "text/html"],
    ["json-as-html", "application/json", "text/html"],
    ["no-type", "text/html", ""],
  ];
  for (const [name, effective, declared] of cases) {
    it(`sniffed type beats header: ${name}`, async () => {
      const r = await fetcher.fetch(`${edge}/type/${name}`);
      expect(r.contentType).toBe(effective);
      expect(r.declaredContentType ?? "").toBe(declared);
    });
  }
  it("blocks types outside the request allowlist before returning a body", async () => {
    const e = await failure(fetcher.fetch(`${edge}/type/png-as-html`, { accept: ["text/html"] }));
    expect(e.code).toBe("content_type_blocked");
    const strict = createFetcher({ ssrf: createSsrfGuard({ allow: "127.0.0.1" }), allowedTypes: ["text/html"] });
    expect((await failure(strict.fetch(`${edge}/type/pdf-as-html`))).code).toBe("content_type_blocked");
    await strict.close();
  });
});

describe("charset", () => {
  it("uses the header", async () => {
    const r = await fetcher.fetch(`${edge}/charset/latin1`);
    expect(r.charset).toBe("windows-1252");
    expect(r.charsetSource).toBe("header");
  });
  it("uses the meta tag", async () => {
    const r = await fetcher.fetch(`${edge}/charset/meta-latin1`);
    expect(r.charset).toBe("windows-1252");
    expect(r.charsetSource).toBe("meta");
  });
  it("uses the BOM", async () => {
    const r = await fetcher.fetch(`${edge}/charset/utf8-bom`);
    expect(r.charset).toBe("utf-8");
    expect(r.charsetSource).toBe("bom");
  });
});

describe("conditional requests", () => {
  it("returns notModified on matching validators", async () => {
    await control("reset=1");
    const first = await fetcher.fetch(`${edge}/cond/doc`);
    const etag = first.headers.etag!;
    const lm = first.headers["last-modified"]!;
    expect(etag).toBeTruthy();
    const second = await fetcher.fetch(`${edge}/cond/doc`, { conditional: { etag, lastModified: lm } });
    expect(second.status).toBe(304);
    expect(second.notModified).toBe(true);
    expect((second.body as Buffer).length).toBe(0);
    const byEtag = await fetcher.fetch(`${edge}/cond/etag-only`, { conditional: { etag: (await fetcher.fetch(`${edge}/cond/etag-only`)).headers.etag } });
    expect(byEtag.notModified).toBe(true);
    const lastMod = await fetcher.fetch(`${edge}/cond/lastmod-only`);
    const byLm = await fetcher.fetch(`${edge}/cond/lastmod-only`, { conditional: { lastModified: lastMod.headers["last-modified"] } });
    expect(byLm.notModified).toBe(true);
    const weak = await fetcher.fetch(`${edge}/cond/weak`);
    expect((await fetcher.fetch(`${edge}/cond/weak`, { conditional: { etag: weak.headers.etag } })).notModified).toBe(true);
  });
  it("returns the new body when content changed", async () => {
    await control("reset=1");
    const first = await fetcher.fetch(`${edge}/cond/doc`);
    await control("cond_version=2");
    const r = await fetcher.fetch(`${edge}/cond/doc`, { conditional: { etag: first.headers.etag, lastModified: first.headers["last-modified"] } });
    expect(r.status).toBe(200);
    expect(r.notModified).toBe(false);
    expect(r.headers.etag).not.toBe(first.headers.etag);
    await control("reset=1");
  });
  it("same body with a new etag is a 200", async () => {
    await control("reset=1");
    const first = await fetcher.fetch(`${edge}/cond/doc`);
    await control("etag_salt=zz");
    const r = await fetcher.fetch(`${edge}/cond/doc`, { conditional: { etag: first.headers.etag } });
    expect(r.status).toBe(200);
    await control("reset=1");
  });
  it("surfaces a gone page", async () => {
    await control("gone=1");
    expect((await fetcher.fetch(`${edge}/cond/gone`)).status).toBe(404);
    await control("reset=1");
  });
});

describe("rate limits", () => {
  it("throws rate_limited with retryAfterMs (seconds form)", async () => {
    const e = await failure(fetcher.fetch(`${edge}/429?after=2`));
    expect(e.code).toBe("rate_limited");
    expect(e.retryAfterMs).toBe(2000);
    expect(e.status).toBe(429);
  });
  it("parses the HTTP-date form", async () => {
    const e = await failure(fetcher.fetch(`${edge}/429?after=30&date=1`));
    expect(e.retryAfterMs).toBeGreaterThan(25_000);
    expect(e.retryAfterMs).toBeLessThanOrEqual(30_000);
  });
  it("succeeds after a one-off 429", async () => {
    await control("reset=1");
    await failure(fetcher.fetch(`${edge}/429/once?key=k1`));
    expect((await fetcher.fetch(`${edge}/429/once?key=k1`)).status).toBe(200);
  });
  it("exposes Retry-After on a 503 result and reports it to hooks", async () => {
    await control("reset=1");
    let hooked: number | undefined;
    const r = await fetcher.fetch(`${edge}/flaky/t1?fail=2&after=3`, { hooks: { afterHop: (i) => { hooked = i.retryAfterMs; } } });
    expect(r.status).toBe(503);
    expect(r.retryAfterMs).toBe(3000);
    expect(hooked).toBe(3000);
  });
});

describe("timeouts and abort", () => {
  it("headers timeout", async () => {
    expect((await failure(fetcher.fetch(`${edge}/delay/2000`, { timeouts: { headersMs: 300 } }))).code).toBe("timeout_headers");
    expect((await failure(fetcher.fetch(`${edge}/hang`, { timeouts: { headersMs: 300 } }))).code).toBe("timeout_headers");
  });
  it("body idle timeout", async () => {
    expect((await failure(fetcher.fetch(`${edge}/slow-body?ms=1500&chunks=3`, { timeouts: { bodyMs: 300 } }))).code).toBe("timeout_body");
  });
  it("wall-clock timeout", async () => {
    expect((await failure(fetcher.fetch(`${edge}/slow-body?ms=200&chunks=20`, { timeouts: { totalMs: 600 } }))).code).toBe("timeout_total");
    expect((await failure(fetcher.fetch(`${edge}/delay/3000`, { timeouts: { totalMs: 300 } }))).code).toBe("timeout_total");
  });
  it("caller abort", async () => {
    const ac = new AbortController();
    const p = fetcher.fetch(`${edge}/delay/3000`, { signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    expect((await failure(p)).code).toBe("aborted");
    expect((await failure(fetcher.fetch(`${edge}/final`, { signal: AbortSignal.abort() }))).code).toBe("aborted");
  });
});

describe("offline", () => {
  it("makes no request when forced offline", async () => {
    const before = (await edgeLog()).total;
    let offline = true;
    const f = createFetcher({ ssrf: createSsrfGuard({ allow: "127.0.0.1" }), isOffline: () => offline });
    const e = await failure(f.fetch(`${edge}/final`));
    expect(e.code).toBe("offline");
    expect((await edgeLog()).total).toBe(before);
    offline = false;
    expect((await f.fetch(`${edge}/final`)).status).toBe(200);
    await f.close();
  });
  it("stops mid-redirect when offline flips on", async () => {
    let calls = 0;
    const f = createFetcher({ ssrf: createSsrfGuard({ allow: "127.0.0.1" }), isOffline: () => ++calls > 2 });
    expect((await failure(f.fetch(`${edge}/redirect/chain/3`))).code).toBe("offline");
    await f.close();
  });
});

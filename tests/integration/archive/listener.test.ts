import net from "node:net";
import { describe, expect, it } from "vitest";
import { MemoryCaptureStore } from "@ncb/server";
import { startListener, type Harness } from "./helpers.js";

const PAGE = "https://site.example/a/page";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const VIDEO = Buffer.alloc(1000, 1);

function buildStore(): MemoryCaptureStore {
  const store = new MemoryCaptureStore();
  store
    .addVersion({
      versionId: "ver_a", pageId: "pg_a", url: PAGE,
      html: `<!doctype html><html><head><title>Page A</title><link rel=stylesheet href="/s.css"><script>window.pwned=1</script></head>
<body onload="alert(1)"><h1>Hello</h1>
<a id=c href="/b">cached</a> <a id=p href="/partial">partial</a> <a id=q href="/queued">queued</a>
<a id=l href="https://other.example/x#frag">live</a> <a id=u href="/gone">gone</a> <a id=m href="mailto:a@b.c">mail</a> <a id=j href="javascript:alert(1)">js</a>
<a id=s href="#section">self</a> <a id=z href="https://en.wikipedia.org/wiki/Cat">zim</a>
<img id=i src="/i.png"><img id=x src="/missing.png"><video id=v src="/v.mp4" controls></video>
<form action="https://evil.example/post"><input name=q></form></body></html>`,
      reader: { title: "Reader A", html: `<p>Reader text <a href="/b">link</a></p><script>alert(1)</script>` },
      resources: [
        { url: "https://site.example/s.css", assetKey: "s1", contentType: "text/css", body: `@import url(/imp.css);@font-face{font-family:f;src:url(/f.woff2)}body{background:url(/i.png),url(/nope.png)}` },
        { url: "https://site.example/imp.css", assetKey: "s2", contentType: "text/css; charset=utf-8", body: `p{color:red}` },
        { url: "https://site.example/f.woff2", assetKey: "f1", contentType: "font/woff2", body: "wOF2fake" },
        { url: "https://site.example/i.png", assetKey: "i1", contentType: "image/png", body: PNG },
        { url: "https://site.example/v.mp4", assetKey: "v1", contentType: "video/mp4", body: VIDEO },
        { url: "https://site.example/ev.svg", assetKey: "g1", contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><rect width="1" height="1"/></svg>` },
        { url: "https://site.example/evil.html", assetKey: "h1", contentType: "text/html", body: "<script>alert(1)</script>" },
      ],
    })
    .addVersion({ versionId: "ver_b", pageId: "pg_b", url: "https://site.example/b", html: "<html><body><p>B</p></body></html>" })
    .addVersion({ versionId: "ver_p", pageId: "pg_p", url: "https://site.example/partial", html: "<html><body><p>Partial</p></body></html>", status: "partial", missingResources: 3 })
    .setLink("https://site.example/b", { kind: "page", pageId: "pg_b", status: "ready" })
    .setLink("https://site.example/partial", { kind: "page", pageId: "pg_p", status: "partial" })
    .setLink("https://site.example/queued", { kind: "queued" })
    .setLink("https://site.example/gone", { kind: "unavailable" })
    .setLink("https://en.wikipedia.org/wiki/Cat", { kind: "zim", zimId: "wiki", path: "Cat" })
    .setZimEntry("wiki", "Cat", { contentType: "text/html", body: Buffer.from(`<html><body><script>alert(1)</script><p>Cat</p><a href="Dog">dog</a><a href="https://x.example/">x</a><img src="I/cat.jpg"></body></html>`) })
    .setZimEntry("wiki", "I/cat.jpg", { contentType: "image/jpeg", body: Buffer.from("jpeg") })
    .setZimEntry("wiki", "Old", { contentType: "text/html", body: Buffer.alloc(0), redirectTo: "Cat" });
  return store;
}

const STANDARD = ["content-security-policy", "x-content-type-options", "referrer-policy", "cache-control"];
function expectStandardHeaders(r: Response, popups = false): void {
  const csp = r.headers.get("content-security-policy")!;
  expect(csp).toMatch(popups ? /^sandbox allow-popups allow-popups-to-escape-sandbox;/ : /^sandbox; default-src 'none'/);
  if (!popups) expect(csp).not.toContain("allow-");
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain("form-action 'none'");
  expect(csp).toContain("base-uri 'none'");
  expect(csp).toMatch(/frame-ancestors http:\/\/localhost:3000(;|$)/);
  expect(csp).toContain("default-src 'none'");
  for (const h of STANDARD) expect(r.headers.get(h), h).toBeTruthy();
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  expect(r.headers.get("set-cookie")).toBeNull();
  expect(r.headers.get("cookie")).toBeNull();
}

describe("archive listener routes", () => {
  let h: Harness;
  const setup = async (opts: Parameters<typeof startListener>[0] = {}) => (h = await startListener({ store: buildStore(), ...opts }));
  const text = async (p: string, init?: RequestInit) => (await h.get(h.url(p).replace(h.origin, ""), init)).text();

  it("rewrites a document: link states, resources, no script, banner absent for ready pages", async () => {
    await setup();
    const r = await h.get(h.url("/p/pg_a").replace(h.origin, ""));
    expect(r.status).toBe(200);
    expectStandardHeaders(r);
    expect(r.headers.get("content-type")).toMatch(/^text\/html/);
    const html = await r.text();
    expect(html).not.toMatch(/<script|onload|javascript:|alert\(|evil\.example|<base/i);
    expect(html).toMatch(/<a id="c" href="\/a\/[^"]+\/p\/pg_b" data-ncb-link="cached">/);
    expect(html).toMatch(/<a id="p" href="\/a\/[^"]+\/p\/pg_p" data-ncb-link="partial">/);
    expect(html).toMatch(/<a id="q" href="\/a\/[^"]+\/m\?u=https%3A%2F%2Fsite\.example%2Fqueued&amp;from=ver_a" data-ncb-link="queued">/);
    expect(html).toMatch(/<a id="l" href="\/a\/[^"]+\/m\?u=https%3A%2F%2Fother\.example%2Fx&amp;from=ver_a" data-ncb-link="live-only">/);
    expect(html).toMatch(/<a id="u" href="[^"]+" data-ncb-link="unavailable">/);
    expect(html).toContain('<a id="m" data-ncb-link="unsupported">');
    expect(html).toContain('<a id="j" data-ncb-link="unsupported">');
    expect(html).toContain('<a id="s" href="#section">');
    expect(html).toMatch(/<a id="z" href="\/a\/[^"]+\/z\/wiki\/Cat" data-ncb-link="cached">/);
    expect(html).toMatch(/<img id="i" src="\/a\/[^"]+\/v\/ver_a\/r\/i1">/);
    expect(html).toMatch(/<img id="x" src="data:image\/gif;base64,/);
    expect(html).toMatch(/<link rel="stylesheet" href="\/a\/[^"]+\/v\/ver_a\/r\/s1">/);
    expect(html).toMatch(/<video id="v" src="\/a\/[^"]+\/v\/ver_a\/r\/v1" controls="">/);
    expect(html).toContain("a[data-ncb-link=live-only]"); // legend
    expect(html).not.toContain("ncb-partial-banner");
    expect(html).not.toContain("<form action");
  });

  it("hides the link-state legend when the setting is off", async () => {
    await setup({ showLinkStates: () => false });
    expect(await text("/p/pg_a")).not.toContain("a[data-ncb-link=live-only]");
  });

  it("shows the partial banner for partial versions, via p and v", async () => {
    await setup();
    for (const p of ["/p/pg_p", "/v/ver_p"]) {
      const html = await text(p);
      expect(html).toContain("ncb-partial-banner");
      expect(html).toContain("3 files were not saved");
      expect(html).toContain("Download the rest");
    }
  });

  it("serves the reader view with preferences as CSS variables", async () => {
    await setup();
    const html = await text("/p/pg_a/reader?theme=dark&font=serif&size=5&width=narrow&evil=1");
    expect(html).toContain("Reader A");
    expect(html).toContain("--r-size:1.5rem");
    expect(html).toContain("--r-width:52ch");
    expect(html).toContain("Georgia");
    expect(html).toContain("--r-bg:#18181b");
    expect(html).not.toMatch(/<script|alert/);
    expect(html).toMatch(/Reader text <a href="\/a\/[^"]+\/p\/pg_b" data-ncb-link="cached">/);
    const bad = await text("/v/ver_a/reader?size=99&font=<script>");
    expect(bad).toContain("--r-size:1.125rem");
    expect((await h.get(h.url("/v/ver_b/reader").replace(h.origin, ""))).status).toBe(404);
  });

  it("serves the interstitial with popup flags only on /m", async () => {
    await setup();
    const u = encodeURIComponent("https://other.example/x?q=1");
    const r = await h.get(h.url(`/m?u=${u}&from=ver_a`).replace(h.origin, ""));
    expect(r.status).toBe(200);
    expectStandardHeaders(r, true);
    const html = await r.text();
    expect(html).toContain("https://other.example/x?q=1");
    expect(html).toContain("Open live in new tab");
    expect(html).toContain("Queue for download");
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toMatch(/href="\/a\/[^"]+\/v\/ver_a"/);
    // Other classes never get the flags.
    expectStandardHeaders(await h.get(h.url("/p/pg_a").replace(h.origin, "")));
  });

  it("disables the live action offline and says so", async () => {
    await setup();
    h.store.online = "offline";
    const html = await text(`/m?u=${encodeURIComponent("https://other.example/x")}`);
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("offline");
    expect(html).not.toMatch(/<a class="ncb-btn" href="https:\/\/other\.example/);
  });

  it("interstitial states: queued, unavailable, unsupported; and redirects when the page is now cached", async () => {
    await setup();
    expect(await text(`/m?u=${encodeURIComponent("https://site.example/queued")}`)).toContain("waiting in the download queue");
    expect(await text(`/m?u=${encodeURIComponent("https://site.example/gone")}`)).toContain("cannot be fetched");
    expect(await text(`/m?u=${encodeURIComponent("javascript:alert(1)")}`)).not.toMatch(/href="javascript/);
    const r = await h.get(h.url(`/m?u=${encodeURIComponent("https://site.example/b")}`).replace(h.origin, ""));
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toMatch(/^\/a\/[^/]+\/p\/pg_b$/);
    expectStandardHeaders(r, false);
    expect((await h.get(h.url("/m").replace(h.origin, ""))).status).toBe(400);
  });

  it("rewrites CSS and svg sub-resources and forces download for active types", async () => {
    await setup();
    const css = await text("/v/ver_a/r/s1");
    expect(css).toMatch(/@import url\(\/a\/[^)]+\/v\/ver_a\/r\/s2\)/);
    expect(css).toMatch(/src:url\(\/a\/[^)]+\/r\/f1\)/);
    expect(css).toMatch(/background:url\(\/a\/[^)]+\/r\/i1\)/);
    expect(css).not.toContain("nope");
    const cssRes = await h.get(h.url("/v/ver_a/r/s1").replace(h.origin, ""));
    expect(cssRes.headers.get("content-type")).toMatch(/^text\/css/);
    expect(cssRes.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    const svg = await text("/v/ver_a/r/g1");
    expect(svg).toContain("<rect");
    expect(svg).not.toMatch(/script|onload/);
    const font = await h.get(h.url("/v/ver_a/r/f1").replace(h.origin, ""));
    expect(font.headers.get("access-control-allow-origin")).toBe("*");
    const html = await h.get(h.url("/v/ver_a/r/h1").replace(h.origin, ""));
    expect(html.headers.get("content-type")).toBe("application/octet-stream");
    expect(html.headers.get("content-disposition")).toBe("attachment");
    expectStandardHeaders(html);
    const png = await h.get(h.url("/v/ver_a/r/i1").replace(h.origin, ""));
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(png.headers.get("etag")).toMatch(/-r1"$/);
    expect(Buffer.from(await png.arrayBuffer()).equals(PNG)).toBe(true);
    const again = await h.get(h.url("/v/ver_a/r/i1").replace(h.origin, ""), { headers: { "if-none-match": png.headers.get("etag")! } });
    expect(again.status).toBe(304);
    expectStandardHeaders(again);
  });

  it("supports byte ranges on media, HEAD, and rejects bad ranges", async () => {
    await setup();
    const p = h.url("/v/ver_a/r/v1").replace(h.origin, "");
    const full = await h.get(p);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("content-length")).toBe("1000");
    const part = await h.get(p, { headers: { range: "bytes=10-19" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 10-19/1000");
    expect((await part.arrayBuffer()).byteLength).toBe(10);
    expectStandardHeaders(part);
    const suffix = await h.get(p, { headers: { range: "bytes=-100" } });
    expect(suffix.headers.get("content-range")).toBe("bytes 900-999/1000");
    const open = await h.get(p, { headers: { range: "bytes=990-" } });
    expect((await open.arrayBuffer()).byteLength).toBe(10);
    const bad = await h.get(p, { headers: { range: "bytes=5000-6000" } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe("bytes */1000");
    expectStandardHeaders(bad);
    const head = await h.get(p, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("1000");
    expect(await head.text()).toBe("");
  });

  it("404s an asset the version does not reference, and unknown versions", async () => {
    await setup();
    for (const p of ["/v/ver_b/r/i1", "/v/ver_a/r/zz", "/v/nope/r/i1", "/v/ver_a/r/i1/extra", "/p/nope"]) {
      const r = await h.get(h.url(p).replace(h.origin, ""));
      expect(r.status, p).toBe(404);
      expectStandardHeaders(r);
    }
  });

  it("serves ZIM entries sanitised, follows redirects and rewrites links", async () => {
    await setup();
    const r = await h.get(h.url("/z/wiki/Cat").replace(h.origin, ""));
    expect(r.status).toBe(200);
    expectStandardHeaders(r);
    const html = await r.text();
    expect(html).not.toContain("<script");
    expect(html).toMatch(/<a href="\/a\/[^"]+\/z\/wiki\/Dog" data-ncb-link="cached">/);
    expect(html).toMatch(/<img src="\/a\/[^"]+\/z\/wiki\/I\/cat\.jpg">/);
    expect(html).toContain("/m?u=https%3A%2F%2Fx.example%2F");
    const red = await h.get(h.url("/z/wiki/Old").replace(h.origin, ""));
    expect(red.status).toBe(302);
    expect(red.headers.get("location")).toMatch(/\/z\/wiki\/Cat$/);
    expectStandardHeaders(red);
    const img = await h.get(h.url("/z/wiki/I/cat.jpg").replace(h.origin, ""));
    expect(img.headers.get("content-type")).toBe("image/jpeg");
    expect((await h.get(h.url("/z/wiki/Missing").replace(h.origin, ""))).status).toBe(404);
  });

  it("serves listener static assets under _", async () => {
    await setup();
    for (const n of ["ui.css", "links.css", "reader.css?size=5"]) {
      const r = await h.get(h.url(`/_/${n}`).replace(h.origin, ""));
      expect(r.status, n).toBe(200);
      expect(r.headers.get("content-type")).toMatch(/^text\/css/);
      expectStandardHeaders(r);
    }
    expect((await h.get(h.url("/_/nothing.css").replace(h.origin, ""))).status).toBe(404);
  });

  it("answers /healthz without a token", async () => {
    await setup();
    const r = await h.get("/healthz");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("ok\n");
    expectStandardHeaders(r);
  });

  it("batches last_accessed_at updates", async () => {
    await setup();
    for (let i = 0; i < 5; i++) await h.get(h.url("/p/pg_a").replace(h.origin, ""));
    await h.get(h.url("/v/ver_b").replace(h.origin, ""));
    expect(h.store.touched).toHaveLength(0);
    await h.listener.flush();
    expect(h.store.touched).toHaveLength(1);
    expect(h.store.touched[0]!.ids.sort()).toEqual(["ver_a", "ver_b"]);
    expect(h.store.touched[0]!.at).toBe(h.clock.now());
  });
});

describe("archive listener headers and tokens", () => {
  let h: Harness;

  it("has the full header set on every route class, error page and status", async () => {
    h = await startListener({ store: buildStore() });
    const u = (p: string) => h.url(p).replace(h.origin, "");
    const cases: [string, string, number, boolean?][] = [
      ["p", u("/p/pg_a"), 200], ["p reader", u("/p/pg_a/reader"), 200], ["v", u("/v/ver_a"), 200], ["v reader", u("/v/ver_a/reader"), 200],
      ["r", u("/v/ver_a/r/i1"), 200], ["r css", u("/v/ver_a/r/s1"), 200], ["m", u("/m?u=https%3A%2F%2Fo.example%2F"), 200, true],
      ["m bad", u("/m"), 400, true], ["z", u("/z/wiki/Cat"), 200], ["z missing", u("/z/wiki/Nope"), 404], ["_", u("/_/ui.css"), 200],
      ["healthz", "/healthz", 200], ["__health", "/__health", 200],
      ["404 root", "/", 404], ["404 api", "/api/system/health", 404], ["404 unknown class", u("/q/x"), 404], ["404 page", u("/p/none"), 404],
      ["404 bad id", u("/p/%20bad"), 404], ["401 junk token", "/a/not-a-token/p/pg_a", 401], ["401 no token", "/a/", 401],
      ["401 tampered", u("/p/pg_a").replace(/\.[\w-]+\/p\//, ".AAAA/p/"), 401], ["400 bad escape", u("/p/%zz"), 400],
    ];
    for (const [name, path, status, popups] of cases) {
      const r = await h.get(path, { headers: { cookie: "ncb_session=SECRET", "x-nocon-csrf": "1" } });
      expect(r.status, name).toBe(status);
      expectStandardHeaders(r, popups ?? false);
      await r.arrayBuffer();
    }
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const r = await h.get(u("/p/pg_a"), { method, body: method === "POST" || method === "PUT" || method === "PATCH" ? "x" : undefined });
      expect(r.status, method).toBe(405);
      expect(r.headers.get("allow")).toBe("GET, HEAD");
      expectStandardHeaders(r);
    }
  });

  it("uses the token's app origin for frame-ancestors", async () => {
    h = await startListener({ store: buildStore() });
    const t = h.tokens.mint({ userId: "u", frameId: "f", appOrigin: "https://brain.home.arpa:8443" });
    const r = await h.get(`/a/${t}/p/pg_a`);
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors https://brain.home.arpa:8443");
  });

  it("answers malformed HTTP with the same headers", async () => {
    h = await startListener();
    const raw = await new Promise<string>((resolve) => {
      const s = net.connect(h.port, "127.0.0.1", () => s.write("NOT HTTP AT ALL\r\n\r\n"));
      let buf = "";
      s.on("data", (d) => (buf += d));
      s.on("close", () => resolve(buf));
    });
    expect(raw).toMatch(/^HTTP\/1\.1 400/);
    expect(raw.toLowerCase()).toContain("content-security-policy: sandbox;");
    expect(raw.toLowerCase()).toContain("x-content-type-options: nosniff");
    expect(raw.toLowerCase()).not.toContain("set-cookie");
  });

  it("ignores cookies completely: same bytes with and without a Cookie header, never a Set-Cookie", async () => {
    h = await startListener({ store: buildStore() });
    const p = h.url("/p/pg_a").replace(h.origin, "");
    const a = await h.get(p);
    const b = await h.get(p, { headers: { cookie: "ncb_session=abc; other=1" } });
    expect(await a.text()).toBe(await b.text());
    expect(b.headers.get("set-cookie")).toBeNull();
  });

  it("returns the 401 page for tampered, expired and malformed tokens", async () => {
    h = await startListener({ store: buildStore() });
    const good = h.mint();
    expect((await h.get(`/a/${good}/p/pg_a`)).status).toBe(200);
    const [v, pl, sig] = good.split(".");
    const forged = Buffer.from(JSON.stringify({ u: "u1", f: "fr_test", e: 9_999_999_999, o: "http://evil.example" })).toString("base64url");
    for (const t of [`${v}.${forged}.${sig}`, `${v}.${pl}.${sig!.slice(1)}x`, "x.y.z", "v1..", "v1.a.b.c"]) {
      const r = await h.get(`/a/${t}/p/pg_a`);
      expect(r.status, t).toBe(401);
      expectStandardHeaders(r);
      const body = await r.text();
      expect(body).toContain("expired or is not valid");
      expect(body).not.toContain("pg_a");
    }
    h.clock.advance(8 * 3600 * 1000 + 1000);
    const late = await h.get(`/a/${good}/p/pg_a`);
    expect(late.status).toBe(401);
    expectStandardHeaders(late);
    // A fresh token minted after the jump works.
    expect((await h.get(`/a/${h.mint()}/p/pg_a`)).status).toBe(200);
  });

  it("returns 401 for every route class when the token is bad", async () => {
    h = await startListener({ store: buildStore() });
    for (const p of ["p/pg_a", "v/ver_a", "v/ver_a/r/i1", "m?u=https%3A%2F%2Fx.example", "z/wiki/Cat", "_/ui.css"]) {
      expect((await h.get(`/a/bad/${p}`)).status, p).toBe(401);
    }
  });

  it("rejects tokens signed with another key (rotation)", async () => {
    h = await startListener({ store: buildStore() });
    const other = await startListener({ store: buildStore() });
    other.tokens.mint({ userId: "x", frameId: "y", appOrigin: "http://localhost:3000" });
    const { ArchiveTokenService } = await import("@ncb/server");
    const foreign = new ArchiveTokenService({ secret: Buffer.alloc(32, 99), clock: h.clock }).mint({ userId: "u", frameId: "f", appOrigin: "http://localhost:3000" });
    expect((await h.get(`/a/${foreign}/p/pg_a`)).status).toBe(401);
  });

  it("records the last top-level document per frame id, only for iframe or document navigations", async () => {
    h = await startListener({ store: buildStore() });
    const t1 = h.mint("fr_1");
    const t2 = h.mint("fr_2");
    await h.get(`/a/${t1}/p/pg_a`, { headers: { "sec-fetch-dest": "iframe" } });
    await h.get(`/a/${t2}/v/ver_p`, { headers: { "sec-fetch-dest": "document" } });
    await h.get(`/a/${t1}/p/pg_b`, { headers: { "sec-fetch-dest": "image" } });
    await h.get(`/a/${t1}/v/ver_a/r/i1`, { headers: { "sec-fetch-dest": "iframe" } });
    expect(h.listener.frames.get("fr_1")).toMatchObject({ pageId: "pg_a", versionId: "ver_a", title: "Page A", state: "ready", url: PAGE });
    expect(h.listener.frames.get("fr_2")).toMatchObject({ pageId: "pg_p", state: "partial" });
    expect(h.listener.frames.get("fr_3")).toBeUndefined();
    // Wrong frame: a token for fr_1 is not accepted where fr_2 is required.
    expect(h.tokens.verify(t1, { frameId: "fr_2" })).toEqual({ ok: false, reason: "wrong-frame" });
  });

  it("works with the default empty store and no tokens attached (everything 401/404 with headers)", async () => {
    const { createArchiveServer } = await import("@ncb/server");
    const server = createArchiveServer({ appUrl: "http://localhost:3000" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/a/token/p/pg_1`);
      expect(r.status).toBe(401);
      expectStandardHeaders(r);
    } finally {
      server.close();
    }
  });
});

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MemoryCaptureStore, type PageAttribution } from "@ncb/server";
import { ArchiveTokenService } from "@ncb/server";
import { corpus } from "../../packages/render/test/xss-corpus.js";
import { problemsIn } from "../../packages/render/test/vector-check.js";
import { startListener } from "../integration/archive/helpers.js";

/**
 * H-03 XSS corpus and header assertions against the archive listener (`/a/{token}/...`), without a database:
 * archived pages (document and reader view), titles, attributions, the interstitial, error pages, sub-resources, highlight and reader
 * preference parameters, and the headers on every route class and error page.
 */

const HOSTILE = [
  `<img src=x onerror=alert(1)>`, `<script>alert(1)</script>`, `"><svg onload=alert(1)>`, `'><script>alert(1)</script>`, `</title><script>alert(1)</script>`,
  `javascript:alert(1)`, ` <script>alert(1)</script>`, `{{constructor.constructor('alert(1)')()}}`, `${"<b>".repeat(500)}`, `&lt;script&gt;alert(1)&lt;/script&gt;`,
];

/**
 * `problemsIn` allows only archive-relative addresses. The listener's own chrome (the partial banner, the credit footer, the interstitial's
 * "save" and "queue" buttons) deliberately links out with http(s) and target=_blank, so those are checked here instead: every absolute address
 * is plain http(s), and every link that opens a new tab says noopener.
 */
function chromeProblems(body: string): string[] {
  const out = problemsIn(body).filter((p) => !/^non-archive url in href: https?:\/\//i.test(p));
  for (const m of body.matchAll(/<a\b[^>]*>/gi)) {
    const tag = m[0];
    const href = /href="([^"]*)"/i.exec(tag)?.[1] ?? "";
    if (/^\s*[a-z][a-z0-9+.-]*:/i.test(href) && !/^\s*https?:/i.test(href)) out.push(`link scheme: ${href.slice(0, 40)}`);
    if (/target="_blank"/i.test(tag) && !/rel="[^"]*noopener/i.test(tag)) out.push(`target=_blank without noopener: ${tag.slice(0, 80)}`);
  }
  return out;
}

const hasHeaders = (r: Response, label: string, o: { popups?: boolean } = {}) => {
  const csp = r.headers.get("content-security-policy") ?? "";
  expect(csp, `${label}: csp`).toMatch(/^sandbox( allow-popups allow-popups-to-escape-sandbox)?; default-src 'none';/);
  expect(csp.includes("allow-popups"), `${label}: popups`).toBe(!!o.popups);
  expect(csp, `${label}: scripts`).not.toMatch(/allow-scripts|allow-same-origin|allow-top-navigation|allow-forms|allow-modals|unsafe-eval|script-src/);
  expect(csp, `${label}: connect`).toContain("connect-src 'none'");
  expect(csp, `${label}: frames`).toContain("frame-src 'none'");
  expect(csp, `${label}: forms`).toContain("form-action 'none'");
  expect(csp, `${label}: base`).toContain("base-uri 'none'");
  expect(csp, `${label}: object`).toContain("object-src 'none'");
  expect(csp, `${label}: ancestors`).toMatch(/frame-ancestors http:\/\/localhost:3000$/);
  expect(r.headers.get("x-content-type-options"), `${label}: nosniff`).toBe("nosniff");
  expect(r.headers.get("referrer-policy"), `${label}: referrer`).toBe("no-referrer");
  expect(r.headers.get("cache-control"), `${label}: cache`).toBeTruthy();
  expect(r.headers.get("set-cookie"), `${label}: cookie`).toBeNull();
  expect(r.headers.get("access-control-allow-credentials"), `${label}: cors credentials`).toBeNull();
};

class HostileStore extends MemoryCaptureStore {
  attribution: PageAttribution | null = null;
  async readAttribution() {
    return this.attribution;
  }
}

describe("archived pages", () => {
  it("every corpus vector is inert in the document view and the reader view, with the archive headers", async () => {
    const store = new HostileStore();
    corpus.forEach((v, i) => store.addVersion({ versionId: `ver_${i}`, pageId: `pg_${i}`, url: "https://site.example/dir/page.html", html: `<!doctype html><title>t</title><body>${v.html}`, reader: { title: v.html, html: v.html } }));
    const h = await startListener({ store });
    const bad: string[] = [];
    for (const [i, v] of corpus.entries()) {
      for (const route of [`/p/pg_${i}`, `/v/ver_${i}`, `/p/pg_${i}/reader`, `/v/ver_${i}/reader`]) {
        const r = await fetch(h.url(route), { redirect: "manual" });
        hasHeaders(r, `${v.name} ${route}`);
        const body = await r.text();
        const problems = problemsIn(body);
        if (r.status !== 200) bad.push(`${v.name} ${route}: ${r.status}`);
        if (problems.length) bad.push(`${v.name} ${route}: ${problems.join("; ")}`);
        // the reader page also carries the hostile text as its title: it must be escaped
        const pageTitle = /<title>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? "";
        if (route.endsWith("reader") && /<[a-z]/i.test(pageTitle)) bad.push(`${v.name} ${route}: title not escaped`);
      }
    }
    expect(bad).toEqual([]);
  }, 300_000);

  it("a hostile title, address and attribution are text in the page, the banner and the footer", async () => {
    const store = new HostileStore();
    for (const [i, t] of HOSTILE.entries()) {
      store.addVersion({
        versionId: `ver_${i}`, pageId: `pg_${i}`, url: `https://site.example/${i}?q=${encodeURIComponent(t)}`, status: "partial", missingResources: 3,
        html: `<!doctype html><html><head><title>${t}</title></head><body><h1>${t}</h1><p>text</p></body></html>`,
        reader: { title: t, html: `<p>${t}</p>` },
      });
    }
    const hostileAttribution = (t: string): PageAttribution => ({
      licenseName: t, licenseUrl: "javascript:alert(1)", sourceUrl: `data:text/html,${t}`, revisionId: t, historyUrl: "vbscript:x", creditText: t, retrievedAt: 0,
      images: [{ file: t, url: t, author: t, licenseName: t, licenseUrl: `javascript:${t}`, sourcePageUrl: `JaVaScRiPt:${t}` }, { file: null, url: null, author: null, licenseName: null, licenseUrl: null, sourcePageUrl: "https://ok.example/a b\"c" }],
    });
    const h = await startListener({ store });
    for (const [i, t] of HOSTILE.entries()) {
      store.attribution = hostileAttribution(t);
      for (const route of [`/p/pg_${i}`, `/p/pg_${i}/reader`]) {
        const r = await fetch(h.url(route));
        hasHeaders(r, route);
        const body = await r.text();
        expect(chromeProblems(body), `${route} with ${t.slice(0, 30)}`).toEqual([]);
        expect(body, route).not.toMatch(/href="(javascript|vbscript|data):/i);
        expect(body, route).not.toMatch(/<img[^>]*onerror/i);
        expect(body, route).not.toMatch(/<script/i);
        // the quoted address never ends an attribute early
        expect(body, route).not.toMatch(/href="https:\/\/ok\.example\/a b"c/);
      }
    }
  });

  it("?hl= and the reader preferences cannot break out of their element", async () => {
    const store = new HostileStore();
    store.addVersion({ versionId: "ver_a", pageId: "pg_a", url: "https://site.example/a", html: "<p>alert hello <b>world</b> onerror img script</p>", reader: { title: "Reader", html: "<p>hello world</p>" } });
    const h = await startListener({ store });
    const payloads = [`</style><script>alert(1)</script>`, `"onload="alert(1)`, `');alert(1);//`, `<img src=x onerror=alert(1)>`, `}body{background:url(http://attacker.invalid/x)}`, `expression(alert(1))`, "\u0000", "a".repeat(5000), "%3Cscript%3E", `(`, `[`, `\\`, `.*`, `alert`, `img`, `script`];
    const bad: string[] = [];
    for (const p of payloads) {
      const q = encodeURIComponent(p);
      for (const url of [`/p/pg_a?hl=${q}`, `/v/ver_a?hl=${q}&hl=${q}`, `/p/pg_a/reader?font=${q}&theme=${q}&size=${q}&width=${q}&spacing=${q}&fs=${q}&lh=${q}&family=${q}&hl=${q}`]) {
        const r = await fetch(h.url(url));
        hasHeaders(r, url.slice(0, 60));
        const body = await r.text();
        const problems = problemsIn(body);
        if (problems.length) bad.push(`${url.slice(0, 80)}: ${problems.join("; ")}`);
        if (/attacker\.invalid/.test(body)) bad.push(`${url.slice(0, 80)}: external url reached the stylesheet`);
        if (r.status >= 500) bad.push(`${url.slice(0, 80)}: ${r.status}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("sub-resources: html, script, svg and xml assets are never offered as a document, and svg and css are cleaned", async () => {
    const store = new HostileStore();
    const A = "alert(1)";
    const assets = [
      { assetKey: "a1", url: "https://site.example/a.html", contentType: "text/html", body: `<script>${A}</script>` },
      { assetKey: "a2", url: "https://site.example/a.js", contentType: "text/javascript", body: A },
      { assetKey: "a3", url: "https://site.example/a.svg", contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" onload="${A}"><script>${A}</script><image href="http://attacker.invalid/a.png"/></svg>` },
      { assetKey: "a4", url: "https://site.example/a.xml", contentType: "application/xml", body: `<x:script xmlns:x="http://www.w3.org/1999/xhtml">${A}</x:script>` },
      { assetKey: "a5", url: "https://site.example/a.xhtml", contentType: "application/xhtml+xml", body: `<html xmlns="http://www.w3.org/1999/xhtml"><script>${A}</script></html>` },
      { assetKey: "a6", url: "https://site.example/a.css", contentType: "text/css", body: `@import url(http://attacker.invalid/x.css); body{background:url(http://attacker.invalid/a.png);behavior:url(x.htc)} a{width:expression(${A})}` },
      { assetKey: "a7", url: "https://site.example/a.png", contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64") },
      { assetKey: "a8", url: "https://site.example/a.pdf", contentType: "application/pdf", body: `%PDF <script>${A}</script>` },
      { assetKey: "a9", url: "https://site.example/a.txt", contentType: "text/plain; charset=utf-7", body: `+ADw-script+AD4-${A}` },
      { assetKey: "b1", url: "https://site.example/a.mhtml", contentType: "multipart/related", body: `<script>${A}</script>` },
      { assetKey: "b2", url: "https://site.example/a.swf", contentType: "application/x-shockwave-flash", body: "CWS" },
    ];
    store.addVersion({ versionId: "ver_r", pageId: "pg_r", url: "https://site.example/", html: "<p>x</p>", resources: assets });
    const h = await startListener({ store });
    const bad: string[] = [];
    for (const a of assets) {
      const r = await fetch(h.url(`/v/ver_r/r/${a.assetKey}`));
      hasHeaders(r, a.url);
      const type = (r.headers.get("content-type") ?? "").toLowerCase();
      const body = await r.text();
      if (/html|xhtml|\bxml\b|javascript|utf-7/.test(type) && !type.startsWith("image/svg")) bad.push(`${a.url}: served as ${type}`);
      if (type.startsWith("image/svg") && /<script|\son\w+\s*=|attacker\.invalid/i.test(body)) bad.push(`${a.url}: svg kept active parts`);
      if (type.startsWith("text/css") && /@import|attacker\.invalid|expression\(|behavior/i.test(body)) bad.push(`${a.url}: css kept active parts`);
      if (!/png|svg|css|octet-stream/.test(type)) bad.push(`${a.url}: unexpected type ${type}`);
      if (["a1", "a2", "a4", "a5", "a8", "a9", "b1", "b2"].includes(a.assetKey) && r.headers.get("content-disposition") !== "attachment") bad.push(`${a.url}: not an attachment`);
    }
    expect(bad).toEqual([]);
  });
});

describe("the interstitial and the error pages echo nothing as markup", () => {
  it("escapes the address, the origin page and a package title in every position", async () => {
    const store = new HostileStore();
    store.setZimPackage({ zimId: "zim_a", title: `<img src=x onerror=alert(1)>`, uuid: "u", newNamespaceScheme: true, mainPath: null });
    store.addVersion({ versionId: "ver_1", pageId: "pg_1", url: "https://site.example/", html: "<p>x</p>" });
    const h = await startListener({ store });
    const targets = [
      ...HOSTILE, `http://example.com/"><script>alert(1)</script>`, `http://example.com/?a=<img src=x onerror=alert(1)>`, `https://user:pw@example.com/`,
      `zim://zim_a/${encodeURIComponent(`<script>alert(1)</script>`)}`, `zim://zim_a/"><img src=x onerror=alert(1)>`, `zim://zim_missing/<b>x</b>`, `data:text/html,<script>alert(1)</script>`, `file:///etc/passwd`,
      `ftp://example.com/`, `http://[::1]/<script>`, "x".repeat(3000),
    ];
    for (const u of targets) {
      for (const from of ["ver_1", `ver_1"><script>alert(1)</script>`, "../../etc/passwd", ""]) {
        const r = await fetch(h.url(`/m?u=${encodeURIComponent(u)}&from=${encodeURIComponent(from)}`), { redirect: "manual" });
        hasHeaders(r, `interstitial ${u.slice(0, 30)}`, { popups: true });
        const body = await r.text();
        expect(chromeProblems(body), `${u.slice(0, 40)} / ${from.slice(0, 20)}`).toEqual([]);
        expect(body).not.toMatch(/<script|<img[^>]*onerror/i);
        expect(body).not.toMatch(/href="(javascript|data|vbscript|file):/i);
        // the back link only ever points inside the archive
        for (const m of body.matchAll(/href="(\/a\/[^"]*)"/g)) expect(m[1]).toMatch(/^\/a\/[^/]+\/v\/ver_1$/);
      }
    }
  });

  it("error pages carry the same headers and no request data", async () => {
    const h = await startListener({});
    const token = h.mint();
    const cases: [string, string][] = [
      ["/", "404"], ["/healthz", "200"], ["/__health", "200"], ["/a", "404"], ["/a/", "401"], [`/a/${token}`, "404"], [`/a/${token}/`, "404"], [`/a/${token}/p`, "404"], [`/a/${token}/p/pg_none`, "404"],
      [`/a/${token}/p/<script>`, "404"], [`/a/${token}/p/%3Cscript%3Ealert(1)%3C%2Fscript%3E`, "404"], [`/a/${token}/v/x/r/<img>`, "404"], [`/a/${token}/z/zim_none/<b>`, "404"], [`/a/${token}/_/nope`, "404"],
      [`/a/${token}/_/ui.css`, "200"], [`/a/${token}/%`, "400"], [`/a/${token}/%E0%A4%A`, "400"], [`/a/${token}/p/..%2f..%2f`, "404"], [`/a/bad.token.value`, "401"], [`/a/${token}x/p/a`, "401"],
      [`/a/${"A".repeat(3000)}/p/a`, "401"], ["/api/settings", "404"], ["/api/system/health", "404"], ["/login", "404"], ["/_next/static/x.js", "404"],
    ];
    for (const [p, want] of cases) {
      const r = await fetch(`${h.origin}${p}`, { redirect: "manual", headers: { cookie: "ncb_session=SECRET", authorization: "Bearer SECRET", origin: "http://evil.example" } });
      hasHeaders(r, p.slice(0, 50), { popups: false });
      const body = await r.text();
      expect(String(r.status), `${p.slice(0, 60)} -> ${r.status} ${body.slice(0, 80)}`).toBe(want);
      expect(body, p).not.toContain("SECRET");
      expect(body, p).not.toMatch(/<script|onerror/i);
      expect(r.headers.get("access-control-allow-origin"), p).toBeNull();
    }
    // methods other than GET and HEAD
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS", "TRACE"]) {
      const r = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port: h.port, method, path: `/a/${token}/p/pg_none` }, (res) => { res.resume(); resolve({ status: res.statusCode ?? 0, headers: res.headers }); });
        req.on("error", reject);
        req.end(method === "POST" || method === "PUT" || method === "PATCH" ? "x=1" : undefined);
      });
      expect(r.status, method).toBe(405);
      expect(String(r.headers["content-security-policy"] ?? ""), method).toMatch(/^sandbox/);
      expect(r.headers["set-cookie"], method).toBeUndefined();
    }
  });
});

describe("listener isolation: it is a read-only island", () => {
  it("serves the same bytes with and without the app's cookie, never sets one, and answers a CORS preflight with nothing", async () => {
    const store = new HostileStore();
    store.addVersion({ versionId: "ver_1", pageId: "pg_1", url: "https://site.example/", html: "<p>hello</p>" });
    const h = await startListener({ store });
    const plain = await (await fetch(h.url("/p/pg_1"))).text();
    const withCookie = await fetch(h.url("/p/pg_1"), { headers: { cookie: "ncb_session=abc; other=1", authorization: "Basic eDp5", "x-nocon-proxy-secret": "x".repeat(32) } });
    expect(await withCookie.text()).toBe(plain);
    expect(withCookie.headers.get("set-cookie")).toBeNull();
    const pre = await fetch(h.url("/p/pg_1"), { method: "OPTIONS", headers: { origin: "http://evil.example", "access-control-request-method": "GET" } });
    expect(pre.status).toBe(405);
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("only font responses carry a permissive CORS header, and nothing else does", async () => {
    const store = new HostileStore();
    store.addVersion({
      versionId: "ver_1", pageId: "pg_1", url: "https://site.example/", html: "<p>hello</p>",
      resources: [
        { assetKey: "f1", url: "https://site.example/f.woff2", contentType: "font/woff2", body: "wOF2" }, { assetKey: "i1", url: "https://site.example/i.png", contentType: "image/png", body: "png" },
        { assetKey: "h1", url: "https://site.example/h.html", contentType: "text/html", body: "<p>x</p>" },
      ],
    });
    const h = await startListener({ store });
    expect((await fetch(h.url("/v/ver_1/r/f1"))).headers.get("access-control-allow-origin")).toBe("*");
    for (const route of ["/p/pg_1", "/v/ver_1/r/i1", "/v/ver_1/r/h1", "/m?u=http%3A%2F%2Fexample.com%2F", "/healthz"]) {
      const r = await fetch(route === "/healthz" ? `${h.origin}${route}` : h.url(route), { headers: { origin: "http://evil.example" } });
      expect(r.headers.get("access-control-allow-origin"), route).toBeNull();
    }
  });

  it("frame-ancestors is the app origin the token was minted for, whatever Host or Origin the request claims", async () => {
    const h = await startListener({});
    const tokens = new ArchiveTokenService({ secret: Buffer.alloc(32, 3), clock: h.clock });
    const t = tokens.mint({ userId: "u1", frameId: "f", appOrigin: "https://brain.example.org" });
    for (const hdr of [{ host: "evil.example" }, { origin: "https://evil.example" }, { "x-forwarded-host": "evil.example" }, { referer: "https://evil.example/" }] as Record<string, string>[]) {
      const r = await fetch(`${h.origin}/a/${t}/_/ui.css`, { headers: hdr });
      expect(r.headers.get("content-security-policy"), JSON.stringify(hdr)).toMatch(/frame-ancestors https:\/\/brain\.example\.org$/);
    }
  });

  it("tampered, truncated, expired and foreign tokens are all 401 with the standard headers", async () => {
    const h = await startListener({});
    const good = h.mint("fr_1");
    const [v, body, sig] = good.split(".") as [string, string, string];
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);
    const forgedPayload = Buffer.from(JSON.stringify({ u: "1", f: "fr_1", e: 4102444800, o: "https://evil.example" })).toString("base64url");
    const foreign = new ArchiveTokenService({ secret: Buffer.alloc(32, 9), clock: h.clock }).mint({ userId: "u1", frameId: "fr_1", appOrigin: "http://localhost:3000" });
    const tokens = [
      `${v}.${body}.${flip(sig, 0)}`, `${v}.${body}.${flip(sig, sig.length - 2)}`, `${v}.${flip(body, 3)}.${sig}`, `${v}.${forgedPayload}.${sig}`, `${v}.${body}.`, `${v}..${sig}`, `${v}.${body}`,
      `v2.${body}.${sig}`, `${body}.${sig}`, `${v}.${body}.${sig}.extra`, foreign, "", "null", "undefined", "../../x", `${v}.${body}.${sig}%00`, `${v}.${body}.${sig.toUpperCase()}`, "e30.e30.e30",
      `${v}.${Buffer.from("{}").toString("base64url")}.${sig}`,
    ];
    for (const t of tokens) {
      const r = await fetch(`${h.origin}/a/${encodeURIComponent(t)}/p/pg_1`, { redirect: "manual" });
      expect(r.status, t.slice(0, 50)).toBe(401);
      hasHeaders(r, `token ${t.slice(0, 20)}`);
    }
    h.clock.advance((8 * 3600 + 5) * 1000);
    const expired = await fetch(`${h.origin}/a/${good}/p/pg_1`);
    expect(expired.status).toBe(401);
  });

  it("the listener's source has no database, network client or API code to reach", () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../apps/server/src/archive");
    const forbidden = /from\s+["'](@ncb\/db|@ncb\/fetch|undici|node:dns|node:net|node:tls|node:child_process|better-sqlite3|\.\.\/(services|routes|downloads|pipeline|sources|online|search|storage)[^"']*)["']/;
    const offenders = fs.readdirSync(dir).filter((f) => f.endsWith(".ts")).filter((f) => forbidden.test(fs.readFileSync(path.join(dir, f), "utf8")));
    expect(offenders).toEqual([]);
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      expect(/\bhttps?\.(request|get)\(|\bfetch\(/.test(src), `${f} makes outbound requests`).toBe(false);
    }
  });
});


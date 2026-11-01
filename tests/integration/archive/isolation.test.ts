import http from "node:http";
import { chromium, type Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectUrls, sanitizeHtml } from "@ncb/render";
import { MemoryCaptureStore } from "@ncb/server";
import { startFixtures } from "../../fixtures/sites/index.mjs";
import { corpus } from "../../../packages/render/test/xss-corpus.js";
import { onCleanup, startListener } from "./helpers.js";

/**
 * Port of the PoC isolation tests (docs/research/poc-archive-isolation, tests B, C, I) against the real listener:
 * the fixture site's hostile /malicious page is archived, then served inside a sandboxed iframe on another origin and
 * opened directly in a tab. Everything is on `localhost` with different ports, the worst case: cookies cross ports.
 */

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

function listen(handler: http.RequestListener): Promise<{ port: number; server: http.Server }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "0.0.0.0", () => resolve({ port: (server.address() as { port: number }).port, server }));
    onCleanup(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  });
}

/** Archives a fixture page the way the pipeline would: the HTML plus every sub-resource it (and its CSS) references. */
async function archivePage(store: MemoryCaptureStore, url: string, ids: { versionId: string; pageId: string }) {
  const html = await (await fetch(url)).text();
  const { resources } = collectUrls(html, url);
  const seen = new Map<string, { url: string; assetKey: string; contentType: string; body: Buffer }>();
  const queue = [...resources];
  while (queue.length) {
    const u = queue.shift()!;
    if (seen.has(u)) continue;
    const r = await fetch(u);
    if (!r.ok) continue;
    const body = Buffer.from(await r.arrayBuffer());
    const contentType = r.headers.get("content-type") ?? "application/octet-stream";
    seen.set(u, { url: u, assetKey: (seen.size + 1).toString(36), contentType, body });
    if (contentType.includes("css")) {
      for (const m of body.toString().matchAll(/(?:url\(\s*['"]?|@import\s+['"])([^'")\s]+)/g)) queue.push(new URL(m[1]!, u).href);
    }
  }
  store.addVersion({ ...ids, url, html, resources: [...seen.values()] });
  return seen.size;
}

describe("isolation in Chromium (PoC tests B, C, I against the real listener)", () => {
  it("keeps the hostile fixture page inert in a sandboxed iframe and on direct open", async () => {
    const cookieLog: (string | undefined)[] = [];
    const appRequests: { url: string; cookie?: string }[] = [];
    // The "app": sets an HttpOnly session cookie on localhost (shared by every port) and records every request.
    const app = await listen((req, res) => {
      appRequests.push({ url: req.url ?? "", cookie: req.headers.cookie });
      if (req.url === "/seed") res.setHeader("set-cookie", "ncb_session=SECRET; HttpOnly; Path=/");
      res.setHeader("access-control-allow-origin", req.headers.origin ?? "*");
      res.setHeader("access-control-allow-credentials", "true");
      res.end("SECRET-DATA");
    });
    const fx = await startFixtures({ appApiUrl: `http://localhost:${app.port}/api/evil-probe` });
    onCleanup(() => fx.close());
    const store = new MemoryCaptureStore();
    expect(await archivePage(store, `${fx.urls.article}/malicious`, { versionId: "ver_mal", pageId: "pg_mal" })).toBeGreaterThan(2);

    // The shell: a trusted page on another origin that frames the archive and listens for postMessage.
    const messages: string[] = [];
    let archiveSrc = "";
    const shell = await listen((req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html><title>shell</title><script>window.__msgs=[];addEventListener('message',e=>__msgs.push(String(e.data)))</script>
<iframe id=f sandbox="allow-popups allow-popups-to-escape-sandbox" src="${archiveSrc}" width=600 height=400></iframe>`);
    });
    const h = await startListener({ store, appOrigin: `http://localhost:${shell.port}`, host: "0.0.0.0" });
    h.listener.server.on("request", (req) => cookieLog.push(req.headers.cookie));
    const token = h.mint("fr_iso");
    const archiveUrl = `http://localhost:${h.port}/a/${token}/p/pg_mal`;
    archiveSrc = archiveUrl;

    const beacons = async () => (await (await fetch(`${fx.urls.article}/__beacons`)).json()) as unknown[];
    const probes = () => appRequests.filter((r) => r.url.startsWith("/api/evil-probe"));

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${app.port}/seed`); // HttpOnly cookie now sent to every localhost port
    const responses: { status: number; csp: string | null; setCookie: string | null }[] = [];
    ctx.on("response", (r) => {
      if (r.url().startsWith(`http://localhost:${h.port}/`)) void r.allHeaders().then((hd) => responses.push({ status: r.status(), csp: hd["content-security-policy"] ?? null, setCookie: hd["set-cookie"] ?? null }));
    });

    // --- sandboxed iframe on a different origin
    await page.goto(`http://localhost:${shell.port}/`);
    await page.waitForTimeout(2500);
    const frame = page.frames().find((f) => f.url().includes("/a/"))!;
    expect(frame).toBeTruthy();
    expect(await frame.evaluate(() => document.title)).toBe("Malicious page | Fixture Gazette"); // the script's `document.title='pwned'` never ran
    expect(await frame.evaluate(() => document.scripts.length)).toBe(0);
    expect(await frame.evaluate(() => Array.from(document.images).some((i) => i.naturalWidth > 0))).toBe(true); // archived image loads under the CSP
    expect(await frame.evaluate(() => document.styleSheets.length)).toBeGreaterThan(0);
    expect(await frame.evaluate(() => document.querySelectorAll("iframe,form[action],object,embed,meta[http-equiv]").length)).toBe(0);
    expect(page.url()).toBe(`http://localhost:${shell.port}/`); // top.location was not navigated
    expect(await page.evaluate(() => (window as unknown as { __msgs: string[] }).__msgs)).toEqual([]); // no postMessage reached the shell
    expect(await beacons()).toEqual([]);
    expect(probes()).toEqual([]);
    expect(h.listener.frames.get("fr_iso")).toMatchObject({ pageId: "pg_mal", title: "Malicious page | Fixture Gazette" });
    // The threat was real (the browser did send the cookie to the archive port) and the listener still ignored it.
    expect(cookieLog.some((c) => c?.includes("ncb_session=SECRET"))).toBe(true);
    expect(responses.length).toBeGreaterThan(2);
    for (const r of responses) {
      expect(r.setCookie).toBeNull();
      expect(r.csp).toMatch(/^sandbox/);
    }

    // --- direct open in a tab (PoC test I): the CSP sandbox header is the only protection
    const direct = await ctx.newPage();
    await direct.goto(archiveUrl);
    await direct.waitForTimeout(2000);
    expect(await direct.title()).toBe("Malicious page | Fixture Gazette");
    expect(await direct.evaluate(() => document.scripts.length)).toBe(0);
    await expect(direct.evaluate(() => document.cookie)).rejects.toThrow(/SecurityError|sandbox/i);
    const fetched = await direct.evaluate(async (u) => fetch(u, { credentials: "include" }).then(() => "reached", () => "blocked"), `http://localhost:${app.port}/api/steal`);
    expect(fetched).toBe("blocked");
    expect(await beacons()).toEqual([]);
    expect(probes()).toEqual([]);
    expect(appRequests.filter((r) => r.url.startsWith("/api/steal"))).toEqual([]);

    // --- the clicked link: leaving the sandbox needs allow-popups, and only /m has it
    const m = await ctx.newPage();
    await m.goto(`http://localhost:${h.port}/a/${token}/m?u=${encodeURIComponent(fx.urls.article + "/about")}`);
    expect(await m.getByRole("link", { name: "Open live in new tab" }).getAttribute("target")).toBe("_blank");

    // --- control: the same page opened live (no sandbox) does run, so the harness would have caught a leak
    const live = await ctx.newPage();
    await live.goto(`${fx.urls.article}/malicious`);
    await live.waitForTimeout(1500);
    expect((await beacons()).length).toBeGreaterThan(0);
    expect(probes().length).toBeGreaterThan(0);
    await ctx.close();
  }, 120_000);
});

describe("XSS corpus executed in Chromium", () => {
  it("no sanitised vector runs script or makes a request (control: raw vectors do)", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    let dialogs = 0;
    const requests: string[] = [];
    page.on("dialog", (d) => { dialogs++; void d.dismiss(); });
    page.on("request", (r) => { if (!/^(about:|data:|blob:)/.test(r.url())) requests.push(r.url()); });
    const run = async (html: string) => {
      await page.setContent(html);
      await page.evaluate(() => new Promise((r) => setTimeout(r, 10)));
    };

    await run(`<img src=x onerror="alert(1)">`);
    expect(dialogs).toBeGreaterThan(0); // control: the harness sees an executed vector
    dialogs = 0;
    requests.length = 0;

    const fails: string[] = [];
    for (const v of corpus) {
      if (v.html.length > 100_000) continue;
      const out = sanitizeHtml(v.html, { baseUrl: "https://site.example/p" }).html;
      await run(out);
      if (dialogs > 0 || requests.length > 0) fails.push(`${v.name}: dialogs=${dialogs} requests=${requests.join(",")}`);
      dialogs = 0;
      requests.length = 0;
    }
    expect(fails).toEqual([]);
    await ctx.close();
  }, 180_000);
});

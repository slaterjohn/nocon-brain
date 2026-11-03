import { chromium, firefox, webkit, type Browser, type BrowserType } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryCaptureStore } from "@ncb/server";
import { sanitizeHtml } from "@ncb/render";
import { corpus } from "../../packages/render/test/xss-corpus.js";
import { startListener } from "../integration/archive/helpers.js";

/**
 * H-03 XSS corpus executed in real browsers. For every engine in SECURITY_BROWSERS (default "chromium,firefox"; CI also lists webkit, which
 * does not start on macOS 26 with Playwright 1.64's build):
 *
 *   control   a raw vector in a page runs (so the harness can see a run)
 *   sanitiser the sanitiser's output, in a page with no other protection, runs nothing and requests nothing
 *   served    the same document opened directly from the archive listener (its CSP `sandbox` is then the only layer besides the sanitiser)
 */

const ENGINES: Record<string, BrowserType> = { chromium, firefox, webkit };
const wanted = (process.env.SECURITY_BROWSERS ?? "chromium,firefox").split(",").map((s) => s.trim()).filter(Boolean);

for (const name of wanted) {
  describe(`XSS corpus in ${name}`, () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await ENGINES[name]!.launch();
    }, 60_000);
    afterAll(async () => {
      await browser?.close();
    });

    it("control: raw vectors run script here", async () => {
      const page = await browser.newPage();
      let dialogs = 0;
      page.on("dialog", (d) => { dialogs++; void d.dismiss(); });
      await page.setContent(`<img src=x onerror="alert(1)">`);
      await page.waitForTimeout(100);
      expect(dialogs).toBeGreaterThan(0);
      await page.close();
    });

    it("the sanitiser's output runs nothing and requests nothing", async () => {
      const page = await browser.newPage();
      let dialogs = 0;
      const requests: string[] = [];
      page.on("dialog", (d) => { dialogs++; void d.dismiss(); });
      page.on("request", (r) => { if (!/^(about:|data:|blob:)/.test(r.url())) requests.push(r.url()); });
      const fails: string[] = [];
      for (const v of corpus) {
        if (v.html.length > 100_000) continue;
        const out = sanitizeHtml(v.html, { baseUrl: "https://site.example/p" }).html;
        await page.setContent(out);
        await page.evaluate(() => new Promise((r) => setTimeout(r, 10)));
        if (dialogs > 0 || requests.length > 0) fails.push(`${v.name}: dialogs=${dialogs} requests=${requests.join(",")}`);
        dialogs = 0;
        requests.length = 0;
      }
      expect(fails).toEqual([]);
      await page.close();
    }, 240_000);

    it("served by the archive listener and opened directly, nothing runs, nothing leaves, no cookie or storage is reachable", async () => {
      const store = new MemoryCaptureStore();
      corpus.forEach((v, i) => store.addVersion({ versionId: `ver_${i}`, pageId: `pg_${i}`, url: "https://site.example/dir/page.html", html: `<!doctype html><title>t</title><body>${v.html}` }));
      const h = await startListener({ store });
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      let dialogs = 0;
      const requests: string[] = [];
      const cookieHeaders: string[] = [];
      page.on("dialog", (d) => { dialogs++; void d.dismiss(); });
      page.on("request", (r) => { if (!r.url().startsWith(h.origin) && !/^(about:|data:|blob:)/.test(r.url())) requests.push(r.url()); });
      ctx.on("response", (r) => { void r.allHeaders().then((x) => { if (x["set-cookie"]) cookieHeaders.push(r.url()); }); });
      const fails: string[] = [];
      for (const [i, v] of corpus.entries()) {
        if (v.html.length > 100_000) continue;
        await page.goto(h.url(`/p/pg_${i}`), { waitUntil: "load" });
        await page.waitForTimeout(15);
        if (dialogs > 0 || requests.length > 0) fails.push(`${v.name}: dialogs=${dialogs} requests=${requests.join(",")}`);
        dialogs = 0;
        requests.length = 0;
      }
      expect(fails).toEqual([]);
      expect(cookieHeaders).toEqual([]);
      // sandbox without allow-same-origin: an opaque origin, so cookies and storage are not reachable even when a script could run
      expect(await page.evaluate(() => { try { return String(document.cookie); } catch (e) { return "blocked"; } })).toMatch(/blocked|^$/);
      expect(await page.evaluate(() => { try { return typeof localStorage === "undefined" ? "none" : String(localStorage.length); } catch { return "blocked"; } })).toMatch(/blocked|none/);
      await ctx.close();
    }, 240_000);
  });
}

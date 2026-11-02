import fs from "node:fs";
import { chromium, type Browser, type BrowserContext } from "playwright-core";

export interface EngineOptions {
  /** The server's guarded forward proxy, for example http://server:3128. The browser has no other route out. */
  proxyUrl: string;
  proxyPassword?: string;
  /** The browser is restarted after this many pages, so a leak cannot grow without bound. Default 50. */
  restartAfterPages?: number;
  /** Override for tests of the engine without a proxy. */
  extraArgs?: string[];
}

export interface RenderInput {
  url: string;
  timeoutMs: number;
  maxBytes: number;
  userAgent: string;
}

export interface RenderOutput {
  finalUrl: string;
  status: number;
  html: string;
  title: string | null;
  loadedBytes: number;
  durationMs: number;
  requests: number;
  blockedRequests: number;
  memoryMb?: number;
}

/** A failure with a code the server maps to "retry" or "give up". */
export class RenderError extends Error {
  constructor(readonly code: "bad_request" | "timeout" | "too_large" | "navigation_failed" | "busy" | "internal", message: string, readonly httpStatus = 502) {
    super(message);
  }
}

/** Request types the DOM does not need. The server fetches the page's real assets itself, through its own guard, afterwards. */
const SKIP_TYPES = new Set(["image", "media", "font", "ping", "beacon", "other", "texttrack", "eventsource", "manifest", "prefetch"]);

/** Container memory in MiB: the cgroup figure includes Chromium's child processes, which `process.memoryUsage()` does not. */
export function cgroupMemoryMb(): number | undefined {
  for (const f of ["/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory/memory.usage_in_bytes"]) {
    try {
      return Math.round(Number(fs.readFileSync(f, "utf8").trim()) / 1048576);
    } catch {
      /* try the next */
    }
  }
  return undefined;
}

/**
 * One Chromium (chromium_headless_shell), one page at a time, a fresh browser context for each page. Images, media and
 * fonts are not loaded: the output is the DOM after scripts ran, and the server fetches assets itself.
 */
export class Engine {
  private browser: Browser | undefined;
  private rendered = 0;
  private busy = false;
  private launching: Promise<Browser> | undefined;

  constructor(private readonly o: EngineOptions) {}

  get pagesRendered(): number {
    return this.rendered;
  }
  get isBusy(): boolean {
    return this.busy;
  }
  get browserUp(): boolean {
    return this.browser?.isConnected() ?? false;
  }

  private async launch(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.launching ??= (async () => {
      const proxy = new URL(this.o.proxyUrl);
      const b = await chromium.launch({
        headless: true,
        chromiumSandbox: true,
        // `<-loopback>` removes Chromium's built-in exception for localhost, so even that goes through the proxy (which refuses it).
        proxy: { server: this.o.proxyUrl, bypass: "<-loopback>", ...(this.o.proxyPassword ? { username: "renderer", password: this.o.proxyPassword } : {}) },
        args: [
          // Chromium does its own DNS. With a proxy it asks the proxy to resolve; this makes any other lookup fail outright.
          `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${proxy.hostname}`,
          "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync",
          "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--disable-translate", "--mute-audio",
          "--disable-features=OptimizationHints,MediaRouter,Translate,AutofillServerCommunication,CertificateTransparencyComponentUpdater",
          "--js-flags=--max-old-space-size=256",
          ...(this.o.extraArgs ?? []),
        ],
      });
      b.on("disconnected", () => { if (this.browser === b) this.browser = undefined; });
      this.browser = b;
      return b;
    })().finally(() => { this.launching = undefined; });
    return this.launching;
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = undefined;
    await b?.close().catch(() => undefined);
  }

  async render(input: RenderInput): Promise<RenderOutput> {
    let target: URL;
    try {
      target = new URL(input.url);
    } catch {
      throw new RenderError("bad_request", "That is not a web address.", 400);
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") throw new RenderError("bad_request", "Only http and https pages can be rendered.", 400);
    if (this.busy) throw new RenderError("busy", "Another page is being rendered.", 429);
    this.busy = true;
    const started = Date.now();
    let ctx: BrowserContext | undefined;
    let timedOut = false;
    let tooBig = false;
    let loaded = 0;
    let requests = 0;
    let blocked = 0;
    const deadline = setTimeout(() => { timedOut = true; void ctx?.close().catch(() => undefined); }, input.timeoutMs);
    try {
      if (this.rendered > 0 && this.rendered % (this.o.restartAfterPages ?? 50) === 0) await this.close();
      const browser = await this.launch();
      ctx = await browser.newContext({
        userAgent: input.userAgent, viewport: { width: 1280, height: 900 }, locale: "en-GB", timezoneId: "UTC", javaScriptEnabled: true,
        serviceWorkers: "block", acceptDownloads: false, permissions: [], ignoreHTTPSErrors: false, reducedMotion: "reduce",
      });
      ctx.setDefaultTimeout(input.timeoutMs);
      await ctx.route("**/*", (route) => {
        const req = route.request();
        const u = req.url();
        if (SKIP_TYPES.has(req.resourceType()) || !/^(https?:|data:|blob:|about:)/i.test(u)) {
          blocked++;
          return route.abort("blockedbyclient");
        }
        requests++;
        return route.continue();
      });
      const page = await ctx.newPage();
      ctx.on("page", (p) => { if (p !== page) void p.close().catch(() => undefined); });
      page.on("dialog", (d) => void d.dismiss().catch(() => undefined));
      page.on("requestfinished", (r) => {
        void r.sizes().then((s) => {
          loaded += s.responseBodySize + s.responseHeadersSize;
          if (loaded > input.maxBytes && !tooBig) { tooBig = true; void ctx?.close().catch(() => undefined); }
        }).catch(() => undefined);
      });
      const remaining = () => Math.max(1000, input.timeoutMs - (Date.now() - started));
      const resp = await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: remaining() });
      await page.waitForLoadState("networkidle", { timeout: Math.min(remaining(), 8000) }).catch(() => undefined);
      // Scroll a few screens so content that loads on scroll appears, then let it settle.
      await page.evaluate(
        `(async () => { for (let i = 0; i < 4; i++) { window.scrollBy(0, window.innerHeight); await new Promise((r) => setTimeout(r, 150)); } window.scrollTo(0, 0); })()`,
      ).catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: Math.min(remaining(), 3000) }).catch(() => undefined);
      const [html, title] = await Promise.all([page.content(), page.title().catch(() => "")]);
      if (Buffer.byteLength(html, "utf8") > input.maxBytes) throw new RenderError("too_large", "The rendered page is larger than the size limit.", 413);
      this.rendered++;
      return {
        finalUrl: page.url(), status: resp?.status() ?? 0, html, title: title || null, loadedBytes: loaded, durationMs: Date.now() - started,
        requests, blockedRequests: blocked, memoryMb: cgroupMemoryMb(),
      };
    } catch (e) {
      if (e instanceof RenderError) throw e;
      if (tooBig) throw new RenderError("too_large", "The page loaded more data than the size limit allows.", 413);
      if (timedOut) throw new RenderError("timeout", "The page took too long to render.", 504);
      const msg = e instanceof Error ? e.message.split("\n")[0]! : String(e);
      if (/Target (page, context or browser )?has been closed|browser has been closed|disconnected/i.test(msg)) {
        console.error("browser stopped while rendering:", e instanceof Error ? e.message.slice(0, 1500) : e);
        await this.close();
        throw new RenderError("internal", "The browser stopped while rendering. It will be restarted.", 500);
      }
      throw new RenderError("navigation_failed", msg.slice(0, 300), 502);
    } finally {
      clearTimeout(deadline);
      await ctx?.close().catch(() => undefined);
      this.busy = false;
    }
  }
}

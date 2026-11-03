import { expect, test, type Page } from "@playwright/test";
import { activeFrame, articleUrl, login, mode, openAddress, savePage } from "./helpers";

// H-03 isolation proof of concept, run in every browser project (Chromium, Firefox, WebKit): archived content, which is hostile by assumption,
// cannot read the app's cookies or storage, cannot call the app's API, cannot navigate or message the app, and the app cannot be framed by it.
// The hostile page is the fixture article site's /malicious: its script reads document.cookie, writes localStorage, posts to the app's API with
// credentials, navigates top, posts a message to its parent and beacons everything it can read back to the fixture site.
test.skip(mode() !== "real-server", "needs the real server");

const CSRF = { "X-NoCon-CSRF": "1" };
const SECRET = "TOP-SECRET-APP-COOKIE";

async function beacons(page: Page): Promise<unknown[]> {
  return (await (await page.request.get(articleUrl("/__beacons"))).json()) as unknown[];
}

/**
 * Runs a function in the page and reports what it saw. A sandboxed document without `allow-scripts` runs no timers and no event handlers,
 * only promise callbacks, so a probe must not wait for either; and an answer that never comes is reported as "no answer" after 5 s.
 */
async function probe<A, T>(page: Page, fn: (arg: A) => T | Promise<T>, arg?: A): Promise<string> {
  const answer = page.evaluate(fn as never, arg as never).then((v) => String(v), (e) => `evaluate-failed: ${String(e).slice(0, 120)}`);
  const none = new Promise<string>((resolve) => setTimeout(() => resolve("no answer"), 5000));
  return Promise.race([answer, none]);
}

test.beforeEach(async ({ page, context, baseURL }) => {
  await login(page);
  // A cookie and a storage entry the page must never be able to read: set on the app origin, which shares a host with the archive origin.
  await context.addCookies([{ name: "app_secret", value: SECRET, url: baseURL! }]);
  await page.evaluate((s) => { try { localStorage.setItem("app_secret", s); sessionStorage.setItem("app_secret", s); } catch { /* ignore */ } }, SECRET);
});

test("the hostile page in the shell's sandboxed frame reads nothing, calls nothing and moves nothing", async ({ page, context, baseURL }) => {
  const url = articleUrl("/malicious");
  await savePage(page, url);
  const webOrigin = new URL(baseURL!).origin;
  const archiveOrigin = new URL(process.env.E2E_ARCHIVE_URL!).origin;
  const leaks: string[] = [];
  context.on("request", (r) => {
    const from = r.frame()?.url() ?? "";
    // any request to the app's API that was made from inside the archive frame, or any request to the attacker's address
    if (from.startsWith(archiveOrigin) && r.url().startsWith(webOrigin)) leaks.push(`frame -> app: ${r.method()} ${r.url()}`);
    if (/evil\.example\.invalid|\/api\/evil-probe/.test(r.url())) leaks.push(`attacker address: ${r.url()}`);
  });
  // The shell is a single-page app that stays loaded, so the listener goes into the live document.
  await page.evaluate(() => {
    (window as unknown as { __msgs: string[] }).__msgs = [];
    window.addEventListener("message", (e) => (window as unknown as { __msgs: string[] }).__msgs.push(String(e.data)));
  });
  await openAddress(page, url);
  await expect(activeFrame(page)).toBeVisible();
  const src = (await activeFrame(page).getAttribute("src")) ?? "";
  expect(src.startsWith(`${archiveOrigin}/a/`)).toBe(true);
  const fl = page.frameLocator('iframe[data-testid="archive-frame"]');
  await expect(fl.getByRole("heading", { level: 1, name: /Totally safe article/ })).toBeVisible();
  await page.waitForTimeout(2500); // time for any script that did run to do its worst

  expect(await beacons(page)).toEqual([]); // nothing read back from the page
  expect(leaks).toEqual([]);
  expect(page.url().startsWith(webOrigin)).toBe(true); // top.location was not navigated
  expect(await page.evaluate(() => (window as unknown as { __msgs: string[] }).__msgs.filter((m) => /malicious/.test(m)))).toEqual([]); // no postMessage reached the shell
  // the frame is a different origin: the shell cannot reach into it, and it cannot reach out
  expect(await page.evaluate(() => { const f = document.querySelector<HTMLIFrameElement>('iframe[data-testid="archive-frame"]:not([hidden])'); try { return f?.contentDocument ? "same-origin" : "cross-origin"; } catch { return "cross-origin"; } })).toBe("cross-origin");
  // the page title in the tab is the page's own (the script's `document.title = 'pwned'` did not run)
  await expect(page.getByRole("tab", { name: /Malicious page/ })).toBeVisible();
  // the app's secret cookie and storage are still intact and were not exfiltrated anywhere
  expect((await context.cookies(baseURL!)).find((c) => c.name === "app_secret")?.value).toBe(SECRET);
});

test("opened directly in a tab, the archive page cannot read cookies or storage or call the API", async ({ page, context, baseURL }) => {
  const { pageId } = await savePage(page, articleUrl("/malicious"));
  const grant = await page.request.post("/api/archive/frame-grants", { data: { pageId }, headers: CSRF });
  expect(grant.status(), await grant.text()).toBe(200);
  const archiveUrl = ((await grant.json()) as { url: string }).url;
  const webOrigin = new URL(baseURL!).origin;
  const apiCalls: string[] = [];
  // `requestfinished` only fires for a request that got an answer: one that the CSP stopped fires `requestfailed` instead.
  context.on("requestfinished", (r) => { if (r.url().startsWith(webOrigin) && /\/api\//.test(r.url()) && r.frame()?.url().startsWith(process.env.E2E_ARCHIVE_URL!)) apiCalls.push(r.url()); });

  const direct = await context.newPage();
  const res = await direct.goto(archiveUrl);
  expect(res?.status()).toBe(200);
  await direct.waitForTimeout(1500);
  const csp = (await res!.allHeaders())["content-security-policy"] ?? "";
  expect(csp).toMatch(/^sandbox(?! [^;]*allow-(scripts|same-origin))/);
  expect(csp).toContain("connect-src 'none'");
  expect((await res!.allHeaders())["set-cookie"]).toBeUndefined();

  // Whatever the browser lets us ask the document, it must not answer with the secret, and a request to the API must not succeed.
  expect(await probe(direct, () => document.cookie)).not.toContain(SECRET);
  expect(await probe(direct, () => localStorage.getItem("app_secret"))).not.toContain(SECRET);
  expect(await probe(direct, () => sessionStorage.getItem("app_secret"))).not.toContain(SECRET);
  expect(await probe(direct, () => String(window.origin))).toMatch(/^(null|evaluate-failed|no answer)/);
  // a cross-origin request to the app's API with credentials, the thing a hostile script would try first
  const reached = await probe(direct, (api: string) => fetch(api, { credentials: "include" }).then((r) => `reached ${r.status}`, () => "blocked"), `${webOrigin}/api/auth/me`);
  expect(reached).not.toMatch(/^reached/);
  // sendBeacon returns true when the browser queues the request, even if the policy then stops it, so what counts is that no answer comes back
  await probe(direct, (api: string) => String(navigator.sendBeacon(api, "x")), `${webOrigin}/api/evil-probe`);
  await direct.waitForTimeout(500);
  expect(await beacons(page)).toEqual([]);
  expect(apiCalls).toEqual([]);
  expect(await direct.title()).toMatch(/Malicious page/); // not 'pwned'
  await direct.close();
});

test("the listener ignores the session cookie that the browser does send to its port", async ({ page, context }) => {
  const { pageId } = await savePage(page, articleUrl("/astronomy"));
  const grant = await page.request.post("/api/archive/frame-grants", { data: { pageId }, headers: CSRF });
  const archiveUrl = ((await grant.json()) as { url: string }).url;
  const cookies = await context.cookies();
  expect(cookies.some((c) => c.name === "ncb_session")).toBe(true); // the threat is real: cookies are shared across ports on one host
  const withCookies = await page.request.get(archiveUrl);
  const without = await (await page.context().browser()!.newContext()).request.get(archiveUrl);
  expect(withCookies.status()).toBe(200);
  expect(await withCookies.text()).toBe(await without.text());
  expect(withCookies.headers()["set-cookie"]).toBeUndefined();
});

test("a request that claims to come from the archive origin is refused by the API, with or without the session cookie", async ({ page, context }) => {
  const archiveOrigin = new URL(process.env.E2E_ARCHIVE_URL!).origin;
  const asArchive = { Origin: archiveOrigin, "Sec-Fetch-Site": "cross-site" };
  const get = await page.request.get("/api/auth/me", { headers: asArchive });
  expect(get.status()).toBe(403);
  expect(((await get.json()) as { error: string }).error).toBe("csrf");
  const post = await page.request.post("/api/system/connectivity", { data: { forceOffline: false }, headers: { ...asArchive, ...CSRF } });
  expect(post.status()).toBe(403);
  const noHeader = await page.request.post("/api/system/connectivity", { data: { forceOffline: false }, headers: { Origin: archiveOrigin } });
  expect(noHeader.status()).toBe(403);
  // and with no cookie at all, the API is closed
  const bare = await (await context.browser()!.newContext()).request.get(`${new URL(page.url()).origin}/api/auth/me`);
  expect(bare.status()).toBe(401);
});

test("the app cannot be framed, and the app's pages refuse to be embedded by anything", async ({ page, baseURL }) => {
  const res = await page.request.get("/login");
  expect(res.headers()["x-frame-options"]).toBe("DENY");
  expect(res.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  const api = await page.request.get("/api/system/health");
  expect(api.headers()["x-frame-options"]).toBe("DENY");
  expect(api.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  // a page on another origin that tries to frame the app gets nothing from it
  const other = await page.context().newPage();
  await other.route("http://attacker.invalid/**", (route) => route.fulfill({ contentType: "text/html", body: `<iframe id=f src="${baseURL}/login" width=400 height=300></iframe>` }));
  await other.goto("http://attacker.invalid/");
  await other.waitForTimeout(1500);
  const framed = other.frames().find((f) => f.url().startsWith(baseURL!));
  if (framed) expect(await framed.locator('input[name="password"], input[type="password"]').count()).toBe(0);
  await other.close();
});

test("an encoded spelling of an API path does not get around sign-in (regression: /%61pi/... skipped every API check)", async ({ playwright, baseURL }) => {
  const anon = await playwright.request.newContext({ baseURL: baseURL! });
  for (const p of ["/%61pi/settings", "/%61pi/storage/volumes", "/ap%69/system/status", "/%61%70%69/auth/sessions", "/api/%73ettings", "/api/../api/settings", "/api/./settings", "/api//settings"]) {
    const r = await anon.get(p, { maxRedirects: 0 });
    const body = await r.text();
    expect(body, `${p} -> ${r.status()}`).not.toMatch(/"appName"|"rootPath"|"sessions"/);
    if (/json/.test(r.headers()["content-type"] ?? "")) expect([401, 403, 404], `${p} -> ${r.status()}`).toContain(r.status());
  }
  await anon.dispose();
});

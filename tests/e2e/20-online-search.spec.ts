import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { articleUrl, login, mode, setWorkOffline, trackExternalRequests } from "./helpers";
import { startFakeSearx, webResults, type FakeSearx } from "./fakes";
import { addFake, addProvider, enableOnline, ensureLocalPages, positions, recordAnnouncements, resetOnline } from "./online-helpers";

// O-06, O-08, O-09, O-10 in the browser: progressive web results, freezing, the one announcement, offline, failures, hostile
// provider text, saving, coverage, back navigation and the event stream through the web proxy.
test.skip(mode() !== "real-server", "needs the real server");

const CSRF = { "X-NoCon-CSRF": "1" };
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
async function serious(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).exclude('iframe[data-testid="archive-frame"]').analyze();
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

const fakes: FakeSearx[] = [];
const fake = async (init: Parameters<typeof startFakeSearx>[0] = {}) => {
  const f = await startFakeSearx(init);
  fakes.push(f);
  return f;
};

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await login(page);
  await setWorkOffline(page, false);
  await ensureLocalPages(page);
  await page.close();
});
test.beforeEach(async ({ page }) => {
  await login(page);
  await setWorkOffline(page, false);
  await resetOnline(page);
  await enableOnline(page);
  const r = await page.request.patch("/api/settings/user", { data: { search: { resultsPerPage: 10 } }, headers: CSRF });
  expect(r.ok()).toBeTruthy();
});
test.afterEach(async ({ page }) => {
  await setWorkOffline(page, false);
  await resetOnline(page);
  for (const f of fakes.splice(0)) await f.close();
});

const items = (page: Page) => page.getByTestId("search-result");
const online = (page: Page) => page.locator('[data-testid="search-result"][data-origin="online"]');

test("local results come first, web results are appended below, and nothing above them moves", async ({ page, baseURL }) => {
  const external = trackExternalRequests(page, baseURL!);
  const f = await fake({ results: webResults(6), delayMs: 700 });
  await addFake(page, f);
  const announced = await recordAnnouncements(page);
  await page.goto("/search?q=astronomy");
  await expect(items(page).first()).toBeVisible();
  // The web has not answered yet: only saved pages are listed, and a fixed-height placeholder holds the place.
  await expect(online(page)).toHaveCount(0);
  await expect(page.getByTestId("online-placeholder")).toBeVisible();
  const before = await positions(page);
  const localKeys = Object.keys(before);
  expect(localKeys.length).toBeGreaterThan(0);
  await expect(online(page)).toHaveCount(6, { timeout: 10_000 });
  await expect(page.getByTestId("online-status")).toContainText("Web search finished");
  const after = await positions(page);
  for (const k of localKeys) expect(after[k], `result ${k} moved`).toBe(before[k]);
  // Appended after the last saved result, in the order they came.
  const order = await items(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.origin));
  expect(order.indexOf("online")).toBe(order.lastIndexOf("archive") + 1);
  await expect(online(page).first().getByTestId("result-providers")).toContainText("Fake web");
  // Counts, never a percentage.
  const strip = await page.getByTestId("coverage-strip").textContent();
  expect(strip).toMatch(/matches? in your saved pages/);
  expect(strip).toContain("6 found on the web");
  expect(strip).not.toContain("%");
  // One message was announced, and it is the summary.
  await expect.poll(async () => (await announced()).length).toBe(1);
  expect((await announced())[0]).toMatch(/results? for astronomy: \d+ from your saved pages, 6 from the web\./);
  expect(await serious(page)).toEqual([]);
  expect(external, "requests that left the app").toEqual([]);
});

test("after the Human hovers, scrolls or focuses, late results wait behind a button and nothing moves", async ({ page }) => {
  const f = await fake({ results: webResults(5), delayMs: 1300 });
  await addFake(page, f);
  const announced = await recordAnnouncements(page);
  await page.goto("/search?q=astronomy");
  await expect(items(page).first()).toBeVisible();
  const before = await positions(page);
  await items(page).first().hover();
  await page.waitForTimeout(450); // longer than 300 ms: the list is frozen
  await expect(page.getByTestId("show-new")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("show-new")).toHaveText("Show 5 new web results");
  await expect(online(page)).toHaveCount(0);
  expect(await positions(page)).toEqual(before);
  // The Human decides: the new ones are added at the end, and the others stay put.
  await page.getByTestId("show-new").click();
  await expect(online(page)).toHaveCount(5);
  const after = await positions(page);
  for (const k of Object.keys(before)) expect(after[k]).toBe(before[k]);
  expect((await announced()).length).toBeLessThanOrEqual(2); // the summary, then "shown at the end" for the Human's own click
  expect((await announced())[0]).toMatch(/for astronomy/);
});

test("focus moving into the results freezes them too", async ({ page }) => {
  const f = await fake({ results: webResults(4), delayMs: 1200 });
  await addFake(page, f);
  await page.goto("/search?q=astronomy");
  await expect(items(page).first()).toBeVisible();
  await items(page).first().getByTestId("result-title").focus();
  await expect(page.getByTestId("show-new")).toBeVisible({ timeout: 10_000 });
  await expect(online(page)).toHaveCount(0);
});

test("results that arrive after the two-second box wait; Load more from the web asks for the next page", async ({ page }) => {
  const f = await fake({ results: webResults(14), delayMs: 2600, pageSize: 10 });
  await addFake(page, f);
  const announced = await recordAnnouncements(page);
  await page.goto("/search?q=astronomy");
  await expect(items(page).first()).toBeVisible();
  const before = await positions(page);
  await expect(page.getByTestId("online-status")).toContainText("Still waiting for Fake web", { timeout: 5000 });
  await expect(page.getByTestId("show-new")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("online-status")).toContainText("after the first two seconds");
  await expect(online(page)).toHaveCount(0);
  expect(await positions(page)).toEqual(before);
  await page.getByTestId("show-new").click();
  await expect(online(page)).toHaveCount(10);
  for (const [k, y] of Object.entries(before)) expect((await positions(page))[k]).toBe(y);
  // The provider has a second page.
  const more = page.getByTestId("load-more-web");
  await expect(more).toBeVisible();
  const asked = page.waitForResponse((r) => /\/api\/search\/[^/]+\/more$/.test(r.url()) && r.request().method() === "POST");
  await more.click();
  expect((await asked).status()).toBe(202);
  await expect(online(page)).toHaveCount(14, { timeout: 15_000 });
  expect(f.requests.map((r) => r.pageno)).toEqual([1, 2]);
  for (const [k, y] of Object.entries(before)) expect((await positions(page))[k]).toBe(y);
  expect((await announced())[0]).toMatch(/for astronomy/);
});

test("a result that also appears locally moves it only when the Human asks: Re-rank with web results", async ({ page }) => {
  // The web puts a saved page that is low in the local order first, which would change the fused order.
  const local = (await (await page.request.post("/api/search", { data: { query: "astronomy", online: "off" }, headers: CSRF })).json()) as { results: { url: string; title: string; pageId: string }[] };
  expect(local.results.length).toBeGreaterThan(1);
  expect(new Set(local.results.map((r) => r.title)).size).toBe(local.results.length);
  const last = local.results[local.results.length - 1]!;
  const f = await fake({ results: [{ url: last.url, title: last.title, content: "also on the web" }, ...webResults(3)], delayMs: 500 });
  await addFake(page, f);
  await page.goto("/search?q=astronomy");
  await expect(items(page).first()).toBeVisible();
  const firstBefore = await items(page).first().getByTestId("result-details").getAttribute("href");
  await expect(page.getByTestId("rerank")).toBeVisible({ timeout: 10_000 });
  // The order did not change by itself.
  expect(await items(page).first().getByTestId("result-details").getAttribute("href")).toBe(firstBefore);
  const fused = page.waitForRequest((r) => r.url().includes("order=fused"));
  await page.getByTestId("rerank").click();
  await fused;
  // The promoted saved page is first now (compared by where it links to: the title shown is the server's).
  await expect(items(page).first().getByTestId("result-details")).toHaveAttribute("href", `/library/pages/${last.pageId}`);
  await expect(items(page).first().getByTestId("result-title")).toContainText(last.title);
  await expect(page.getByTestId("rerank")).toHaveCount(0);
});

test("the stream falls back to polling when it cannot be opened", async ({ page }) => {
  const f = await fake({ results: webResults(3), delayMs: 300 });
  await addFake(page, f);
  await page.route("**/api/search/*/events*", (route) => route.fulfill({ status: 500, body: "no stream" }));
  const polled = page.waitForRequest((r) => /\/api\/search\/[^/?]+\?after=\d+/.test(r.url()));
  await page.goto("/search?q=astronomy");
  await polled;
  await expect(online(page)).toHaveCount(3, { timeout: 15_000 });
  await expect(page.getByTestId("online-status")).toContainText("Web search finished");
});

test("online search off or forced offline: saved pages only, with an honest note and no provider request", async ({ page }) => {
  const f = await fake({ results: webResults(3) });
  await addFake(page, f);
  // Forced offline.
  await setWorkOffline(page, true);
  await page.goto("/search?q=astronomy");
  await expect(items(page).first()).toBeVisible();
  await expect(page.getByTestId("online-note")).toContainText("You are offline. Results come from your saved pages.");
  await expect(page.getByTestId("cat-online")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("cat-online")).toHaveAccessibleDescription("You are offline");
  await expect(online(page)).toHaveCount(0);
  await expect(page.getByTestId("online-strip")).toHaveCount(0);
  expect(await serious(page)).toEqual([]);
  await setWorkOffline(page, false);
  // Master switch off.
  await page.request.patch("/api/settings", { data: { privacy: { onlineSearch: { enabled: false } } }, headers: CSRF });
  await page.goto("/search?q=astronomy");
  await expect(items(page).first()).toBeVisible();
  await expect(page.getByText("Online search is off. Results come from your saved pages.")).toBeVisible();
  await expect(page.getByTestId("cat-online")).toHaveAccessibleDescription("Online search is off");
  expect(f.requests).toHaveLength(0);
});

test("the Online tab works when online search is on and a provider is set up", async ({ page }) => {
  const f = await fake({ results: webResults(3), delayMs: 100 });
  await addFake(page, f);
  await page.goto("/search?q=astronomy");
  const tab = page.getByTestId("cat-online");
  await expect(tab).not.toHaveAttribute("aria-disabled", "true");
  await tab.click();
  await expect(page).toHaveURL(/scope=online/);
  await expect(online(page)).toHaveCount(3, { timeout: 10_000 });
  await expect(page.locator('[data-testid="search-result"][data-origin="archive"]')).toHaveCount(0);
  expect(await serious(page)).toEqual([]);
});

test("a failing provider is named with its code, the others and the saved pages still answer", async ({ page }) => {
  const good = await fake({ results: webResults(3, "astronomy", "good.example.test", "Good") });
  const down = await fake({ fail: { status: 500, body: "boom" } });
  const limited = await fake({ fail: { status: 429, headers: { "retry-after": "30" } } });
  const broken = await fake({ fail: { status: 200, body: '{"results": [ {"title": "cut off", "url": ' } });
  const slow = await fake({ delayMs: 3000 });
  await addFake(page, good, "Good web", { priority: 1 });
  await addFake(page, down, "Down web", { priority: 2 });
  await addFake(page, limited, "Limited web", { priority: 3 });
  await addFake(page, broken, "Broken web", { priority: 4 });
  await addFake(page, slow, "Slow web", { priority: 5, timeoutMs: 800 });
  // A real fixture provider with a wrong key.
  await addProvider(page, { adapter: "brave", name: "Brave (wrong key)", baseUrl: process.env.E2E_BRAVE_URL, apiKey: "wrong-key", priority: 6 });
  await page.goto("/search?q=astronomy");
  await expect(items(page).first()).toBeVisible();
  await expect(page.getByTestId("online-status")).toContainText("Web search finished", { timeout: 20_000 });
  const codes = page.getByTestId("provider-error-code");
  await expect(codes).toHaveCount(5);
  const found = (await codes.allTextContents()).sort();
  expect(found).toEqual(["auth", "bad_request", "rate_limited", "timeout", "upstream"]);
  await expect(page.getByTestId("provider-run").filter({ hasText: "Down web" })).toContainText("upstream");
  await expect(page.getByTestId("provider-run").filter({ hasText: "Good web" })).toContainText("3 results");
  await expect(page.locator('[data-testid="search-result"][data-origin="archive"]').first()).toBeVisible();
  await expect(online(page).first()).toContainText("Good result");
  expect(await serious(page)).toEqual([]);
});

test("hostile provider titles, snippets and addresses are shown as text and never run", async ({ page, baseURL }) => {
  const external = trackExternalRequests(page, baseURL!);
  const dialogs: string[] = [];
  page.on("dialog", async (d) => {
    dialogs.push(d.message());
    await d.dismiss();
  });
  const f = await fake({
    results: [
      { url: "https://evil.example.test/one", title: '<img src=x onerror="window.__xss=1">Hostile title', content: '<script>window.__xss=2</script><b onmouseover="window.__xss=3">bold</b> &lt;i&gt; <iframe src="https://evil.example.test/frame"></iframe>' },
      { url: "javascript:window.__xss=4", title: "Script address", content: "dropped" },
      { url: "data:text/html,<script>window.__xss=5</script>", title: "Data address", content: "dropped" },
      { url: "ftp://files.example.test/x", title: "FTP address", content: "dropped" },
      { url: "https://evil.example.test/two", title: "<svg onload=window.__xss=6>SVG title", content: "plain" },
    ],
  });
  await addFake(page, f);
  await page.goto("/search?q=astronomy");
  await expect(online(page)).toHaveCount(2, { timeout: 15_000 });
  // The server turns provider markup into plain text; whatever is left is shown as text.
  await expect(online(page).first().getByTestId("result-title")).toContainText("Hostile title");
  await expect(online(page).first().getByTestId("result-snippet")).toContainText("bold");
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(dialogs).toEqual([]);
  expect(await page.locator("[data-testid=result-snippet] :not(mark)").count()).toBe(0);
  expect(await page.locator("[data-testid=result-title] :not(mark):not(.sr-only)").count()).toBe(0);
  expect(await page.locator('main img[src="x"], main iframe:not([data-testid="archive-frame"]), main script:not([src])').count()).toBe(0);
  expect(await page.locator('a[href^="javascript:" i], a[href^="data:" i], a[href^="ftp:" i]').count()).toBe(0);
  for (const href of await online(page).locator("a").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href))) expect(href).toMatch(/^https?:\/\//);
  // Online results never fetch an icon from the web.
  await expect(online(page).getByTestId("result-favicon")).toHaveCount(0);
  await page.getByTestId("online-strip").waitFor();
  expect(external, "requests that left the app").toEqual([]);
  expect(await serious(page)).toEqual([]);
});

test("save a web result, see it as saved with a link to the archive, and open it offline", async ({ page }) => {
  const url = articleUrl("/online-only/2");
  const f = await fake({ results: [{ url, title: "Offshore wind farm status dashboard (online only)", content: "Live renewable energy output for wind and solar sites." }, ...webResults(2, "energy")] });
  await addFake(page, f);
  await page.goto("/search?q=wind%20energy");
  const row = online(page).filter({ hasText: "Offshore wind farm" });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.getByTestId("result-availability")).toHaveText("Online only");
  const asked = page.waitForResponse((r) => /\/results\/[^/]+\/save$/.test(r.url()) && r.request().method() === "POST");
  await row.getByTestId("result-save").click();
  expect((await asked).status()).toBe(202);
  await expect(row.getByTestId("result-availability")).toHaveText("Saved", { timeout: 60_000 });
  await expect(row.getByTestId("result-save")).toHaveCount(0);
  // The title now opens the archived copy; the provider's text was not stored.
  await expect(row.getByTestId("result-details")).toHaveAttribute("href", /\/library\/pages\//);
  // The next search finds it locally.
  await expect
    .poll(async () => {
      const r = await page.request.post("/api/search", { data: { query: "offshore wind", online: "off" }, headers: CSRF });
      return ((await r.json()) as { results: { url: string }[] }).results.some((x) => x.url === url);
    }, { timeout: 60_000 })
    .toBe(true);
  // Offline, the saved page still opens.
  await setWorkOffline(page, true);
  await row.getByTestId("result-title").click();
  await expect(page.locator('iframe[data-testid="archive-frame"]:not([hidden])')).toBeVisible();
  await expect(page.frameLocator('iframe[data-testid="archive-frame"]').locator("body")).toContainText(/wind/i);
});

test("Improve offline coverage: counts, a choice of how, an estimate, then the queue", async ({ page }) => {
  const f = await fake({ results: [3, 4, 5].map((n) => ({ url: articleUrl(`/online-only/${n}`), title: `Online only ${n}`, content: "energy" })) });
  await addFake(page, f);
  await page.goto("/search?q=energy");
  await expect(online(page)).toHaveCount(3, { timeout: 15_000 });
  await expect(page.getByTestId("coverage-strip")).toContainText("3 not saved yet");
  await page.getByTestId("improve-coverage").click();
  const dialog = page.getByRole("dialog", { name: "Improve offline coverage" });
  await expect(dialog.getByTestId("coverage-candidates").getByRole("checkbox")).toHaveCount(3);
  expect(await serious(page)).toEqual([]);
  await dialog.getByLabel("Online only 5").uncheck();
  await dialog.getByLabel("Put the saved pages in a new collection").check();
  await dialog.getByLabel("Collection name").fill(`Energy ${Date.now() % 10000}`);
  await dialog.getByTestId("coverage-estimate").click();
  await expect(dialog.getByTestId("coverage-plan")).toBeVisible();
  await expect(dialog.getByTestId("coverage-basis")).toContainText("This is an estimate");
  await expect(dialog.getByTestId("coverage-plan")).not.toContainText("%");
  expect(await serious(page)).toEqual([]);
  const queued = page.waitForResponse((r) => r.url().endsWith("/api/search/coverage/queue"));
  await dialog.getByTestId("coverage-queue").click();
  const res = await queued;
  expect(res.status()).toBe(202);
  expect((await res.json()).queued).toBe(2);
  await expect(dialog).toHaveCount(0);
  await expect(online(page).filter({ hasText: "Online only 3" }).getByTestId("result-availability")).toHaveText(/Waiting to be saved|Saved/);
});

test("Back restores the same list from the snapshot without searching again", async ({ page }) => {
  const f = await fake({ results: webResults(4), delayMs: 300 });
  await addFake(page, f);
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/search")) posts.push(r.url());
  });
  await page.goto("/search?q=astronomy");
  await expect(online(page)).toHaveCount(4, { timeout: 15_000 });
  await expect(page.getByTestId("online-status")).toContainText("Web search finished");
  const keys = await items(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.resultKey));
  await items(page).first().getByTestId("result-title").click();
  await expect(page).toHaveURL(/\/$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/search\?q=astronomy/);
  await expect(items(page)).toHaveCount(keys.length);
  expect(await items(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.resultKey))).toEqual(keys);
  expect(posts).toHaveLength(1);
  expect(f.requests).toHaveLength(1);
});

test("the event stream passes through the web proxy as it happens, and resumes with Last-Event-ID", async ({ page, baseURL }) => {
  const f = await fake({ results: webResults(3), delayMs: 1500 });
  await addFake(page, f);
  const started = await page.request.post("/api/search", { data: { query: "astronomy" }, headers: CSRF });
  const { searchId } = (await started.json()) as { searchId: string };
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const t0 = Date.now();
  const res = await fetch(`${baseURL}/api/search/${searchId}/events`, { headers: { cookie, accept: "text/event-stream" } });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  expect(res.headers.get("content-length")).toBeNull();
  expect(res.headers.get("x-accel-buffering")).toBe("no");
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const seen: { type: string; at: number; seq: number }[] = [];
  const pump = async (until: (types: string[]) => boolean) => {
    while (!until(seen.map((s) => s.type))) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const type = /^event: (.+)$/m.exec(block)?.[1];
        const seq = Number(/^id: (\d+)$/m.exec(block)?.[1]);
        if (type) seen.push({ type, at: Date.now() - t0, seq });
      }
    }
  };
  await pump((t) => t.includes("provider_started"));
  // The provider takes 1.5 s: a buffering proxy would hold this event back until then.
  expect(seen[0]!.at).toBeLessThan(1000);
  await pump((t) => t.includes("provider_results"));
  expect(seen.find((s) => s.type === "provider_results")!.at).toBeGreaterThan(1200);
  await reader.cancel();
  // Resume: only events after the one named come back, and a client that has seen the end gets 204.
  const first = seen[0]!.seq;
  const again = await fetch(`${baseURL}/api/search/${searchId}/events`, { headers: { cookie, accept: "text/event-stream", "last-event-id": String(first) } });
  expect(again.status).toBe(200);
  const text = await again.text();
  expect(text).not.toContain("event: provider_started");
  expect(text).toContain("event: provider_results");
  expect(text).toContain("event: done");
  const last = Math.max(...[...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1])));
  const ended = await fetch(`${baseURL}/api/search/${searchId}/events`, { headers: { cookie, accept: "text/event-stream", "last-event-id": String(last) } });
  expect(ended.status).toBe(204);
});

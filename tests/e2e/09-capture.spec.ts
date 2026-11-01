import { expect, test } from "@playwright/test";
import { activeFrame, articleUrl, login, mode, openAddress, savePage, setWorkOffline } from "./helpers";

// A-15: single-page capture end to end, through the UI and the real server.
test.skip(mode() !== "real-server", "needs the real server");

test.beforeEach(async ({ page }) => {
  await login(page);
  await setWorkOffline(page, false);
});
test.afterEach(async ({ page }) => {
  await setWorkOffline(page, false);
});

test("enter a URL, save it, watch the progress, open the copy offline and follow a link to another saved page", async ({ page, baseURL }) => {
  const other = articleUrl("/solar-power");
  const url = articleUrl("/renewable-energy");
  await savePage(page, other);

  const seen: string[] = [];
  const external: string[] = [];
  const origins = new Set([new URL(baseURL!).origin, new URL(process.env.E2E_ARCHIVE_URL!).origin]);
  page.on("request", (r) => {
    if (/^(data|blob|about):/.test(r.url())) return;
    if (!origins.has(new URL(r.url()).origin)) external.push(r.url());
  });

  await openAddress(page, url);
  await expect(page.getByRole("heading", { name: "This page is not saved" })).toBeVisible();
  // Record what is announced to screen readers, and every progress line, as they change.
  await page.evaluate(() => {
    const w = window as unknown as { __seen: string[] };
    w.__seen = [];
    const note = () => {
      for (const sel of ['[data-testid="capture-announcer"]', '[data-testid="capture-label"]']) {
        const t = document.querySelector(sel)?.textContent?.trim();
        if (t && w.__seen[w.__seen.length - 1] !== t) w.__seen.push(t);
      }
    };
    new MutationObserver(note).observe(document.body, { subtree: true, childList: true, characterData: true });
  });

  await page.getByTestId("panel-save").click();
  const status = page.getByTestId("capture-status");
  await expect(status).toBeVisible();
  await expect(status).toHaveAttribute("data-state", "completed");
  await expect(status).toHaveAttribute("data-outcome", "created");
  await expect(page.getByTestId("capture-label")).toHaveText("Saved");
  seen.push(...(await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen)));
  expect(seen.some((s) => /^Saving 127\.0\.0\.1\./.test(s)), JSON.stringify(seen)).toBe(true);
  expect(seen.some((s) => /is saved\. It now opens offline\./.test(s)), JSON.stringify(seen)).toBe(true);
  await expect(page.getByTestId("capture-announcer")).toContainText("is saved");

  // Offline, using the switch in the header.
  await page.getByRole("switch", { name: "Work offline" }).click();
  await expect(page.getByTestId("connectivity")).toHaveAttribute("data-state", "offline");
  await page.getByTestId("open-saved").click();
  const fl = page.frameLocator('iframe[data-testid="archive-frame"]');
  await expect(fl.getByRole("heading", { level: 1, name: /Renewable energy/i })).toBeVisible();
  await expect(page.getByTestId("tab-source").first()).toHaveAttribute("data-source", "saved");

  // A link from this saved page to another saved page opens offline; one to an unsaved page says it is unavailable.
  const first = fl.locator('a[data-ncb-link="cached"]').filter({ hasNotText: /^$/ });
  expect(await first.count()).toBeGreaterThan(0);
  expect(await fl.locator('a[data-ncb-link="unavailable"]').count()).toBeGreaterThan(0);
  const solar = fl.locator('a[data-ncb-link="cached"]', { hasText: /solar/i }).first();
  await solar.click();
  await expect(page.getByRole("textbox", { name: "Address or search terms" })).toHaveValue(other);
  await expect(fl.getByRole("heading", { level: 1, name: /Solar/i })).toBeVisible();
  expect(external, "nothing left the app and the archive").toEqual([]);
});

test("a second save of an unchanged page creates no new version", async ({ page }) => {
  const url = articleUrl("/geothermal-energy");
  const first = await savePage(page, url);
  const second = await savePage(page, url);
  expect(first.pageId).toBeTruthy();
  const res = await page.request.get(`/api/archive/captures/${second.downloadId}`);
  expect(await res.json()).toMatchObject({ outcome: "unchanged", label: "Already saved, nothing has changed" });
  const versions = await page.request.get(`/api/archive/versions?pageId=${first.pageId}`);
  expect(((await versions.json()) as { items: unknown[] }).items).toHaveLength(1);
});

test("a save made while offline is queued, shown as queued, and runs when work offline is switched off", async ({ page }) => {
  const url = articleUrl("/hydropower");
  await openAddress(page, url);
  await expect(page.getByRole("heading", { name: "This page is not saved" })).toBeVisible();
  await page.getByRole("switch", { name: "Work offline" }).click();
  await expect(page.getByTestId("connectivity")).toHaveAttribute("data-state", "offline");
  await expect(page.getByTestId("tab-source").first()).toHaveAttribute("data-source", "offline");

  // The page tells the Human what is possible: queue it.
  await page.getByTestId("save-button").click();
  await expect(page.getByTestId("capture-label")).toHaveText("Waiting for the connection to return");
  await expect(page.getByTestId("capture-announcer")).toContainText("Queued.");
  const row = await page.request.get("/api/archive/captures");
  const items = ((await row.json()) as { items: { url: string; held: boolean }[] }).items;
  expect(items.find((i) => i.url === url)?.held).toBe(true);

  await page.getByRole("switch", { name: "Work offline" }).click();
  await expect(page.getByTestId("capture-status")).toHaveAttribute("data-state", "completed");
  await expect(page.getByTestId("capture-label")).toHaveText("Saved");
});

test("the Downloads page lists saves with their state", async ({ page }) => {
  await savePage(page, articleUrl("/biomass"));
  await page.goto("/downloads");
  await expect(page.getByRole("heading", { level: 1, name: "Downloads" })).toBeVisible();
  const row = page.getByTestId("download-row").filter({ hasText: "/biomass" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Saved");
});

test("the save page used by the listener's notices saves an address with the Human's own session", async ({ page }) => {
  const url = articleUrl("/wind-power");
  await page.goto(`/save?url=${encodeURIComponent(url)}`);
  await expect(page.getByRole("heading", { level: 1, name: "Save a page for offline" })).toBeVisible();
  await expect(page.getByTestId("save-url")).toHaveText(url);
  await page.getByTestId("save-start").click();
  await expect(page.getByTestId("capture-status")).toHaveAttribute("data-state", "completed");
  const r = await page.request.post("/api/browser/resolve", { data: { input: url }, headers: { "X-NoCon-CSRF": "1" } });
  expect(((await r.json()) as { resolution: { kind: string } }).resolution.kind).toBe("archive");
});

test("a page that cannot be saved reports a plain failure", async ({ page }) => {
  await openAddress(page, articleUrl("/this-page-does-not-exist"));
  await page.getByTestId("panel-save").click();
  await expect(page.getByTestId("capture-status")).toHaveAttribute("data-state", "failed");
  await expect(page.getByTestId("capture-label")).toContainText("Could not be saved");
  await expect(activeFrame(page)).toHaveCount(0);
});

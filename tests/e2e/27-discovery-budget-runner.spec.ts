import { expect, test } from "@playwright/test";
import { login, mode, setWorkOffline } from "./helpers";
import { CSRF, candidates, enableDiscovery, resetDiscovery, rowFor, seedCandidates, showState, waitDownloadDone } from "./discovery-helpers";

// D-07: budget meters with text equivalents, the ledger, the runner panel and the kill switch.
test.skip(mode() !== "real-server", "needs the real server");

interface Budget { active: { requests: { used: number; limit: number }; bytes: { used: number; limit: number } }; background: { requests: { used: number; limit: number } }; month: { requests: number }; perSite: { cap: number; top: { host: string; requests: number }[] }; queue: { limit: number }; pool: { limit: number } }

test.beforeEach(async ({ page }) => {
  await login(page);
  await setWorkOffline(page, false);
  await resetDiscovery(page);
});
test.afterEach(async ({ page }) => {
  await resetDiscovery(page);
});

test("with discovery off the runner says so in plain words", async ({ page }) => {
  await page.goto("/discovery/budget");
  await expect(page.getByRole("heading", { level: 1, name: "Budget and runner" })).toBeVisible();
  await expect(page.getByTestId("runner-state")).toHaveText("Off");
  await expect(page.getByTestId("runner-headline")).toContainText("Discovery is off");
  await expect(page.getByTestId("runner-blockers").locator("li")).toContainText(["Discovery is switched off in the settings."]);
  await expect(page.getByTestId("kill-state")).toContainText("not paused");
});

test("every meter has its figures in words, and they match the server", async ({ page }) => {
  await enableDiscovery(page);
  await page.goto("/discovery/budget");
  const b = (await (await page.request.get("/api/discovery/budget")).json()) as Budget;
  const reqText = page.getByTestId("meter-active-requests-text");
  await expect(reqText).toContainText(`${b.active.requests.used} of ${b.active.requests.limit} requests used`);
  await expect(page.getByTestId("meter-active-bytes-text")).toContainText("used");
  await expect(page.getByTestId("meter-background-requests-text")).toContainText(`of ${b.background.requests.limit} requests used`);
  await expect(page.getByTestId("meter-queue-text")).toContainText(`of ${b.queue.limit} at once`);
  await expect(page.getByTestId("meter-pool-text")).toContainText(`of ${b.pool.limit}`);
  await expect(page.getByTestId("month-total")).toContainText("downloaded");
  // Each bar is a progressbar whose name carries the same text, so it reads the same without sight.
  const bar = page.getByTestId("meter-active-requests").getByRole("progressbar");
  expect(await bar.getAttribute("aria-label")).toContain("requests used");
  const now = Number(await bar.getAttribute("aria-valuenow"));
  expect(now).toBe(Math.round(Math.min(100, (b.active.requests.used / b.active.requests.limit) * 100)));
});

test("a pass shows in the runner panel, the per-site list and the ledger", async ({ page }) => {
  await enableDiscovery(page);
  const fresh = await seedCandidates(page);
  const target = fresh[0]!;
  const ok = await page.request.post(`/api/discovery/candidates/${target.id}/approve`, { headers: CSRF, data: {} });
  expect(ok.ok()).toBeTruthy();
  const before = (await (await page.request.get("/api/discovery/budget")).json()) as Budget;

  await page.goto("/discovery/budget");
  await expect(page.getByTestId("runner-state")).toHaveText("Ready");
  await expect(page.getByTestId("runner-headline")).toContainText("every 30 seconds");
  await expect(page.getByTestId("no-pass").or(page.getByTestId("last-pass"))).toBeVisible();
  await page.getByTestId("run-pass").click();
  await expect(page.getByTestId("last-pass")).toContainText("started by you");
  await expect(page.getByTestId("pass-active")).toContainText("started");

  const c = (await (await page.request.get(`/api/discovery/candidates/${target.id}`)).json()) as { downloadId?: string };
  expect(c.downloadId).toBeTruthy();
  await waitDownloadDone(page, c.downloadId!);

  await expect
    .poll(async () => ((await (await page.request.get("/api/discovery/budget")).json()) as Budget).active.requests.used, { timeout: 20_000 })
    .toBe(before.active.requests.used + 1);
  await expect(page.getByTestId("meter-active-requests-text")).toContainText(`${before.active.requests.used + 1} of`, { timeout: 15_000 });
  await expect(page.getByTestId("per-site-row").filter({ hasText: "127.0.0.1" })).toHaveCount(1);
  await expect(page.getByTestId("per-site-table")).toContainText("Requests today");
  const ledger = page.getByTestId("ledger-row").first();
  await expect(ledger).toBeVisible();
  await expect(ledger).toContainText("Active runner");
  await expect(ledger).toContainText("127.0.0.1");
  await page.getByLabel("Show", { exact: true }).selectOption("auto_cache");
  await expect(page.getByText("Nothing in the ledger yet")).toBeVisible();
});

test("the kill switch: confirmation to pause, nothing starts while paused, resume restores it", async ({ page }) => {
  await enableDiscovery(page);
  const fresh = await seedCandidates(page);
  const target = fresh[0]!;
  await page.request.post(`/api/discovery/candidates/${target.id}/approve`, { headers: CSRF, data: {} });

  await page.goto("/discovery/budget");
  const pause = page.getByTestId("kill-pause");
  await expect(pause).toBeVisible();
  await expect(page.getByRole("heading", { name: /Kill switch/ })).toBeVisible();

  // Cancel leaves it running, and focus returns to the button.
  await pause.click();
  const dialog = page.getByTestId("pause-dialog");
  await expect(dialog).toContainText("No discovery download will start");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(pause).toBeFocused();
  expect(((await (await page.request.get("/api/discovery/runner")).json()) as { killSwitch: { paused: boolean } }).killSwitch.paused).toBe(false);

  // Confirm pauses.
  await pause.click();
  await page.getByTestId("pause-confirm").click();
  await expect(page.getByTestId("kill-state")).toContainText("paused");
  await expect(page.getByTestId("runner-state")).toHaveText("Paused");
  await expect(page.getByTestId("runner-headline")).toContainText("Paused by the kill switch");
  expect(((await (await page.request.get("/api/discovery/runner")).json()) as { killSwitch: { paused: boolean } }).killSwitch.paused).toBe(true);
  await expect(page.getByTestId("kill-resume")).toBeVisible();

  // A pass now starts nothing, and says why.
  await page.getByTestId("run-pass").click();
  await expect(page.getByTestId("pass-active")).toContainText("kill switch");
  expect(((await (await page.request.get(`/api/discovery/candidates/${target.id}`)).json()) as { state: string }).state).toBe("approved");

  // The candidates page says so too.
  await page.goto("/discovery");
  await expect(page.getByTestId("discovery-paused")).toBeVisible();

  // Resume restores it.
  await page.goto("/discovery/budget");
  await page.getByTestId("kill-resume").click();
  await expect(page.getByTestId("kill-state")).toContainText("not paused");
  await expect(page.getByTestId("kill-pause")).toBeVisible();
  await page.getByTestId("run-pass").click();
  await expect.poll(async () => ((await (await page.request.get(`/api/discovery/candidates/${target.id}`)).json()) as { state: string }).state, { timeout: 20_000 }).toMatch(/queued|archived/);
  const id = ((await (await page.request.get(`/api/discovery/candidates/${target.id}`)).json()) as { downloadId: string }).downloadId;
  await waitDownloadDone(page, id);
});

test("the pause survives a reload", async ({ page }) => {
  await enableDiscovery(page);
  await page.goto("/discovery/budget");
  await page.getByTestId("kill-pause").click();
  await page.getByTestId("pause-confirm").click();
  await expect(page.getByTestId("kill-state")).toContainText("paused");
  await page.reload();
  await expect(page.getByTestId("runner-state")).toHaveText("Paused");
  await expect(page.getByTestId("kill-resume")).toBeVisible();
});

test("the runner polls while the page is open, and stops when the tab is hidden", async ({ page }) => {
  await enableDiscovery(page);
  let runnerCalls = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/discovery/runner")) runnerCalls++;
  });
  await page.goto("/discovery/budget");
  await expect(page.getByTestId("runner-state")).toBeVisible();
  const settled = runnerCalls;
  // Hide the tab: the interval fires but nothing is requested.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hiddenStart = runnerCalls;
  await page.waitForTimeout(3000);
  expect(runnerCalls).toBe(hiddenStart);
  expect(settled).toBeGreaterThanOrEqual(1);
  // Showing it again refreshes at once.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => runnerCalls).toBeGreaterThan(hiddenStart);
});

test("approved candidates wait when downloading is off, and the page says so", async ({ page }) => {
  await enableDiscovery(page, { active: { mode: "off" } });
  const fresh = await seedCandidates(page);
  const target = fresh[0]!;
  await page.request.post(`/api/discovery/candidates/${target.id}/approve`, { headers: CSRF, data: {} });
  await page.goto("/discovery");
  await showState(page, "approved");
  await expect(rowFor(page, target).getByTestId("candidate-job")).toContainText("downloading is off");
  expect((await candidates(page, "state=approved")).items.map((c) => c.id)).toContain(target.id);
});

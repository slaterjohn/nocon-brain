import { expect, test } from "@playwright/test";
import { login, mode, setWorkOffline } from "./helpers";
import { CSRF, ensurePackage } from "./zim-helpers";

// Phase 8 interface: the Wikipedia topic form with its preview and start, and the status panel. The server talks to the fake Wikimedia
// server of the fixture sites (NCB_WIKIPEDIA_ORIGIN), never to wikipedia.org.
test.skip(mode() !== "real-server", "needs the real server and libzim");
test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await login(page);
  await ensurePackage(page, "wiki");
  await page.close();
});
test.beforeEach(async ({ page }) => {
  await login(page);
  await setWorkOffline(page, false);
});

test("the status panel: contact set, requests running normally, nothing to reset", async ({ page }) => {
  await page.goto("/library/wikipedia");
  await expect(page.getByRole("navigation", { name: "Library sections" }).getByRole("link", { name: "Wikipedia" })).toHaveAttribute("aria-current", "page");
  const panel = page.getByTestId("wikipedia-status");
  await expect(panel.getByTestId("wiki-contact")).toHaveText("Set");
  await expect(panel.getByTestId("wiki-breaker")).toHaveAttribute("data-state", "closed");
  await expect(panel).toContainText("At most one request every 1 seconds");
  await expect(panel).toContainText("Running normally");
  await expect(panel).toContainText("NoConBrain/");
  await expect(panel.getByTestId("wiki-reset")).toBeDisabled();
  await expect(page.getByTestId("wiki-contact-help")).toHaveCount(0);
  // The reset call itself works and answers with the status.
  const r = await page.request.post("/api/wikipedia/reset", { headers: CSRF });
  expect(r.ok()).toBeTruthy();
});

test("the form checks its fields, then the preview shows the cost with later levels as estimates, and the start waits for it", async ({ page }) => {
  await page.goto("/library/wikipedia");
  await page.getByTestId("wiki-preview-button").click();
  await expect(page.getByTestId("error-summary")).toBeFocused();
  await expect(page.getByTestId("error-summary")).toContainText("Enter an article title or a Wikipedia address");
  await page.getByTestId("wiki-start").fill("Astronomy");
  await page.getByTestId("wiki-depth").fill("4");
  await page.getByTestId("wiki-max-pages").fill("5000");
  await page.getByTestId("wiki-preview-button").click();
  await expect(page.getByTestId("error-summary")).toContainText("0 to 3");
  await expect(page.getByTestId("error-summary")).toContainText("1 to 2,000");
  await expect(page.getByTestId("wiki-start-button")).toBeDisabled();

  await page.getByTestId("wiki-depth").fill("2");
  await page.getByTestId("wiki-max-pages").fill("30");
  await page.getByTestId("wiki-images").uncheck();
  await page.getByTestId("wiki-preview-button").click();
  const preview = page.getByTestId("wiki-preview");
  await expect(preview).toBeVisible();
  await expect(preview.getByTestId("preview-title")).toHaveText("Astronomy");
  const rows = preview.getByTestId("preview-level");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("The article");
  await expect(rows.nth(1)).not.toContainText("estimate");
  await expect(rows.nth(2)).toContainText("Level 2 (estimate)");
  await expect(rows.nth(2)).toHaveAttribute("data-estimated", "true");
  await expect(preview.getByTestId("preview-time")).toContainText("about");
  await expect(preview.getByTestId("preview-requests")).not.toBeEmpty();
  await expect(preview.getByTestId("preview-coverage")).toContainText(/already in Wikipedia \(fixture\) and would not be fetched/);
  await expect(preview).toContainText("All figures are estimates");
  // The preview has the focus, and the start is now allowed.
  await expect(page.getByTestId("wiki-start-button")).toBeEnabled();
  // Changing anything the preview was made for turns the start off again.
  await page.getByTestId("wiki-depth").fill("1");
  await expect(page.getByTestId("wiki-start-button")).toBeDisabled();
});

test("an article Wikipedia does not have is said in words", async ({ page }) => {
  await page.goto("/library/wikipedia");
  await page.getByTestId("wiki-start").fill("Zzz no such article qq");
  await page.getByTestId("wiki-preview-button").click();
  await expect(page.getByTestId("error-summary")).toContainText("no article with that title");
  await expect(page.getByTestId("wiki-preview")).toHaveCount(0);
});

test("starting the crawl makes a normal source and download job that finishes", async ({ page }) => {
  await page.goto("/library/wikipedia");
  await page.getByTestId("wiki-start").fill("Black hole");
  await page.getByTestId("wiki-depth").fill("1");
  await page.getByTestId("wiki-max-pages").fill("2");
  await page.getByTestId("wiki-images").uncheck();
  await page.getByRole("button", { name: "Advanced settings" }).click();
  await page.getByLabel("Name of the source").fill("Black hole topic (UI test)");
  await page.getByTestId("wiki-preview-button").click();
  await expect(page.getByTestId("wiki-preview")).toBeVisible();
  await page.getByTestId("wiki-start-button").click();
  const started = page.getByTestId("wiki-started");
  await expect(started).toBeVisible();
  await expect(started.getByRole("link", { name: "Black hole topic (UI test)" })).toBeVisible();

  // It is a source like any other, and its downloads finish.
  await started.getByRole("link", { name: "Black hole topic (UI test)" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Black hole topic (UI test)" })).toBeVisible();
  const list = (await (await page.request.get("/api/sources?limit=200")).json()) as { items: { id: string; name: string; adapter: string }[] };
  const src = list.items.find((s) => s.name === "Black hole topic (UI test)");
  expect(src?.adapter).toBe("wikipedia");
  await expect
    .poll(async () => ((await (await page.request.get(`/api/sources/${src!.id}/stats`)).json()) as { pages: number }).pages, { timeout: 45_000 })
    .toBeGreaterThan(0);
  await page.goto("/downloads");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

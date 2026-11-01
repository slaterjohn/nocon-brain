import { expect, test } from "@playwright/test";
import { ADMIN_USER, login, mode } from "./helpers";

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("dashboard shows worker status, storage, job counts and last update", async ({ page }) => {
  await page.getByRole("navigation", { name: "Areas" }).getByRole("link", { name: "Storage and settings" }).click();
  await page.getByRole("link", { name: "Open the dashboard" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();

  await expect(page.getByRole("heading", { level: 2, name: "Workers" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Worker status" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Storage" })).toBeVisible();
  await expect(page.getByText(/used,.*available/)).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Storage used" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Jobs" })).toBeVisible();
  await expect(page.getByText("Failed in the last 24 hours")).toBeVisible();
  await expect(page.getByTestId("last-update")).toContainText("Last update:");

  if (mode() === "mock-api") {
    const row = page.getByRole("row", { name: /Job runner/ });
    await expect(row).toContainText("Busy");
    await expect(page.getByRole("row", { name: /Page renderer/ })).toContainText("Off");
    await expect(page.getByText("2.3 GB used, 90.8 GB available")).toBeVisible();
  }
});

test("dashboard shows an error with a retry when the API fails", async ({ page }) => {
  await page.route("**/api/system/dashboard", (r) =>
    r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal", message: "The dashboard broke.", requestId: "x" }) }),
  );
  await page.goto("/storage/dashboard");
  await expect(page.getByRole("alert").filter({ hasText: "The dashboard broke." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("activity log filters by level and area and loads more", async ({ page }) => {
  const real = mode() !== "mock-api";
  // The mock has error rows. A fresh real server has none, and no user action produces one, so seed a real
  // warn-level row deterministically: a failed sign-in is logged as warn in area auth.
  // The level under test is "error" for the mock and "warn" for the real server.
  const level = real ? "warn" : "error";
  const levelText = real ? "Warning" : "Error";
  if (real) {
    const r = await page.request.post("/api/auth/login", {
      data: { username: ADMIN_USER, password: "definitely-not-the-password" },
      headers: { "X-NoCon-CSRF": "1" },
    });
    expect(r.status()).toBe(401);
  }

  await page.goto("/storage/activity");
  await expect(page.getByRole("heading", { level: 1, name: "Activity log" })).toBeVisible();
  const rows = page.getByTestId("log-row");
  await expect(rows.first()).toBeVisible();

  if (!real) {
    await expect(rows).toHaveCount(50);
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(rows).toHaveCount(100);
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(rows).toHaveCount(130);
    await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  }

  const req = page.waitForRequest((r) => r.url().includes("/api/system/logs") && r.url().includes(`level=${level}`));
  await page.getByLabel("Level", { exact: true }).selectOption(level);
  await req;
  await expect(rows.first()).toBeVisible();
  const levels = await page.locator("td:nth-child(2)").allTextContents();
  expect(levels.length).toBeGreaterThan(0);
  for (const text of levels) expect(text).toBe(levelText);
  if (real) await expect(rows.filter({ hasText: "Failed sign-in attempt" }).first()).toBeVisible();

  const req2 = page.waitForRequest((r) => r.url().includes("area=storage") && r.url().includes(`level=${level}`));
  await page.getByLabel("Area", { exact: true }).selectOption("storage");
  await req2;

  // No storage row has this level in either mode (the mock's levels and areas never coincide here), so the empty state shows.
  await expect(page.getByRole("heading", { name: "No entries match these filters" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(rows.first()).toBeVisible();
});

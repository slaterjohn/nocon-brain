import { expect, test, type Page } from "@playwright/test";
import { login, mode, setWorkOffline } from "./helpers";
import { CSRF, resetDiscovery } from "./discovery-helpers";

// D-07: the Discovery settings page. Everything off by default, plain-language explanations, the automatic-mode acknowledgement,
// server validation errors mapped to fields, and the limits that are really in force.
test.skip(mode() !== "real-server", "needs the real server");

interface View { settings: Record<string, any>; effective: Record<string, any>; profile: string; profileMaximums: Record<string, number> }
const view = async (page: Page) => (await (await page.request.get("/api/discovery/settings")).json()) as View;

let startProfile = "standard";
test.beforeEach(async ({ page }) => {
  await login(page);
  startProfile = (await view(page)).profile;
  await setWorkOffline(page, false);
  await resetDiscovery(page);
});
test.afterEach(async ({ page }) => {
  await resetDiscovery(page);
  await page.request.patch("/api/settings", { headers: CSRF, data: { resources: { profile: startProfile } } });
});

test("reached from the settings hub; everything is off by default and each setting says so", async ({ page }) => {
  await page.goto("/storage");
  await page.getByRole("link", { name: "Open discovery settings" }).click();
  await expect(page).toHaveURL(/\/discovery\/settings$/);
  await expect(page.getByRole("heading", { level: 1, name: "Discovery settings" })).toBeVisible();
  await expect(page.getByTestId("defaults-state")).toContainText("Everything is off");

  for (const key of ["enabled", "passive.fromLinks", "passive.fromVisits", "passive.fromBookmarks", "passive.fromMissingLinks", "passive.fromSavedSearches", "searchDriven.searchesInfluenceDiscovery", "searchDriven.autoCacheOpenedOnlinePages", "searchDriven.prioritiseFrequentTopics"]) {
    await expect(page.getByTestId(`set-${key}`)).not.toBeChecked();
    await expect(page.getByTestId(`default-${key}`)).toHaveText("Default: off.");
  }
  // Asking before downloading search-driven pages is on by default.
  await expect(page.getByTestId("set-searchDriven.requireApproval")).toBeChecked();
  await expect(page.getByTestId("mode-off")).toBeChecked();
  await expect(page.getByTestId("settings-save")).toBeDisabled();

  // Every control has a label and a description wired to it.
  const switches = page.getByTestId("settings-form").getByRole("switch");
  const n = await switches.count();
  expect(n).toBeGreaterThanOrEqual(10);
  for (let i = 0; i < n; i++) {
    const sw = switches.nth(i);
    expect(await sw.getAttribute("aria-describedby"), `switch ${i} has a description`).toBeTruthy();
  }
  // The advanced settings are closed until asked for.
  const limits = page.getByRole("button", { name: /^Limits/ });
  await expect(limits).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("set-active.maxDepth")).toBeHidden();
  await limits.click();
  await expect(page.getByTestId("set-active.maxDepth")).toBeVisible();
  await expect(page.getByTestId("set-active.maxDepth")).toHaveValue("1");
  await expect(page.getByText("Default: 1.").first()).toBeVisible();
  await expect(page.getByTestId("online-only")).toContainText("cannot be changed");
});

test("switching things on and saving persists, and the page says what changed", async ({ page }) => {
  await page.goto("/discovery/settings");
  await page.getByTestId("set-enabled").click();
  await page.getByTestId("set-passive.fromLinks").click();
  await expect(page.getByTestId("settings-state")).toHaveText("You have changes that are not saved.");
  await page.getByTestId("mode-approval").check();
  await page.getByRole("button", { name: /^Limits/ }).click();
  await page.getByTestId("set-active.maxRequestsPerDay").fill("40");
  await page.getByTestId("set-active.maxBytesPerDay").fill("64");
  await expect(page.getByRole("button", { name: /^Limits/ })).toContainText("2 changed");
  await page.getByTestId("settings-save").click();
  await expect(page.getByText("Settings saved")).toBeVisible();
  await expect(page.getByTestId("settings-state")).toHaveText("No unsaved changes.");
  await expect(page.getByTestId("defaults-state")).toContainText("Discovery is set up");

  const v = await view(page);
  expect(v.settings.enabled).toBe(true);
  expect(v.settings.passive.fromLinks).toBe(true);
  expect(v.settings.active.mode).toBe("approval");
  expect(v.settings.active.maxRequestsPerDay).toBe(40);
  expect(v.settings.active.maxBytesPerDay).toBe(64 * 1024 * 1024);
  expect(v.effective.active.maxRequestsPerDay).toBe(40);

  // It is still there after a reload; Discard puts back what was saved.
  await page.reload();
  await expect(page.getByTestId("set-enabled")).toBeChecked();
  await page.getByTestId("set-passive.fromVisits").click();
  await page.getByTestId("settings-discard").click();
  await expect(page.getByTestId("set-passive.fromVisits")).not.toBeChecked();
  await expect(page.getByTestId("settings-save")).toBeDisabled();
});

test("automatic mode needs an explicit acknowledgement, and is not set until it is given", async ({ page }) => {
  await page.request.put("/api/discovery/settings", { headers: CSRF, data: { enabled: true, active: { mode: "approval" } } });
  await page.goto("/discovery/settings");
  await expect(page.getByTestId("mode-approval")).toBeChecked();

  // Cancel: the mode stays, and focus goes back to where it was.
  await page.getByTestId("mode-automatic").click();
  const dialog = page.getByTestId("ack-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("without asking each time");
  await expect(page.getByTestId("ack-confirm")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("mode-approval")).toBeChecked();
  await expect(page.getByTestId("mode-automatic")).toBeFocused();
  await expect(page.getByTestId("settings-save")).toBeDisabled();

  // Confirm: the box must be ticked first.
  await page.getByTestId("mode-automatic").click();
  await page.getByTestId("ack-checkbox").click();
  await expect(page.getByTestId("ack-confirm")).toBeEnabled();
  await page.getByTestId("ack-confirm").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("mode-automatic")).toBeChecked();
  await expect(page.getByTestId("ack-pending")).toBeVisible();
  // Nothing has been sent yet.
  expect((await view(page)).settings.active.mode).toBe("approval");

  await page.getByTestId("settings-save").click();
  await expect(page.getByText("Settings saved")).toBeVisible();
  const v = await view(page);
  expect(v.settings.active.mode).toBe("automatic");
  expect(v.settings.active.automaticAcknowledgedAt).not.toBeNull();

  // Going back needs no acknowledgement and clears it.
  await page.getByTestId("mode-off").check();
  await page.getByTestId("settings-save").click();
  await expect(page.getByText("Settings saved").first()).toBeVisible();
  const after = await view(page);
  expect(after.settings.active.mode).toBe("off");
  expect(after.settings.active.automaticAcknowledgedAt).toBeNull();
});

test("the server refuses automatic mode without the acknowledgement", async ({ page }) => {
  const r = await page.request.put("/api/discovery/settings", { headers: CSRF, data: { active: { mode: "automatic" } } });
  expect(r.status()).toBe(400);
  expect(JSON.stringify(await r.json())).toContain("acknowledged");
});

test("a ceiling above the profile maximum is refused, mapped to its field, and listed in the error summary", async ({ page }) => {
  const v = await view(page);
  const tooMuch = Math.floor(v.profileMaximums.maxBytesPerDay / (1024 * 1024)) + 1;
  await page.goto("/discovery/settings");
  const ceilings = page.getByRole("button", { name: /^Global ceilings/ });
  await ceilings.click();
  await expect(page.getByTestId("set-ceilings.maxBytesPerDay")).toBeVisible();
  await expect(page.locator("#dset-ceilings-maxBytesPerDay-hint")).toContainText(/Highest allowed on the .* profile: [\d,]+ MiB/);
  await page.getByTestId("set-ceilings.maxBytesPerDay").fill(String(tooMuch));
  await page.getByTestId("settings-save").click();

  const summary = page.getByTestId("error-summary");
  await expect(summary).toBeVisible();
  await expect(summary).toBeFocused();
  await expect(summary).toContainText("cannot be more than");
  const field = page.getByTestId("set-ceilings.maxBytesPerDay");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#dset-ceilings-maxBytesPerDay-error")).toContainText("cannot be more than");
  expect(await field.getAttribute("aria-describedby")).toContain("dset-ceilings-maxBytesPerDay-error");

  // The summary links to the field.
  await summary.getByRole("link").first().click();
  await expect(field).toBeFocused();
  // Nothing was saved.
  expect((await view(page)).settings.ceilings.maxBytesPerDay).toBe(v.settings.ceilings.maxBytesPerDay);

  // Fixing the number clears the message and saves.
  await field.fill("256");
  await expect(page.locator("#dset-ceilings-maxBytesPerDay-error")).toHaveCount(0);
  await page.getByTestId("settings-save").click();
  await expect(page.getByText("Settings saved")).toBeVisible();
  expect((await view(page)).settings.ceilings.maxBytesPerDay).toBe(256 * 1024 * 1024);
});

test("a limit above its ceiling opens the section it is in and says to raise the ceiling first", async ({ page }) => {
  await page.goto("/discovery/settings");
  await page.getByRole("button", { name: /^Limits/ }).click();
  await page.getByTestId("set-active.maxDepth").fill("9"); // the ceiling is 3
  await page.getByRole("button", { name: /^Limits/ }).click(); // close it again: the error must open it
  await expect(page.getByRole("button", { name: /^Limits/ })).toHaveAttribute("aria-expanded", "false");
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("error-summary")).toContainText("raise the ceiling first");
  await expect(page.getByRole("button", { name: /^Limits/ })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("set-active.maxDepth")).toHaveAttribute("aria-invalid", "true");
  expect((await view(page)).settings.active.maxDepth).toBe(1);
});

test("a box that is not a number is caught before anything is sent", async ({ page }) => {
  await page.goto("/discovery/settings");
  await page.getByRole("button", { name: /^Scoring weights/ }).click();
  await page.getByTestId("set-weights.bookmarks").fill("lots");
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("error-summary")).toContainText("enter a number");
  await expect(page.getByTestId("set-weights.bookmarks")).toHaveAttribute("aria-invalid", "true");
  await page.getByTestId("set-weights.bookmarks").fill("150");
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("error-summary")).toContainText("cannot be more than 100");
});

test("the limits in force are shown, and a profile maximum that caps a setting is explained", async ({ page }) => {
  // Start from the larger profile so a bigger setting can be saved, then move to the smaller one.
  const toStandard = await page.request.patch("/api/settings", { headers: CSRF, data: { resources: { profile: "standard" } } });
  test.skip(!toStandard.ok(), `the profile cannot be changed here: ${await toStandard.text()}`);
  const before = await view(page);
  expect(before.profile).toBe("standard");
  await page.goto("/discovery/settings");
  const rows = page.getByTestId("limit-row");
  await expect(rows).toHaveCount(9);
  await expect(page.getByTestId("pmax-bytes")).toContainText("MiB");
  for (const r of await rows.all()) await expect(r).toHaveAttribute("data-capped", "false");
  await expect(page.getByTestId("capped-note")).toHaveCount(0);

  // Raise the data ceiling and daily limit to 3 GiB, which the standard profile allows, then move to pi-lite (2 GiB).
  const gib3 = 3 * 1024 * 1024 * 1024;
  const r1 = await page.request.put("/api/discovery/settings", { headers: CSRF, data: { ceilings: { maxBytesPerDay: gib3 }, active: { maxBytesPerDay: gib3 } } });
  expect(r1.ok(), await r1.text()).toBeTruthy();
  const r2 = await page.request.patch("/api/settings", { headers: CSRF, data: { resources: { profile: "pi-lite" } } });
  expect(r2.ok(), await r2.text()).toBeTruthy();
  await page.goto("/discovery/settings");
  const bytes = page.locator('[data-testid="limit-row"][data-key="activeBytes"]');
  await expect(bytes).toHaveAttribute("data-capped", "true");
  await expect(bytes.getByTestId("limit-reason")).toContainText("pi-lite profile maximum");
  await expect(bytes.getByTestId("limit-effective")).toHaveText("2,048 MiB");
  await expect(page.getByTestId("capped-note")).toBeVisible();
  // Saving anything now is refused until the ceiling is brought under the new maximum, and the error names the field.
  await page.getByRole("button", { name: /^Global ceilings/ }).click();
  await page.getByTestId("set-enabled").click();
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("error-summary")).toContainText("pi-lite");
  await expect(page.getByTestId("set-ceilings.maxBytesPerDay")).toHaveAttribute("aria-invalid", "true");
});

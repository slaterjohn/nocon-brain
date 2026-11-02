import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { login, mode, setWorkOffline } from "./helpers";
import { CSRF, resetPolicy, serious } from "./storage-helpers";

// T-09: the policy editor (with the P2 permit warning flow) and volume management.
test.skip(mode() !== "real-server", "needs the real server");

test.beforeEach(async ({ page }) => {
  await login(page);
  await setWorkOffline(page, false);
  await resetPolicy(page);
});
test.afterEach(async ({ page }) => {
  await resetPolicy(page);
});

const policy = async (page: import("@playwright/test").Page) => (await (await page.request.get("/api/storage/policy")).json()) as { permitImportantEviction: boolean; permitAcknowledgedAt: string | null; autoEviction: boolean; volumeThresholds: { volumeId: string; softPct: number; evictStartPct: number; evictTargetPct: number }[] };

test("turning on the P2 permit shows a warning and needs an explicit acknowledgement", async ({ page }) => {
  await page.goto("/storage/policy");
  await expect(page.getByRole("heading", { level: 1, name: "Storage policy" })).toBeVisible();
  // Protected content is never removed automatically: said plainly, in two places.
  await expect(page.getByTestId("policy-protected")).toContainText("Protected (P1) content is never removed automatically");
  await expect(page.getByTestId("permit-section").getByTestId("protected-note")).toBeVisible();
  const permit = page.getByTestId("pol-permit");
  await expect(permit).not.toBeChecked();

  // The server itself refuses the permit without the acknowledgement.
  const refused = await page.request.put("/api/storage/policy", { headers: CSRF, data: { permitImportantEviction: true } });
  expect(refused.status()).toBe(400);
  expect(JSON.stringify(await refused.json())).toContain("storage.acknowledged");

  // The switch opens a warning; nothing changes yet. Escape backs out and focus returns to the switch.
  await permit.click();
  const dialog = page.getByRole("dialog", { name: "Allow removal of Important content?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("permit-warning")).not.toBeEmpty();
  await expect(dialog).toContainText("Protected (P1) content is still never removed automatically");
  await expect(dialog.getByTestId("permit-confirm")).toBeDisabled();
  expect(await serious(page)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(permit).toBeFocused();
  await expect(permit).not.toBeChecked();
  expect((await policy(page)).permitImportantEviction).toBe(false);

  // By keyboard: open again, tick the acknowledgement, confirm.
  await permit.focus();
  await page.keyboard.press("Space");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/I understand that Important content can now be removed/).check();
  await expect(dialog.getByTestId("permit-confirm")).toBeEnabled();
  await dialog.getByTestId("permit-confirm").click();
  await expect(dialog).toHaveCount(0);
  await expect(permit).toBeChecked();
  await expect(page.getByTestId("permit-state")).toContainText("On. Confirmed");
  const on = await policy(page);
  expect(on.permitImportantEviction).toBe(true);
  expect(on.permitAcknowledgedAt).not.toBeNull();

  // Turning it off needs no warning and clears the acknowledgement.
  await permit.click();
  await expect(permit).not.toBeChecked();
  await expect(page.getByTestId("permit-state")).toContainText("Off");
  const off = await policy(page);
  expect(off.permitImportantEviction).toBe(false);
  expect(off.permitAcknowledgedAt).toBeNull();
});

test("the other policy settings save, with advanced options behind a disclosure", async ({ page }) => {
  await page.goto("/storage/policy");
  const adv = page.getByRole("button", { name: /Advanced settings: grace period/ });
  await expect(adv).toHaveAttribute("aria-expanded", "false");
  await page.getByTestId("pol-auto").click();
  await page.getByTestId("policy-save").click();
  await expect(page.getByTestId("policy-status")).toHaveText("Policy saved.");
  expect((await policy(page)).autoEviction).toBe(false);

  // A bad advanced value opens the section and moves focus to the field.
  await page.getByTestId("pol-auto").click();
  await page.getByRole("button", { name: /Advanced settings: grace period/ }).click();
  await page.getByLabel("Forecast period (days)").fill("3");
  await page.getByTestId("policy-save").click();
  await expect(page.getByLabel("Forecast period (days)")).toBeFocused();
  await expect(page.getByText("Enter whole days from 7 to 365.")).toBeVisible();
  await page.getByLabel("Forecast period (days)").fill("45");
  await page.getByTestId("policy-save").click();
  await expect(page.getByTestId("policy-status")).toHaveText("Policy saved.");
  await page.getByLabel("Forecast period (days)").fill("30");
  await page.getByTestId("policy-save").click();
});

test("volume thresholds are validated and saved", async ({ page }) => {
  await page.goto("/storage/policy");
  const form = page.getByTestId("threshold-form").first();
  const before = (await policy(page)).volumeThresholds[0]!;
  await form.getByLabel("Start removing at (%)").fill("70");
  await form.getByLabel("Slow downloads at (%)").fill("80");
  await form.getByRole("button", { name: /Save thresholds/ }).click();
  await expect(form.getByText("The soft threshold can't be above the eviction start.")).toBeVisible();
  await expect(form.getByLabel("Slow downloads at (%)")).toBeFocused();
  await form.getByLabel("Slow downloads at (%)").fill("60");
  await form.getByLabel("Stop removing at (%)").fill("50");
  await form.getByRole("button", { name: /Save thresholds/ }).click();
  await expect(page.getByText("Thresholds saved")).toBeVisible();
  const after = (await policy(page)).volumeThresholds[0]!;
  expect([after.softPct, after.evictStartPct, after.evictTargetPct]).toEqual([60, 70, 50]);
  // Put them back.
  const r = await page.request.patch(`/api/storage/volumes/${before.volumeId}`, { headers: CSRF, data: { thresholds: { softPct: before.softPct, evictStartPct: before.evictStartPct, evictTargetPct: before.evictTargetPct } } });
  expect(r.ok(), await r.text()).toBeTruthy();
});

test("volumes: add, edit, see an offline volume honestly, and remove", async ({ page }) => {
  const root = path.join(process.env.E2E_VOLUMES_ROOT!, `extra-${Date.now() % 100000}`);
  fs.mkdirSync(root, { recursive: true });
  const name = `Extra ${Date.now() % 100000}`;
  await page.goto("/storage/volumes");
  await expect(page.getByRole("heading", { level: 1, name: "Volumes" })).toBeVisible();
  await expect(page.getByTestId("volume-item").first()).toContainText("Default volume");

  // Add: a missing folder is reported, then it is saved.
  await page.getByTestId("volume-add").click();
  const dialog = page.getByRole("dialog", { name: "Add a volume" });
  expect(await serious(page)).toEqual([]);
  await dialog.getByTestId("volume-save").click();
  await expect(dialog.getByText("Enter a name.")).toBeVisible();
  await expect(dialog.getByLabel("Name", { exact: true })).toBeFocused();
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog.getByLabel("Folder").fill(root);
  await dialog.getByLabel("Limit for NoConBrain", { exact: true }).fill("5");
  await dialog.getByTestId("volume-save").click();
  await expect(dialog).toHaveCount(0);
  const item = page.getByTestId("volume-item").filter({ hasText: name });
  await expect(item).toBeVisible();
  await expect(item.getByTestId("volume-state")).toHaveText("Online");
  await expect(item).toContainText("Limit set for NoConBrain");
  await expect(item.getByTestId("volume-preferred")).toContainText("No source prefers this volume.");

  // Edit: rename, and thresholds sit in the advanced section.
  await item.getByTestId("volume-edit").click();
  const edit = page.getByRole("dialog", { name: `Edit ${name}` });
  await expect(edit.getByRole("button", { name: /Advanced settings/ })).toHaveAttribute("aria-expanded", "false");
  await edit.getByLabel("Name", { exact: true }).fill(`${name} renamed`);
  await edit.getByRole("button", { name: /Advanced settings/ }).click();
  await edit.getByLabel("Stop removing at").fill("95");
  await edit.getByTestId("volume-save").click();
  await expect(edit.getByText("The eviction target must be below the eviction start.")).toBeVisible();
  await edit.getByLabel("Stop removing at").fill("75");
  await edit.getByTestId("volume-save").click();
  await expect(edit).toHaveCount(0);
  const renamed = page.getByTestId("volume-item").filter({ hasText: `${name} renamed` });
  await expect(renamed).toBeVisible();

  // Check: reports only.
  await renamed.getByTestId("volume-verify").click();
  const verify = page.getByRole("dialog", { name: `Check ${name} renamed` });
  await expect(verify.getByTestId("verify-result")).toContainText("A test write worked.", { timeout: 15_000 });
  await verify.getByRole("button", { name: "Close", exact: true }).first().click();

  // An unplugged drive is shown as offline, with what that means, and it recovers on its own.
  const marker = path.join(root, ".noconbrain-volume");
  const saved = fs.readFileSync(marker);
  fs.rmSync(marker);
  await page.reload();
  const off = page.getByTestId("volume-item").filter({ hasText: `${name} renamed` });
  await expect(off.getByTestId("volume-state")).toHaveText("Offline");
  await expect(off.getByTestId("offline-note")).toContainText("Nothing on it is removed");
  expect(await serious(page)).toEqual([]);
  fs.writeFileSync(marker, saved);
  await page.reload();
  await expect(page.getByTestId("volume-item").filter({ hasText: `${name} renamed` }).getByTestId("volume-state")).toHaveText("Online");

  // Remove asks first. An empty volume goes.
  await page.getByTestId("volume-item").filter({ hasText: `${name} renamed` }).getByTestId("volume-remove").click();
  const confirm = page.getByRole("dialog", { name: `Remove ${name} renamed?` });
  await expect(confirm).toContainText("does not delete the folder");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("volume-item").filter({ hasText: `${name} renamed` })).toBeVisible();
  await page.getByTestId("volume-item").filter({ hasText: `${name} renamed` }).getByTestId("volume-remove").click();
  await page.getByTestId("volume-remove-confirm").click();
  await expect(page.getByTestId("volume-item").filter({ hasText: `${name} renamed` })).toHaveCount(0);
});

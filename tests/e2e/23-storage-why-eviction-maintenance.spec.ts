import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { login, mode, setWorkOffline } from "./helpers";
import { deleteSource, makeSourcedPage, resetPolicy, serious } from "./storage-helpers";

// T-09: "why was this kept / evicted", pin and unpin, the removal plan reasons and run, the record, and maintenance.
test.skip(mode() !== "real-server", "needs the real server");

test.beforeEach(async ({ page }) => {
  await login(page);
  await setWorkOffline(page, false);
  await resetPolicy(page);
});

test("why was this kept: from the Library, with references, copies, history, pin and unpin", async ({ page }) => {
  const name = `Why ${Date.now() % 100000}`;
  const { source, pageId, url } = await makeSourcedPage(page, name, "/tide-pools", "P3");
  try {
    // Reachable from the page detail, and from the Library list.
    await page.goto(`/library/pages/${pageId}`);
    await page.getByTestId("detail-why-kept").click();
    await expect(page).toHaveURL(new RegExp(`/storage/pages/${pageId}$`));
    await page.goto("/library");
    await page.getByLabel("Search saved pages").fill("tide");
    await expect(page.getByTestId("library-row").filter({ hasText: "tide-pools" }).getByTestId("why-kept-link").first()).toBeVisible();

    await page.goto(`/storage/pages/${pageId}`);
    await expect(page.getByRole("heading", { level: 1, name: "Why is this page kept?" })).toBeVisible();
    await expect(page.getByTestId("why-url")).toHaveText(url);
    await expect(page.getByTestId("why-headline")).toHaveText("This page can be removed automatically if space runs short.");
    await expect(page.getByTestId("why-decision")).toHaveText("Can be removed");
    await expect(page.getByTestId("why-reasons").getByRole("listitem").first()).not.toBeEmpty();
    const ref = page.getByTestId("reference-row").filter({ hasText: name });
    await expect(ref).toContainText("P3 Standard");
    await expect(ref).toContainText("Allowed");
    await expect(page.getByTestId("why-version")).toHaveCount(1);
    await expect(page.getByTestId("why-history")).toContainText("No copy of this page has been removed.");
    await expect(page.getByTestId("protected-note")).toContainText("never removed automatically");
    expect(await serious(page)).toEqual([]);

    // Pin at P1: it is then kept, and the reference list says so.
    await page.getByTestId("pin-priority").selectOption("P1");
    await page.locator("#pin-reason").fill("Needed for the e2e check");
    await page.getByTestId("pin").click();
    await expect(page.getByTestId("pin-state")).toContainText("Pinned at");
    await expect(page.getByTestId("pin-state")).toContainText("Needed for the e2e check");
    await expect(page.getByTestId("pin-status")).toContainText("Page pinned at P1 Protected.");
    await expect(page.getByTestId("why-headline")).toHaveText("Automatic removal can't take this page now.");
    await expect(page.getByTestId("reference-row").filter({ hasText: "Pin" })).toContainText("P1 Protected");
    const pinned = (await (await page.request.get(`/api/storage/pages/${pageId}`)).json()) as { pin: { priority: string } | null; page: { effectivePriority: string } };
    expect(pinned.pin?.priority).toBe("P1");
    expect(pinned.page.effectivePriority).toBe("P1");

    // Unpin.
    await page.getByTestId("unpin").click();
    await expect(page.getByTestId("pin")).toBeVisible();
    await expect(page.getByTestId("why-headline")).toHaveText("This page can be removed automatically if space runs short.");
    expect(((await (await page.request.get(`/api/storage/pages/${pageId}`)).json()) as { pin: unknown }).pin).toBeNull();
  } finally {
    await deleteSource(page, source.id);
  }
});

test("an insufficient plan says so and cannot be run", async ({ page }) => {
  await page.goto("/storage/eviction");
  await expect(page.getByTestId("protected-note")).toContainText("Protected (P1) content is never removed automatically");
  await page.getByRole("button", { name: /Advanced settings/ }).click();
  await page.getByTestId("ev-need").fill("900");
  await page.getByLabel("Room needed, unit").selectOption("TB");
  await page.getByTestId("plan-preview").click();
  await expect(page.getByTestId("plan-sufficiency")).toHaveText("Insufficient");
  await expect(page.getByTestId("plan-headline")).toHaveText(/^Not enough\./);
  await expect(page.getByTestId("plan-insufficient")).toContainText("Nothing is removed from an insufficient plan");
  await expect(page.getByTestId("plan-run")).toBeDisabled();
  expect(await serious(page)).toEqual([]);
});

test("the plan lists reasons, running it asks first, and the run shows in the history and the record", async ({ page }) => {
  const name = `Cheap ${Date.now() % 100000}`;
  const { source, url } = await makeSourcedPage(page, name, "/mars", "P4");
  try {
    await page.goto("/storage/eviction");
    await page.getByRole("button", { name: /Advanced settings/ }).click();
    await page.getByTestId("ev-need").fill("0.000001");
    await page.getByLabel("Room needed, unit").selectOption("MB");
    await page.getByTestId("plan-preview").click();
    await expect(page.getByTestId("plan-sufficiency")).toHaveText("Enough");
    await expect(page.getByTestId("plan-headline")).toHaveText(/^Would free /);
    await expect(page.getByTestId("plan-steps")).toBeVisible();
    const first = page.getByTestId("plan-item").first();
    await expect(first.getByTestId("plan-item-reason")).not.toBeEmpty();
    await expect(page.getByTestId("plan-skipped")).toBeVisible();
    expect(await serious(page)).toEqual([]);

    const runsBefore = ((await (await page.request.get("/api/storage/eviction/runs")).json()) as { items: unknown[] }).items.length;

    // Cancel keeps everything.
    await page.getByTestId("plan-run").click();
    const dialog = page.getByRole("dialog", { name: "Run this plan?" });
    await expect(dialog.getByTestId("run-confirm-text")).toContainText("can't be brought back");
    expect(await serious(page)).toEqual([]);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("plan-run")).toBeFocused();
    expect(((await (await page.request.get("/api/storage/eviction/runs")).json()) as { items: unknown[] }).items.length).toBe(runsBefore);

    // Confirm removes.
    await page.getByTestId("plan-run").click();
    await page.getByTestId("run-confirm").click();
    await expect(page.getByTestId("run-result")).toContainText("removed");
    await expect(page.getByTestId("run-history").getByTestId("run-row").first()).toContainText("Finished");
    expect(((await (await page.request.get("/api/storage/eviction/runs")).json()) as { items: unknown[] }).items.length).toBe(runsBefore + 1);

    // The record lists it, with the reason, and links to the page's own history.
    await page.goto("/storage/audit");
    await expect(page.getByRole("heading", { level: 1, name: "Removal record" })).toBeVisible();
    const row = page.getByTestId("audit-row").filter({ hasText: "Removed automatically" }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText(/\w+/);
    expect(await serious(page)).toEqual([]);
    await page.getByTestId("audit-kind").selectOption("evicted");
    await expect(page.getByTestId("audit-row").first()).toHaveAttribute("data-kind", "evicted");
    await page.getByTestId("audit-kind").selectOption("deleted");
    await expect(page.getByTestId("audit-row").filter({ hasText: "Removed automatically" })).toHaveCount(0);
    await page.getByTestId("audit-kind").selectOption("evicted");
    await page.getByTestId("audit-row").first().getByRole("link").first().click();
    await expect(page).toHaveURL(/\/storage\/pages\//);
    await expect(page.getByTestId("why-history").getByTestId("audit-row").first()).toContainText("Removed automatically");
    await expect(page.getByTestId("why-version").first()).toHaveAttribute("data-status", /evicted|ready|partial/);
    void url;
  } finally {
    await deleteSource(page, source.id);
  }
});

test("maintenance: a verify is a dry run by default, repair asks first and quarantines instead of deleting", async ({ page }) => {
  const vols = (await (await page.request.get("/api/storage/volumes")).json()) as { items: { rootPath: string; isDefault: boolean }[] };
  const root = vols.items.find((v) => v.isDefault)!.rootPath;
  const stray = path.join(root, "blobs", "ab", "cd", crypto.randomBytes(32).toString("hex"));
  fs.mkdirSync(path.dirname(stray), { recursive: true });
  fs.writeFileSync(stray, "not in the archive");
  try {
    await page.goto("/storage/maintenance");
    await expect(page.getByRole("heading", { level: 1, name: "Check and repair" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Advanced settings: choose checks/ })).toHaveAttribute("aria-expanded", "false");
    expect(await serious(page)).toEqual([]);

    await page.getByTestId("verify-run").click();
    const report = page.getByTestId("maintenance-report");
    await expect(report.getByTestId("report-mode")).toHaveText("Dry run: nothing was changed");
    await expect(report.getByTestId("report-headline")).toContainText("This was a dry run: nothing was changed.");
    const finding = report.getByTestId("finding").filter({ hasText: "I-2" });
    await expect(finding).toContainText("A file on a volume has no database row");
    expect(fs.existsSync(stray), "a dry run changes nothing").toBe(true);
    await expect(page.getByTestId("maintenance-runs").getByTestId("maintenance-run").first()).toContainText("Dry run");
    expect(await serious(page)).toEqual([]);

    // Repair is behind a confirmation that says what happens to the file.
    await page.getByTestId("repair-open").click();
    const dialog = page.getByRole("dialog", { name: "Repair what was found?" });
    await expect(dialog.getByTestId("repair-quarantine-note")).toContainText("quarantined, not deleted");
    expect(await serious(page)).toEqual([]);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(fs.existsSync(stray)).toBe(true);
    await page.getByTestId("repair-open").click();
    await page.getByTestId("repair-confirm").click();
    await expect(page.getByTestId("report-mode")).toHaveText("Repair run");
    await expect(page.getByTestId("finding").filter({ hasText: "I-2" })).toContainText("Moved to the volume's quarantine folder; nothing was deleted.");
    expect(fs.existsSync(stray)).toBe(false);
    const q = fs.readdirSync(path.join(root, "quarantine"));
    expect(q.some((f) => f.endsWith(path.basename(stray)))).toBe(true);

    // The next dry run is clean for that check, and an earlier report can be reopened.
    await page.getByTestId("verify-run").click();
    await expect(page.getByTestId("finding").filter({ hasText: "I-2" })).toHaveCount(0);
    await page.getByTestId("maintenance-runs").getByTestId("maintenance-run").filter({ hasText: "Changes made" }).first().getByRole("button", { name: /View report/ }).click();
    await expect(page.getByTestId("report-mode")).toHaveText("Repair run");

    // Backup.
    await page.getByTestId("backup-run").click();
    await expect(page.getByTestId("backup-result")).toContainText(/Written: (main-.*\.db|backup-.*\/main\.db)/);
  } finally {
    fs.rmSync(stray, { force: true });
  }
});

test("a throttled P4 download shows why it is waiting", async ({ page }) => {
  // The server-side behaviour is covered by an integration test; here the screen is given the reason the API now sends.
  const job = {
    id: "dl_throttled", kind: "capture", state: "queued", priority: "P4", queueOrder: 1, title: "Waiting for room", requestedBy: "schedule", requestedUrl: "https://example.org/x",
    progress: { pagesDone: 0, pagesFailed: 0, bytesDone: 0 }, attempts: 0, controls: { pause: true, resume: false, cancel: true, retry: false, setPriority: true },
    wait: { reason: "throttled", message: "Waiting" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await page.route("**/api/downloads?*", (route) => route.fulfill({ json: { items: [job], total: 1 } }));
  await page.route("**/api/downloads/queue", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ json: { ...body, counts: { ...(body.counts as object), queued: 1 }, storageThrottle: { downloads: 1 } } });
  });
  await page.goto("/downloads");
  await page.getByTestId("tab-queued").click();
  const wait = page.getByTestId("download-wait");
  await expect(wait).toContainText("Opportunistic (P4) downloads are paused while storage is above its soft threshold");
  await expect(wait).toHaveAttribute("data-reason", "throttled");
  await expect(page.getByTestId("storage-throttle")).toContainText("1 background download is waiting because storage is nearly full.");
  expect(await serious(page)).toEqual([]);
});

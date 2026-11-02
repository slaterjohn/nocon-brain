import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { login, mode, setWorkOffline } from "./helpers";
import { startFakeSearx, webResults, type FakeSearx } from "./fakes";
import { resetOnline } from "./online-helpers";

// O-07 in the UI: the online search settings page, the provider list and form, the disclosure, write-only keys, tests and usage.
test.skip(mode() !== "real-server", "needs the real server");

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
async function serious(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).exclude('iframe[data-testid="archive-frame"]').analyze();
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

let fake: FakeSearx;
test.beforeAll(async () => {
  fake = await startFakeSearx({ results: webResults(3) });
});
test.afterAll(async () => fake.close());
test.beforeEach(async ({ page }) => {
  await login(page);
  await setWorkOffline(page, false);
  await resetOnline(page);
});
test.afterEach(async ({ page }) => {
  await resetOnline(page);
});

test("the provider flow: disclosure first, write-only key, test, usage, edit, delete", async ({ page }) => {
  const braveUrl = process.env.E2E_BRAVE_URL!;
  const braveKey = process.env.E2E_BRAVE_TOKEN!;
  await page.goto("/storage");
  await page.getByRole("link", { name: "Open online search settings" }).click();
  await expect(page).toHaveURL(/\/storage\/online-search$/);
  await expect(page.getByRole("heading", { level: 1, name: "Online search" })).toBeVisible();
  await expect(page.getByTestId("online-master")).not.toBeChecked();
  await expect(page.getByTestId("brave-statement")).toContainText("Results from Brave Search are never stored");
  await expect(page.getByText("No search providers")).toBeVisible();
  expect(await serious(page)).toEqual([]);

  // Add SearXNG. The server wants the disclosure read before the first switch-on, so the dialog appears and nothing is saved before it.
  await page.getByTestId("provider-add").click();
  const form = page.getByRole("dialog", { name: "Add a search provider" });
  await form.getByLabel("Name", { exact: true }).fill("My SearXNG");
  await form.getByLabel("Address of the SearXNG server").fill(fake.url);
  expect(await serious(page)).toEqual([]);
  await form.getByTestId("provider-save").click();
  const disclosure = page.getByRole("dialog", { name: "Before you search the web" });
  await expect(disclosure).toBeVisible();
  await expect(disclosure.getByTestId("disclosure-text")).not.toBeEmpty();
  const list = await (await page.request.get("/api/search/providers")).json();
  expect(list.items).toHaveLength(0);
  expect(list.online.acknowledgedAt).toBeNull();
  await expect(disclosure.getByTestId("disclosure-confirm")).toBeDisabled();
  expect(await serious(page)).toEqual([]);
  await disclosure.getByLabel("I have read this and want to search the web.").check();
  await disclosure.getByTestId("disclosure-confirm").click();
  await expect(page.getByTestId("provider-card").filter({ hasText: "My SearXNG" })).toBeVisible();
  expect((await (await page.request.get("/api/search/providers")).json()).online.acknowledgedAt).not.toBeNull();

  // The master switch is separate and needs no second disclosure now.
  await page.getByTestId("online-master").click();
  await expect(page.getByTestId("online-master")).toBeChecked();
  await expect(page.getByTestId("online-state-text")).toContainText("On. Your search words go to the providers");

  // Brave, with a key. The key is never shown again.
  await page.getByTestId("provider-add").click();
  const bform = page.getByRole("dialog", { name: "Add a search provider" });
  await bform.getByLabel("Provider").selectOption("brave");
  await expect(bform.getByTestId("storage-note")).toContainText("never stored");
  await bform.getByLabel("Key", { exact: true }).fill(braveKey);
  await bform.getByRole("button", { name: "Advanced settings" }).click();
  await bform.getByLabel("Address override").fill(braveUrl);
  await bform.getByLabel("Requests allowed per day").fill("50");
  await bform.getByTestId("provider-save").click();
  const brave = page.getByTestId("provider-card").filter({ hasText: "Brave Search" });
  await expect(brave).toBeVisible();
  await expect(brave.getByTestId("provider-key-saved")).toHaveText("Key saved");
  await expect(brave.getByTestId("usage-day")).toContainText("0 of 50 requests");
  expect(await page.content()).not.toContain(braveKey);
  expect(JSON.stringify(await (await page.request.get("/api/search/providers")).json())).not.toContain(braveKey);

  // Edit: the key field is empty, it says a key is saved, and the page still holds no secret.
  await brave.getByTestId("provider-edit").click();
  const edit = page.getByRole("dialog", { name: "Edit Brave Search" });
  await expect(edit.getByTestId("key-saved")).toHaveText("Key saved");
  await expect(edit.getByLabel("Key", { exact: true })).toHaveValue("");
  expect(await page.content()).not.toContain(braveKey);
  await edit.getByLabel("Priority").fill("1");
  await edit.getByLabel("If it fails, ask").selectOption({ label: "My SearXNG" });
  await edit.getByTestId("provider-save").click();
  await expect(edit).toHaveCount(0);
  await expect(brave).toContainText("If it fails: My SearXNG");

  // Test button and usage.
  await brave.getByTestId("provider-test").click();
  await expect(brave.getByTestId("provider-test-result")).toContainText("Working", { timeout: 15_000 });
  await expect(brave.getByTestId("provider-health")).toHaveText("Working");
  await expect(brave.getByTestId("usage-day")).toContainText("1 of 50 requests");
  await brave.getByTestId("provider-usage").click();
  await expect(brave.getByTestId("usage-history")).toBeVisible();

  // A wrong key is reported with its code, and the key is replaced without being shown.
  await brave.getByTestId("provider-edit").click();
  await page.getByRole("dialog", { name: "Edit Brave Search" }).getByLabel("Key", { exact: true }).fill("not-the-key");
  await page.getByRole("dialog", { name: "Edit Brave Search" }).getByTestId("provider-save").click();
  await brave.getByTestId("provider-test").click();
  await expect(brave.getByTestId("provider-test-result")).toContainText("auth", { timeout: 15_000 });
  expect(await serious(page)).toEqual([]);

  // Switch off, then delete.
  await brave.getByTestId("provider-enabled").click();
  await expect(brave.getByTestId("provider-enabled")).not.toBeChecked();
  await brave.getByTestId("provider-delete").click();
  await page.getByTestId("provider-delete-confirm").click();
  await expect(brave).toHaveCount(0);
  await expect(page.getByTestId("provider-card")).toHaveCount(1);
});

test("validation errors are listed in a summary and keep the dialog open", async ({ page }) => {
  await page.goto("/storage/online-search");
  await page.getByTestId("provider-add").click();
  const form = page.getByRole("dialog", { name: "Add a search provider" });
  await form.getByTestId("provider-save").click();
  await expect(form.getByTestId("error-summary")).toContainText("Enter the address of the SearXNG server");
  await expect(form).toBeVisible();
  expect(await serious(page)).toEqual([]);
  await form.getByLabel("Provider").selectOption("mojeek");
  await form.getByTestId("provider-save").click();
  await expect(form.getByTestId("error-summary")).toContainText("Enter the key");
  await page.keyboard.press("Escape");

  await expect(page.getByTestId("online-master")).not.toBeChecked();
});

for (const scheme of ["light", "dark"] as const) {
  test(`${scheme} theme: the settings page with a provider has no serious axe violations`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.request.post("/api/search/providers", { data: { adapter: "searxng", name: "Axe provider", baseUrl: fake.url, enabled: true, acknowledged: true }, headers: { "X-NoCon-CSRF": "1" } });
    await page.goto("/storage/online-search");
    await expect(page.getByTestId("provider-card")).toBeVisible();
    expect(await serious(page)).toEqual([]);
  });
}

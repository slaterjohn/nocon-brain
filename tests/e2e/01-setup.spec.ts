import { expect, test } from "@playwright/test";
import path from "node:path";
import { ADMIN_PASSWORD, ADMIN_USER, trackExternalRequests } from "./helpers";

// Runs first (file order, one worker): creates the administrator that every later spec signs in as.
test("setup wizard, first run with no search providers", async ({ page, baseURL }) => {
  const external = trackExternalRequests(page, baseURL!);
  const volumes = process.env.E2E_VOLUMES_ROOT!;

  // Nothing is set up, so the app sends a visitor to the wizard.
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);

  // Step 1: administrator.
  await expect(page.getByRole("heading", { level: 1, name: "Create the administrator account" })).toBeVisible();
  await page.getByLabel("Username").fill(ADMIN_USER);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByLabel("Confirm password").fill("something-else-entirely");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("The two passwords don't match.")).toBeVisible();
  await page.getByLabel("Confirm password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();

  // Step 2: storage. A path outside the allowed roots is refused with a message, and nothing is registered.
  await expect(page.getByRole("heading", { level: 1, name: /Choose where to keep archived pages/ })).toBeFocused();
  await page.getByLabel("Folder path").fill("/etc");
  await page.getByRole("button", { name: "Check folder" }).click();
  await expect(page.getByRole("alert").first()).toContainText(/allowed|outside|root/i);
  await expect(page.getByRole("heading", { level: 1, name: /Choose where to keep archived pages/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use this folder" })).toHaveCount(0);

  // A folder on the container's own filesystem is checked on blur. Its warnings show before anything is registered.
  const folder = page.getByLabel("Folder path");
  await folder.fill(path.join(volumes, "container-fs"));
  await folder.blur();
  await expect(page.getByTestId("storage-checks")).toContainText("This folder can be used");
  if (process.env.E2E_MODE !== "real-server") {
    await expect(page.getByRole("list", { name: "Warnings" })).toContainText("container's own filesystem");
  }
  // The real server decides which warnings apply to a temp directory, so only check them when they appear.
  const warnings = page.getByRole("list", { name: "Warnings" });
  if (await warnings.waitFor({ timeout: 1000 }).then(() => true, () => false)) {
    await expect(warnings.getByRole("listitem").first()).toBeVisible();
  }
  const status = await page.request.get("/api/setup/status");
  expect(((await status.json()) as { storageConfigured: boolean }).storageConfigured).toBe(false);
  await page.getByRole("button", { name: "Use this folder" }).click();

  // Step 3: resource profile.
  await expect(page.getByRole("heading", { level: 1, name: "Choose a resource profile" })).toBeVisible();
  await page.getByLabel(/Raspberry Pi \(light\)/).check();
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 4: online search is optional and says where queries go.
  await expect(page.getByRole("heading", { level: 1, name: /Online search/ })).toBeVisible();
  await expect(page.getByTestId("provider-disclosure")).toContainText("sent to that provider's servers");
  await page.getByRole("button", { name: "Skip for now" }).click();

  // Step 5: the first source is optional. A bad address is refused with a message on the field.
  await expect(page.getByRole("heading", { level: 1, name: "Add your first source" })).toBeVisible();
  if (process.env.E2E_MODE === "real-server") {
    await page.getByLabel("Web address").fill("not-an-address");
    await page.getByRole("button", { name: "Add source and continue" }).click();
    await expect(page.getByText("Start the address with https:// or http://.")).toBeVisible();
    // A real page from the local fixture site, created with the default profile. It is not started here: a finished fetch would make
    // the connectivity indicator "online", and later specs rely on a fresh start being "not checked" (running it is covered by the integration tests).
    await page.getByLabel("Web address").fill(`${process.env.E2E_ARTICLE_URL}/bread-baking`);
    await page.getByLabel("Start saving it now").uncheck();
    await page.getByRole("button", { name: "Add source and continue" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Your first source is ready" })).toBeVisible();
    await expect(page.getByTestId("first-source-done")).toContainText("was added");
    const status = await page.request.get("/api/setup/status");
    expect(((await status.json()) as { firstSourceCreated: boolean }).firstSourceCreated).toBe(true);
    await page.getByRole("button", { name: "Continue" }).click();
  } else {
    await page.getByRole("button", { name: "Skip for now" }).click();
  }

  // Step 6: finish, and land in the main UI with no providers configured.
  await expect(page.getByRole("heading", { level: 1, name: "Ready to go" })).toBeVisible();
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("navigation", { name: "Areas" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: /NoConBrain/ })).toBeVisible();

  expect(external, "requests to external hosts").toEqual([]);
});

test("the wizard is not offered again once setup is complete", async ({ page }) => {
  await page.goto("/setup");
  await expect(page).toHaveURL(/\/$|\/login/);
});

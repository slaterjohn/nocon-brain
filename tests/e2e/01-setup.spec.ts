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

  // Step 2: storage. A path outside the allowed roots is refused with a message.
  await expect(page.getByRole("heading", { level: 1, name: /Choose where to keep archived pages/ })).toBeFocused();
  await page.getByLabel("Folder path").fill("/etc");
  await page.getByRole("button", { name: "Check and continue" }).click();
  await expect(page.getByRole("alert").first()).toContainText(/allowed|outside|root/i);
  await expect(page.getByRole("heading", { level: 1, name: /Choose where to keep archived pages/ })).toBeVisible();

  // A folder on the container's own filesystem is accepted with a warning that must be read.
  await page.getByLabel("Folder path").fill(path.join(volumes, "container-fs"));
  await page.getByRole("button", { name: "Check and continue" }).click();
  if (process.env.E2E_MODE !== "real-server") {
    await expect(page.getByRole("list", { name: "Warnings" })).toContainText("container's own filesystem");
    await page.getByRole("button", { name: "Continue with this folder" }).click();
  } else {
    // The real server decides which warnings apply to a temp directory.
    const cont = page.getByRole("button", { name: "Continue with this folder" });
    if (await cont.isVisible().catch(() => false)) await cont.click();
  }

  // Step 3: resource profile.
  await expect(page.getByRole("heading", { level: 1, name: "Choose a resource profile" })).toBeVisible();
  await page.getByLabel(/Raspberry Pi \(light\)/).check();
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 4: online search is optional and says where queries go.
  await expect(page.getByRole("heading", { level: 1, name: /Online search/ })).toBeVisible();
  await expect(page.getByTestId("provider-disclosure")).toContainText("sent to that provider's servers");
  await page.getByRole("button", { name: "Skip for now" }).click();

  // Step 5: first source is a placeholder.
  await expect(page.getByRole("heading", { level: 1, name: "Add your first source" })).toBeVisible();
  await expect(page.getByText("arrive in a later release")).toBeVisible();
  await page.getByRole("button", { name: "Skip for now" }).click();

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

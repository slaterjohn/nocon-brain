import { expect, type Page } from "@playwright/test";

export const ADMIN_USER = "e2eadmin";
export const ADMIN_PASSWORD = "correct-horse-battery-1";

export const mode = () => process.env.E2E_MODE ?? "mock-api";

/** Signs in through the login screen. Specs after 01-setup rely on the administrator created there. */
export async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(ADMIN_USER);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Areas" })).toBeVisible();
}

/** Records every request the page makes and returns those that left the app's own origin. */
export function trackExternalRequests(page: Page, baseURL: string) {
  const origin = new URL(baseURL).origin;
  const external: string[] = [];
  page.on("request", (r) => {
    const u = r.url();
    if (u.startsWith("data:") || u.startsWith("blob:") || u.startsWith("about:")) return;
    if (new URL(u).origin !== origin) external.push(`${r.method()} ${u}`);
  });
  return external;
}

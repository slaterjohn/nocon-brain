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

/** The local article fixture site (global-setup starts it and allows its loopback host for fetching). */
export const articleUrl = (path = "") => `${process.env.E2E_ARTICLE_URL ?? ""}${path}`;

const CSRF = { "X-NoCon-CSRF": "1" };

/** Saves a page through the API and waits until the capture has finished. */
export async function savePage(page: Page, url: string): Promise<{ downloadId: string; pageId?: string; versionId?: string }> {
  const res = await page.request.post("/api/browser/save", { data: { url }, headers: CSRF });
  expect(res.status(), await res.text()).toBe(202);
  const { downloadId } = (await res.json()) as { downloadId: string };
  let last: { state: string; outcome: string; pageId?: string; versionId?: string } | undefined;
  await expect
    .poll(async () => {
      const r = await page.request.get(`/api/archive/captures/${downloadId}`);
      last = (await r.json()) as typeof last;
      return last?.state;
    }, { timeout: 30_000 })
    .toMatch(/completed|failed/);
  expect(last?.state).toBe("completed");
  let { pageId, versionId } = last ?? {};
  if (!pageId) {
    // Nothing changed since an earlier save, so this capture made no version: ask where the page is.
    const r = await page.request.post("/api/browser/resolve", { data: { input: url }, headers: CSRF });
    const j = (await r.json()) as { resolution: { kind: string; page?: { id: string }; version?: { id: string } } };
    pageId = j.resolution.page?.id;
    versionId = j.resolution.version?.id;
  }
  return { downloadId, pageId, versionId };
}

export async function setWorkOffline(page: Page, on: boolean) {
  const r = await page.request.post("/api/system/connectivity", { data: { forceOffline: on }, headers: CSRF });
  expect(r.ok()).toBeTruthy();
}

/** The archive frame of the active tab. */
export const activeFrame = (page: Page) => page.locator('iframe[data-testid="archive-frame"]:not([hidden])');

/** Types an address into the address bar and presses Enter. */
export async function openAddress(page: Page, address: string) {
  const bar = page.getByRole("textbox", { name: "Address or search terms" });
  await bar.fill(address);
  await bar.press("Enter");
}

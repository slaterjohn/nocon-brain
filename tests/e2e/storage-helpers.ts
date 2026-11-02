import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { articleUrl } from "./helpers";

export const CSRF = { "X-NoCon-CSRF": "1" };
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** Serious and critical axe violations on the current page (the archive frame is a separate document and is left out). */
export async function serious(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).exclude('iframe[data-testid="archive-frame"]').analyze();
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

/** A one-page source at a given priority, run once and waited for. Returns the source and its page. */
export async function makeSourcedPage(page: Page, name: string, path: string, priority: "P1" | "P2" | "P3" | "P4", extra: Record<string, unknown> = {}) {
  const created = await page.request.post("/api/sources", { headers: CSRF, data: { name, type: "single_page", startUrl: articleUrl(path), profile: "focused", priority, ...extra } });
  expect(created.status(), await created.text()).toBe(201);
  const src = (await created.json()) as { id: string; name: string };
  const run = await page.request.post(`/api/sources/${src.id}/run`, { headers: CSRF, data: {} });
  expect(run.status(), await run.text()).toBe(202);
  await expect
    .poll(async () => ((await (await page.request.get(`/api/sources/${src.id}/stats`)).json()) as { pages: number }).pages, { timeout: 30_000 })
    .toBe(1);
  const pages = (await (await page.request.get(`/api/sources/${src.id}/pages`)).json()) as { items: { pageId: string; url: string }[] };
  return { source: src, pageId: pages.items[0]!.pageId, url: pages.items[0]!.url };
}

export async function deleteSource(page: Page, id: string) {
  await page.request.delete(`/api/sources/${id}`, { headers: CSRF });
}

export async function usage(page: Page, by: "priority" | "source" | "kind" | "volume") {
  const r = await page.request.get(`/api/storage/usage?by=${by}`);
  expect(r.ok()).toBeTruthy();
  return (await r.json()) as { totalBytes: number; items: { key: string; exclusiveBytes: number; sharedBytes: number }[] };
}

/** Leaves the policy as the other specs expect it: the P2 permit off. */
export async function resetPolicy(page: Page) {
  const r = await page.request.put("/api/storage/policy", { headers: CSRF, data: { permitImportantEviction: false, autoEviction: true, throttleOpportunistic: true } });
  expect(r.ok(), await r.text()).toBeTruthy();
}

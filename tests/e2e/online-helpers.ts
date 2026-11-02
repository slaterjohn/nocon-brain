import { expect, type Page } from "@playwright/test";
import type { FakeSearx } from "./fakes";
import { articleUrl, savePage } from "./helpers";

const CSRF = { "X-NoCon-CSRF": "1" };

/** Online search off and no providers: the state every other spec expects. */
export async function resetOnline(page: Page) {
  const list = await page.request.get("/api/search/providers");
  if (list.ok()) {
    for (const p of ((await list.json()) as { items: { id: string }[] }).items) await page.request.delete(`/api/search/providers/${p.id}`, { headers: CSRF });
  }
  const r = await page.request.patch("/api/settings", { data: { privacy: { onlineSearch: { enabled: false } } }, headers: CSRF });
  expect(r.ok(), await r.text()).toBeTruthy();
}

export async function enableOnline(page: Page) {
  const r = await page.request.patch("/api/settings", { data: { privacy: { onlineSearch: { enabled: true, acknowledged: true } } }, headers: CSRF });
  expect(r.ok(), await r.text()).toBeTruthy();
}

export async function addProvider(page: Page, body: Record<string, unknown>) {
  const r = await page.request.post("/api/search/providers", { data: { enabled: true, acknowledged: true, rateLimitPerSec: 50, ...body }, headers: CSRF });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()) as { id: string; name: string };
}

export const addFake = (page: Page, fake: FakeSearx, name = "Fake web", extra: Record<string, unknown> = {}) =>
  addProvider(page, { adapter: "searxng", name, baseUrl: fake.url, ...extra });

/** Saves a few article pages and waits until a search finds them. */
export async function ensureLocalPages(page: Page, paths = ["/astronomy", "/black-holes", "/solar-system", "/planets"]) {
  for (const p of paths) await savePage(page, articleUrl(p));
  await expect
    .poll(async () => {
      const r = await page.request.post("/api/search", { data: { query: "astronomy", online: "off" }, headers: CSRF });
      return ((await r.json()) as { results?: unknown[] }).results?.length ?? 0;
    }, { timeout: 60_000 })
    .toBeGreaterThan(0);
}

/** Top positions of every result on the page, by key. */
export async function positions(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const out: Record<string, number> = {};
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-result-key]"))) out[el.dataset.resultKey!] = Math.round(el.getBoundingClientRect().top + window.scrollY);
    return out;
  });
}

/** Records every text the live region ever holds (the page must be loaded after this). */
export async function recordAnnouncements(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __announced: string[] };
    w.__announced = [];
    const note = () => {
      const el = document.querySelector('[data-testid="results-status"]');
      const t = el?.textContent?.trim();
      if (t && w.__announced[w.__announced.length - 1] !== t) w.__announced.push(t);
    };
    new MutationObserver(note).observe(document, { subtree: true, childList: true, characterData: true });
  });
  return () => page.evaluate(() => (window as unknown as { __announced: string[] }).__announced);
}

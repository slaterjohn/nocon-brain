import { expect, type Page } from "@playwright/test";
import { linkGraphUrl, savePage } from "./helpers";

export const CSRF = { "X-NoCon-CSRF": "1" };

export interface Cand {
  id: string;
  url: string;
  host: string;
  title?: string;
  state: string;
  score: number;
  downloadId?: string;
  suggestedCollectionId?: string;
}

/** Everything off and every limit back at its default, the kill switch off: the state every discovery spec starts from and leaves. */
export async function resetDiscovery(page: Page) {
  const r = await page.request.put("/api/discovery/settings", {
    headers: CSRF,
    data: {
      enabled: false,
      passive: { fromLinks: false, fromVisits: false, fromBookmarks: false, fromMissingLinks: false, fromSavedSearches: false },
      searchDriven: { searchesInfluenceDiscovery: false, autoCacheOpenedOnlinePages: false, prioritiseFrequentTopics: false, requireApproval: true, backgroundBudget: { maxRequestsPerDay: 50, maxBytesPerDay: 104857600 } },
      active: { mode: "off", allowedSourceIds: [], maxCandidatesPerRun: 10, maxDepth: 1, maxQueued: 20, maxBytesPerDay: 104857600, maxRequestsPerDay: 50, perSiteDailyCap: 10, respectSchedule: true, minScore: 10 },
      pool: { maxCandidates: 500, expireAfterDays: 30, maxLinksPerPage: 25 },
      ceilings: { maxDepth: 3, maxQueued: 100, maxRequestsPerDay: 200, maxBytesPerDay: 536870912 },
      weights: { inboundArchivedLinks: 30, collectionRelevance: 20, searchFrequency: 10, bookmarks: 25, recentActivity: 10, sourcePriority: 10, estimatedCost: -10, storageHeadroom: -15 },
    },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  await page.request.post("/api/discovery/resume", { headers: CSRF });
}

/** Switches discovery on with link collection and the ask-first mode. */
export async function enableDiscovery(page: Page, extra: Record<string, unknown> = {}) {
  const r = await page.request.put("/api/discovery/settings", { headers: CSRF, data: { enabled: true, passive: { fromLinks: true }, active: { mode: "approval" }, ...extra } });
  expect(r.ok(), await r.text()).toBeTruthy();
}

export async function candidates(page: Page, query = "state=new&limit=200"): Promise<{ items: Cand[]; total: number; counts: Record<string, number> }> {
  const r = await page.request.get(`/api/discovery/candidates?${query}`);
  expect(r.ok(), await r.text()).toBeTruthy();
  return (await r.json()) as { items: Cand[]; total: number; counts: Record<string, number> };
}

/** True when the address is already saved (link collection only runs when a page is captured, so a saved page makes no new candidates). */
async function isSaved(page: Page, url: string): Promise<boolean> {
  const r = await page.request.post("/api/browser/resolve", { data: { input: url }, headers: CSRF });
  const j = (await r.json()) as { resolution?: { page?: unknown } };
  return !!j.resolution?.page;
}

/** Candidates on the local fixture sites, which the test server may fetch. Links to other hosts (references) would fail to download. */
const local = (c: Cand) => c.url.startsWith("http://127.0.0.1");

/** Node ids of the link-graph fixture, deepest-but-one level first: each page there links to several local pages. */
const NODES = [...Array.from({ length: 30 }, (_, i) => 7 + i), ...Array.from({ length: 6 }, (_, i) => 1 + i), ...Array.from({ length: 150 }, (_, i) => 37 + i)];

/**
 * Saves a page of the link-graph fixture with link collection on and waits for the candidates its links made. Pages an earlier spec
 * saved are skipped (link collection only runs when a page is captured). Returns the new local candidates, or, when no page can make
 * enough, the local candidates that are waiting for review anyway, so a test never depends on what earlier specs used up.
 */
export async function seedCandidates(page: Page, atLeast = 1): Promise<Cand[]> {
  let tried = 0;
  for (const n of NODES) {
    if (tried >= 10) break;
    const url = linkGraphUrl(`/n/${n}`);
    if (await isSaved(page, url)) continue;
    tried++;
    const before = new Set((await candidates(page)).items.map((c) => c.id));
    await savePage(page, url);
    let fresh: Cand[] = [];
    try {
      await expect
        .poll(async () => {
          fresh = (await candidates(page)).items.filter((c) => !before.has(c.id) && local(c));
          return fresh.length;
        }, { timeout: 8_000 })
        .toBeGreaterThanOrEqual(atLeast);
      return fresh;
    } catch {
      /* try the next page */
    }
  }
  const waiting = (await candidates(page)).items.filter(local);
  expect(waiting.length, "local candidates waiting for review").toBeGreaterThanOrEqual(atLeast);
  return waiting;
}

/** The row for one candidate on the Discovery page. */
export const rowFor = (page: Page, c: { id: string }) => page.locator(`[data-testid="candidate-row"][data-id="${c.id}"]`);

/** Opens the Discovery page narrowed to one candidate by its address, so it is on the first page whatever else is waiting. */
export async function openCandidate(page: Page, c: { id: string; url: string }) {
  await page.goto("/discovery");
  await page.getByLabel("Address or title contains").fill(c.url);
  await expect(rowFor(page, c)).toBeVisible();
}

/** Shows the state tab and waits for the list to settle. */
export async function showState(page: Page, state: string) {
  await page.getByTestId(`state-${state}`).click();
  await expect(page.getByTestId(`state-${state}`)).toHaveAttribute("aria-pressed", "true");
}

export async function waitDownloadDone(page: Page, id: string) {
  await expect
    .poll(async () => ((await (await page.request.get(`/api/downloads/${id}`)).json()) as { state: string }).state, { timeout: 45_000 })
    .toMatch(/completed|failed|cancelled/);
}

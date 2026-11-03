import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { buildFixtures } from "../fixtures/zim/build.mjs";
import { savePage } from "./helpers";

export const CSRF = { "X-NoCon-CSRF": "1" };
const here = path.dirname(fileURLToPath(import.meta.url));

export type FixtureKey = "wiki" | "chem" | "notitle" | "other";
export interface Pkg { id: string; title: string; uuid: string; state: string; priority: string; sourceId: string | null; path: string; storageMode: string }

/** The fixture ZIM files (built once into the gitignored cache) copied under the allowed volume root with a name of this suite's own. */
export async function fixturePath(key: FixtureKey): Promise<string> {
  const built = await buildFixtures(path.join(here, "../fixtures/zim/.cache"));
  const dir = path.join(process.env.E2E_VOLUMES_ROOT!, "library");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `ui-${key}.zim`);
  if (!fs.existsSync(dest)) fs.copyFileSync(built[key], dest);
  return dest;
}

export async function listPackages(page: Page): Promise<Pkg[]> {
  const r = await page.request.get("/api/zim/packages");
  expect(r.ok(), await r.text()).toBeTruthy();
  return ((await r.json()) as { items: Pkg[] }).items;
}

const TITLE: Record<FixtureKey, string> = { wiki: "Wikipedia (fixture)", chem: "Chemistry (fixture)", notitle: "Notes without a full-text index", other: "Cuisine (fixture)" };

/** The package for a fixture: registered in place if it is not there yet (spec 29 may have added the Wikipedia one already). */
export async function ensurePackage(page: Page, key: FixtureKey, body: Record<string, unknown> = {}): Promise<Pkg> {
  const have = (await listPackages(page)).find((p) => p.title === TITLE[key]);
  if (have) return have;
  const r = await page.request.post("/api/zim/packages/import", { data: { path: await fixturePath(key), ...body }, headers: CSRF });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()) as Pkg;
}

/** Removes a fixture package and everything that refers to it (no error when it is not there). */
export async function dropPackage(page: Page, key: FixtureKey) {
  const have = (await listPackages(page)).find((p) => p.title === TITLE[key]);
  if (have) {
    const r = await page.request.delete(`/api/zim/packages/${have.id}?confirm=true`, { headers: CSRF });
    expect(r.ok(), await r.text()).toBeTruthy();
  }
}

/** `https://en.wikipedia.org/wiki/Black_hole`, saved through the Wikipedia client from the fake Wikimedia server. */
export const BLACK_HOLE = "https://en.wikipedia.org/wiki/Black_hole";
export async function archiveBlackHole(page: Page) {
  return savePage(page, BLACK_HOLE);
}

/** Waits until the search index can find a word in a saved page (indexing runs after a capture). */
export async function untilIndexed(page: Page, query: string, origin: "archive" | "zim" = "archive") {
  await expect
    .poll(async () => {
      const r = await page.request.post("/api/search", { data: { query, scope: "offline", online: "off" }, headers: CSRF });
      const j = (await r.json()) as { results: { origin: string }[] };
      return j.results.some((x) => x.origin === origin);
    }, { timeout: 30_000 })
    .toBe(true);
}

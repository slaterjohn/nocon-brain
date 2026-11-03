import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { articleUrl, login, mode, savePage, setWorkOffline } from "./helpers";
import { buildFixtures } from "../fixtures/zim/build.mjs";

// Z-06: unified browsing. A Wikipedia article address opens from an enabled Wikipedia package, offline; the visit and a bookmark of it are
// kept; an archived page's Wikipedia link opens the package copy. The web app's address bar does not show package entries yet (the interface
// follows), so this spec drives the same API calls the address bar makes, through the web app's own proxy, and reads what the listener serves.
test.skip(mode() !== "real-server", "needs the real server and libzim");
test.describe.configure({ mode: "serial" });

const CSRF = { "X-NoCon-CSRF": "1" };
const here = path.dirname(fileURLToPath(import.meta.url));
let zimId = "";

async function resolve(page: Page, input: string) {
  const r = await page.request.post("/api/browser/resolve", { data: { input }, headers: CSRF });
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()) as { resolution: { kind: string; path?: string; zim?: { id: string }; frame: { url: string; frameId: string } }; alternatives: string[] };
}
const inFrame = { "sec-fetch-dest": "iframe" };

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await login(page);
  const built = await buildFixtures(path.join(here, "../fixtures/zim/.cache"));
  const lib = path.join(process.env.E2E_VOLUMES_ROOT!, "library");
  fs.mkdirSync(lib, { recursive: true });
  const dest = path.join(lib, "wikipedia_en_fixture.zim");
  fs.copyFileSync(built.wiki, dest);
  const res = await page.request.post("/api/zim/packages/import", { data: { path: dest }, headers: CSRF });
  expect(res.status(), await res.text()).toBe(201);
  const pkg = (await res.json()) as { id: string; state: string };
  expect(pkg.state).toBe("ready");
  zimId = pkg.id;
  await page.close();
});

test.beforeEach(async ({ page }) => {
  await login(page);
  await setWorkOffline(page, false);
  await page.request.delete("/api/history", { headers: CSRF });
  await page.request.patch("/api/settings", { data: { privacy: { history: { enabled: true } } }, headers: CSRF });
});
test.afterEach(async ({ page }) => {
  await setWorkOffline(page, false);
});

test("typing a Wikipedia article address offline opens the article from the package; the visit and a bookmark are kept", async ({ page }) => {
  await setWorkOffline(page, true);
  const r = await resolve(page, "https://en.m.wikipedia.org/wiki/Benzene");
  expect(r.resolution).toMatchObject({ kind: "zim", path: "Benzene", zim: { id: zimId } });
  expect(r.alternatives).toContain("zim");

  // The listener serves the package copy.
  const doc = await page.request.get(r.resolution.frame.url, { headers: inFrame });
  expect(doc.status()).toBe(200);
  const html = await doc.text();
  expect(html).toContain("Benzene</b> is an aromatic hydrocarbon");
  expect(html).not.toMatch(/<script/i);
  expect(doc.headers()["content-security-policy"]).toContain("sandbox");

  // The shell reads frame state after the frame loads; it names the Wikipedia address and the package entry.
  const fs1 = await page.request.get(`/api/browser/frame-state?frameId=${r.resolution.frame.frameId}`);
  expect(await fs1.json()).toMatchObject({ state: "zim", zimId, zimPath: "Benzene", url: "https://en.wikipedia.org/wiki/Benzene" });

  // History and bookmarks work for the entry.
  const hist = await (await page.request.get("/api/history")).json();
  expect(hist.items).toHaveLength(1);
  expect(hist.items[0]).toMatchObject({ url: "https://en.wikipedia.org/wiki/Benzene", servedFrom: "zim", zim: { zimId, path: "Benzene" } });
  const bm = await page.request.post("/api/bookmarks", { data: { url: "https://en.wikipedia.org/wiki/Benzene" }, headers: CSRF });
  expect(bm.status()).toBe(201);
  expect(await bm.json()).toMatchObject({ originalUrl: "https://en.wikipedia.org/wiki/Benzene", zim: { zimId, path: "Benzene" } });

  await page.goto("/history");
  await expect(page.getByTestId("history-row").filter({ hasText: "wikipedia.org/wiki/Benzene" })).toHaveCount(1);
  await page.goto("/bookmarks");
  await expect(page.getByText("Benzene").first()).toBeVisible();

  // Opening the bookmarked address again, still offline, gives the same entry.
  expect((await resolve(page, "https://en.wikipedia.org/wiki/Benzene")).resolution).toMatchObject({ kind: "zim", path: "Benzene" });
  // An article the package does not hold is the offline page, not a request to Wikipedia.
  expect((await resolve(page, "https://en.wikipedia.org/wiki/Zirconium")).resolution.kind).toBe("offline");
});

test("an archived page's Wikipedia links open the package copy", async ({ page }) => {
  const cites = articleUrl("/cites-wikipedia");
  await savePage(page, cites);
  await setWorkOffline(page, true);
  const r = await resolve(page, cites);
  expect(r.resolution.kind).toBe("archive");
  const html = await (await page.request.get(r.resolution.frame.url)).text();
  const link = (id: string) => new RegExp(`<a [^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? "";
  for (const [id, entry] of [["w-benzene", "Benzene"], ["w-toluene", "Toluene"], ["w-index", "Aromaticity"]] as const) {
    expect(link(id), id).toMatch(new RegExp(`href="[^"]*/z/${zimId}/${entry}"`));
    expect(link(id), id).toContain('data-ncb-link="cached"');
  }
  // Following one lands on the package entry.
  const href = /href="([^"]*\/z\/[^"]*\/Benzene)"/.exec(link("w-benzene"))![1]!;
  const entry = await page.request.get(new URL(href, r.resolution.frame.url).href);
  expect(await entry.text()).toContain("Benzene</b> is an aromatic hydrocarbon");
  // A link to an article that is neither saved nor in the package is marked as not available while offline.
  expect(link("w-missing")).toContain('data-ncb-link="unavailable"');
});

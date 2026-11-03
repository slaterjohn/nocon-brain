import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { articleUrl, login, mode, savePage, setWorkOffline } from "./helpers";

// H-05: accessibility across the whole app. 05-a11y covers the first pages and the shared behaviours; this spec adds every other route
// (axe, landmarks, headings), keyboard-only paths through the main flows, visible focus on whatever the keyboard reaches, reduced
// motion, reflow at 320 CSS pixels (what 400% zoom of a 1280 pixel window gives) and live regions for asynchronous status.
test.skip(mode() !== "real-server", "needs the real server");

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** The routes that need no id. The ones that do are added in `beforeAll`. */
const STATIC_ROUTES = [
  "/", "/library", "/library/sources", "/library/sources/new", "/library/sources/new/package", "/library/collections", "/library/packages",
  "/library/wikipedia", "/downloads", "/save", "/bookmarks", "/history", "/search", "/search?q=astronomy", "/storage", "/storage/dashboard",
  "/storage/activity", "/storage/space", "/storage/volumes", "/storage/policy", "/storage/eviction", "/storage/audit", "/storage/maintenance",
  "/storage/online-search", "/storage/packages", "/discovery", "/discovery/budget", "/discovery/settings", "/no-such-page-here",
];
let routes: string[] = [];

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await login(page);
  await setWorkOffline(page, false);
  const saved = await savePage(page, articleUrl("/astronomy"));
  const sources = (await (await page.request.get("/api/sources?limit=5")).json()) as { items: { id: string }[] };
  routes = [...STATIC_ROUTES, `/library/pages/${saved.pageId}`, `/storage/pages/${saved.pageId}`];
  if (sources.items[0]) routes.push(`/library/sources/${sources.items[0].id}`, `/library/sources/${sources.items[0].id}/edit`);
  await page.close();
});

test.beforeEach(async ({ page }) => {
  await login(page);
  await setWorkOffline(page, false);
});

/** The page has stopped loading: no placeholder is left and the event stream is open (not for the 404 page, which has no shell data). */
async function settled(page: Page) {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
}

async function serious(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).exclude('iframe[data-testid="archive-frame"]').analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

test("every route: one main landmark, a banner and the area navigation, one h1, headings in order, no serious axe violations", async ({ page }) => {
  test.setTimeout(240_000);
  const problems: string[] = [];
  for (const route of routes) {
    await page.goto(route);
    await settled(page);
    const info = await page.evaluate(() => {
      const levels = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6")).filter((h) => (h as HTMLElement).offsetParent !== null || getComputedStyle(h).position === "fixed").map((h) => Number(h.tagName[1]));
      return {
        mains: document.querySelectorAll("main, [role=main]").length,
        banners: document.querySelectorAll("body > div > header, body header[role=banner]").length,
        areaNavs: document.querySelectorAll('nav[aria-label="Areas"]').length,
        h1: levels.filter((l) => l === 1).length,
        jumps: levels.filter((l, i) => i > 0 && l - levels[i - 1]! > 1).length,
      };
    });
    if (info.mains !== 1) problems.push(`${route}: ${info.mains} main landmarks`);
    if (info.h1 !== 1) problems.push(`${route}: ${info.h1} h1 elements`);
    if (info.jumps) problems.push(`${route}: heading levels skip (${info.jumps} jumps)`);
    if (route !== "/no-such-page-here" && (info.areaNavs !== 1 || info.banners < 1)) problems.push(`${route}: missing banner or area navigation`);
    for (const v of await serious(page)) problems.push(`${route}: ${v}`);
  }
  expect(problems).toEqual([]);
});

test("every route in the dark theme has no serious axe violations", async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext({ colorScheme: "dark" });
  const page = await ctx.newPage();
  await login(page);
  const problems: string[] = [];
  for (const route of routes) {
    await page.goto(route);
    await settled(page);
    for (const v of await serious(page)) problems.push(`${route}: ${v}`);
  }
  await ctx.close();
  expect(problems).toEqual([]);
});

test.describe("reflow", () => {
  test.use({ viewport: { width: 320, height: 640 } });
  test("at 320 CSS pixels no route scrolls sideways and its heading stays inside the window", async ({ page }) => {
    test.setTimeout(240_000);
    const problems: string[] = [];
    for (const route of routes) {
      await page.goto(route);
      await settled(page);
      const m = await page.evaluate(() => {
        const h1 = document.querySelector("h1");
        const r = h1?.getBoundingClientRect();
        const wide: string[] = [];
        for (const el of Array.from(document.querySelectorAll("body *"))) {
          const b = el.getBoundingClientRect();
          if (b.right > document.documentElement.clientWidth + 1 && b.width > 0 && !el.closest("nav") && !(el instanceof SVGElement) && wide.length < 4)
            wide.push(`<${el.tagName.toLowerCase()} data-testid=${el.getAttribute("data-testid")} class="${String(el.getAttribute("class")).slice(0, 60)}"> ends at ${Math.round(b.right)}`);
        }
        return { scroll: document.documentElement.scrollWidth, width: document.documentElement.clientWidth, h1Right: r ? r.right : 0, h1Left: r ? r.left : 0, wide };
      });
      if (m.scroll > m.width + 1) problems.push(`${route}: page is ${m.scroll}px wide in a ${m.width}px window; ${m.wide.join("; ")}`);
      if (m.h1Left < -1 || m.h1Right > m.width + 1) problems.push(`${route}: the heading is cut off (${Math.round(m.h1Left)} to ${Math.round(m.h1Right)})`);
    }
    expect(problems).toEqual([]);
  });

  test("at 320 CSS pixels the navigation and the main controls are still reachable", async ({ page }) => {
    await page.goto("/library");
    await settled(page);
    const nav = page.getByRole("navigation", { name: "Areas" });
    await expect(nav.getByRole("link", { name: "Library" })).toBeVisible();
    // The area list scrolls inside its own strip; the last area can be reached by keyboard and is scrolled into view.
    await nav.getByRole("link", { name: "Discovery" }).focus();
    await expect(nav.getByRole("link", { name: "Discovery" })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.goto("/");
    await expect(page.getByRole("textbox", { name: "Address or search terms" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Address or search terms" })).toBeInViewport({ ratio: 0.9 });
  });
});

test.describe("keyboard only", () => {
  test("sign-in: the first field has focus, Tab reaches the password, Enter signs in", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/login");
    await expect(page.getByLabel("Username")).toBeFocused();
    await page.keyboard.type("not-the-user");
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Password")).toBeFocused();
    await page.keyboard.type("wrong-password-123");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "username or password" })).toContainText("wrong");
    await ctx.close();
  });

  test("search: type on the home page, Enter, Tab to a result and open it, all by keyboard", async ({ page }) => {
    await page.goto("/");
    const box = page.getByRole("combobox", { name: /Search your archive/ });
    await expect(box).toBeFocused();
    await page.keyboard.type("astronomy");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/search\?q=astronomy/);
    await expect(page.getByTestId("search-result").first()).toBeVisible();
    // Tab until focus is on a result's title link. The count of stops is bounded: a trap or a missing stop fails here.
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(() => !!document.activeElement?.closest('[data-testid="search-result"]') && document.activeElement?.tagName === "A");
    }
    expect(reached, "a result link should be reachable by Tab").toBe(true);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("textbox", { name: "Address or search terms" })).toHaveValue(/astronomy/i);
  });

  test("areas: Tab to the Library link and Enter opens it, with the current area marked", async ({ page }) => {
    await page.goto("/");
    await settled(page);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const link = page.getByRole("navigation", { name: "Areas" }).getByRole("link", { name: "Library" });
    let reached = false;
    for (let i = 0; i < 12 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await link.evaluate((el) => el === document.activeElement);
    }
    expect(reached).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/library$/);
    await expect(page.getByRole("navigation", { name: "Areas" }).getByRole("link", { name: "Library" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("a dialog traps Tab, closes with Escape and returns focus to the control that opened it", async ({ page }) => {
    await page.goto("/");
    await settled(page);
    const help = page.getByTestId("help-button");
    await help.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), `Tab stop ${i + 1} stays in the dialog`).toBe(true);
    }
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(help).toBeFocused();
  });

  test("whatever the keyboard reaches shows a focus indicator, on pages with forms, tables and lists", async ({ page }) => {
    test.setTimeout(120_000);
    const bad: string[] = [];
    for (const route of ["/library", "/downloads", "/search?q=astronomy", "/storage", "/storage/policy", "/library/collections", "/discovery/settings", "/library/packages"]) {
      await page.goto(route);
      await settled(page);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      for (let i = 0; i < 45; i++) {
        await page.keyboard.press("Tab");
        const f = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body || el.tagName === "IFRAME") return null;
          // A tree item shows its focus on the row inside it (the item itself is only the focus target).
          const shown = el.matches('[role="treeitem"]') && el.firstElementChild ? (el.firstElementChild as HTMLElement) : el;
          const c = getComputedStyle(shown);
          const outline = c.outlineStyle !== "none" && parseFloat(c.outlineWidth) >= 2;
          const ring = c.boxShadow !== "none" && c.boxShadow !== "";
          const label = (el.getAttribute("aria-label") ?? el.textContent ?? el.id ?? "").trim().slice(0, 30);
          return { ok: outline || ring, tag: el.tagName.toLowerCase(), label };
        });
        if (f && !f.ok) bad.push(`${route}: <${f.tag}> "${f.label}" has no visible focus`);
      }
    }
    expect([...new Set(bad)]).toEqual([]);
  });
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("no running animation and no transition longer than a blink on the main screens", async ({ page }) => {
    test.setTimeout(120_000);
    const offenders: string[] = [];
    // A slow Downloads list keeps the loading placeholder (the one pulsing element) on screen while it is inspected.
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => (release = r));
    await page.route("**/api/downloads?**", async (route) => {
      await hold;
      await route.continue();
    });
    await page.goto("/downloads");
    await expect(page.locator('[aria-busy="true"]').first()).toBeVisible();
    const scan = () =>
      page.evaluate(() => {
        const out: string[] = [];
        const ms = (v: string) => v.split(",").map((x) => (x.trim().endsWith("ms") ? parseFloat(x) : parseFloat(x) * 1000));
        for (const el of Array.from(document.querySelectorAll("body *"))) {
          const c = getComputedStyle(el);
          if (ms(c.transitionDuration).some((d) => d > 1)) out.push(`transition ${c.transitionDuration} on <${el.tagName.toLowerCase()} class="${String(el.getAttribute("class")).slice(0, 40)}">`);
          if (c.animationName !== "none" && ms(c.animationDuration).some((d) => d > 1)) out.push(`animation ${c.animationName} ${c.animationDuration} on <${el.tagName.toLowerCase()}>`);
        }
        const infinite = document.getAnimations().filter((a) => (a.effect?.getTiming().iterations ?? 1) === Infinity && a.playState === "running");
        if (infinite.length) out.push(`${infinite.length} animation(s) repeating for ever`);
        return out;
      });
    offenders.push(...(await scan()));
    release();
    for (const route of ["/", "/library", "/search?q=astronomy", "/storage/dashboard", "/library/packages"]) {
      await page.goto(route);
      await settled(page);
      offenders.push(...(await scan()).map((o) => `${route}: ${o}`));
    }
    expect([...new Set(offenders)]).toEqual([]);
  });
});

test.describe("live regions", () => {
  test("loading is announced once, a failed load is an alert with Try again, and a retry clears it", async ({ page }) => {
    let fail = true;
    await page.route("**/api/downloads?**", async (route) => {
      if (fail) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal", message: "internal", requestId: "x" }) });
      return route.continue();
    });
    await page.goto("/downloads");
    const alert = page.getByRole("alert").filter({ hasText: "Couldn't load downloads" });
    await expect(alert).toBeVisible();
    // The message is a sentence with a next step, not the code.
    await expect(alert).not.toContainText(/^internal$/m);
    await expect(alert).toContainText(/Try again|check/);
    fail = false;
    await alert.getByRole("button", { name: "Try again" }).click();
    await expect(alert).toHaveCount(0);
    await expect(page.locator('main [role="status"][aria-busy="true"]')).toHaveCount(0);
  });

  test("status regions exist for the connection, the search results and the capture announcements", async ({ page }) => {
    await page.goto("/search?q=astronomy");
    await expect(page.getByTestId("results-status")).toHaveAttribute("aria-live", /polite|assertive/);
    await expect(page.getByTestId("connectivity").getByRole("status")).toHaveCount(1);
    // Saving a page is announced here ("… is saved"); 09-capture drives that end to end.
    await expect(page.getByTestId("capture-announcer")).toHaveAttribute("aria-live", "polite");
  });
});

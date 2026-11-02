import { describe, expect, it } from "vitest";
import { calendarHit, DEFAULT_TRAPS, hasRepeatingSegments, MemoryTrapStore, TrapGuard, urlFamily, type TrapConfig } from "../src/index.js";

describe("repeating segments", () => {
  const cases: [string, boolean][] = [
    ["/a", false], ["/a/b", false], ["/a/b/a/b", true], ["/a/a", false], ["/a/a/a", true], ["/a/b/a/b/a/b", true], ["/a/b/a", false], ["/a/b/b/a", false], ["/x/a/b/a/b/a/b", true],
    ["/a/b/c/a/b/c/a/b/c", true], ["/a/b/c/d/a/b/c/d", true], ["/docs/guide/intro", false], ["/real/1", false], ["/n/10", false],
    ["/one/two/three/four/five", false], ["/x/y/x/z/x", false], ["/a/b/a/c/a/d/a/e/a", true], ["/", false], ["", false], ["/A/a/A", true], ["/x/y/z/x/y/z", true], ["/x/y/z/y/x", false],
    ["/blog/2024/05/post", false], ["/a/a/b/b/a/a", false],
  ];
  it.each(cases)("%s -> %s", (p, want) => expect(hasRepeatingSegments(p, 3, 4)).toBe(want));
});

describe("calendar detection", () => {
  const cases: [string, string | null][] = [
    ["https://x.test/cal/2026/11/01", "x.test/cal/{date}"],
    ["https://x.test/cal/2026/11", "x.test/cal/{date}"],
    ["https://x.test/cal/2026-11-01", "x.test/cal/{date}"],
    ["https://x.test/events/2026/11/01/party", "x.test/events/{date}/party"],
    ["https://x.test/blog/2026/", null],
    ["https://x.test/n/2026", null],
    ["https://x.test/cal?date=2026-11-01", "x.test/cal?date={date}&"],
    ["https://x.test/cal?month=2026-11&view=week", "x.test/cal?month={date}&view"],
    ["https://x.test/page?id=2026-11-01", null],
    ["https://x.test/v/1/2/3", null],
    ["https://x.test/archive/1850/01/01", null],
  ];
  it.each(cases)("%s", (url, template) => {
    expect(calendarHit(new URL(url))?.template ?? null).toBe(template);
  });
  it("converts to epoch days", () => {
    const a = calendarHit(new URL("https://x.test/c/2026/11/01"))!;
    const b = calendarHit(new URL("https://x.test/c/2026/11/02"))!;
    expect(b.epochDay - a.epochDay).toBe(1);
  });
});

describe("url families", () => {
  it("collapses digits and orders parameter names", () => {
    expect(urlFamily(new URL("https://x.test/p/12/c/9?b=1&a=2"))).toBe("x.test/p/#/c/#?a&b");
    expect(urlFamily(new URL("https://x.test/p/13/c/10?a=7&b=8"))).toBe("x.test/p/#/c/#?a&b");
    expect(urlFamily(new URL("https://x.test/list"))).toBe("x.test/list");
  });
});

const guard = (over: Partial<TrapConfig> = {}) => new TrapGuard({ ...DEFAULT_TRAPS, ...over }, new MemoryTrapStore());
/** check + commit, as the engine does for a URL that was queued. */
const accept = (g: TrapGuard, url: string) => {
  const v = g.check(url);
  if (v.ok) v.commit();
  return v;
};

describe("TrapGuard", () => {
  it("rejects repeating segments and very deep paths", () => {
    const g = guard();
    expect(g.check("https://x.test/a/b/a/b/a/b")).toEqual({ ok: false, reason: "trap:repeating_segments" });
    expect(g.check("https://x.test/" + Array.from({ length: 13 }, (_, i) => `s${i}`).join("/"))).toEqual({ ok: false, reason: "trap:path_depth" });
    expect(g.check("https://x.test/real/1").ok).toBe(true);
  });

  it("limits query variants per path, not per site", () => {
    const g = guard({ queryVariantBudget: 3 });
    for (let i = 0; i < 3; i++) expect(accept(g, `https://x.test/list?page=${i}`).ok).toBe(true);
    expect(g.check("https://x.test/list?page=99")).toEqual({ ok: false, reason: "trap:query_variants" });
    expect(g.check("https://x.test/other?page=1").ok).toBe(true);
    expect(g.check("https://x.test/list").ok).toBe(true);
  });

  it("does not use budget for URLs it only checked", () => {
    const g = guard({ queryVariantBudget: 1 });
    expect(g.check("https://x.test/list?page=1").ok).toBe(true);
    expect(g.check("https://x.test/list?page=2").ok).toBe(true);
    accept(g, "https://x.test/list?page=1");
    expect(g.check("https://x.test/list?page=2").ok).toBe(false);
  });

  it("budgets calendar pages per template", () => {
    const g = guard({ calendarBudget: 5 });
    for (let d = 1; d <= 5; d++) expect(accept(g, `https://x.test/cal/2026/11/0${d}`).ok).toBe(true);
    expect(g.check("https://x.test/cal/2026/11/09")).toEqual({ ok: false, reason: "trap:calendar_budget" });
    expect(g.check("https://x.test/other/2026/11/09").ok).toBe(true);
  });

  it("skips dates outside the window around the first one seen", () => {
    const g = guard({ calendarWindowDays: 30, calendarBudget: 100 });
    accept(g, "https://x.test/cal/2026/11/01");
    expect(g.check("https://x.test/cal/2026/11/20").ok).toBe(true);
    expect(g.check("https://x.test/cal/2027/11/01")).toEqual({ ok: false, reason: "trap:calendar_window" });
    expect(g.check("https://x.test/cal/2020/01/01")).toEqual({ ok: false, reason: "trap:calendar_window" });
  });

  it("budgets URLs per host", () => {
    const g = guard({ maxUrlsPerHost: 3 });
    for (let i = 0; i < 3; i++) expect(accept(g, `https://x.test/p/${i}`).ok).toBe(true);
    expect(g.check("https://x.test/p/9")).toEqual({ ok: false, reason: "trap:host_budget" });
    expect(g.check("https://y.test/p/1").ok).toBe(true);
  });

  it("blocks a family after a streak of identical-content pages, and a new page resets the streak", () => {
    const g = guard({ duplicateStreak: 3 });
    const u = (n: number) => `https://x.test/facets?v=${n}`;
    expect(g.observeContent(u(1), true)).toBe(false);
    expect(g.observeContent(u(2), true)).toBe(false);
    expect(g.observeContent(u(3), false)).toBe(false);
    expect(g.observeContent(u(4), true)).toBe(false);
    expect(g.observeContent(u(5), true)).toBe(false);
    expect(g.observeContent(u(6), true)).toBe(true);
    expect(g.check(u(7))).toEqual({ ok: false, reason: "trap:duplicate_content" });
    expect(g.check("https://x.test/real/1").ok).toBe(true);
  });

  it("reports a block once", () => {
    const g = guard({ duplicateStreak: 1 });
    expect(g.observeContent("https://x.test/f?a=1", true)).toBe(true);
    expect(g.observeContent("https://x.test/f?a=2", true)).toBe(false);
  });
});

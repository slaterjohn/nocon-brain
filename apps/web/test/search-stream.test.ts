import { describe, expect, it } from "vitest";
import { applyUpdate, hasHeld, heldCount, initialStream, streamReducer, summaryMessage, type StreamState } from "../lib/search-stream";
import { HOVER_FREEZE_MS, OPEN, TIME_BOX_MS, freeze, freezes, holdCause, isScrollKey, shouldHold } from "../lib/search-freeze";
import { safeHttpUrl, errorSentence } from "../lib/online-search";
import type { SearchResult } from "../lib/search";
import type { SearchEvent } from "../lib/online-search";

const r = (key: string, over: Partial<SearchResult> = {}): SearchResult => ({
  key, url: `https://example.org/${key}`, canonicalUrl: `https://example.org/${key}`, title: key, snippet: "", origin: "archive", availability: "cached", domain: "example.org", type: "html", ...over,
});
const online = (key: string) => r(key, { origin: "online", availability: "online_only", actions: { open: "", saveForOffline: true } });
let seq = 0;
const ev = (e: Record<string, unknown>) => ({ seq: ++seq, at: "2026-11-02T10:00:00Z", ...e }) as unknown as SearchEvent;
const results = (providerId: string, append: SearchResult[], update: unknown[] = [], extra: Record<string, unknown> = {}) =>
  ev({ type: "provider_results", providerId, page: 1, hasMore: false, tookMs: 5, cached: false, dropped: 0, append, update, ...extra });
const start = (): StreamState => { seq = 0; return streamReducer(initialStream(), { type: "reset", results: [r("a"), r("b")] }); };
const apply = (s: StreamState, event: SearchEvent, hold = false, visible?: Set<string>) => streamReducer(s, { type: "event", event, hold, visible });

describe("event reducer", () => {
  it("appends online results after the local ones and never reorders what is there", () => {
    let s = start();
    s = apply(s, ev({ type: "provider_started", providerId: "p1", name: "One", adapter: "searxng", page: 1 }));
    expect(s.providers).toMatchObject([{ id: "p1", name: "One", state: "pending" }]);
    s = apply(s, results("p1", [online("x"), online("y")]));
    expect(s.results.map((x) => x.key)).toEqual(["a", "b", "x", "y"]);
    s = apply(s, results("p2", [online("z"), online("x")]));
    expect(s.results.map((x) => x.key)).toEqual(["a", "b", "x", "y", "z"]);
  });

  it("ignores events it has already seen (a replay after reconnecting)", () => {
    let s = start();
    const e = results("p1", [online("x")]);
    s = apply(s, e);
    const again = apply(s, e);
    expect(again).toBe(s);
  });

  it("holds appended results while the list is frozen and shows them on release", () => {
    let s = start();
    s = apply(s, results("p1", [online("x")]), true);
    expect(s.results.map((x) => x.key)).toEqual(["a", "b"]);
    expect(heldCount(s)).toBe(1);
    expect(hasHeld(s)).toBe(true);
    s = apply(s, results("p2", [online("y")]), true);
    expect(heldCount(s)).toBe(2);
    s = streamReducer(s, { type: "release" });
    expect(s.results.map((x) => x.key)).toEqual(["a", "b", "x", "y"]);
    expect(hasHeld(s)).toBe(false);
  });

  it("still records provider state, coverage, errors and done while frozen", () => {
    let s = start();
    s = apply(s, ev({ type: "provider_started", providerId: "p1", name: "One", adapter: "brave", page: 1 }), true);
    s = apply(s, ev({ type: "provider_error", providerId: "p1", code: "timeout", message: "no answer" }), true);
    s = apply(s, ev({ type: "coverage", coverage: { cachedMatches: 2, onlineMatches: 3, onlineNotArchived: 3, queued: 0, partial: 0, basis: "online_page_estimate" } }), true);
    s = apply(s, ev({ type: "done", reason: "all_providers_answered" }), true);
    expect(s.providers[0]).toMatchObject({ state: "error", error: { code: "timeout" } });
    expect(s.coverage?.onlineMatches).toBe(3);
    expect(s.done).toBe(true);
    expect(s.results).toHaveLength(2);
  });

  it("holds an update to a result that is on screen even when the list is open", () => {
    let s = start();
    s = apply(s, results("p1", [], [{ key: "a", alsoOnline: true }, { key: "b", alsoOnline: true }]), false, new Set(["a"]));
    expect(s.results.find((x) => x.key === "a")?.alsoOnline).toBeUndefined();
    expect(s.results.find((x) => x.key === "b")?.alsoOnline).toBe(true);
    expect(hasHeld(s)).toBe(true);
    s = streamReducer(s, { type: "release" });
    expect(s.results.find((x) => x.key === "a")?.alsoOnline).toBe(true);
  });

  it("reorder_available only sets a flag: the order is unchanged", () => {
    let s = start();
    s = apply(s, ev({ type: "reorder_available", fusedOrder: ["b", "a"] }));
    expect(s.reorderAvailable).toBe(true);
    expect(s.results.map((x) => x.key)).toEqual(["a", "b"]);
  });

  it("applies attribution and snippet text without duplicating", () => {
    const u = applyUpdate(r("a", { snippet: "one" }), { key: "a", addAttribution: { kind: "provider", id: "p1", name: "One", rank: 2 }, snippetExtra: "two" });
    expect(u.snippet).toBe("one two");
    expect(applyUpdate(u, { key: "a", addAttribution: { kind: "provider", id: "p1", name: "One", rank: 2 } }).attribution).toHaveLength(1);
  });

  it("counts a provider's results across pages", () => {
    let s = start();
    s = apply(s, results("p1", [online("x")], [], { hasMore: true }));
    s = apply(s, results("p1", [online("y")], [], { page: 2, hasMore: false }));
    expect(s.providers[0]).toMatchObject({ count: 2, hasMore: false });
  });

  it("replaces the list from a snapshot and clears what was held", () => {
    let s = start();
    s = apply(s, results("p1", [online("x")]), true);
    s = streamReducer(s, { type: "replace", results: [r("b"), r("a"), online("x")], lastSeq: 7 });
    expect(s.results.map((x) => x.key)).toEqual(["b", "a", "x"]);
    expect(hasHeld(s)).toBe(false);
    expect(s.lastSeq).toBe(7);
  });

  it("appends a second local page without duplicates, and marks a saved result as waiting", () => {
    let s = start();
    s = streamReducer(s, { type: "append_local", results: [r("b"), r("c")] });
    expect(s.results.map((x) => x.key)).toEqual(["a", "b", "c"]);
    s = streamReducer(s, { type: "mark_queued", key: "c" });
    expect(s.results[2]).toMatchObject({ availability: "queued" });
  });
});

describe("freeze rules", () => {
  it("scrolling, focus and filter typing freeze at once", () => {
    for (const k of ["scroll", "focus", "filter_typing", "keyboard_scroll"] as const) expect(freeze(OPEN, k).frozen).toBe(true);
  });
  it("hover freezes only after more than 300 ms", () => {
    expect(freezes("hover", 0)).toBe(false);
    expect(freezes("hover", HOVER_FREEZE_MS)).toBe(false);
    expect(freezes("hover", HOVER_FREEZE_MS + 1)).toBe(true);
    expect(freeze(OPEN, "hover", 100).frozen).toBe(false);
    expect(freeze(OPEN, "hover", 400)).toEqual({ frozen: true, reason: "hover" });
  });
  it("stays frozen and keeps the first reason", () => {
    const s = freeze(OPEN, "scroll");
    expect(freeze(s, "focus")).toBe(s);
  });
  it("holds events when frozen or after the 2 s time box", () => {
    expect(shouldHold(OPEN, 100)).toBe(false);
    expect(shouldHold(OPEN, TIME_BOX_MS)).toBe(false);
    expect(shouldHold(OPEN, TIME_BOX_MS + 1)).toBe(true);
    expect(shouldHold(freeze(OPEN, "scroll"), 10)).toBe(true);
    expect(holdCause(OPEN, 10)).toBeNull();
    expect(holdCause(OPEN, 5000)).toBe("time_box");
    expect(holdCause(freeze(OPEN, "focus"), 5000)).toBe("frozen");
  });
  it("knows the keys that scroll", () => {
    expect(isScrollKey("PageDown")).toBe(true);
    expect(isScrollKey("a")).toBe(false);
  });
});

describe("summary and links", () => {
  it("builds one message", () => {
    expect(summaryMessage("tides", { total: 3, local: 3, online: 0, onlineRan: false, pending: false })).toBe("3 results for tides.");
    expect(summaryMessage("tides", { total: 0, local: 0, online: 0, onlineRan: false, pending: false })).toBe("No results for tides.");
    expect(summaryMessage("tides", { total: 3, local: 2, online: 4, onlineRan: true, pending: false })).toBe("6 results for tides: 2 from your saved pages, 4 from the web.");
    expect(summaryMessage("tides", { total: 3, local: 2, online: 0, onlineRan: true, pending: true })).toContain("More may arrive");
  });
  it("accepts only http and https addresses", () => {
    expect(safeHttpUrl("https://example.org/a")).toBe("https://example.org/a");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,<script>")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
  });
  it("words an error with a name", () => {
    expect(errorSentence("Mojeek", "timeout")).toBe("Mojeek did not answer in time");
  });
});

describe("saving and more rounds", () => {
  it("shows a saved result as a saved page that links to the archive, and puts it back when the save fails", () => {
    let s = streamReducer(start(), { type: "append_local", results: [online("x")] });
    s = streamReducer(s, { type: "mark_queued", key: "x" });
    expect(s.results[2]).toMatchObject({ availability: "queued" });
    const saved = streamReducer(s, { type: "mark_saved", key: "x", pageId: "pg_9" });
    expect(saved.results[2]).toMatchObject({ availability: "cached", pageId: "pg_9", actions: { open: "/library/pages/pg_9", saveForOffline: false } });
    const failed = streamReducer(s, { type: "mark_saved", key: "x" });
    expect(failed.results[2]).toMatchObject({ availability: "online_only" });
    expect(failed.results[2]!.actions?.saveForOffline).toBe(true);
  });
  it("reopens after done for the next round", () => {
    let s = start();
    s = apply(s, ev({ type: "done", reason: "all_providers_answered" }));
    expect(s.done).toBe(true);
    s = streamReducer(s, { type: "reopen" });
    expect(s.done).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/api";
import { markedParts, paramsFromState, requestFromState, stateFromParams, EMPTY_STATE } from "../lib/search";
import {
  boldParts, breakerText, checkText, coverageText, crawlBody, crawlStartBody, CRAWL_DEFAULTS, emptyImportDraft, fileOutcome, flavourLabel, formatWait,
  groupNote, importBody, importErrors, isWikipediaPackage, languageLabel, levelRows, parseStart, parseZimUrl, referenceLines, safeLink, validateCrawl,
  validateImport, validateZimSettings, wikipediaErrorText, zimUrl,
  type RemovalPlan, type WikipediaPreview,
} from "../lib/zim";

const apiError = (status: number, code: string, message: string, details?: unknown) => new ApiError(status, code, message, details);

describe("package snippets", () => {
  it("recognises only <b> and renders everything else as text", () => {
    const parts = boldParts('The <b>xyzzy</b> compound is <img src=x onerror="alert(1)"> dangerous <script>alert(1)</script> <a href="javascript:alert(2)">click</a> &lt;b&gt; <mark>no</mark>');
    expect(parts.filter((p) => p.mark).map((p) => p.text)).toEqual(["xyzzy"]);
    const text = parts.map((p) => p.text).join("");
    expect(text).toContain('<img src=x onerror="alert(1)">');
    expect(text).toContain("<script>alert(1)</script>");
    expect(text).toContain("<mark>no</mark>");
    expect(text).toContain("<b>");
  });
  it("leaves <mark> to archive hits", () => {
    expect(markedParts("a <mark>b</mark> <b>c</b>").filter((p) => p.mark).map((p) => p.text)).toEqual(["b"]);
    expect(markedParts("a <mark>b</mark> <b>c</b>", "b").filter((p) => p.mark).map((p) => p.text)).toEqual(["c"]);
  });
  it("copes with unbalanced bold and empty input", () => {
    expect(boldParts("")).toEqual([]);
    expect(boldParts("a </b>b <b>c")).toEqual([{ text: "a ", mark: false }, { text: "b ", mark: false }, { text: "c", mark: true }]);
  });
});

describe("addresses", () => {
  it("round-trips a package address", () => {
    expect(zimUrl("zim_1", "A/Black hole")).toBe("zim://zim_1/A/Black%20hole");
    expect(parseZimUrl("zim://zim_1/A/Black%20hole")).toEqual({ zimId: "zim_1", path: "A/Black hole" });
    expect(parseZimUrl("https://en.wikipedia.org/wiki/Benzene")).toBeNull();
    expect(parseZimUrl("zim://zim_1")).toBeNull();
  });
  it("keeps a path that is not valid percent-encoding", () => {
    expect(parseZimUrl("zim://zim_1/100%")).toEqual({ zimId: "zim_1", path: "100%" });
  });
  it("only links to http and https", () => {
    expect(safeLink("https://example.org/x")).toBe("https://example.org/x");
    expect(safeLink("javascript:alert(1)")).toBeNull();
    expect(safeLink(null)).toBeNull();
  });
});

describe("labels", () => {
  it("names languages and flavours", () => {
    expect(languageLabel("eng")).toBe("English");
    expect(languageLabel(null)).toBe("Not stated");
    expect(languageLabel("zzzz")).toBe("zzzz");
    expect(flavourLabel("nopic")).toBe("Without images");
    expect(flavourLabel("odd")).toBe("odd");
  });
  it("tells a Wikipedia package from another", () => {
    expect(isWikipediaPackage({ name: "wikipedia_en", title: "Wikipedia", sourceUrl: null, creator: null, publisher: null })).toBe(true);
    expect(isWikipediaPackage({ name: "chem", title: "Chemistry", sourceUrl: null, creator: "Wikimedia", publisher: null })).toBe(true);
    expect(isWikipediaPackage({ name: "chem", title: "Chemistry", sourceUrl: null, creator: null, publisher: "Someone" })).toBe(false);
  });
  it("says how long in words", () => {
    expect(formatWait(1)).toBe("1 second");
    expect(formatWait(45)).toBe("45 seconds");
    expect(formatWait(180)).toBe("3 minutes");
    expect(formatWait(3 * 3600 + 20 * 60)).toBe("3 hours 20 min");
  });
  it("describes checks", () => {
    expect(checkText("size:ok")).toEqual({ text: "File size passed", ok: true });
    expect(checkText("dirent_order:failed").ok).toBe(false);
    expect(checkText("open:failed").text).toBe("The package could not be opened.");
    expect(checkText("size:changed").text).toContain("different");
  });
  it("explains a short list", () => {
    expect(groupNote({ state: "ok", mode: "fulltext" })).toBe("");
    expect(groupNote({ state: "partial", mode: "fulltext" })).toContain("short");
    expect(groupNote({ state: "ok", mode: "titles" })).toContain("only titles");
    expect(groupNote({ state: "timeout", mode: "fulltext", message: "Took 900 ms." })).toBe("Took 900 ms.");
  });
});

describe("adding a package", () => {
  it("asks for an absolute path to a .zim file", () => {
    const d = emptyImportDraft();
    expect(validateImport(d).path).toMatch(/Enter the full path/);
    expect(validateImport({ ...d, path: "wiki.zim" }).path).toMatch(/starting from the top/);
    expect(validateImport({ ...d, path: "/mnt/x/wiki.zimaa" }).path).toMatch(/end in .zim/);
    expect(validateImport({ ...d, path: "/mnt/x/wiki.zim" })).toEqual({});
    expect(validateImport({ ...d, path: "/mnt/x/wiki.zim", licenseUrl: "javascript:x" }).licenseUrl).toBeTruthy();
  });
  it("copies asynchronously and sends only what was filled in", () => {
    const d = { ...emptyImportDraft(), path: " /mnt/x/wiki.zim ", copy: true, volumeId: "vol_1" };
    expect(importBody(d)).toEqual({ path: "/mnt/x/wiki.zim", copy: true, async: true, volumeId: "vol_1", priority: "P1", enabledForSearch: true, createSource: true });
    expect(importBody({ ...emptyImportDraft(), path: "/a.zim", attribution: " Credit " })).toEqual({ path: "/a.zim", copy: false, priority: "P1", enabledForSearch: true, createSource: true, attribution: "Credit" });
  });
  it("puts server problems in words", () => {
    expect(importErrors(apiError(400, "bad_request", "x", { fields: [{ in: "body", path: "path", message: "not a valid ZIM package" }] })).fields.path).toBe("not a valid ZIM package");
    expect(importErrors(apiError(409, "conflict", "dup", { existing: { title: "Wikipedia" } })).general).toBe('This package is already added as "Wikipedia".');
    expect(importErrors(apiError(507, "insufficient_storage", "full")).general).toMatch(/not enough room/);
  });
});

describe("removing a package", () => {
  const plan = (over: Partial<RemovalPlan["references"]> = {}, deletesFile = false): RemovalPlan => ({
    package: { id: "zim_1", title: "Wikipedia" }, deletesFile, fileBytes: 2048, needsConfirmation: true,
    references: {
      bookmarks: { count: 2, items: [{ id: "b1", title: "Benzene", path: "Benzene" }] }, collections: { count: 0, items: [] },
      sources: { count: 1, items: [{ id: "src_1", name: "Wikipedia" }] }, history: { count: 3 }, ...over,
    },
  });
  it("lists only what is referenced", () => {
    const lines = referenceLines(plan().references);
    expect(lines.map((l) => l.key)).toEqual(["bookmarks", "sources", "history"]);
    expect(lines[0]!.label).toMatch(/^2 bookmarks/);
    expect(lines[1]!.label).toMatch(/^1 source is bound/);
    expect(referenceLines(plan({ bookmarks: { count: 0, items: [] }, sources: { count: 0, items: [] }, history: { count: 0 } }).references)).toEqual([]);
  });
  it("says a file added in place stays on disk and only a copy is deleted", () => {
    const fmt = (n: number) => `${n} B`;
    expect(fileOutcome({ deletesFile: false, fileBytes: 10 }, fmt)).toMatch(/stays on disk/);
    expect(fileOutcome({ deletesFile: true, fileBytes: 2048 }, fmt)).toMatch(/deletes that copy \(2048 B\)\. The original file you added is not touched/);
  });
});

describe("Wikipedia crawl form", () => {
  it("reads a title or an address", () => {
    expect(parseStart("  ")).toBeNull();
    expect(parseStart("Black hole")).toEqual({ title: "Black hole" });
    expect(parseStart("https://en.wikipedia.org/wiki/Black_hole")).toEqual({ url: "https://en.wikipedia.org/wiki/Black_hole" });
  });
  it("keeps depth to 3 and pages to 2,000", () => {
    const ok = { ...CRAWL_DEFAULTS, start: "Black hole" };
    expect(validateCrawl(ok)).toEqual({});
    expect(validateCrawl({ ...ok, depth: "4" }).depth).toMatch(/0 to 3/);
    expect(validateCrawl({ ...ok, depth: "-1" }).depth).toBeTruthy();
    expect(validateCrawl({ ...ok, maxPages: "2001" }).maxPages).toMatch(/1 to 2,000/);
    expect(validateCrawl({ ...ok, maxPages: "0" }).maxPages).toBeTruthy();
    expect(validateCrawl({ ...CRAWL_DEFAULTS }).start).toBeTruthy();
    expect(validateCrawl({ ...ok, start: "https://example.org/wiki/x" }).start).toMatch(/wikipedia.org/);
    expect(validateCrawl({ ...ok, language: "e n" }).language).toBeTruthy();
  });
  it("builds the preview and crawl bodies", () => {
    const d = { ...CRAWL_DEFAULTS, start: "Black hole", language: "DE", depth: "2", maxPages: "50", images: false, name: " My topic ", priority: "P2" as const };
    expect(crawlBody(d)).toEqual({ title: "Black hole", language: "de", depth: 2, maxPages: 50, images: false, preferZim: true, skipDisambiguation: true, skipLists: true, skipYears: true });
    expect(crawlStartBody(d)).toMatchObject({ name: "My topic", priority: "P2", title: "Black hole" });
    expect(crawlBody({ ...d, start: "https://en.wikipedia.org/wiki/Black_hole" })).not.toHaveProperty("language");
  });
  it("puts errors in words", () => {
    expect(wikipediaErrorText(apiError(404, "not_found", "x"))).toMatch(/no article/);
    expect(wikipediaErrorText(apiError(409, "offline", "x"))).toMatch(/Work offline/);
    expect(wikipediaErrorText(apiError(429, "rate_limited", "x", { retryAfterMs: 90_000 }))).toMatch(/2 minutes|about 2/);
    expect(wikipediaErrorText(apiError(503, "unavailable", "x", { retryAfterMs: 120_000 }))).toMatch(/paused/);
    expect(wikipediaErrorText(apiError(400, "bad_request", "Set NCB_CONTACT to a web address"))).toMatch(/NCB_CONTACT/);
  });
  const preview = (over: Partial<WikipediaPreview> = {}): WikipediaPreview => ({
    estimate: true,
    article: { title: "Black_hole", language: "en", url: "u", revisionId: "1", bytes: 1, redirectedFrom: null },
    caps: { depth: 2, maxPages: 200, maxDepth: 3, maxPagesCeiling: 2000 },
    options: { images: true, preferZim: true, skipDisambiguation: true, skipLists: true, skipYears: true },
    levels: [
      { depth: 0, candidates: 1, willFetch: 1, inKnowledgePackage: 0, skipped: { disambiguation: 0, lists: 0, years: 0, missing: 0 }, estimated: false },
      { depth: 1, candidates: 30, willFetch: 20, inKnowledgePackage: 6, skipped: { disambiguation: 1, lists: 2, years: 1, missing: 0 }, estimated: false },
      { depth: 2, candidates: 400, willFetch: 150, inKnowledgePackage: 40, skipped: { disambiguation: 5, lists: 5, years: 5, missing: 0 }, estimated: true },
    ],
    totals: { pages: 171, images: 300, requests: 480, seconds: 480, bytes: 1_000_000 },
    knowledgePackages: { checked: 30, present: 6, packages: [{ id: "zim_1", title: "Wikipedia" }] },
    sample: [], requestsMade: 3, pace: { requestsPerSecond: 1 }, warnings: [], ...over,
  });
  it("labels later levels as estimates", () => {
    const rows = levelRows(preview());
    expect(rows.map((r) => r.label)).toEqual(["The article", "Level 1", "Level 2 (estimate)"]);
    expect(rows[1]!.skipped).toBe(4);
    expect(rows[2]!.estimated).toBe(true);
  });
  it("describes package coverage", () => {
    expect(coverageText(preview())).toBe("6 of the 30 first links are already in Wikipedia and would not be fetched.");
    expect(coverageText(preview({ knowledgePackages: { checked: 0, present: 0, packages: [] } }))).toMatch(/No installed knowledge package/);
    expect(coverageText(preview({ knowledgePackages: { checked: 0, present: 0, packages: [] }, options: { images: true, preferZim: false, skipDisambiguation: true, skipLists: true, skipYears: true } }))).toMatch(/not preferred/);
  });
  it("reads the circuit breaker", () => {
    expect(breakerText({ breaker: { state: "closed" } }).open).toBe(false);
    expect(breakerText({ breaker: { state: "open", reopensAt: "x" } })).toMatchObject({ label: "Paused", open: true });
    expect(breakerText({ breaker: { state: "half_open" } }).label).toBe("Trying again");
  });
});

describe("package search", () => {
  it("keeps the package filter and scope in the address", () => {
    const s = stateFromParams(new URLSearchParams("q=benzene&scope=zim&pkg=zim_1&pkg=zim_2"));
    expect(s).toMatchObject({ q: "benzene", scope: "zim", zimIds: ["zim_1", "zim_2"] });
    expect(stateFromParams(paramsFromState(s))).toEqual(s);
    expect(stateFromParams(new URLSearchParams("q=x&scope=bogus")).scope).toBe("all");
  });
  it("sends the mode only when it is not the default, and never with the package-only scope", () => {
    const base = { page: 1, pageSize: 10, onlineAvailable: true };
    expect(requestFromState({ ...EMPTY_STATE, q: "a" }, { ...base, zim: "unified" })).not.toHaveProperty("zim");
    expect(requestFromState({ ...EMPTY_STATE, q: "a" }, { ...base, zim: "federated" })).toMatchObject({ zim: "federated" });
    expect(requestFromState({ ...EMPTY_STATE, q: "a" }, { ...base, zim: "off" })).toMatchObject({ zim: "off" });
    const only = requestFromState({ ...EMPTY_STATE, q: "a", scope: "zim", zimIds: ["zim_1"] }, { ...base, zim: "off" });
    expect(only).toMatchObject({ scope: "zim", online: "off", zimIds: ["zim_1"] });
    expect(only).not.toHaveProperty("zim");
  });
});

describe("package settings", () => {
  it("keeps both limits in range", () => {
    expect(validateZimSettings({ zimMaxPackagesPerSearch: "5", zimHitsPerPackage: "20" })).toEqual({ values: { zimMaxPackagesPerSearch: 5, zimHitsPerPackage: 20 }, errors: {} });
    const bad = validateZimSettings({ zimMaxPackagesPerSearch: "0", zimHitsPerPackage: "51" });
    expect(bad.values).toBeNull();
    expect(bad.errors.zimMaxPackagesPerSearch).toMatch(/1 to 20/);
    expect(bad.errors.zimHitsPerPackage).toMatch(/1 to 50/);
    expect(validateZimSettings({ zimMaxPackagesPerSearch: "2.5", zimHitsPerPackage: "" }).values).toBeNull();
  });
});

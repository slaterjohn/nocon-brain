import { describe, expect, it } from "vitest";
import { fold, matchOffsets, normaliseTerm, sanitizeHtml, HIT_ID_PREFIX, MAX_HITS } from "../src/index.js";

const page = (body: string) => `<!doctype html><html><head><title>Stars and more</title></head><body>${body}</body></html>`;
const opts = { baseUrl: "https://example.org/" };

describe("find-in-page matching (A-18)", () => {
  it("normalises the term", () => {
    expect(normaliseTerm("  solar   system ")).toBe("solar system");
    expect(normaliseTerm("   ")).toBeNull();
    expect(normaliseTerm(undefined)).toBeNull();
    expect(normaliseTerm("x".repeat(500))!.length).toBe(100);
  });

  it("folds case and whitespace without changing the length", () => {
    for (const s of ["Hello World", "İstanbul", "ÀÉÎ\tx", "a\u{1F600}B"]) expect(fold(s).length).toBe(s.length);
    expect(matchOffsets("Star star STAR", "star")).toEqual([0, 5, 10]);
    expect(matchOffsets("aaaa", "aa")).toEqual([0, 2]); // non-overlapping
    expect(matchOffsets("a\nb", "a b")).toEqual([0]);
    expect(matchOffsets("abc", "")).toEqual([]);
  });

  it("the number of marks equals the number of matches, in document order with stable ids", () => {
    const html = page("<p>Stars are suns. A star is hot.</p><ul><li>STAR one</li></ul><p>No match.</p>");
    const r = sanitizeHtml(html, { ...opts, highlight: { term: "star" } });
    expect(r.hits).toBe(3);
    const ids = [...r.html.matchAll(/<mark id="(ncb-hit-\d+)" class="ncb-hit">([^<]*)<\/mark>/g)];
    expect(ids.map((m) => m[1])).toEqual([1, 2, 3].map((n) => `${HIT_ID_PREFIX}${n}`));
    expect(ids.map((m) => m[2])).toEqual(["Star", "star", "STAR"]);
    expect(r.html).toContain("mark.ncb-hit");
    expect(r.html.match(/<mark /g)).toHaveLength(3);
  });

  it("does not mark inside the title, styles, scripts or form fields, and never crosses elements", () => {
    const html = page("<style>.star{color:red}</style><textarea>star</textarea><p>st<b>ar</b> star</p><script>var star=1</script>");
    const r = sanitizeHtml(html, { ...opts, highlight: { term: "star" } });
    expect(r.hits).toBe(1);
    expect(r.html).toContain("<title>Stars and more</title>");
  });

  it("escapes page text and keeps the output free of script-capable constructs", () => {
    const html = page("<p>&lt;img src=x onerror=alert(1)&gt; star</p>");
    const r = sanitizeHtml(html, { ...opts, highlight: { term: "img src" } });
    expect(r.hits).toBe(1);
    expect(r.html).not.toMatch(/<img[^>]*onerror/i);
    expect(r.html).toContain("&lt;");
  });

  it("stops at the highlight limit", () => {
    const r = sanitizeHtml(page("<p>" + "a ".repeat(MAX_HITS + 50) + "</p>"), { ...opts, highlight: { term: "a" } });
    expect(r.hits).toBe(MAX_HITS);
  });

  it("without a term nothing changes", () => {
    const r = sanitizeHtml(page("<p>star</p>"), opts);
    expect(r.hits).toBe(0);
    expect(r.html).not.toContain("<mark");
  });
});

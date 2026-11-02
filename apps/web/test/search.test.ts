import { describe, expect, it } from "vitest";
import { displayAddress, markedParts, paramsFromState, readSuggestions, stateFromParams, suggestionQuery } from "../lib/search";

describe("markedParts", () => {
  it("keeps only mark tags as highlights and treats every other tag as text", () => {
    const parts = markedParts('Tides and <mark>moon</mark> <img src=x onerror=alert(1)> <script>x</script> &lt;b&gt; &amp; <mark>more</mark>');
    expect(parts.filter((p) => p.mark).map((p) => p.text)).toEqual(["moon", "more"]);
    const plain = parts.map((p) => p.text).join("");
    expect(plain).toContain("<img src=x onerror=alert(1)>");
    expect(plain).toContain("<script>x</script>");
    expect(plain).toContain("<b> &");
  });
  it("copes with unbalanced marks and empty input", () => {
    expect(markedParts("")).toEqual([]);
    expect(markedParts("a </mark>b <mark>c")).toEqual([{ text: "a ", mark: false }, { text: "b ", mark: false }, { text: "c", mark: true }]);
  });
});

describe("search state in the address", () => {
  it("round-trips filters", () => {
    const s = stateFromParams(new URLSearchParams("q=tides&scope=documents&source=src_1&source=src_2&type=pdf&dlFrom=2026-01-01&avail=cached&avail=nope"));
    expect(s).toMatchObject({ q: "tides", scope: "documents", sources: ["src_1", "src_2"], types: ["pdf"], dlFrom: "2026-01-01", availability: ["cached"] });
    expect(stateFromParams(paramsFromState(s))).toEqual(s);
  });
});

describe("suggestions", () => {
  it("reads strings and objects and turns a site suggestion into a site: search", () => {
    const r = readSuggestions({ suggestions: ["astronomy", { text: "example.org", kind: "domain" }, { title: "Tides", type: "title", url: "https://x.test/" }], didYouMean: { text: "astronomy" } });
    expect(r.suggestions.map(suggestionQuery)).toEqual(["astronomy", "site:example.org", "Tides"]);
    expect(r.didYouMean).toBe("astronomy");
  });
});

describe("displayAddress", () => {
  it("hides the made-up address of an imported file", () => {
    expect(displayAddress("https://imports.noconbrain.invalid/ab12/small.pdf")).toBe("Imported document");
    expect(displayAddress("https://example.org/a/b/")).toBe("example.org › a › b");
  });
});

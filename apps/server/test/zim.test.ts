import { describe, expect, it } from "vitest";
import { highlightTitle, languageForms, languageMatches, sanitiseSnippet, zimQueryText, ZimSearch, zimKey } from "../src/zim/index.js";
import type { ZimRow, ZimService } from "../src/zim/service.js";
import type { ZimSource } from "../src/zim/source.js";

describe("sanitiseSnippet: only <b> survives", () => {
  const evil = [
    `<img src=x onerror=alert(1)>`, `<script>alert(1)</script>`, `<a href="javascript:alert(1)">x</a>`, `<svg onload=alert(1)>`, `<iframe src=//evil></iframe>`,
    `<b onclick="alert(1)">bold</b>`, `<B>mixed</B>`, `<b/onclick=alert(1)>x</b>`, `<scr<script>ipt>alert(1)</scr</script>ipt>`, `<style>@import 'x'</style>`,
    `<!-- <script> -->`, `<math><mtext></mtext></math>`, `"><img src=x onerror=alert(1)>`, `<b>unclosed`, `</b></b>extra closes`, `a < b and c > d & e`,
    `<img src=x onerror=alert(1)`, `<scrip`, `&lt;script&gt;alert(1)&lt;/script&gt;`, `<noscript><p title="</noscript><img src=x onerror=alert(1)>">`,
  ];
  it("never leaves a tag other than a bare <b> or </b>", () => {
    for (const e of evil) {
      const out = sanitiseSnippet(e);
      const tags = out.match(/<[^>]*>/g) ?? [];
      expect(tags.every((t) => t === "<b>" || t === "</b>"), `${e} -> ${out}`).toBe(true);
      expect(out).not.toMatch(/<[^>]*\bon\w+\s*=/i);
      expect(out.includes("<script")).toBe(false);
      // balanced
      expect((out.match(/<b>/g) ?? []).length).toBe((out.match(/<\/b>/g) ?? []).length);
    }
  });
  it("keeps highlights and ordinary text, escapes stray markup characters and truncates", () => {
    expect(sanitiseSnippet("The <b>aromatic</b> ring")).toBe("The <b>aromatic</b> ring");
    expect(sanitiseSnippet("a < b > c & d")).toBe("a &lt; b &gt; c &amp; d");
    expect(sanitiseSnippet("fish &amp; chips &lt;3 &#39;q&#39;")).toBe("fish &amp; chips &lt;3 &#39;q&#39;");
    expect(sanitiseSnippet(`say "hi"`)).toBe("say &quot;hi&quot;");
    expect(sanitiseSnippet("<script>alert(1)</script>after")).toBe("after");
    expect(sanitiseSnippet("x".repeat(1000)).length).toBeLessThanOrEqual(400);
    expect(sanitiseSnippet("<b>" + "y".repeat(1000) + "</b>").endsWith("</b>")).toBe(true);
  });
  it("highlights terms in a title from escaped text only", () => {
    expect(highlightTitle(`<img src=x> Benzene`, ["benzene"])).toBe("&lt;img src=x&gt; <b>Benzene</b>");
    expect(highlightTitle("a.b", ["a.b", "(", "x*"])).toBe("<b>a.b</b>");
  });
});

describe("languages", () => {
  it("maps two-letter codes to ZIM's three-letter ones", () => {
    expect(languageForms("en")).toEqual(expect.arrayContaining(["en", "eng"]));
    expect(languageForms("fra")).toEqual(expect.arrayContaining(["fr", "fra"]));
    expect(languageForms("en-GB")).toEqual(expect.arrayContaining(["eng"]));
    expect(languageMatches("eng", ["en"])).toBe(true);
    expect(languageMatches("eng,fra", ["fr"])).toBe(true);
    expect(languageMatches("deu", ["en", "fr"])).toBe(false);
    expect(languageMatches("eng", [])).toBe(true);
    expect(languageMatches(null, ["en"])).toBe(false);
    expect(languageMatches(null, undefined)).toBe(true);
  });
});

describe("zimQueryText", () => {
  it("sends terms and quoted phrases and drops operators", () => {
    expect(zimQueryText(`aromatic "ring current" -benzene site:example.org`).text).toBe(`aromatic "ring current"`);
    expect(zimQueryText("site:example.org").text).toBe("");
  });
});

/** The federated search against fake packages: ranks are used, never scores; hostile snippets are neutralised; failures are contained. */
describe("ZimSearch with fake packages", () => {
  const row = (n: number, o: Partial<ZimRow> = {}): ZimRow => ({
    id: n, public_id: `zim_${n}`, title: `Package ${n}`, language: "eng", flavour: null, has_fulltext_index: 1, enabled_for_search: 1, state: "ready", priority: 1, ...o,
  } as ZimRow);
  const mk = (rows: ZimRow[], source: Partial<ZimSource>) =>
    new ZimSearch({ db: {} as never, zim: { rows: () => rows, ensureOpen: async () => true } as unknown as ZimService, source: source as ZimSource });
  const opts = { query: "aromatic", budgetMs: 100, maxPackages: 5, hitsPerPackage: 10 };

  it("keeps the order the package gave and ignores its scores", async () => {
    const z = mk([row(1)], { search: async () => ({ hits: [{ title: "Low", path: "L", score: 1, wordCount: 1, snippet: "" }, { title: "High", path: "H", score: 100, wordCount: 1, snippet: "" }], estimated: 2, partial: false }) });
    const out = await z.search(opts, "unified");
    expect(out.groups[0]!.hits.map((h) => [h.path, h.rank])).toEqual([["L", 1], ["H", 2]]);
    expect(Object.keys(out.groups[0]!.hits[0]!)).not.toContain("score");
  });

  it("neutralises a hostile snippet and title", async () => {
    const z = mk([row(1)], {
      search: async () => ({ hits: [{ title: `<img src=x onerror=alert(1)>`, path: "P", score: 1, wordCount: 1, snippet: `<b>hit</b> <img src=x onerror=alert(1)> <script>alert(2)</script>` }], estimated: 1, partial: false }),
    });
    const h = (await z.search(opts, "unified")).groups[0]!.hits[0]!;
    expect(h.snippet).toBe("<b>hit</b>");
    expect(h.title).toBe("<img src=x onerror=alert(1)>"); // the plain title is data for the UI to escape
    expect(h.titleHtml).not.toContain("<img");
    expect(h.key).toBe(zimKey("zim_1", "P"));
  });

  it("a package that fails or hangs is reported and does not stop the others", async () => {
    const slow = new Promise<never>(() => undefined);
    const z = mk([row(1), row(2), row(3)], {
      search: async (id) => {
        if (id === "zim_1") return slow;
        if (id === "zim_2") throw new Error("boom");
        return { hits: [{ title: "T", path: "T", score: 5, wordCount: 1, snippet: "x" }], estimated: 1, partial: false };
      },
    });
    const t0 = performance.now();
    const out = await z.search(opts, "unified");
    expect(performance.now() - t0).toBeLessThan(500);
    expect(out.groups.map((g) => [g.zimId, g.state])).toEqual([["zim_1", "timeout"], ["zim_2", "error"], ["zim_3", "ok"]]);
  });

  it("partial results are flagged; a missing package is skipped; the cap and the language filter apply", async () => {
    const z = mk([row(1), row(2, { state: "missing" }), row(3, { language: "fra" }), row(4), row(5, { priority: 1 })], {
      search: async () => ({ hits: [{ title: "T", path: "T", score: 5, wordCount: 1, snippet: "" }], estimated: 9, partial: true }),
    });
    const out = await z.search({ ...opts, maxPackages: 1, languages: ["en"] }, "unified");
    expect(out.groups.map((g) => [g.zimId, g.state])).toEqual([["zim_1", "partial"]]);
    expect(out.skipped.map((s) => [s.zimId, s.reason])).toEqual([["zim_2", "unavailable"], ["zim_3", "language"], ["zim_4", "cap"], ["zim_5", "cap"]]);
  });
});

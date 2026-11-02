import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { Fts5Index, IndexMissingError, IndexVersionError } from "../src/index.js";
import { buildFixture, doc, fixtureDocs, tmpFile } from "./fixture.js";

const open: Fts5Index[] = [];
afterEach(() => { for (const i of open.splice(0)) { try { i.close(); } catch { /* closed */ } } });
const fx = (docs = fixtureDocs()) => { const f = buildFixture(docs); open.push(f.idx, f.reader); return f; };
const titles = (o: { hits: { title: string }[] }) => o.hits.map((h) => h.title);

describe("S-01 index file lifecycle", () => {
  it("create, open, close; reader works while the writer writes; second writer fails", () => {
    const { idx, reader, file } = fx();
    expect(() => Fts5Index.openWriter(file)).toThrow(/lock/i);
    expect(reader.search({ query: "astronomy" }).hits.length).toBeGreaterThan(0);
    idx.upsert(doc({ title: "Brand new nebula", body: "A nebula is an interstellar cloud of dust and gas visible through telescopes." }));
    expect(reader.search({ query: "nebula" }).hits).toHaveLength(1);
  });
  it("missing and wrong-version files are reported", () => {
    const f = tmpFile();
    expect(Fts5Index.inspect(f)).toMatchObject({ exists: false, ok: false, reason: "missing" });
    expect(() => Fts5Index.openReader(f)).toThrow(IndexMissingError);
    const idx = Fts5Index.create(f);
    idx.setMeta("schema_version", "999");
    idx.close();
    expect(Fts5Index.inspect(f)).toMatchObject({ ok: false, reason: "version" });
    expect(() => Fts5Index.openReader(f)).toThrow(IndexVersionError);
    fs.writeFileSync(f, "not a database at all, just bytes");
    expect(Fts5Index.inspect(f).ok).toBe(false);
  });
  it("upsert replaces, remove deletes, vocabulary follows", () => {
    const { idx, reader } = fx();
    const d = doc({ title: "Zeppelin", body: "The zeppelin floated over the harbour." });
    idx.upsert(d);
    expect(reader.vocabDf("zeppelin")).toBe(1);
    idx.upsert({ ...d, body: "The airship floated over the harbour." });
    expect(reader.vocabDf("zeppelin")).toBe(1); // title still has it
    idx.upsert({ ...d, title: "Airship", body: "The airship floated." });
    expect(reader.vocabDf("zeppelin")).toBe(0);
    expect(idx.remove(d.pageId)).toBe(true);
    expect(idx.remove(d.pageId)).toBe(false);
    expect(reader.search({ query: "airship" }).hits).toHaveLength(0);
  });
});

describe("S-04 matching", () => {
  it("AND, phrase, exclusion, and OR fallback", () => {
    const { reader } = fx();
    expect(titles(reader.search({ query: "solar system planets" }))).toContain("Solar System");
    expect(titles(reader.search({ query: '"red planet"' }))).toEqual(["Planet"]);
    const ex = reader.search({ query: "planet -mars" });
    expect(titles(ex)).not.toContain("Mars");
    expect(titles(ex)).toContain("Astronomy");
    // no document has both words: AND is empty, OR returns both
    const or = reader.search({ query: "pasta telescopes", debug: true });
    expect(titles(or).sort()).toEqual(["Astronomy", "Cooking pasta"]);
    expect(JSON.stringify(or.plan)).toContain('"mode":"or"');
    expect(or.hits[0]!.explain?.matchedBy).toBe("or");
  });
  it("operators as filters", () => {
    const { reader } = fx();
    expect(titles(reader.search({ query: "report type:pdf" }))).toEqual(["Quarterly report"]);
    expect(titles(reader.search({ query: "revenue site:docs.example.org" }))).toEqual(["Quarterly report"]);
    expect(titles(reader.search({ query: "revenue site:example.org" }))).toEqual(["Quarterly report"]); // subdomain
    expect(titles(reader.search({ query: "moon before:2020-01-01" }))).toEqual(["Moon"]); // published 2019 beats capture 2020
    expect(titles(reader.search({ query: "moon after:2020-01-01" }))).not.toContain("Moon");
    expect(titles(reader.search({ query: "pasta -site:recipes.example.com" }))).toEqual([]);
  });
  it("stop words are dropped from bare terms but kept in phrases", () => {
    const { reader } = fx();
    expect(titles(reader.search({ query: "the solar system" }))).toContain("Solar System");
    expect(titles(reader.search({ query: '"the sun and everything"' }))).toEqual(["Solar System"]);
  });
  it("filters by facet fields and the counts match the results", () => {
    const { reader } = fx();
    const all = reader.search({ query: "earth OR moon", facets: true });
    const f = reader.search({ query: "moon", filters: { domains: ["example.org"] }, facets: true });
    expect(f.facets!.domains.find((d) => d.value === "example.org")!.count).toBe(f.total);
    const byType = reader.search({ query: "report revenue costs", filters: { types: ["pdf"] }, facets: true });
    expect(byType.total).toBe(byType.facets!.types.find((t) => t.value === "pdf")!.count);
    void all;
  });
});

describe("S-05 typo tolerance", () => {
  it("astronamy returns Astronomy first, plenets finds planets", () => {
    const { reader } = fx();
    const a = reader.search({ query: "astronamy" });
    expect(a.hits[0]!.title).toBe("Astronomy");
    expect(a.didYouMean).toMatchObject({ text: "astronomy", corrected: [{ from: "astronamy", to: "astronomy" }], appliedAutomatically: true });
    const p = reader.search({ query: "plenets" });
    expect(p.didYouMean?.corrected[0]?.to).toBe("planets");
    expect(titles(p)).toContain("Planet");
    expect(reader.search({ query: "astronamy", typo: false }).hits).toHaveLength(0);
  });
  it("stemmed forms are not corrected: discovering matches discovered", () => {
    const { reader } = fx();
    const r = reader.search({ query: "discovering planets" });
    expect(r.didYouMean).toBeUndefined();
    expect(titles(r)).toContain("Mars");
  });
});

describe("S-06 suggestions", () => {
  it("titles, terms, domains and did-you-mean; empty prefix is safe", () => {
    const { reader } = fx();
    const s = reader.suggest("astro", 8);
    expect(s.items.some((i) => i.kind === "title" && i.text === "Astronomy")).toBe(true);
    expect(s.items.some((i) => i.kind === "term" && i.text === "astronomy")).toBe(true);
    expect(reader.suggest("recip", 8).items.some((i) => i.kind === "domain" && i.text === "recipes.example.com")).toBe(true);
    expect(reader.suggest("site:rec", 5).items[0]).toMatchObject({ kind: "domain", text: "site:recipes.example.com" });
    expect(reader.suggest("astronamy ", 8).didYouMean?.text).toBe("astronomy");
    expect(reader.suggest("", 8).items).toEqual([]);
  });
});

describe("S-07 language groups and synonyms", () => {
  it("English stemming; German doc is findable without stemming", () => {
    const { reader } = fx();
    expect(titles(reader.search({ query: "planet" }))).toContain("Astronomy"); // "planets"
    expect(titles(reader.search({ query: "fotografie" }))).toEqual(["Fotografie"]);
    expect(reader.search({ query: "bildgebendes" }).hits).toHaveLength(1);
    expect(reader.stats().groups).toEqual({ en: 8, default: 1 });
  });
  it("synonyms expand at query time and can be disabled", () => {
    const { reader } = fx();
    reader.setSynonyms({ enabled: true, items: [{ term: "pasta", expansions: ["noodles"], kind: "oneway" }, { term: "moon", expansions: ["luna", "satellite"], kind: "twoway" }] });
    expect(reader.search({ query: "noodles" }).hits).toHaveLength(0);
    reader.setSynonyms({ enabled: true, items: [{ term: "noodles", expansions: ["pasta"], kind: "oneway" }] });
    expect(titles(reader.search({ query: "noodles" }))).toEqual(["Cooking pasta"]);
    expect(reader.search({ query: "noodles", synonyms: false }).hits).toHaveLength(0);
    reader.setSynonyms({ enabled: false, items: [{ term: "noodles", expansions: ["pasta"], kind: "oneway" }] });
    expect(reader.search({ query: "noodles" }).hits).toHaveLength(0);
    reader.setSynonyms({ enabled: true, items: [{ term: "luna", expansions: ["moon"], kind: "twoway" }] });
    expect(titles(reader.search({ query: "moon" }))).toContain("Moon");
    expect(titles(reader.search({ query: "luna" }))).toContain("Moon");
  });
});

describe("S-08 ranking", () => {
  it("exact title wins; boosting a domain changes order; ties are deterministic", () => {
    const docs = [
      doc({ title: "Alpha beta", body: "gamma ".repeat(30), domain: "one.org", url: "https://one.org/1" }),
      doc({ title: "Alpha beta", body: "gamma ".repeat(30), domain: "two.org", url: "https://two.org/1", contentHash: "other" }),
    ];
    const { reader } = fx(docs);
    const a = reader.search({ query: "gamma", group: false });
    const again = reader.search({ query: "gamma", group: false });
    expect(a.hits.map((h) => h.pageId)).toEqual(again.hits.map((h) => h.pageId));
    reader.setRanking({ ...reader.ranking, preferences: { domains: { "two.org": 1 }, sources: {} } });
    expect(reader.search({ query: "gamma", group: false }).hits[0]!.domain).toBe("two.org");
    reader.setRanking({ ...reader.ranking, preferences: { domains: {}, sources: {} } });
    const dbg = reader.search({ query: "gamma", group: false, debug: true });
    expect(dbg.hits[0]!.explain!.components.map((c) => c.name)).toEqual(["relevance", "exactTitle", "freshness", "linkGraph", "preference", "cached"]);
  });
});

describe("S-09 highlighting and grouping", () => {
  it("injected HTML in page text is escaped; only <mark> survives", () => {
    const { reader } = fx();
    const r = reader.search({ query: "astronomy text" });
    const inj = r.hits.find((h) => h.title === "Injection test")!;
    expect(inj.snippet).toContain("<mark>");
    expect(inj.snippet).not.toMatch(/<(?!\/?mark>)/);
    expect(inj.snippet).toContain("&lt;");
    for (const h of r.hits) expect(h.titleHtml.replace(/<\/?mark>/g, "")).not.toMatch(/[<>]/);
  });
  it("duplicates collapse with alsoAt", () => {
    const text = "Identical content about lighthouses and their keepers. ".repeat(12);
    const { reader } = fx([
      doc({ title: "Lighthouse one", body: text, contentHash: "same", url: "https://a.org/1", domain: "a.org" }),
      doc({ title: "Lighthouse copy", body: text, contentHash: "same", url: "https://b.org/1", domain: "b.org" }),
      doc({ title: "Lighthouse near", body: text + " One extra sentence here.", contentHash: "diff", url: "https://c.org/1", domain: "c.org" }),
    ]);
    const r = reader.search({ query: "lighthouses keepers" });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.alsoAt).toHaveLength(2);
    expect(reader.search({ query: "lighthouses keepers", group: false }).hits).toHaveLength(3);
  });
});

describe("per-result highlighting", () => {
  it("each hit's titleHtml and snippet come from its own document", () => {
    const { reader } = fx();
    for (const query of ["astronomy", "planet", "solar system"]) {
      const r = reader.search({ query });
      for (const h of r.hits) {
        const plain = h.titleHtml.replace(/<\/?mark>/g, "");
        expect(plain, `${query}: ${h.title}`).toBe(h.title);
      }
      if (r.hits.length > 1) expect(new Set(r.hits.map((h) => h.titleHtml)).size).toBeGreaterThan(1);
    }
  });
});

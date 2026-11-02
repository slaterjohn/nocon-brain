import { describe, expect, it } from "vitest";
import { parseQuery, parsedForApi, parseDateStart } from "../src/parser.js";
import { Fts5Index } from "../src/index.js";
import { buildFixture } from "./fixture.js";

describe("S-03 query parser", () => {
  it("parses bare terms, phrases, exclusions and operators", () => {
    const q = parseQuery('solar "exact phrase" -mars site:Example.org type:PDF before:2026-01-01 after:2025-06-30 -"bad words"');
    expect(q.terms.map((t) => t.text)).toEqual(["solar"]);
    expect(q.phrases).toEqual([["exact", "phrase"]]);
    expect(q.excludedTerms).toEqual([["mars"], ["bad", "words"]]);
    expect(q.filters.site).toEqual(["example.org"]);
    expect(q.filters.type).toEqual(["pdf"]);
    expect(q.filters.before).toBe(Date.UTC(2026, 0, 1));
    expect(q.filters.after).toBe(Date.UTC(2025, 5, 30));
    expect(q.warnings).toEqual([]);
    expect(parsedForApi(q).operators).toMatchObject({ site: "example.org", type: "pdf", before: "2026-01-01" });
  });

  it("recovers from errors with warnings", () => {
    expect(parseQuery('"unclosed phrase here').warnings[0]).toMatch(/not closed/);
    expect(parseQuery("before:nonsense x").warnings[0]).toMatch(/needs a date/);
    expect(parseQuery("site: x").warnings[0]).toMatch(/no value/);
    expect(parseQuery("type:banana").warnings[0]).toMatch(/types are/);
    expect(parseQuery("- ---").terms).toEqual([]);
    expect(parseQuery("???").warnings[0]).toMatch(/no letters or digits/);
    expect(parseQuery("a".repeat(900)).warnings[0]).toMatch(/cut to 500/);
  });

  it("treats punctuation words as phrases of their tokens and star as prefix", () => {
    const q = parseQuery("foo.bar astro*");
    expect(q.terms[0]).toMatchObject({ tokens: ["foo", "bar"], prefix: false });
    expect(q.terms[1]).toMatchObject({ tokens: ["astro"], prefix: true });
  });

  it("dates: valid and invalid", () => {
    expect(parseDateStart("2026")).toBe(Date.UTC(2026, 0, 1));
    expect(parseDateStart("2026-02")).toBe(Date.UTC(2026, 1, 1));
    expect(parseDateStart("2026-02-31")).toBeNull();
    expect(parseDateStart("x")).toBeNull();
  });

  it("property: random strings never throw and never make FTS5 syntax errors", () => {
    let seed = 987654321;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const alphabet = ['"', "'", "(", ")", "*", ":", "-", "+", "^", "{", "}", "NEAR", "AND", "OR", "NOT", " ", " ", "a", "b", "word", "site:", "type:", "before:", "after:", "2026-01-01", "é", "日本", "\u0000", "\u0001", "\\", "%", "_", "[", "]", "?", "/", ".", "\n", "\t", "x*"];
    const { idx, reader } = buildFixture();
    for (let i = 0; i < 1500; i++) {
      const len = Math.floor(rnd() * 14);
      let s = "";
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      expect(() => parseQuery(s), JSON.stringify(s)).not.toThrow();
      expect(() => reader.search({ query: s, debug: true }), JSON.stringify(s)).not.toThrow();
      expect(() => reader.suggest(s, 8), JSON.stringify(s)).not.toThrow();
    }
    // fully random code points as well
    for (let i = 0; i < 500; i++) {
      let s = "";
      for (let j = 0; j < 12; j++) s += String.fromCodePoint(Math.floor(rnd() * 0x2fff) + 1);
      expect(() => reader.search({ query: s })).not.toThrow();
    }
    // Real words, typos, prefixes, phrases, exclusions and synonyms in every combination.
    reader.setSynonyms({ enabled: true, items: [{ term: "planet", expansions: ["world", "orbiting body"], kind: "twoway" }, { term: "pasta", expansions: ["noodles"], kind: "oneway" }] });
    const words = ["astronomy", "astronamy", "planet*", "plenets", "solar", "sys*", '"solar system"', '-"red planet"', "-mars", "pasta", "the", "a", "moon", "discovering", "site:example.org", "type:pdf", "after:2020", "x", "AND", "OR", "NOT", "NEAR"];
    for (let i = 0; i < 3000; i++) {
      const n = 1 + Math.floor(rnd() * 5);
      const q = Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(" ");
      expect(() => reader.search({ query: q, filters: rnd() < 0.3 ? { types: ["html"], domains: ["example.org"] } : undefined }), q).not.toThrow();
    }
    reader.close();
    idx.close();
  });
});
void Fts5Index;

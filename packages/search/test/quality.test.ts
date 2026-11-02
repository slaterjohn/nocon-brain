import fs from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { Fts5Index } from "../src/index.js";
import { corpusAvailable, corpusPath, corpusToDoc, readCorpus, type CorpusLine } from "./corpus.js";
import { genQueries, synthCorpus, type Q } from "./synth.js";
import { tmpFile } from "./fixture.js";

/**
 * S-15 search quality regression suite. Runs on a deterministic synthetic corpus in CI, and also on the 50k Simple English
 * Wikipedia corpus when it is present (test-only, gitignored: docs/research/search-bench/data/corpus.jsonl).
 *
 * Tolerances (documented in docs/benchmarks.md, "Search quality suite"):
 *  - zero-result queries: none for single, multi, phrase and prefix queries; at most 10% of domain-filtered queries.
 *  - typo recovery (the correction equals the word the typo was made from): at least 90% on the synthetic corpus, 75% on Wikipedia
 *    (real vocabularies have many near neighbours: chemicaly -> chemical is a fair answer when the truth was chemically).
 *  - golden top-5 lists (synthetic corpus, quality/golden.json): mean overlap of top-5 at least 0.9 and at most 10% of queries
 *    may change their top result. Regenerate deliberately with UPDATE_GOLDEN=1.
 *  - latency budgets (p95 under 50 ms single-term on the synthetic corpus) are informational on CI: logged, never failing.
 */
const GOLDEN = new URL("./quality/golden.json", import.meta.url).pathname;
const QUERIES = new URL("./quality/queries.json", import.meta.url).pathname;

interface Corpus { name: string; docs: CorpusLine[]; queries: Q[] }

function build(docs: CorpusLine[]): { idx: Fts5Index; reader: Fts5Index } {
  const idx = Fts5Index.create(tmpFile());
  idx.rebuild(docs.map((d) => corpusToDoc(d)), { generationId: 1, outboxStart: 0 });
  return { idx, reader: Fts5Index.openReader(idx.file) };
}
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] ?? 0;

function suite(c: () => Corpus, label: string, o: { golden: boolean; titleSpot: boolean }) {
  describe(`S-15 quality: ${label}`, () => {
    let idx: Fts5Index, reader: Fts5Index, corpus: Corpus;
    const lat: Record<string, number[]> = {};
    const run = (q: Q) => {
      const t = performance.now();
      const query = q.prefix ? `${q.q}*` : q.q;
      const out = reader.search({ query, filters: q.domain ? { domains: [q.domain] } : undefined, facets: false });
      (lat[q.type] ??= []).push(performance.now() - t);
      return out;
    };
    it("builds", () => { corpus = c(); ({ idx, reader } = build(corpus.docs)); expect(reader.stats().docs).toBe(corpus.docs.length); }, 300_000);
    afterAll(() => { for (const [k, v] of Object.entries(lat)) console.log(`[quality ${label}] ${k}: n=${v.length} p50=${pct(v, 0.5).toFixed(1)}ms p95=${pct(v, 0.95).toFixed(1)}ms`); reader?.close(); idx?.close(); });

    it("zero-result rates are within tolerance", () => {
      const zero: Record<string, number> = {}, n: Record<string, number> = {}, zeroQ: string[] = [];
      for (const q of corpus.queries) {
        n[q.type] = (n[q.type] ?? 0) + 1;
        if (q.type === "typo") continue;
        if (!run(q).hits.length) { zero[q.type] = (zero[q.type] ?? 0) + 1; zeroQ.push(`${q.type}:${q.q}`); }
      }
      for (const t of ["single", "multi", "prefix"]) expect(zero[t] ?? 0, `zero-result ${t}: ${zeroQ.join(" | ")}`).toBe(0);
      // The research query generator ignores digits, so a few "phrases" straddle a number ("completed $1.35 billion"): allow 2 of 30 there.
      expect(zero.phrase ?? 0, `zero-result phrase: ${zeroQ.join(" | ")}`).toBeLessThanOrEqual(label.startsWith("synthetic") ? 0 : 2);
      expect((zero.filtered ?? 0) / (n.filtered ?? 1), "zero-result filtered").toBeLessThanOrEqual(0.1);
    });

    it("typo recovery is within tolerance", () => {
      const typos = corpus.queries.filter((q) => q.type === "typo" && q.truth);
      let ok = 0;
      const failed: string[] = [];
      for (const q of typos) {
        const out = run(q);
        const fixed = out.didYouMean?.corrected.some((c) => c.to === q.truth);
        if (fixed) ok++; else failed.push(`${q.q}->${q.truth} (${out.didYouMean?.corrected.map((x) => x.to).join(",") ?? "none"})`);
      }
      console.log(`[quality ${label}] typo recovery ${ok}/${typos.length}; misses: ${failed.slice(0, 6).join("; ")}`);
      expect(ok / typos.length).toBeGreaterThanOrEqual(label.startsWith("synthetic") ? 0.9 : 0.75);
    });

    it("spot checks: typo, phrase, site:, recency, exclusion, stemming", () => {
      const a = reader.search({ query: "astronamy" });
      expect(a.hits.slice(0, 3).map((h) => h.title), "astronamy").toContain("Astronomy");
      expect(a.hits[0]!.title).toBe("Astronomy");
      expect(reader.search({ query: "plenets" }).didYouMean?.corrected[0]?.to).toBe("planets");
      const ph = reader.search({ query: '"solar system"' });
      expect(ph.hits.length).toBeGreaterThan(0);
      expect(ph.hits.slice(0, 5).every((h) => /solar\W+system/i.test(h.snippet.replace(/<\/?mark>/g, "")) || /solar system/i.test(h.title))).toBe(true);
      const domain = corpus.docs[0]!.domain;
      const site = reader.search({ query: `planet site:${domain}`, facets: false });
      expect(site.hits.length).toBeGreaterThan(0);
      expect(site.hits.every((h) => h.domain === domain || h.domain.endsWith("." + domain))).toBe(true);
      const cut = Date.UTC(2024, 0, 1);
      const rec = reader.search({ query: "planets after:2024-01-01", facets: false });
      expect(rec.hits.length).toBeGreaterThan(0);
      expect(rec.hits.every((h) => (h.publishedAt ?? h.capturedAt ?? 0) >= cut)).toBe(true);
      const ex = reader.search({ query: "planet -mars" });
      expect(ex.hits.some((h) => h.title === "Mars")).toBe(false);
      const st = reader.search({ query: "discovering planets" });
      expect(st.hits.length).toBeGreaterThan(0);
      if (o.titleSpot) expect(reader.search({ query: "astronomy" }).hits[0]!.title).toBe("Astronomy");
    });

    if (o.golden) {
      it("top-5 results match the golden lists within tolerance", () => {
        const sample = corpus.queries.filter((q) => ["single", "multi", "phrase", "typo", "filtered"].includes(q.type)).filter((_, i) => i % 3 === 0);
        const now: Record<string, number[]> = {};
        for (const q of sample) now[`${q.type}|${q.q}|${q.domain ?? ""}`] = run(q).hits.slice(0, 5).map((h) => h.pageId);
        if (process.env.UPDATE_GOLDEN || !fs.existsSync(GOLDEN)) { fs.writeFileSync(GOLDEN, JSON.stringify(now)); return; }
        const gold = JSON.parse(fs.readFileSync(GOLDEN, "utf8")) as Record<string, number[]>;
        let overlap = 0, top1Changed = 0, n = 0;
        for (const [k, g] of Object.entries(gold)) {
          const cur = now[k];
          if (!cur) continue;
          n++;
          const inter = g.filter((x) => cur.includes(x)).length;
          overlap += g.length ? inter / Math.max(g.length, cur.length) : 1;
          if (g[0] !== cur[0]) top1Changed++;
        }
        expect(n).toBeGreaterThan(30);
        expect(overlap / n, "mean top-5 overlap").toBeGreaterThanOrEqual(0.9);
        expect(top1Changed / n, "top result changed").toBeLessThanOrEqual(0.1);
      });
    }

    it("latency (informational)", () => {
      const singles = corpus.queries.filter((q) => q.type === "single");
      const t = singles.map((q) => { const s = performance.now(); reader.search({ query: q.q, facets: false }); return performance.now() - s; });
      console.log(`[quality ${label}] single-term p50=${pct(t, 0.5).toFixed(1)}ms p95=${pct(t, 0.95).toFixed(1)}ms (budget 50ms, informational)`);
      expect(t.length).toBeGreaterThan(0);
    });
  });
}

const synth = (): Corpus => { const docs = synthCorpus(5000); return { name: "synthetic", docs, queries: genQueries(docs) }; };

describe("S-15 queries.json is generated with a fixed seed", () => {
  it("matches the committed file (regenerate with UPDATE_GOLDEN=1)", () => {
    const q = genQueries(synthCorpus(5000));
    if (process.env.UPDATE_GOLDEN || !fs.existsSync(QUERIES)) fs.writeFileSync(QUERIES, JSON.stringify(q));
    expect(JSON.parse(fs.readFileSync(QUERIES, "utf8"))).toEqual(JSON.parse(JSON.stringify(q)));
    expect(q.length).toBe(230);
  });
});

suite(synth, "synthetic 5k", { golden: true, titleSpot: true });

if (corpusAvailable() && process.env.NCB_QUALITY_REAL !== "0") {
  suite(() => {
    const docs: CorpusLine[] = fs.readFileSync(corpusPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l) as CorpusLine);
    const queries = JSON.parse(fs.readFileSync(new URL("../../../docs/research/search-bench/queries.json", import.meta.url).pathname, "utf8")) as Q[];
    return { name: "simplewiki", docs, queries };
  }, "simple English Wikipedia 50k", { golden: false, titleSpot: true });
}

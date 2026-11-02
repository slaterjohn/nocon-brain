// Search benchmark (S-13). Runs natively (`tsx scripts/search/bench.ts --docs=50000 --dir=/tmp/x`) and bundled inside the
// bench container (scripts/bench/search.sh). Builds index.db from the Simple English Wikipedia corpus (test-only, gitignored:
// docs/research/search-bench/data/corpus.jsonl), expanding it deterministically above 50,000 documents, then measures
// latency by query type with a fresh read-only connection. Prints one JSON object.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Fts5Index, VocabCounter, isStopword } from "../../packages/search/src/index.js";
import type { CorpusLine } from "../../packages/search/test/corpus.js";
import { corpusToDoc } from "../../packages/search/test/corpus.js";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DOCS = Number(arg("docs", "50000"));
const DIR = arg("dir", "/tmp/ncb-search-bench");
const CORPUS = arg("corpus", "docs/research/search-bench/data/corpus.jsonl");
const QUERIES = arg("queries", "docs/research/search-bench/queries.json");
const PASSES = Number(arg("passes", "3"));
const OPTIMIZE = arg("optimize", "1") !== "0";

const rss = () => Math.round(process.memoryUsage().rss / 1048576);
let peak = 0;
setInterval(() => { peak = Math.max(peak, rss()); }, 100).unref();
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0; };
const summ = (a: number[]) => ({ n: a.length, p50: +pct(a, 0.5).toFixed(2), p95: +pct(a, 0.95).toFixed(2), p99: +pct(a, 0.99).toFixed(2), max: +Math.max(0, ...a).toFixed(2) });
function rng(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const cg = (f: string) => { try { return Number(fs.readFileSync(f, "utf8").trim()); } catch { return null; } };

/** The base corpus is read line by line from the file (offsets in memory), so a 512 MB container is not holding 100 MB of text as JS strings. */
function indexLines(file: string): { offsets: number[]; lens: number[] } {
  const buf = fs.readFileSync(file);
  const offsets: number[] = [], lens: number[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) { if (i > start) { offsets.push(start); lens.push(i - start); } start = i + 1; }
  if (start < buf.length) { offsets.push(start); lens.push(buf.length - start); }
  return { offsets, lens };
}

async function* docs(): AsyncGenerator<CorpusLine> {
  const { offsets, lens } = indexLines(CORPUS);
  const fd = fs.openSync(CORPUS, "r");
  const get = (i: number): CorpusLine => {
    const b = Buffer.allocUnsafe(lens[i]!);
    fs.readSync(fd, b, 0, lens[i]!, offsets[i]!);
    return JSON.parse(b.toString("utf8")) as CorpusLine;
  };
  const r = rng(424242);
  for (let i = 0; i < DOCS; i++) {
    if (i < offsets.length) { yield get(i); continue; }
    // Deterministic synthetic documents: sentences drawn from two real ones, so vocabulary and frequencies stay realistic.
    const a = get(Math.floor(r() * offsets.length)), b = get(Math.floor(r() * offsets.length));
    const sa = a.body.split(/(?<=\.)\s+/), sb = b.body.split(/(?<=\.)\s+/);
    const out: string[] = [];
    const n = 12 + Math.floor(r() * 18);
    for (let k = 0; k < n; k++) { const src = r() < 0.6 ? sa : sb; out.push(src[Math.floor(r() * src.length)] ?? ""); }
    const dom = a.domain;
    yield {
      id: i, title: `${a.title} ${b.title.split(" ")[0]}`, headings: r() < 0.5 ? a.headings.slice(0, 2) : [], body: out.join(" "), url: `https://${dom}/wiki/synthetic-${i}`, domain: dom,
      collection: a.collection, content_type: a.content_type, language: "en", date: a.date + Math.floor(r() * 86400 * 365),
    };
  }
}

async function main() {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, "index.db");
  const T: Record<string, number> = {};
  const phase = (m: string) => console.error(`[bench] ${m} rss=${rss()}MiB t=${Math.round(performance.now() / 1000)}s`);
  phase("start");
  let t0 = performance.now();
  const idx = Fts5Index.create(file);
  const vocab = new VocabCounter();
  let batch: ReturnType<typeof corpusToDoc>[] = [];
  let n = 0, rawBytes = 0;
  const flush = () => { const b = batch; batch = []; idx.transaction(() => idx.bulkInsert(b, vocab)); };
  for await (const d of docs()) {
    rawBytes += d.body.length;
    batch.push(corpusToDoc(d));
    if (++n % 500 === 0) flush();
  }
  if (batch.length) flush();
  T.insertMs = Math.round(performance.now() - t0); t0 = performance.now();
  phase("inserted");
  const fin = idx.finishBuild(vocab, { optimize: OPTIMIZE });
  T.finishMs = Math.round(performance.now() - t0);
  phase("finished");
  Object.assign(T, { vocabMs: fin.ms.vocab, optimizeMs: fin.ms.optimize });
  idx.setMeta("last_applied_outbox_id", 0);
  idx.close();
  const indexBytes = fs.statSync(file).size;
  const buildPeakMiB = peak;

  // Fresh read-only connection, as the search worker would have after a restart.
  const reader = Fts5Index.openReader(file);
  const Q = JSON.parse(fs.readFileSync(QUERIES, "utf8")) as { type: string; q: string; prefix?: boolean; domain?: string }[];
  const run = (q: string, o: { domain?: string } = {}) => {
    const s = performance.now();
    // debug bypasses the hot-query cache, so repeated passes measure the engine and not the cache.
    const out = reader.search({ query: q, filters: o.domain ? { domains: [o.domain] } : undefined, facets: false, debug: true });
    return { ms: performance.now() - s, hits: out.hits.length, total: out.total };
  };
  // Cold: the first five queries after open.
  const cold = Q.slice(0, 5).map((q) => +run(q.prefix ? q.q + "*" : q.q, q).ms.toFixed(1));
  for (const q of Q) run(q.prefix ? q.q + "*" : q.q, q);
  const by: Record<string, number[]> = {};
  const zero: Record<string, number> = {};
  for (let pass = 0; pass < PASSES; pass++) {
    for (const q of Q) {
      const r = run(q.prefix ? q.q + "*" : q.q, q);
      (by[q.type] ??= []).push(r.ms);
      if (pass === 0 && !r.hits) zero[q.type] = (zero[q.type] ?? 0) + 1;
    }
  }
  const all = Object.values(by).flat();
  // Common terms: the most frequent real words, single and in pairs; and bare stop words.
  const vr = reader.db.prepare("SELECT term, df FROM vocab ORDER BY df DESC LIMIT 400").all() as { term: string; df: number }[];
  const common = vr.filter((v) => !isStopword(v.term) && v.term.length >= 4).slice(0, 40);
  const stops = vr.filter((v) => isStopword(v.term)).slice(0, 15);
  const cm: number[] = [], cm2: number[] = [], sw: number[] = [];
  for (let pass = 0; pass < PASSES; pass++) {
    for (const c of common) cm.push(run(c.term).ms);
    for (let i = 0; i + 1 < common.length; i += 2) cm2.push(run(`${common[i]!.term} ${common[i + 1]!.term}`).ms);
    for (const s of stops) sw.push(run(s.term).ms);
  }
  // Suggestions: three-letter prefixes of common words, and title prefixes.
  const sug: number[] = [];
  for (let pass = 0; pass < PASSES; pass++) for (const c of common) { const s = performance.now(); reader.suggest(c.term.slice(0, 3), 8); sug.push(performance.now() - s); }
  const sug2: number[] = [];
  for (const q of Q.filter((x) => x.type === "multi").slice(0, 40)) { const s = performance.now(); reader.suggest(q.q.slice(0, q.q.length - 2), 8); sug2.push(performance.now() - s); }
  // The hot-query cache: the same 75 common queries again, as a repeated search would be.
  const hot: number[] = [];
  for (const c of common) reader.search({ query: c.term, facets: false });
  for (let pass = 0; pass < PASSES; pass++) for (const c of common) { const s = performance.now(); reader.search({ query: c.term, facets: false }); hot.push(performance.now() - s); }
  // Typo queries with correction.
  const typo = by.typo ?? [];
  reader.close();
  // Incremental upserts into the finished index.
  const w = Fts5Index.openWriter(file);
  const up: number[] = [];
  const probe = corpusToDoc({ id: 9_000_001, title: "Incremental probe", headings: [], body: "A probe document with some words about lighthouses and tides. ".repeat(40), url: "https://probe.example/x", domain: "probe.example", collection: "misc", content_type: "article", language: "en", date: 1_700_000_000 });
  for (let i = 0; i < 200; i++) { const s = performance.now(); w.upsert({ ...probe, pageId: 9_000_001 + i, publicPageId: `pg_probe_${i}` }); up.push(performance.now() - s); }
  w.close();
  const cgroup = { peakMiB: cg("/sys/fs/cgroup/memory.peak") ? Math.round(cg("/sys/fs/cgroup/memory.peak")! / 1048576) : null };
  console.log(JSON.stringify({
    docs: n, rawTextMiB: Math.round(rawBytes / 1048576), indexMiB: Math.round(indexBytes / 1048576), indexOverRaw: +(indexBytes / rawBytes).toFixed(2),
    buildMs: T, buildSeconds: +((T.insertMs! + T.finishMs!) / 1000).toFixed(1), buildNodePeakRssMiB: buildPeakMiB, nodePeakRssMiB: Math.max(peak, rss()), cgroup,
    coldFirstFiveMs: cold, overall: summ(all), byType: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, summ(v)])), zeroResultQueries: zero,
    commonTerms: summ(cm), commonPairs: summ(cm2), stopWordOnly: summ(sw), suggestionsPrefix3: summ(sug), suggestionsTitle: summ(sug2), typoQueries: summ(typo), incrementalUpsertMs: summ(up),
    hotCachedRepeat: summ(hot), commonSample: common.slice(0, 5),
  }));
}
void main();

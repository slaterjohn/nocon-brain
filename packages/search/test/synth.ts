import type { CorpusLine } from "./corpus.js";

/**
 * A deterministic synthetic corpus (S-04, S-15). It stands in for the Simple English Wikipedia corpus when that
 * (test-only, gitignored) download is absent, and is what CI runs. Same seed, same corpus, on every machine.
 */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const SYL = ["ba", "ke", "lo", "mi", "na", "ro", "su", "ta", "vi", "zo", "pra", "sto", "ler", "mon", "dar", "kin", "tel", "gra", "fen", "cho", "wal", "yu", "ex", "or"];
const COMMON = "the of and to in is that for it with as was on be by this are from at or an have not but had they which their one all were we when there can more also its into time has other some than then about only new these may use two most after first over such many them even any made through where who could years work would those people very much just state how well said between during before being back".split(" ");
const REAL = ["astronomy", "planet", "planets", "solar", "system", "moon", "orbit", "earth", "telescope", "galaxy", "stars", "comet", "discovered", "discovering", "mercury", "venus", "jupiter", "saturn", "mars", "neptune"];

export function synthCorpus(n: number, seed = 20261102): CorpusLine[] {
  const r = rng(seed);
  const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)]!;
  // A lexicon of pronounceable words, then topics that each favour a slice of it.
  const lex = new Set<string>();
  while (lex.size < 4000) {
    const k = 2 + Math.floor(r() * 3);
    let w = "";
    for (let i = 0; i < k; i++) w += pick(SYL);
    lex.add(w);
  }
  const words = [...lex];
  const topics = Array.from({ length: 40 }, () => Array.from({ length: 160 }, () => words[Math.floor(Math.pow(r(), 1.4) * words.length)]!));
  const domains = ["wiki.example.org", ...Array.from({ length: 12 }, (_, i) => `site${i + 1}.example.net`)];
  const colls = ["reading-list", "research", "science", "history", "geography", "misc"];
  const docs: CorpusLine[] = [];
  const sentence = (topic: string[], len: number) => {
    const out: string[] = [];
    for (let i = 0; i < len; i++) out.push(r() < 0.35 ? pick(COMMON) : r() < 0.75 ? pick(topic) : pick(words));
    return out.join(" ") + ".";
  };
  const t0 = Date.UTC(2021, 0, 1), span = 5 * 365 * 86400;
  const planted: { title: string; body: string }[] = [
    { title: "Astronomy", body: "Astronomy is the study of stars, planets, comets and galaxies. Astronomers observe the sky with a telescope. The solar system has eight planets and one star. Astronomy began with people watching the sky." },
    { title: "Planet", body: "A planet is a large object that orbits a star. The planets of the solar system are Mercury, Venus, Earth, Mars, Jupiter, Saturn and Neptune. Astronomers keep discovering planets around other stars." },
    { title: "Solar System", body: "The solar system is the Sun and everything that orbits it, including planets, moons, asteroids and comets. Early astronomy mapped the solar system with a telescope." },
    { title: "Moon", body: "The Moon orbits the Earth. Astronomy students learn how the moon causes tides and eclipses." },
    { title: "Mars", body: "Mars is the fourth planet from the Sun. It has two small moons and was discovered in antiquity by astronomers." },
  ];
  for (let i = 0; i < n; i++) {
    const p = i < planted.length ? planted[i]! : undefined;
    const topic = pick(topics);
    const title = p?.title ?? Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(topic)).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
    const heads = Array.from({ length: Math.floor(r() * 4) }, () => pick(topic) + " " + pick(topic));
    let body = p?.body ?? "";
    const sentences = p ? 3 : 6 + Math.floor(r() * 14);
    for (let s = 0; s < sentences; s++) body += (body ? " " : "") + sentence(topic, 10 + Math.floor(r() * 14));
    if (!p && r() < 0.06) body += " " + REAL.slice(0, 1 + Math.floor(r() * REAL.length)).join(" ") + ".";
    const dom = i % 3 === 0 ? domains[0]! : pick(domains);
    docs.push({
      id: i, title: title + (docs.some((d) => d.title === title) ? ` ${i}` : ""), headings: heads, body, url: `https://${dom}/wiki/${i}`, domain: dom,
      collection: pick(colls), content_type: r() < 0.8 ? "article" : "reference", language: "en", date: Math.floor((t0 + r() * span * 1000) / 1000),
    });
  }
  return docs;
}

export interface Q { type: string; q: string; truth?: string; domain?: string; prefix?: boolean }

/** Deterministic query set in the style of docs/research/search-bench/gen_queries.mjs. */
export function genQueries(docs: CorpusLine[], seed = 1234567): Q[] {
  const r = rng(seed);
  const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)]!;
  const STOP = new Set("the and for with from that this was were are has have had not but its their which also into about after more other than when who what where".split(" "));
  const words = (s: string) => (s.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w));
  const df = new Map<string, number>();
  for (const d of docs.slice(0, 20000)) for (const w of new Set(words(d.title + " " + d.body))) df.set(w, (df.get(w) ?? 0) + 1);
  const hi = Math.max(5, Math.min(5000, Math.floor(docs.length / 10)));
  const lo = Math.max(3, Math.min(20, Math.floor(docs.length / 500)));
  const vocab = [...df].filter(([, c]) => c >= lo && c <= hi).map(([w]) => w).sort();
  const long = vocab.filter((w) => w.length >= 6);
  const domains = [...new Set(docs.map((d) => d.domain))].sort();
  const mutate = (w: string) => {
    const i = 1 + Math.floor(r() * (w.length - 2)), k = Math.floor(r() * 3);
    if (k === 0) return w.slice(0, i) + w.slice(i + 1);
    if (k === 1) return w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2);
    return w.slice(0, i) + String.fromCharCode(97 + Math.floor(r() * 26)) + w.slice(i + 1);
  };
  const Q: Q[] = [];
  for (let i = 0; i < 40; i++) Q.push({ type: "single", q: pick(vocab) });
  for (let i = 0; i < 40; i++) {
    const d = pick(docs);
    const w = words(d.body).filter((x) => df.has(x) && df.get(x)! >= lo && df.get(x)! <= hi);
    if (w.length >= 2) Q.push({ type: "multi", q: [pick(w), pick(w)].join(" ") }); else i--;
  }
  for (let i = 0; i < 20; i++) {
    const d = pick(docs);
    const w = words(d.title);
    if (w.length >= 2) Q.push({ type: "multi", q: w.slice(0, 3).join(" ") }); else i--;
  }
  Q.push({ type: "typo", q: "astronamy", truth: "astronomy" });
  for (let i = 0; i < 39; i++) { const w = pick(long); const m = mutate(w); if (m === w || df.has(m)) { i--; continue; } Q.push({ type: "typo", q: m, truth: w }); }
  Q.push({ type: "phrase", q: '"solar system"' });
  for (let i = 0; i < 29; i++) {
    const d = pick(docs);
    const t = d.body.toLowerCase().match(/[a-z]+/g) ?? [];
    if (t.length < 5) { i--; continue; }
    const j = Math.floor(r() * (t.length - 3));
    const p = t.slice(j, j + 2);
    if (p.every((x) => x.length >= 4 && !STOP.has(x))) Q.push({ type: "phrase", q: `"${p.join(" ")}"` }); else i--;
  }
  for (let i = 0; i < 30; i++) { const w = pick(long); Q.push({ type: "prefix", q: w.slice(0, 3 + Math.floor(r() * 3)), prefix: true }); }
  for (let i = 0; i < 30; i++) Q.push({ type: "filtered", q: i % 2 ? pick(vocab) : [pick(vocab), pick(vocab)].join(" "), domain: pick(domains) });
  return Q;
}

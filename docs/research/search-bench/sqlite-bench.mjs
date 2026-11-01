// Runs INSIDE the brainbench-sqlite container. Usage: node /bench/sqlite-bench.mjs index|query|spot
// FTS5 design: porter+unicode61 external-content index (title/headings/url/body, bm25 weights 10/5/3/1,
// prefix indexes 2/3/4), plus a separate vocabulary table + trigram FTS5 table for typo correction.
import { createRequire } from 'node:module'; const Database = createRequire('/opt/app/')('better-sqlite3');
import fs from 'node:fs'; import readline from 'node:readline';
const DB = '/db/bench.sqlite', mode = process.argv[2];
const rss = () => Math.round(process.memoryUsage().rss / 1048576);
let peakRss = 0; const t = setInterval(() => { peakRss = Math.max(peakRss, rss()); }, 100);
const out = o => { clearInterval(t); console.log(JSON.stringify({ ...o, nodeRssPeakMiB: Math.max(peakRss, rss()) })); };

function open() {
  const db = new Database(DB);
  db.pragma('journal_mode = WAL'); db.pragma('synchronous = NORMAL'); db.pragma('cache_size = -65536'); // 64 MiB page cache
  return db;
}
async function index() {
  for (const f of [DB, DB + '-wal', DB + '-shm']) fs.rmSync(f, { force: true });
  const db = open(); const T = {}; let t0 = performance.now(); const lap = k => { const n = performance.now(); T[k] = Math.round(n - t0); t0 = n; };
  db.exec(`CREATE TABLE docs(id INTEGER PRIMARY KEY, title TEXT, headings TEXT, url TEXT, body TEXT, domain TEXT, collection TEXT, content_type TEXT, language TEXT, date INTEGER);
    CREATE VIRTUAL TABLE fts USING fts5(title, headings, url, body, content='docs', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2', prefix='2 3 4');
    CREATE TABLE vocab(term TEXT PRIMARY KEY, df INTEGER) WITHOUT ROWID;
    CREATE VIRTUAL TABLE vocab_tri USING fts5(term, tokenize='trigram', detail=none);`);
  const ins = db.prepare('INSERT INTO docs VALUES(@id,@title,@headings,@url,@body,@domain,@collection,@content_type,@language,@date)');
  const df = new Map(); let n = 0; db.exec('BEGIN');
  const rl = readline.createInterface({ input: fs.createReadStream('/data/corpus.jsonl') });
  for await (const line of rl) {
    const d = JSON.parse(line); d.headings = d.headings.join(' \n'); ins.run(d); n++;
    for (const w of new Set((`${d.title} ${d.headings} ${d.body}`.toLowerCase().match(/[a-z0-9]{3,}/g) || []))) df.set(w, (df.get(w) || 0) + 1);
  }
  db.exec('COMMIT'); lap('insertDocsAndCountVocabMs');
  db.exec("INSERT INTO fts(rowid,title,headings,url,body) SELECT id,title,headings,url,body FROM docs"); lap('buildFtsMs');
  db.exec("INSERT INTO fts(fts) VALUES('optimize')"); lap('optimizeMs');
  const iv = db.prepare('INSERT INTO vocab VALUES(?,?)'), it = db.prepare('INSERT INTO vocab_tri(rowid,term) VALUES(?,?)');
  db.exec('BEGIN'); let r = 0; for (const [w, c] of df) { iv.run(w, c); it.run(++r, w); } db.exec('COMMIT'); lap('buildVocabTrigramMs');
  db.pragma('wal_checkpoint(TRUNCATE)'); db.close();
  out({ docs: n, vocabTerms: df.size, stages: T, totalMs: Object.values(T).reduce((a, b) => a + b, 0) });
}
// ---- query side
const lev = (a, b) => { const m = a.length, n = b.length; let p = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const c = [i]; for (let j = 1; j <= n; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); p = c; } return p[n]; };
function makeSearch(db) {
  const hasTerm = db.prepare('SELECT df FROM vocab WHERE term=?');
  const cand = new Map(); const candQ = n => cand.get(n) || (cand.set(n, db.prepare(`SELECT term FROM vocab_tri WHERE vocab_tri MATCH ? ORDER BY rank LIMIT 200`)), cand.get(n));
  const dfOf = db.prepare('SELECT df FROM vocab WHERE term=?');
  function suggest(term) {
    const L = term.length, maxD = L >= 7 ? 2 : L >= 4 ? 1 : 0; if (!maxD) return [];
    const grams = []; for (let i = 0; i + 3 <= L; i++) grams.push(`"${term.slice(i, i + 3)}"`);
    const rows = candQ(1).all(grams.join(' OR ')); const res = [];
    for (const { term: c } of rows) { if (Math.abs(c.length - L) > maxD) continue; const d = lev(term, c); if (d <= maxD) res.push({ c, d, df: dfOf.get(c).df }); }
    return res.sort((a, b) => a.d - b.d || b.df - a.df).slice(0, 3).map(x => x.c);
  }
  // user query -> FTS5 expression. Supports "phrases", -excluded, bare words; typo correction + last-word prefix.
  function build(q, { prefix = false, correct = true } = {}) {
    const parts = [], neg = []; let didYouMean = []; const re = /(-?)"([^"]+)"|(-?)([^\s"]+)/g; let m; const toks = [];
    while ((m = re.exec(q))) toks.push(m[2] !== undefined ? { neg: !!m[1], phrase: m[2] } : { neg: !!m[3], word: m[4] });
    toks.forEach((tk, i) => {
      if (tk.phrase) { const s = `"${tk.phrase.replace(/"/g, '')}"`; (tk.neg ? neg : parts).push(s); return; }
      const w = tk.word.toLowerCase().replace(/[^a-z0-9]/g, ''); if (!w) return;
      if (tk.neg) { neg.push(w); return; }
      const last = i === toks.length - 1;
      if (prefix && last) { parts.push(`${w}*`); return; }
      if (correct && w.length >= 4 && !hasTerm.get(w)) { const s = suggest(w); if (s.length) { didYouMean.push([w, s[0]]); parts.push(`(${s.join(' OR ')})`); return; } }
      parts.push(w);
    });
    if (!parts.length) return null;
    return { expr: parts.join(' ') + neg.map(n => ` NOT ${n}`).join(''), didYouMean };
  }
  const base = db.prepare(`SELECT fts.rowid AS id, bm25(fts,10.0,5.0,3.0,1.0) AS s FROM fts WHERE fts MATCH ? ORDER BY s LIMIT 10`);
  const filt = db.prepare(`SELECT fts.rowid AS id, bm25(fts,10.0,5.0,3.0,1.0) AS s FROM fts JOIN docs d ON d.id=fts.rowid WHERE fts MATCH ? AND d.domain=? ORDER BY s LIMIT 10`);
  const snip = db.prepare(`SELECT rowid AS id, snippet(fts,3,'<mark>','</mark>','…',24) AS sn FROM fts WHERE fts MATCH ? AND rowid IN (SELECT value FROM json_each(?))`);
  const meta = db.prepare(`SELECT id,title,url,domain FROM docs WHERE id IN (SELECT value FROM json_each(?))`);
  return function search(q, o = {}) {
    const b = build(q, o); if (!b) return { ids: [], titles: [], total: 0 };
    const rows = o.domain ? filt.all(b.expr, o.domain) : base.all(b.expr);
    const ids = JSON.stringify(rows.map(r => r.id)); const sn = new Map(snip.all(b.expr, ids).map(r => [r.id, r.sn])); const md = new Map(meta.all(ids).map(r => [r.id, r]));
    return { ids: rows.map(r => r.id), titles: rows.map(r => md.get(r.id).title), snippet0: sn.get(rows[0]?.id), didYouMean: b.didYouMean, expr: b.expr, total: rows.length };
  };
}
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
function query() {
  const db = open(); const search = makeSearch(db); const Q = JSON.parse(fs.readFileSync('/bench/queries.json', 'utf8'));
  const run = q => search(q.q, { prefix: !!q.prefix, domain: q.domain });
  const coldT = []; for (const q of Q.slice(0, 5)) { const a = performance.now(); run(q); coldT.push(performance.now() - a); }
  for (const q of Q) run(q); // warm-up
  const lat = {}, zero = {}; let all = [], errors = 0;
  for (let pass = 0; pass < 3; pass++) for (const q of Q) { const a = performance.now(); let r; try { r = run(q); } catch (e) { errors++; continue; } const ms = performance.now() - a;
    (lat[q.type] ||= []).push(ms); all.push(ms); if (pass === 0 && !r.total) zero[q.type] = (zero[q.type] || 0) + 1; }
  const sum = a => ({ n: a.length, p50: +pct(a, .5).toFixed(2), p95: +pct(a, .95).toFixed(2), max: +Math.max(...a).toFixed(2) });
  out({ cold5FirstQueriesMs: coldT.map(x => +x.toFixed(1)), overall: sum(all), byType: Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, sum(v)])), zeroResultQueries: zero, errors });
}
function spot() {
  const db = open(); const search = makeSearch(db);
  const S = [['typo', 'astronamy'], ['typo', 'plenets'], ['phrase', '"solar system"'], ['single', 'astronomy'], ['stemming', 'discovering planets'], ['negation', 'planet -mars'], ['prefix', 'solar sys', true], ['multi', 'moon orbit earth']];
  out({ spot: S.map(([k, q, p]) => { const r = search(q, { prefix: !!p }); return { kind: k, q, total: r.total, top5: r.titles.slice(0, 5), didYouMean: r.didYouMean, snippet0: r.snippet0 }; }) });
}
({ index, query, spot })[mode]();

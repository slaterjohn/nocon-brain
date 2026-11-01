// Generates queries.json (seeded, deterministic) from data/corpus.jsonl.
import fs from 'node:fs';
let seed = 1234567; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const pick = a => a[Math.floor(rnd() * a.length)];
const docs = fs.readFileSync('data/corpus.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
const STOP = new Set('the and for with from that this was were are has have had not but its their which also into about after more other than when who what where'.split(' '));
const words = s => (s.toLowerCase().match(/[a-z]{4,}/g) || []).filter(w => !STOP.has(w));
const df = new Map();
for (const d of docs.slice(0, 20000)) for (const w of new Set(words(d.title + ' ' + d.body))) df.set(w, (df.get(w) || 0) + 1);
// "usable" vocabulary: appears in 20..5000 docs of the 20k sample
const vocab = [...df].filter(([, n]) => n >= 20 && n <= 5000).map(([w]) => w).sort();
const long = vocab.filter(w => w.length >= 6);
const domains = [...new Set(docs.map(d => d.domain))];
const mutate = w => {
  const i = 1 + Math.floor(rnd() * (w.length - 2)), k = Math.floor(rnd() * 3);
  if (k === 0) return w.slice(0, i) + w.slice(i + 1);                       // deletion
  if (k === 1) return w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2);      // transposition
  return w.slice(0, i) + String.fromCharCode(97 + Math.floor(rnd() * 26)) + w.slice(i + 1); // substitution
};
const Q = [];
const add = (type, q, extra = {}) => Q.push({ type, q, ...extra });
for (let i = 0; i < 40; i++) add('single', pick(vocab));
for (let i = 0; i < 40; i++) { const d = pick(docs); const w = words(d.body).filter(x => df.has(x) && df.get(x) >= 20 && df.get(x) <= 5000); if (w.length >= 2) add('multi', [pick(w), pick(w)].join(' ')); else i--; } // 2 co-occurring words
for (let i = 0; i < 20; i++) { const d = pick(docs); const w = words(d.title); if (w.length >= 2) add('multi', w.slice(0, 3).join(' ')); else i--; } // coherent multi-term
add('typo', 'astronamy');
for (let i = 0; i < 39; i++) { const w = pick(long); add('typo', mutate(w), { truth: w }); }
add('phrase', '"solar system"');
for (let i = 0; i < 29; i++) { const d = pick(docs); const t = d.body.toLowerCase().match(/[a-z]+/g); const j = Math.floor(rnd() * (t.length - 3)); const p = t.slice(j, j + 2); if (p.every(x => x.length >= 4 && !STOP.has(x))) add('phrase', `"${p.join(' ')}"`); else i--; }
for (let i = 0; i < 30; i++) { const w = pick(long); add('prefix', w.slice(0, 3 + Math.floor(rnd() * 3)), { prefix: true }); }
for (let i = 0; i < 30; i++) add('filtered', i % 2 ? pick(vocab) : [pick(vocab), pick(vocab)].join(' '), { domain: pick(domains) });
fs.writeFileSync('queries.json', JSON.stringify(Q, null, 0));
const c = {}; Q.forEach(q => c[q.type] = (c[q.type] || 0) + 1); console.log(Q.length, c, 'vocab', vocab.length);

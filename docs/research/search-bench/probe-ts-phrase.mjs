// Diagnostic: why do many generated phrase queries return zero hits in Typesense?
import { execFileSync } from 'node:child_process'; import fs from 'node:fs';
const sh = (...a) => execFileSync(a[0], a.slice(1), { encoding: 'utf8', env: { ...process.env, MEM_LIMIT: '0' } });
const sleep = ms => new Promise(r => setTimeout(r, ms)); const U = 'http://127.0.0.1:18108', K = { 'X-TYPESENSE-API-KEY': 'bench' };
sh('docker', 'compose', '-p', 'brainbench', '--profile', 'typesense', 'up', '-d');
for (let i = 0; i < 60; i++) { try { if ((await fetch(U + '/health')).ok) break; } catch {} await sleep(500); }
await fetch(U + '/collections', { method: 'POST', headers: { ...K, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'docs', fields: [{ name: 'title', type: 'string', stem: process.env.STEM !== '0' }, { name: 'headings', type: 'string[]', stem: process.env.STEM !== '0' }, { name: 'url', type: 'string' }, { name: 'body', type: 'string', stem: process.env.STEM !== '0' }, { name: 'domain', type: 'string', facet: true }] }) });
const docs = fs.readFileSync('data/corpus.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
for (let i = 0; i < docs.length; i += 1000) await fetch(U + '/collections/docs/documents/import?action=create', { method: 'POST', headers: K, body: docs.slice(i, i + 1000).map(d => JSON.stringify({ ...d, id: String(d.id) })).join('\n') });
const Q = JSON.parse(fs.readFileSync('queries.json')).filter(q => q.type === 'phrase');
const ask = async (q, extra = {}) => { const p = new URLSearchParams({ q, query_by: 'title,headings,url,body', query_by_weights: '10,5,3,1', per_page: '1', ...extra }); return (await (await fetch(`${U}/collections/docs/documents/search?${p}`, { headers: K })).json()).found; };
const lc = docs.map(d => (d.title + ' ' + d.headings.join(' ') + ' ' + d.body).toLowerCase());
let zero = 0, zeroButPresent = 0, fixed = 0, shown = 0;
for (const q of Q) { const f = await ask(q.q); if (f) continue; zero++; const ph = q.q.replace(/"/g, ''); const present = lc.some(t => t.includes(ph)); if (present) zeroButPresent++;
  const f2 = await ask(q.q, { drop_tokens_threshold: 0, typo_tokens_threshold: 0, prefix: 'false' }); if (f2) fixed++; if (shown++ < 6) console.log(q.q, 'literal-substring-in-corpus:', present, 'found-with-no-prefix/typo:', f2); }
console.log({ phraseQueries: Q.length, zero, zeroButSubstringPresent: zeroButPresent, recoveredWithPrefixFalse: fixed });
sh('docker', 'compose', '-p', 'brainbench', '--profile', 'typesense', 'down', '-v');

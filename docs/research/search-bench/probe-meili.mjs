// Diagnostic: where does Meilisearch hit the cgroup limit? Usage: MEM=1g BATCH=500 node probe-meili.mjs
import { execFileSync } from 'node:child_process'; import fs from 'node:fs'; import readline from 'node:readline';
const MEM = process.env.MEM || '1g', BATCH = +(process.env.BATCH || 500), U = 'http://127.0.0.1:17700';
const env = { ...process.env, MEM_LIMIT: MEM, MEILI_IDX_MEM: process.env.MEILI_IDX_MEM || '268435456', MEILI_THREADS: process.env.MEILI_THREADS || '2' };
const sh = (...a) => execFileSync(a[0], a.slice(1), { encoding: 'utf8', env });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const j = async (p, m = 'GET', b) => { const r = await fetch(U + p, { method: m, headers: { 'content-type': 'application/json' }, body: b && JSON.stringify(b) }); return r.json(); };
sh('docker', 'compose', '-p', 'brainbench', '-f', 'docker-compose.yml', '-f', 'docker-compose.tuned.yml', '--profile', 'meili', 'up', '-d');
for (let i = 0; i < 60; i++) { try { if ((await fetch(U + '/health')).ok) break; } catch {} await sleep(500); }
await j('/indexes', 'POST', { uid: 'docs', primaryKey: 'id' });
await j('/indexes/docs/settings', 'PATCH', { searchableAttributes: ['title', 'headings', 'url', 'body'], filterableAttributes: ['domain', 'collection', 'content_type', 'language', 'date'] });
const cg = () => { try { const s = sh('docker', 'exec', 'brainbench-meili', 'cat', '/sys/fs/cgroup/memory.stat'); const g = k => Math.round(+s.match(new RegExp(`^${k} (\\d+)`, 'm'))[1] / 1048576); return `anon=${g('anon')} file=${g('file')} mapped=${g('file_mapped')} dirty=${g('file_dirty')}`; } catch { return 'n/a'; } };
const rl = readline.createInterface({ input: fs.createReadStream('data/corpus.jsonl') }); let b = [], n = 0;
try {
  for await (const l of rl) { b.push(JSON.parse(l)); if (b.length === BATCH) { const t = await j('/indexes/docs/documents', 'POST', b); n += b.length; b = [];
    for (;;) { const r = await j('/tasks?statuses=enqueued,processing&limit=1'); if (!r.results.length) break; await sleep(300); }
    if (n % 5000 === 0) console.log(n, cg()); } }
} catch (e) { console.log('FAILED at ~', n, String(e), cg()); }
console.log(sh('docker', 'inspect', 'brainbench-meili', '--format', '{{.State.OOMKilled}} {{.State.ExitCode}}'));
sh('docker', 'compose', '-p', 'brainbench', '--profile', 'meili', 'down', '-v');

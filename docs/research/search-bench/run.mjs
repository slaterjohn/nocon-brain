// Orchestrator. Usage: node run.mjs <meili|typesense|sqlite> <memLimit: 0|1g|512m> 
// Brings up the container via compose project "brainbench", indexes, restarts, queries, records results/<engine>-<mem>.json, tears down.
import { execFileSync, execFile } from 'node:child_process';
import fs from 'node:fs'; import readline from 'node:readline';
const [engine, MEM = '0'] = process.argv.slice(2);
const NAME = { meili: 'brainbench-meili', typesense: 'brainbench-typesense', sqlite: 'brainbench-sqlite' }[engine];
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', env: { ...process.env, MEM_LIMIT: MEM }, maxBuffer: 1 << 28, ...opts });
const ash = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28 }, (e, o) => e ? rej(e) : res(o)));
const TUNED = process.env.TUNED === '1';
const compose = (...a) => sh('docker', ['compose', '-p', 'brainbench', ...(TUNED ? ['-f', 'docker-compose.yml', '-f', 'docker-compose.tuned.yml'] : []), '--profile', engine, ...a]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const toMiB = s => { const m = s.trim().match(/([\d.]+)\s*(B|kB|KiB|MiB|GiB|MB|GB)/); const v = +m[1]; return { B: v / 1048576, kB: v / 1024, KiB: v / 1024, MiB: v, MB: v * .9537, GiB: v * 1024, GB: v * 954.7 }[m[2]]; };
async function memNow() { try { return toMiB((await ash('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', NAME])).split('/')[0]); } catch { return null; } }
function cgroup() { try { const ms = sh('docker', ['exec', NAME, 'cat', '/sys/fs/cgroup/memory.stat']); const g = k => +(ms.match(new RegExp(`^${k} (\\d+)`, 'm'))?.[1] ?? 0) / 1048576;
  let peak = null; try { peak = +sh('docker', ['exec', NAME, 'cat', '/sys/fs/cgroup/memory.peak']) / 1048576; } catch {}
  return { anonMiB: +g('anon').toFixed(1), fileMiB: +g('file').toFixed(1), fileMappedMiB: +g('file_mapped').toFixed(1), cgroupPeakMiB: peak && +peak.toFixed(1) }; } catch { return null; } }
let ALIVE = true;
function sampler() { const s = []; let run = true; const p = (async () => { while (run && ALIVE) { const m = await memNow(); if (m != null) s.push(m); } })();
  return async () => { run = false; await p; return { samples: s.length, peakMiB: s.length ? +Math.max(...s).toFixed(1) : null, lastMiB: s.length ? +s.at(-1).toFixed(1) : null }; }; }
const state = () => { try { return JSON.parse(sh('docker', ['inspect', NAME, '--format', '{{json .State}}'])); } catch { return {}; } };
const duKiB = p => +sh('docker', ['exec', NAME, 'du', '-sk', p]).split('\t')[0];
async function idle() { const v = []; for (let i = 0; i < 3; i++) { await sleep(2000); const m = await memNow(); if (m != null) v.push(m); } v.sort((a, b) => a - b); return +v[1]?.toFixed(1); }
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const summ = a => ({ n: a.length, p50: +pct(a, .5).toFixed(2), p95: +pct(a, .95).toFixed(2), max: +Math.max(...a).toFixed(2) });
const Q = JSON.parse(fs.readFileSync('queries.json', 'utf8'));
const LIMIT = +(process.env.LIMIT || 0);
async function* batches(n) { let cnt = 0; const rl = readline.createInterface({ input: fs.createReadStream('data/corpus.jsonl') }); let b = []; for await (const l of rl) { if (LIMIT && cnt++ >= LIMIT) break; b.push(JSON.parse(l)); if (b.length === n) { yield b; b = []; } } if (b.length) yield b; }

// ---------- adapters ----------
const meili = {
  url: 'http://127.0.0.1:17700', dataDir: '/meili_data',
  async ready() { for (let i = 0; i < 120; i++) { try { const r = await fetch(this.url + '/health'); if (r.ok) return; } catch {} await sleep(1000); } throw new Error('meili not ready'); },
  async j(path, method = 'GET', body) { const r = await fetch(this.url + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); const t = await r.text(); if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 200)}`); return JSON.parse(t); },
  async waitTasks() { for (;;) { const r = await this.j('/tasks?statuses=enqueued,processing&limit=1'); if (!r.results.length) return; await sleep(500); } },
  async setup() { await this.j('/indexes', 'POST', { uid: 'docs', primaryKey: 'id' });
    await this.j('/indexes/docs/settings', 'PATCH', { searchableAttributes: ['title', 'headings', 'url', 'body'], filterableAttributes: ['domain', 'collection', 'content_type', 'language', 'date'], sortableAttributes: ['date'], displayedAttributes: ['id', 'title', 'url', 'domain', 'body'] });
    await this.waitTasks(); },
  async index() { for await (const b of batches(+(process.env.BATCH || 1000))) { await this.j('/indexes/docs/documents', 'POST', b); if (process.env.SEQ === '1') await this.waitTasks(); } await this.waitTasks();
    const f = await this.j('/tasks?statuses=failed&limit=5'); const s = await this.j('/tasks?statuses=succeeded&types=documentAdditionOrUpdate&limit=1000');
    const st = await this.j('/indexes/docs/stats'); return { failedTasks: f.results.length, failedSample: f.results[0]?.error, indexedDocs: st.numberOfDocuments, indexDbBytes: st.rawDocumentDbSize != null ? st : undefined }; },
  async search(q) { const body = { q: q.q, limit: 10, attributesToRetrieve: ['id', 'title', 'url', 'domain'], attributesToHighlight: ['title', 'body'], attributesToCrop: ['body'], cropLength: 30 };
    if (q.domain) body.filter = `domain = "${q.domain}"`; const r = await this.j('/indexes/docs/search', 'POST', body);
    return { total: r.estimatedTotalHits, titles: r.hits.map(h => h.title), serverMs: r.processingTimeMs, snippet0: r.hits[0]?._formatted?.body }; },
};
const KEY = { 'X-TYPESENSE-API-KEY': 'bench' };
const typesense = {
  url: 'http://127.0.0.1:18108', dataDir: '/data',
  async ready() { for (let i = 0; i < 600; i++) { try { const r = await fetch(this.url + '/health'); if (r.ok && (await r.json()).ok) { const c = await fetch(this.url + (this.expectColl ? '/collections/docs' : '/collections'), { headers: KEY }); if (c.ok) return; } } catch {} await sleep(1000); } throw new Error('typesense not ready'); },
  async setup() { const r = await fetch(this.url + '/collections', { method: 'POST', headers: { ...KEY, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'docs', fields: [
    { name: 'title', type: 'string', stem: process.env.STEM !== '0' }, { name: 'headings', type: 'string[]', stem: process.env.STEM !== '0' }, { name: 'url', type: 'string' }, { name: 'body', type: 'string', stem: process.env.STEM !== '0' },
    { name: 'domain', type: 'string', facet: true }, { name: 'collection', type: 'string', facet: true }, { name: 'content_type', type: 'string', facet: true }, { name: 'language', type: 'string', facet: true }, { name: 'date', type: 'int64' }] }) });
    if (!r.ok) throw new Error(await r.text()); this.expectColl = true; },
  async index() { let fail = 0, firstErr; for await (const b of batches(1000)) { const body = b.map(d => JSON.stringify({ ...d, id: String(d.id) })).join('\n');
      const r = await fetch(this.url + '/collections/docs/documents/import?action=create', { method: 'POST', headers: KEY, body }); const t = await r.text();
      if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 200)}`); for (const l of t.split('\n')) { const o = JSON.parse(l); if (!o.success) { fail++; firstErr ||= o.error; } } }
    const c = await (await fetch(this.url + '/collections/docs', { headers: KEY })).json(); return { failedDocs: fail, failedSample: firstErr, indexedDocs: c.num_documents }; },
  async search(q) { const p = new URLSearchParams({ q: q.q, query_by: 'title,headings,url,body', query_by_weights: '10,5,3,1', per_page: '10', include_fields: 'id,title,url,domain', highlight_fields: 'title,body', snippet_threshold: '30', highlight_affix_num_tokens: '12' });
    if (q.domain) p.set('filter_by', `domain:=${q.domain}`); const r = await fetch(`${this.url}/collections/docs/documents/search?${p}`, { headers: KEY }); const o = await r.json(); if (!r.ok) throw new Error(JSON.stringify(o).slice(0, 200));
    return { total: o.found, titles: o.hits.map(h => h.document.title), serverMs: o.search_time_ms, snippet0: o.hits[0]?.highlights?.find(h => h.field === 'body')?.snippet }; },
};
const SPOT = [['typo', 'astronamy'], ['typo', 'plenets'], ['phrase', '"solar system"'], ['single', 'astronomy'], ['stemming', 'discovering planets'], ['negation', 'planet -mars'], ['prefix', 'solar sys'], ['multi', 'moon orbit earth']];

(async () => {
  const R = { engine, memLimit: MEM === '0' ? 'unlimited (Docker VM ~7.65 GiB)' : MEM, startedAt: new Date().toISOString(), tuned: TUNED ? `MEILI_MAX_INDEXING_MEMORY=${process.env.MEILI_IDX_MEM}` : undefined, host: 'Apple Silicon Mac, Docker Desktop linux/arm64 VM, 12 CPUs (NOT a Raspberry Pi)' };
  const file = `results/${engine}-${MEM === '0' ? 'unlimited' : MEM}${TUNED ? '-tuned' : ''}${LIMIT ? `-${LIMIT}docs` : ''}${process.env.SEQ === '1' ? '-seq' : ''}${process.env.STEM === '0' ? '-nostem' : ''}.json`; fs.mkdirSync('results', { recursive: true });
  try { compose('down', '-v', '--remove-orphans'); } catch {}
  compose('up', '-d'); await sleep(2000);
  try {
    if (engine === 'sqlite') {
      R.idleMiB = await idle();
      let stop = sampler(); const t0 = Date.now(); const ix = JSON.parse(await ash('docker', ['exec', NAME, 'node', '/bench/sqlite-bench.mjs', 'index'])); R.indexWallMs = Date.now() - t0; R.index = ix; R.indexMem = { ...(await stop()), ...cgroup() };
      R.diskKiB = duKiB('/db'); R.diskMiB = +(R.diskKiB / 1024).toFixed(1);
      R.idleAfterIndexMiB = await idle();
      stop = sampler(); R.query = JSON.parse(await ash('docker', ['exec', NAME, 'node', '/bench/sqlite-bench.mjs', 'query'])); R.queryMem = { ...(await stop()), ...cgroup() };
      R.spot = JSON.parse(sh('docker', ['exec', NAME, 'node', '/bench/sqlite-bench.mjs', 'spot'])).spot;
    } else {
      const E = engine === 'meili' ? meili : typesense;
      await E.ready(); R.idleMiB = await idle(); await E.setup();
      let stop = sampler(); const t0 = Date.now(); R.index = await E.index(); R.indexWallMs = Date.now() - t0; R.indexMem = { ...(await stop()), ...cgroup() };
      R.diskKiB = duKiB(E.dataDir); R.diskMiB = +(R.diskKiB / 1024).toFixed(1); R.idleAfterIndexMiB = await idle(); R.afterIndexCgroup = cgroup();
      // restart: realistic "service boot" state
      const tr = Date.now(); sh('docker', ['restart', NAME]); await E.ready(); R.restartToReadyMs = Date.now() - tr; R.idleAfterRestartMiB = await idle(); R.afterRestartCgroup = cgroup();
      stop = sampler(); const lat = {}; let all = [], errors = 0, serv = []; const zero = {}; let firstErr;
      const run = async q => { const a = performance.now(); try { const r = await E.search(q); const ms = performance.now() - a; return { ms, r }; } catch (e) { errors++; firstErr ||= String(e).slice(0, 200); return null; } };
      const cold = []; for (const q of Q.slice(0, 5)) { const x = await run(q); if (x) cold.push(+x.ms.toFixed(1)); } R.cold5FirstQueriesMs = cold;
      for (const q of Q) await run(q);
      for (let pass = 0; pass < 3; pass++) for (const q of Q) { const x = await run(q); if (!x) continue; (lat[q.type] ||= []).push(x.ms); all.push(x.ms); if (x.r.serverMs != null) serv.push(x.r.serverMs); if (pass === 0 && !x.r.total) zero[q.type] = (zero[q.type] || 0) + 1; }
      R.queryMem = { ...(await stop()), ...cgroup() };
      R.query = { overallClientMs: all.length ? summ(all) : null, serverReportedMs: serv.length ? summ(serv) : null, byType: Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, summ(v)])), zeroResultQueries: zero, errors, firstError: firstErr };
      R.spot = []; for (const [kind, q] of SPOT) { try { const r = await E.search({ q }); R.spot.push({ kind, q, total: r.total, top5: r.titles.slice(0, 5), snippet0: r.snippet0 }); } catch (e) { R.spot.push({ kind, q, error: String(e) }); } }
    }
    R.status = 'ok';
  } catch (e) { R.status = 'failed'; R.error = String(e).slice(0, 500); ALIVE = false; }
  R.containerState = (({ OOMKilled, ExitCode, Status, Error }) => ({ OOMKilled, ExitCode, Status, Error }))(state());
  try { R.dockerLogsTail = sh('docker', ['logs', '--tail', '15', NAME], { stdio: ['ignore', 'pipe', 'pipe'] }).slice(-1500); } catch {}
  fs.writeFileSync(file, JSON.stringify(R, null, 1)); console.log(file, R.status, R.error || '', JSON.stringify({ idle: R.idleMiB, indexMs: R.indexWallMs, disk: R.diskMiB, idx: R.indexMem, q: R.query?.overallClientMs || R.query?.overall, oom: R.containerState.OOMKilled }));
  try { compose('down', '-v', '--remove-orphans'); } catch {}
})();

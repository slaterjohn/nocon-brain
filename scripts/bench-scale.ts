// Scale benchmark (H-09). Builds a synthetic library through the app's own database, migrations, volume and blob layout, boots the real
// server on it and measures what a large library costs. Not part of any test suite.
//
//   pnpm bench:scale                      20,000 pages, a few minutes
//   pnpm bench:scale --pages 500000       the full run (needs about 10 GB of free disk and about an hour)
//   pnpm bench:scale --pages 5000 --exec 200 --dir /path/to/scratch --keep --out result.json
//
// Flags: --pages N, --dir PATH (scratch directory; default a fresh temp folder), --keep (do not delete it), --out FILE (also write the JSON),
// --seed N, --exec N (versions to evict in the eviction-execution sample; 0 skips it), --under-load 0|1 (search while a second rebuild runs;
// default on up to 100,000 pages), --force (skip the free-disk check).
//
// Nothing here contacts a network. The data is generated: words follow a Zipf distribution over a made-up vocabulary, so the numbers say
// how big the library is, not how good the ranking is. The synthetic library has no outline blobs, no link graph rows and no renderer
// output; see docs/benchmarks.md for what that means for the figures.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { loadConfig, newId } from "@ncb/shared";
import { openDb, type BetterSqliteDb } from "@ncb/db";
import { createServer, blobPathFor, type Services } from "@ncb/server";

// ---- arguments ---------------------------------------------------------------------------------

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const a = argv[i]!;
  if (a.includes("=")) return a.slice(a.indexOf("=") + 1);
  const next = argv[i + 1];
  return next !== undefined && !next.startsWith("--") ? next : "1";
}
const PAGES = Math.max(100, Number(flag("pages") ?? 20_000));
const KEEP = flag("keep") !== undefined;
const OUT = flag("out");
const SEED = Number(flag("seed") ?? 20261103);
const EXEC = Number(flag("exec") ?? 2000);
const UNDER_LOAD = flag("under-load") !== undefined ? flag("under-load") !== "0" : PAGES <= 100_000;
const FORCE = flag("force") !== undefined;
const ROOT = flag("dir") ? path.resolve(flag("dir")!) : fs.mkdtempSync(path.join(os.tmpdir(), "ncb-scale-"));

// ---- small helpers -----------------------------------------------------------------------------

const t0 = performance.now();
const log = (m: string) => { if (OUT && partialResult) try { fs.writeFileSync(`${OUT}.partial`, JSON.stringify(partialResult, null, 2)); } catch { /* best effort */ } console.error(`[scale ${((performance.now() - t0) / 1000).toFixed(0).padStart(5)}s rss=${rssMiB()}MiB] ${m}`); };
let partialResult: Record<string, unknown> | undefined;
const rssMiB = () => Math.round(process.memoryUsage().rss / 1048576);
let peakSampled = 0;
const sampler = setInterval(() => { peakSampled = Math.max(peakSampled, rssMiB()); }, 100);
sampler.unref();
const ms = (n: number) => Math.round(n * 100) / 100;
async function time<T>(fn: () => Promise<T> | T): Promise<{ ms: number; value: T }> {
  const s = performance.now();
  const value = await fn();
  return { ms: ms(performance.now() - s), value };
}
function pct(a: number[], p: number): number {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0;
}
const summ = (a: number[]) => ({ n: a.length, p50: ms(pct(a, 0.5)), p95: ms(pct(a, 0.95)), p99: ms(pct(a, 0.99)), max: ms(Math.max(0, ...a)) });
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const rand = rng(SEED);
const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)]!;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const mib = (n: number) => Math.round((n / 1048576) * 10) / 10;
const fileSize = (f: string) => { try { return fs.statSync(f).size; } catch { return 0; } };

// ---- vocabulary and text -----------------------------------------------------------------------

const STOP = "the of and to a in is that it was for on are as with his they at be this from have or by one had not but what all were when we there can an your which their said if do will each about how up out them then she many some so these would other into has more her two like him see time could no make than first been its who now people my made over did down only way find use may water long little very after words called just where most know get through back much before go good new write our me man too any day same right look think also around another came come work three word must because does part even place well such here take why help put different away again off went old number great tell men say small every found still between name should home big give air line set own under read last never us left end along while might next sound below saw something thought both few those always looked show large often together asked house don't world going want school important until form food keep children feet land side without boy once animal life enough took sometimes four head above kind began almost live page got earth need far hand high year mother light country father let night picture being study second soon story since white ever paper hard near sentence better best across during today however sure knew try told young sun thing whole hear example heard several change answer room sea against top turned learn point city play toward five using himself usually money seen didn't car morning body upon family later turn move face door cut done group true leave color red friend pretty fall bring sit river office market garden history system science church music street window power energy language computer village forest mountain bridge machine season weather country station library kitchen engine battery article report season doctor design network memory planet orbit signal harbour castle journal record theory method result course region century culture nation market budget policy economy research university hospital teacher student author editor server archive browser".split(/\s+/).filter(Boolean);
const STOP_COUNT = 62; // the first words of the list are the stop words
const VOCAB = 40_000;
const syl = ["ba", "do", "ke", "li", "mo", "nu", "pa", "re", "si", "to", "va", "we", "xa", "yo", "zi", "cha", "dre", "fle", "gri", "sho", "tra", "bel", "cor", "dan", "fen", "gol", "har", "jun", "kal", "lor", "mer", "nor"];
const words: string[] = [...new Set(STOP)];
{
  const seen = new Set(words);
  const r = rng(77);
  while (words.length < VOCAB) {
    const n = 2 + Math.floor(r() * 3);
    let w = "";
    for (let i = 0; i < n; i++) w += syl[Math.floor(r() * syl.length)];
    if (!seen.has(w) && w.length >= 4) { seen.add(w); words.push(w); }
  }
}
const cum = new Float64Array(VOCAB);
{
  let acc = 0;
  for (let i = 0; i < VOCAB; i++) { acc += 1 / Math.pow(i + 1, 1.02); cum[i] = acc; }
}
function zipf(): number {
  const x = rand() * cum[VOCAB - 1]!;
  let lo = 0, hi = VOCAB - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid]! < x) lo = mid + 1; else hi = mid; }
  return lo;
}
const POOL = 30_000;
const TOPICS = 50;
const sentences: string[][] = [];
for (let i = 0; i < POOL; i++) {
  const n = 6 + Math.floor(rand() * 17);
  const s: string[] = [];
  for (let k = 0; k < n; k++) s.push(words[zipf()]!);
  sentences.push(s);
}
const sentenceText = (s: string[]) => s[0]![0]!.toUpperCase() + s[0]!.slice(1) + (s.length > 1 ? " " + s.slice(1).join(" ") : "") + ".";

function docText(id: number, variant: number): { title: string; text: string; description: string } {
  // Log-normal-ish length: median about 1.4 KB, mean about 2 KB, clamped.
  const g = (rand() + rand() + rand() + rand() - 2) * 1.7;
  const chars = Math.min(40_000, Math.max(240, Math.round(1400 * Math.exp(g * 0.9))));
  const topic = (id * 7 + variant) % TOPICS;
  const base = topic * (POOL / TOPICS);
  const parts: string[] = [];
  let len = 0;
  const unique = `zq${id.toString(36)}x`;
  while (len < chars) {
    const idx = rand() < 0.7 ? base + Math.floor(rand() * (POOL / TOPICS)) : Math.floor(rand() * POOL);
    let t = sentenceText(sentences[idx]!);
    if (parts.length === 0) t = t.replace(/\.$/, ` ${unique}.`);
    parts.push(t);
    len += t.length + 1;
    if (parts.length % 6 === 0) parts.push("\n");
  }
  const tw = sentences[(base + Math.floor(rand() * (POOL / TOPICS))) % POOL]!.slice(0, 3 + Math.floor(rand() * 3));
  const title = tw.map((w, i) => (i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w)).join(" ");
  return { title, text: parts.join(" ").replace(/ \n /g, "\n\n"), description: parts[0]! };
}

// ---- configuration and server ------------------------------------------------------------------

const DATA = path.join(ROOT, "data");
const VOL = path.join(ROOT, "vol");

function config() {
  return loadConfig({
    NCB_DATA_DIR: DATA, NCB_VOLUMES_ALLOWED_ROOTS: ROOT, NCB_APP_URL: "http://localhost:3000", NCB_PROXY_SECRET: "p".repeat(32), NCB_LOG_LEVEL: "fatal",
    NCB_EXTRACT_WORKERS: "0", NCB_MIN_FREE_DISK_GB: "0", NCB_API_HOST: "127.0.0.1", NCB_ARCHIVE_HOST: "127.0.0.1", NCB_BACKUP_INTERVAL_HOURS: "0",
    NCB_VERIFY_INTERVAL_HOURS: "0",
  } as NodeJS.ProcessEnv);
}
async function boot(autoRebuild: boolean) {
  const s = performance.now();
  const server = await createServer({
    config: { ...config(), NCB_API_PORT: 0, NCB_ARCHIVE_PORT: 0 }, archive: false, runnerPollMs: 500, storageTickMs: 0,
    discovery: { tickMs: 0 }, search: { autoRebuild },
  });
  const svc = await server.initialize();
  return { server, svc, startupMs: ms(performance.now() - s) };
}

// ---- seeding -----------------------------------------------------------------------------------

interface Seeded {
  pages: number; versions: number; hosts: number; sources: number; textBlobs: number; sharedAssets: number; uniqueAssets: number; assetRefs: number;
  rawTextBytes: number; storedBytes: number; seedSeconds: number; sourcePublicIds: string[]; hostNames: string[];
}

function seed(db: BetterSqliteDb, volumeId: number): Seeded {
  const s0 = performance.now();
  const now = Date.now();
  const nHosts = Math.max(20, Math.round(PAGES / 250));
  const nSources = Math.max(5, Math.min(300, Math.round(PAGES / 1500)));
  const raw = db.raw;
  // Bulk load only: the random public-id indexes thrash the default 2 MiB cache at this size, and the run starts over if it is interrupted anyway.
  raw.pragma("cache_size = -2000000");
  raw.pragma("synchronous = OFF");
  raw.pragma("temp_store = MEMORY");
  const dirs = new Set<string>();
  const writeBlob = (data: Buffer, compress: boolean): { sha: string; stored: number } => {
    const h = sha(data);
    const file = blobPathFor(VOL, h, compress);
    const dir = path.dirname(file);
    if (!dirs.has(dir)) { fs.mkdirSync(dir, { recursive: true }); dirs.add(dir); }
    const body = compress ? zlib.zstdCompressSync(data) : data;
    fs.writeFileSync(file, body);
    return { sha: h, stored: body.length };
  };

  const insSource = raw.prepare(`INSERT INTO sources (public_id, name, type, adapter, strategy, profile, priority, retention_mode, retention_json, automatic_eviction, enabled, created_at, updated_at)
    VALUES (?, ?, 'website', 'http', 'explore', 'balanced', ?, 'latest', '{"count":1}', ?, 1, ?, ?)`);
  const srcIds: number[] = [];
  const srcPrio: number[] = [];
  const sourcePublicIds: string[] = [];
  raw.exec("BEGIN");
  for (let i = 0; i < nSources; i++) {
    const m = i % 20;
    const prio = m === 0 ? 1 : m <= 3 ? 2 : m <= 11 ? 3 : 4;
    const pid = newId("src");
    srcIds.push(Number(insSource.run(pid, `Synthetic source ${i + 1}`, prio, prio >= 3 ? 1 : 0, now, now).lastInsertRowid));
    srcPrio.push(prio);
    sourcePublicIds.push(pid);
  }
  raw.exec("COMMIT");

  const insBlob = raw.prepare(`INSERT INTO blobs (sha256, size_bytes, stored_bytes, compression, mime, kind, volume_id, refcount, zero_since, state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'ready', ?)`);
  const insAsset = raw.prepare(`INSERT INTO assets (blob_id, url, url_key, kind, mime, http_status, size_bytes, status, fetched_at) VALUES (?, ?, ?, ?, ?, 200, ?, 'ok', ?)`);
  const insPage = raw.prepare(`INSERT INTO pages (id, public_id, url_key, canonical_url, host, registrable_domain, origin, content_type, title, language, latest_version_id, version_count,
    availability, effective_priority, inbound_count, first_captured_at, last_captured_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'web', 'html', ?, 'en', NULL, ?, 'archived', ?, ?, ?, ?, ?)`);
  // The page row cannot name its latest version before that row exists, and deferring the foreign key makes SQLite scan `pages` (no index on
  // latest_version_id) for every version inserted, which made seeding quadratic. So the page goes in first and is pointed at its version after.
  const setLatest = raw.prepare("UPDATE pages SET latest_version_id = ? WHERE id = ?");
  const insVer = raw.prepare(`INSERT INTO page_versions (id, public_id, page_id, version_no, requested_url, final_url, status, http_status, mime, content_hash, title, description, language,
    word_count, total_bytes, retained, fetched_at, created_at, published_at) VALUES (?, ?, ?, ?, ?, ?, 'ready', 200, 'text/html', ?, ?, ?, 'en', ?, ?, ?, ?, ?, ?)`);
  const insContent = raw.prepare("INSERT INTO version_content (version_id, text_blob_id, extraction_method) VALUES (?, ?, 'readability')");
  const insRef = raw.prepare("INSERT INTO asset_references (version_id, asset_id, role, referenced_url) VALUES (?, ?, ?, ?)");
  const insPS = raw.prepare("INSERT INTO page_sources (page_id, source_id, first_seen_at, last_seen_at, discovered_via) VALUES (?, ?, ?, ?, 'link')");
  const bumpRef = raw.prepare("UPDATE blobs SET refcount = ? WHERE id = ?");

  // Shared assets: three per host (a style sheet, a logo, a font), referenced by every page of the host.
  const hostNames: string[] = [];
  const hostAssets: { assetId: number; blobId: number; url: string; role: string; size: number; refs: number }[][] = [];
  raw.exec("BEGIN");
  for (let h = 0; h < nHosts; h++) {
    const host = `www.site${h}.example`;
    hostNames.push(host);
    const list: (typeof hostAssets)[number] = [];
    const specs: [string, string, string, string, number, boolean][] = [
      ["/static/site.css", "css", "stylesheet", "text/css", 12_000, true],
      ["/static/logo.png", "image", "image", "image/png", 6_000, false],
      ["/static/font.woff2", "font", "font", "font/woff2", 20_000, false],
    ];
    for (const [p, kind, role, mime, size, comp] of specs) {
      const data = comp ? Buffer.from((`.s${h}{color:#${(h * 977 % 0xffffff).toString(16).padStart(6, "0")};margin:0;padding:${h % 9}px}\n`).repeat(Math.ceil(size / 50))).subarray(0, size) : Buffer.allocUnsafe(size);
      if (!comp) for (let i = 0; i < size; i += 4) data.writeUInt32LE((Math.imul(h + 1, 2654435761) ^ Math.imul(i + p.length, 40503)) >>> 0, i);
      const w = writeBlob(data, comp);
      const blobId = Number(insBlob.run(w.sha, size, w.stored, comp ? "zstd" : "none", mime, kind, volumeId, 0, now).lastInsertRowid);
      const url = `https://${host}${p}`;
      const assetId = Number(insAsset.run(blobId, url, url, kind, mime, size, now).lastInsertRowid);
      list.push({ assetId, blobId, url, role, size, refs: 0 });
    }
    hostAssets.push(list);
  }
  raw.exec("COMMIT");

  let verId = 0, textBlobs = 0, uniqueAssets = 0, assetRefs = 0, versions = 0, rawText = 0, stored = 0;
  const BATCH = 2000;
  for (let start = 0; start < PAGES; start += BATCH) {
    const end = Math.min(PAGES, start + BATCH);
    raw.exec("BEGIN");
    for (let i = start; i < end; i++) {
      const pageId = i + 1;
      const hostIdx = Math.min(nHosts - 1, Math.floor(nHosts * Math.pow(rand(), 1.6)));
      const host = hostNames[hostIdx]!;
      const reg = host.slice(4);
      const url = `https://${host}/article/${i}`;
      const nVer = rand() < 0.1 ? 2 : 1;
      const srcIdx = hostIdx % nSources;
      const second = rand() < 0.05 ? (srcIdx + 1 + Math.floor(rand() * (nSources - 1))) % nSources : -1;
      const prio = second >= 0 ? Math.min(srcPrio[srcIdx]!, srcPrio[second]!) : srcPrio[srcIdx]!;
      const ageDays = Math.floor(rand() * 1095);
      const fetchedLatest = now - ageDays * 86_400_000;
      let latestVer = 0;
      let latestTitle = "";
      const versionIds: number[] = [];
      for (let v = 1; v <= nVer; v++) {
        const d = docText(i, v);
        const text = Buffer.from(d.text, "utf8");
        rawText += text.length;
        const w = writeBlob(text, true);
        stored += w.stored;
        const blobId = Number(insBlob.run(w.sha, text.length, w.stored, "zstd", "text/plain", "text", volumeId, 1, now).lastInsertRowid);
        textBlobs++;
        const id = ++verId;
        versions++;
        const fetched = v === nVer ? fetchedLatest : fetchedLatest - (30 + Math.floor(rand() * 300)) * 86_400_000;
        const wc = d.text.split(/\s+/).length;
        const assetBytes = hostAssets[hostIdx]!.reduce((n, a) => n + a.size, 0);
        versionIds.push(id);
        if (v === nVer) { latestVer = id; latestTitle = d.title; }
        pendingVers.push({ id, pageId, v, url, d, blobId, wc, fetched, total: text.length + assetBytes, retained: v === nVer ? 1 : 0, hash: sha(text) });
      }
      // Page-unique image on 15% of pages (attached to the latest version).
      let uniq: { assetId: number; blobId: number; url: string } | null = null;
      if (rand() < 0.15) {
        const data = Buffer.allocUnsafe(3000);
        for (let k = 0; k < 3000; k += 4) data.writeUInt32LE((Math.imul(i + 1, 2246822519) ^ Math.imul(k + 7, 3266489917)) >>> 0, k);
        const w = writeBlob(data, false);
        stored += w.stored;
        const blobId = Number(insBlob.run(w.sha, 3000, w.stored, "none", "image/jpeg", "image", volumeId, 1, now).lastInsertRowid);
        const aurl = `https://${host}/img/${i}.jpg`;
        const assetId = Number(insAsset.run(blobId, aurl, aurl, "image", "image/jpeg", 3000, now).lastInsertRowid);
        uniq = { assetId, blobId, url: aurl };
        uniqueAssets++;
      }
      insPage.run(pageId, newId("pg"), url, url, host, reg, latestTitle, nVer, prio, Math.floor(rand() * rand() * 40), fetchedLatest - (nVer - 1) * 86_400_000 * 30, fetchedLatest, fetchedLatest);
      for (const pv of pendingVers.splice(0)) {
        insVer.run(pv.id, newId("ver"), pv.pageId, pv.v, pv.url, pv.url, pv.hash, pv.d.title, pv.d.description.slice(0, 200), pv.wc, pv.total, pv.retained, pv.fetched, pv.fetched, pv.fetched - 86_400_000);
        insContent.run(pv.id, pv.blobId);
        for (const a of hostAssets[hostIdx]!) { insRef.run(pv.id, a.assetId, a.role, a.url); a.refs++; assetRefs++; }
        if (uniq && pv.v === nVer) { insRef.run(pv.id, uniq.assetId, "image", uniq.url); assetRefs++; }
      }
      setLatest.run(latestVer, pageId);
      insPS.run(pageId, srcIds[srcIdx]!, fetchedLatest, fetchedLatest);
      if (second >= 0) insPS.run(pageId, srcIds[second]!, fetchedLatest, fetchedLatest);
    }
    raw.exec("COMMIT");
    if ((end % 20_000) < BATCH || end === PAGES) log(`seeded ${end.toLocaleString("en-GB")} of ${PAGES.toLocaleString("en-GB")} pages`);
  }
  raw.exec("BEGIN");
  for (const list of hostAssets) for (const a of list) bumpRef.run(a.refs, a.blobId);
  raw.exec("COMMIT");
  // The triggers queued an outbox row for every insert; the index is built from the tables, so the queue starts empty.
  raw.exec("DELETE FROM index_outbox");
  stored += hostAssets.flat().reduce((n, a) => n + a.size, 0);
  return {
    pages: PAGES, versions, hosts: nHosts, sources: nSources, textBlobs, sharedAssets: nHosts * 3, uniqueAssets, assetRefs, rawTextBytes: rawText, storedBytes: stored,
    seedSeconds: ms((performance.now() - s0) / 1000), sourcePublicIds, hostNames,
  };
}
const pendingVers: { id: number; pageId: number; v: number; url: string; d: ReturnType<typeof docText>; blobId: number; wc: number; fetched: number; total: number; retained: number; hash: string }[] = [];

// ---- measurements ------------------------------------------------------------------------------

function mutateTypo(w: string): string {
  const i = 1 + Math.floor(rand() * (w.length - 3));
  return w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2);
}

function buildQueries(seeded: Seeded, titleOf: (id: number) => string | undefined): { type: string; q: string; filters?: Record<string, string[]> }[] {
  const N = 300;
  const out: { type: string; q: string; filters?: Record<string, string[]> }[] = [];
  const content = (lo: number, hi: number) => words[lo + Math.floor(rand() * (hi - lo))]!;
  for (let i = 0; i < N; i++) out.push({ type: "common single term", q: content(STOP_COUNT + 20, Math.min(STOP_COUNT + 330, words.length)) });
  for (let i = 0; i < N; i++) out.push({ type: "mid-frequency single term", q: content(2000, 9000) });
  for (let i = 0; i < N; i++) out.push({ type: "unique token (one hit)", q: `zq${Math.floor(rand() * PAGES).toString(36)}x` });
  for (let i = 0; i < N; i++) {
    const s = sentences[Math.floor(rand() * POOL)]!.filter((w) => !STOP.includes(w));
    out.push({ type: "multi-term (2 to 3 words)", q: s.slice(0, Math.min(s.length, 2 + Math.floor(rand() * 2))).join(" ") || "archive" });
  }
  for (let i = 0; i < N; i++) {
    const s = sentences[Math.floor(rand() * POOL)]!;
    const at = Math.floor(rand() * Math.max(1, s.length - 3));
    out.push({ type: "phrase (3 words)", q: `"${s.slice(at, at + 3).join(" ")}"` });
  }
  for (let i = 0; i < N; i++) out.push({ type: "term with domain filter", q: content(STOP_COUNT + 20, STOP_COUNT + 330), filters: { domains: [pick(seeded.hostNames)] } });
  for (let i = 0; i < N; i++) out.push({ type: "term with source filter", q: content(STOP_COUNT + 20, STOP_COUNT + 330), filters: { sources: [pick(seeded.sourcePublicIds)] } });
  for (let i = 0; i < N; i++) { const w = content(2000, 9000); out.push({ type: "typo (adjacent letters swapped)", q: w.length >= 5 ? mutateTypo(w) : w }); }
  for (let i = 0; i < N; i++) out.push({ type: "exact page title", q: titleOf(1 + Math.floor(rand() * PAGES)) ?? "archive" });
  return out;
}

async function searchBench(svc: Services, seeded: Seeded) {
  const run = async (q: { q: string; filters?: Record<string, string[]> }, facets: boolean) => {
    const s = performance.now();
    const r = (await svc.search.search({ query: q.q, filters: q.filters ?? {}, online: "off", zim: "off", record: false, facets, pageSize: 20 })) as { results?: unknown[]; total?: number; tookMs?: { local?: number } };
    return { ms: performance.now() - s, hits: (r.results ?? []).length, total: r.total ?? 0, engine: r.tookMs?.local ?? 0 };
  };
  const qs = buildQueries(seeded, (id) => svc.db.get<{ title: string }>("SELECT title FROM pages WHERE id = ?", [id])?.title);
  // The first five queries after the workers start are the cold ones.
  const cold: number[] = [];
  for (const q of qs.slice(0, 5)) cold.push(ms((await run(q, false)).ms));
  const by = new Map<string, number[]>();
  const engine: number[] = [];
  const zero = new Map<string, number>();
  const sample = new Map<string, number>();
  for (const q of qs) {
    const r = await run(q, false);
    (by.get(q.type) ?? by.set(q.type, []).get(q.type)!).push(r.ms);
    engine.push(r.engine);
    if (!r.hits) zero.set(q.type, (zero.get(q.type) ?? 0) + 1);
    sample.set(q.type, (sample.get(q.type) ?? 0) + r.total);
  }
  const all = [...by.values()].flat();
  // The same queries again: the hot-query cache.
  const cached: number[] = [];
  for (const q of qs.filter((_, i) => i % 3 === 0)) cached.push((await run(q, false)).ms);
  // With facets, as the results page asks for them.
  const faceted: number[] = [];
  for (const q of qs.filter((_, i) => i % 5 === 1)) faceted.push((await run(q, true)).ms);
  // Suggestions as the search box asks for them.
  const sug: number[] = [];
  for (let i = 0; i < 300; i++) {
    const w = words[STOP_COUNT + 20 + Math.floor(rand() * 300)]!;
    const s = performance.now();
    await svc.search.suggestions(w.slice(0, 3), 8);
    sug.push(performance.now() - s);
  }
  return {
    queries: qs.length, coldFirstFiveMs: cold, overall: summ(all), overallEngineReportedLocalMs: summ(engine), byType: Object.fromEntries([...by].map(([k, v]) => [k, { ...summ(v), zeroResult: zero.get(k) ?? 0, meanTotalHits: Math.round((sample.get(k) ?? 0) / v.length) }])),
    repeatedQueriesCached: summ(cached), withFacets: summ(faceted), suggestions3LetterPrefix: summ(sug),
  };
}

async function libraryBench(svc: Services, seeded: Seeded) {
  const out: Record<string, unknown> = {};
  const lib = (q: Partial<Parameters<Services["library"]["list"]>[0]>) => svc.library.list({ limit: 50, offset: 0, ...q } as Parameters<Services["library"]["list"]>[0]);
  const measure = (label: string, f: () => unknown, runs: number) => {
    const t: number[] = [];
    let last: { total?: number } = {};
    for (let i = 0; i < runs; i++) { const s = performance.now(); last = f() as { total?: number }; t.push(performance.now() - s); }
    out[label] = { ...summ(t), total: last.total };
  };
  measure("newest first, offset 0", () => lib({}), 20);
  measure("newest first, offset 1,000", () => lib({ offset: 1000 }), 20);
  measure("newest first, offset 100,000", () => lib({ offset: Math.min(100_000, PAGES - 100) }), 10);
  measure("newest first, offset at 90% of the library", () => lib({ offset: Math.floor(PAGES * 0.9) }), 10);
  measure("sorted by title, offset 0", () => lib({ sort: "title" }), 5);
  measure("sorted by site, offset 0", () => lib({ sort: "site" }), 5);
  measure("sorted by size, offset 0", () => lib({ sort: "size" }), 5);
  measure("one source, offset 0", () => lib({ sourceId: pick(seeded.sourcePublicIds) }), 10);
  measure("one domain, offset 0", () => lib({ domain: pick(seeded.hostNames) }), 10);
  measure("priority P1 only", () => lib({ priorities: [1] }), 10);
  measure("title or address contains a word", () => lib({ q: "zq1" }), 3);
  const walk: number[] = [];
  for (let off = 0; off < 5000; off += 50) { const s = performance.now(); lib({ offset: off }); walk.push(performance.now() - s); }
  out["walking the first 100 pages of 50"] = summ(walk);
  return out;
}

async function storageBench(svc: Services, totalStoredBytes: number) {
  const out: Record<string, unknown> = {};
  const need = Math.round(totalStoredBytes * 0.02);
  const plans: number[] = [];
  let items = 0, steps = 0;
  for (let i = 0; i < 3; i++) {
    const r = await time(() => svc.storage.buildPlan({ bytesNeeded: need, incomingPriority: 1 }));
    plans.push(r.ms);
    items = r.value.plan.items.length;
    steps = r.value.plan.steps.length;
  }
  out["pressure plan (free 2% of stored bytes for an incoming P1)"] = { runsMs: plans, itemsPlanned: items, steps, bytesNeeded: need };
  const prune = await time(() => svc.storage.buildPlan({ bytesNeeded: 0, incomingPriority: 1, mode: "prune" }));
  out["tidy-up (prune) plan"] = { ms: prune.ms, itemsPlanned: prune.value.plan.items.length, unreferencedBlobs: prune.value.plan.unreferencedBlobs.length };
  const api = await time(() => svc.storage.planAndStore({ bytesNeeded: need, incomingPriority: 1 }));
  out["plan as the API returns it"] = { ms: api.ms, itemsTotal: api.value.itemsTotal, itemsListed: api.value.items.length };
  const ut = await time(() => svc.storage.usage.compute("priority"));
  out["usage by priority"] = { ms: ut.ms };
  const backup = await time(() => svc.storage.runBackup({ includeIndex: false }));
  out["backup of main.db (VACUUM INTO, checksummed)"] = { ms: backup.ms, files: backup.value.manifest.files.map((f) => ({ name: f.name, bytes: f.bytes })) };
  // Not measured here: storage.tick(). The first pass of a new install also executes the whole tidy-up plan (every surplus older copy), which is
  // the eviction execution measured separately below, and runs what is due (verify, integrity check), which the verify section times.
  const gc = await time(() => svc.blobs.collectGarbage(86_400_000));
  out["collect unreferenced files"] = { ms: gc.ms, removed: gc.value };
  return out;
}

async function verifyBench(svc: Services) {
  const perCheck: Record<string, { ms: number; findings: number; checked: Record<string, number> }> = {};
  for (const id of ["I-1", "I-2", "I-3", "I-4", "I-5", "I-6", "I-7", "I-8", "I-9", "I-10", "I-12", "I-13", "REF"]) {
    log(`verify ${id}`);
    const r = await time(() => svc.storage.maintenance.verify({ checks: [id] }));
    perCheck[id] = { ms: r.ms, findings: r.value.findings.reduce((n, f) => n + f.count, 0), checked: r.value.checked };
  }
  const sampleBlobs = 2000;
  log("verify I-11");
  const i11 = await time(() => svc.storage.maintenance.verify({ checks: ["I-11"], sampleBlobs }));
  perCheck["I-11"] = { ms: i11.ms, findings: i11.value.findings.reduce((n, f) => n + f.count, 0), checked: i11.value.checked };
  log("verify, default options, all checks");
  const full = await time(() => svc.storage.maintenance.verify({}));
  const quick = (perCheck["I-1"]?.ms ?? 0);
  return {
    perCheck, i11SampleBlobs: sampleBlobs, i11MsPerBlob: ms(i11.ms / sampleBlobs),
    allChecksDefaultMs: full.ms, allChecksDefaultFindings: full.value.findings.filter((f) => f.invariant !== "REF").map((f) => ({ invariant: f.invariant, count: f.count, examples: f.examples })),
    quickVerifyI1Ms: quick,
  };
}

function dirDiskKiB(p: string): number | null {
  try { return Number(execFileSync("du", ["-sk", p], { encoding: "utf8", timeout: 600_000 }).split("\t")[0]); } catch { return null; }
}


/** The production bundle (apps/server/dist) on the same library: time to healthy and idle memory without the TypeScript loader or the benchmark's own heap. */
async function bundledStage(): Promise<Record<string, unknown>> {
  const entry = path.resolve("apps/server/dist/index.js");
  if (!fs.existsSync(entry)) return { skipped: "apps/server/dist/index.js is missing; run pnpm --filter @ncb/server build" };
  const apiPort = 25020, archivePort = 25021;
  const env = {
    ...process.env, NODE_ENV: "production", NCB_DATA_DIR: DATA, NCB_VOLUMES_ALLOWED_ROOTS: ROOT, NCB_APP_URL: "http://localhost:3000", NCB_PROXY_SECRET: "p".repeat(32), NCB_LOG_LEVEL: "fatal",
    NCB_API_HOST: "127.0.0.1", NCB_ARCHIVE_HOST: "127.0.0.1", NCB_API_PORT: String(apiPort), NCB_ARCHIVE_PORT: String(archivePort), NCB_MIN_FREE_DISK_GB: "0",
    NCB_BACKUP_INTERVAL_HOURS: "0", NCB_VERIFY_INTERVAL_HOURS: "0",
  };
  const s = performance.now();
  const proc = (await import("node:child_process")).spawn(process.execPath, [entry], { env, stdio: ["ignore", "ignore", "pipe"] });
  let errTail = "";
  proc.stderr!.on("data", (d: Buffer) => { errTail = (errTail + d.toString()).slice(-600); });
  let exited = false;
  proc.once("exit", () => { exited = true; });
  const rssOf = (pid: number) => { try { return Math.round(Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) / 1024); } catch { return null; } };
  let healthyMs: number | null = null;
  for (let i = 0; i < 1200 && healthyMs === null && !exited; i++) {
    try {
      // node:http, not fetch: undici on macOS can throw setTypeOfService EINVAL on a loopback socket.
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.get({ host: "127.0.0.1", port: apiPort, path: "/api/system/health", timeout: 2000 }, (res) => {
          let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve(res.statusCode === 200 ? b : "")); 
        });
        req.on("error", reject); req.on("timeout", () => req.destroy(new Error("timeout")));
      });
      if (body && (JSON.parse(body) as { status?: string }).status === "ok") healthyMs = ms(performance.now() - s);
    } catch { /* not listening yet */ }
    if (healthyMs === null) await new Promise((r) => setTimeout(r, 100));
  }
  if (exited) return { error: "the bundled server exited before it was healthy", stderrTail: errTail };
  await new Promise((r) => setTimeout(r, 10_000));
  const idle = rssOf(proc.pid!);
  proc.kill("SIGTERM");
  if (!exited) await new Promise((r) => proc.once("exit", r));
  return { timeToHealthyMs: healthyMs, idleRssMiBTenSecondsAfterHealthy: idle, note: "node apps/server/dist/index.js, search index present, no jobs, API and archive listeners bound, no browser connected." };
}

// ---- main --------------------------------------------------------------------------------------

const STAGE = flag("stage");

/** Stage "seed" runs in its own process so the generator's memory does not count towards the figures taken afterwards. */
async function seedStage(): Promise<void> {
  fs.mkdirSync(VOL, { recursive: true });
  // An empty server creates the database, the migrations and a storage volume exactly as a real install does.
  const b = await boot(false);
  const baselineRssMiB = rssMiB();
  await b.svc.volumes.register({ path: VOL, name: "Main" });
  const sqliteVersion = b.svc.db.get<{ v: string }>("SELECT sqlite_version() v")!.v;
  await b.server.close();
  log("seeding");
  const sdb = openDb(path.join(DATA, "db", "main.db"));
  const volumeId = sdb.get<{ id: number }>("SELECT id FROM volumes ORDER BY id LIMIT 1")!.id;
  const seeded = seed(sdb, volumeId);
  sdb.checkpoint("TRUNCATE");
  sdb.exec("ANALYZE");
  sdb.close();
  log(`seeded in ${seeded.seedSeconds}s`);
  console.log(JSON.stringify({ seeded, baselineRssMiB, sqliteVersion }));
}

/** Stage "library": only the library paging measurements, on a library that `--stage seed --dir X` left behind (no index is built). */
async function libraryStage(): Promise<void> {
  const b = await boot(false);
  const svc = b.svc;
  const sourcePublicIds = svc.db.all<{ public_id: string }>("SELECT public_id FROM sources WHERE deleted_at IS NULL ORDER BY id").map((r) => r.public_id);
  const hostNames = svc.db.all<{ host: string }>("SELECT DISTINCT host FROM pages LIMIT 200").map((r) => r.host);
  const fd = fs.openSync(path.join(DATA, "db", "main.db"), "r"); const buf = Buffer.allocUnsafe(8 << 20); while (fs.readSync(fd, buf, 0, buf.length, null) > 0) { /* warm the cache */ } fs.closeSync(fd);
  await libraryBench(svc, { sourcePublicIds, hostNames } as Seeded);
  const out = await libraryBench(svc, { sourcePublicIds, hostNames } as Seeded);
  console.log(JSON.stringify({ pages: PAGES, libraryListing: out }, null, 2));
  await b.server.close();
}

async function main() {
  const need = PAGES * 14_000 * 1.2;
  const free = (() => { const s = fs.statfsSync(os.tmpdir()); return Number(s.bavail) * Number(s.bsize); })();
  if (!FORCE && free < need) {
    console.error(`Not enough free disk: about ${mib(need)} MiB needed for ${PAGES} pages, ${mib(free)} MiB free. Use --force to try anyway.`);
    process.exit(2);
  }
  fs.mkdirSync(ROOT, { recursive: true });
  log(`scratch directory ${ROOT}, ${PAGES} pages`);
  const result: Record<string, unknown> = {
    when: new Date().toISOString(),
    environment: {
      cpu: `${os.cpus()[0]?.model ?? "unknown"} x${os.cpus().length}`, ramGiB: Math.round(os.totalmem() / 2 ** 30), os: `${os.type()} ${os.release()} ${process.arch}`,
      node: process.version, scratchFilesystem: ROOT,
    },
    parameters: { pages: PAGES, seed: SEED, execSample: EXEC, searchUnderLoad: UNDER_LOAD },
  };
  partialResult = result; // each log line below rewrites <out>.partial, so an interrupted run keeps what it measured

  // 1 and 2. Create and fill the library in a child process.
  const child = spawnSync(process.execPath, ["--import", "tsx", process.argv[1]!, "--pages", String(PAGES), "--seed", String(SEED), "--dir", ROOT, "--stage", "seed"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024,
  });
  if (child.status !== 0) throw new Error(`seeding failed (exit ${child.status})`);
  const seedOut = JSON.parse(child.stdout.trim().split("\n").pop()!) as { seeded: Seeded; baselineRssMiB: number; sqliteVersion: string };
  const seeded = seedOut.seeded;
  result["sqliteVersion"] = seedOut.sqliteVersion;
  const dbFile = path.join(DATA, "db", "main.db");
  const { sourcePublicIds: _s, hostNames: _h, ...seedSummary } = seeded;
  result["library"] = { ...seedSummary, meanRawTextBytesPerPage: Math.round(seeded.rawTextBytes / seeded.versions) };

  // 3. Start with no index: time to healthy.
  log("cold start (no search index)");
  const memory: Record<string, number> = { "empty server, just started (MiB, separate process)": seedOut.baselineRssMiB };
  let b = await boot(false);
  const startupCold = b.startupMs;
  memory["after start, no index (MiB)"] = rssMiB();
  const svc = b.svc;
  // The seed bypassed the app, so refresh cached volume statistics the way the app does at start.
  const stats = await svc.search.status();
  result["startup"] = { coldNoIndexMs: startupCold, indexStateAtStart: (stats as { state?: string }).state };

  // 4. Build the index.
  log("index rebuild");
  const rb = await time(async () => {
    await svc.search.startRebuild("scale benchmark");
    const poll = setInterval(() => { void svc.search.status().then((s) => { const r = (s as { rebuild?: { docsDone?: number } }).rebuild; if (r) log(`indexing ${r.docsDone ?? 0}`); }); }, 60_000);
    try { await svc.search.waitForRebuild(4 * 3600_000); } finally { clearInterval(poll); }
  });
  const idxPath = path.join(DATA, "index", "index.db");
  const indexBytes = fileSize(idxPath);
  const st = (await svc.search.status()) as { docs?: number; state?: string };
  result["indexRebuild"] = { ms: rb.ms, seconds: ms(rb.ms / 1000), docsIndexed: st.docs, docsPerSecond: Math.round(((st.docs ?? PAGES) / rb.ms) * 1000), indexBytes, indexOverRawText: ms(indexBytes / seeded.rawTextBytes) };
  memory["after index rebuild (MiB)"] = rssMiB();

  // 5. Search. The files are read once, front to back, first, so the figures are for a warm page cache (as in a server that has been up for a
  // while); the first queries after opening are reported separately as "cold". A cold random read of a 4 GB file is a disk benchmark, not a search one.
  log("warming the page cache");
  for (const f of [dbFile, idxPath]) { const fd = fs.openSync(f, "r"); const buf = Buffer.allocUnsafe(8 << 20); while (fs.readSync(fd, buf, 0, buf.length, null) > 0) { /* read */ } fs.closeSync(fd); }
  log("search");
  const sb = await searchBench(svc, seeded);
  result["search"] = sb;
  memory["after search queries (MiB)"] = rssMiB();

  if (UNDER_LOAD) {
    log("search while a second rebuild runs");
    const lat: number[] = [];
    let stop = false;
    const q = buildQueries(seeded, () => undefined).filter((x) => x.type === "common single term" || x.type === "multi-term (2 to 3 words)");
    const loader = (async () => {
      let i = 0;
      while (!stop) {
        const x = q[i++ % q.length]!;
        const s = performance.now();
        await svc.search.search({ query: x.q, online: "off", zim: "off", record: false, facets: false });
        lat.push(performance.now() - s);
        await new Promise((r) => setTimeout(r, 100));
      }
    })();
    const rb2 = await time(async () => { await svc.search.startRebuild("scale benchmark under load", { fresh: true }); await svc.search.waitForRebuild(4 * 3600_000); });
    stop = true;
    await loader;
    result["searchDuringRebuild"] = { rebuildMs: rb2.ms, duringRebuild: summ(lat), idleCommonSingleTerm: sb.byType["common single term"], idleMultiTerm: sb.byType["multi-term (2 to 3 words)"] };
  }

  // 6. Library listing.
  log("library listing");
  result["libraryListing"] = await libraryBench(svc, seeded);
  memory["after library listing (MiB)"] = rssMiB();

  // 7. Storage planning and the storage pass.
  log("storage planning");
  const totalStored = svc.db.get<{ n: number }>("SELECT COALESCE(SUM(stored_bytes), 0) AS n FROM blobs")!.n;
  result["storage"] = await storageBench(svc, totalStored);
  memory["after storage planning (MiB)"] = rssMiB();

  // 8. Verify.
  log("verify");
  result["verify"] = await verifyBench(svc);
  memory["after verify (MiB)"] = rssMiB();

  // 9. Evict a sample, then see how long the index takes to follow.
  if (EXEC > 0) {
    log(`eviction execution sample (${EXEC} versions)`);
    const meanVersionBytes = Math.max(1, totalStored / seeded.versions);
    const plan = svc.storage.planAndStore({ bytesNeeded: Math.round(EXEC * meanVersionBytes), incomingPriority: 1 });
    const sqlTime = new Map<string, { ms: number; n: number }>();
    if (process.env.BENCH_SQL_PROFILE) {
      for (const m of ["run", "get", "all"] as const) {
        const orig = (svc.db[m] as (...a: unknown[]) => unknown).bind(svc.db);
        (svc.db as unknown as Record<string, unknown>)[m] = (sql: string, ...a: unknown[]) => { const t = performance.now(); try { return orig(sql, ...a); } finally { const k = sql.replace(/\s+/g, " ").slice(0, 110); const e = sqlTime.get(k) ?? { ms: 0, n: 0 }; e.ms += performance.now() - t; e.n++; sqlTime.set(k, e); } };
      }
    }
    const run = await time(() => svc.storage.runPlan(plan.planId));
    if (process.env.BENCH_SQL_PROFILE) console.error([...sqlTime].sort((a, b) => b[1].ms - a[1].ms).slice(0, 8).map(([k, v]) => `${Math.round(v.ms)} ms in ${v.n} calls: ${k}`).join("\n"));
    const evicted = run.value.evictedVersionIds.length;
    const drain = await time(() => svc.search.drain(600_000));
    result["evictionExecution"] = { planned: plan.itemsTotal, evictedVersions: evicted, ms: run.ms, versionsPerSecond: ms(evicted / (run.ms / 1000)), indexCatchUpMs: drain.ms, freedBytes: (run.value as { freedBytes?: number }).freedBytes };
    memory["after eviction sample (MiB)"] = rssMiB();
  }

  const shut = await time(() => b.server.close());
  result["shutdown"] = { ms: shut.ms };

  // 10. A restart with the index in place.
  log("warm start (index present)");
  b = await boot(false);
  (result["startup"] as Record<string, unknown>)["warmWithIndexMs"] = b.startupMs;
  memory["after warm start (MiB)"] = rssMiB();
  const firstSearch = await time(() => b.svc.search.search({ query: "archive", online: "off", zim: "off", record: false, facets: false }));
  (result["startup"] as Record<string, unknown>)["firstSearchAfterStartMs"] = firstSearch.ms;
  await b.server.close();

  log("production bundle");
  result["productionBundle"] = await bundledStage();

  // 11. Sizes.
  const mainBytes = fileSize(dbFile);
  const blobDisk = dirDiskKiB(path.join(VOL, "blobs"));
  result["sizes"] = {
    mainDbBytes: mainBytes, mainDbWalBytes: fileSize(dbFile + "-wal"), indexDbBytes: fileSize(idxPath), blobsLogicalStoredBytes: totalStored,
    blobsDiskKiB: blobDisk, blobFiles: seeded.textBlobs + seeded.sharedAssets + seeded.uniqueAssets,
    mainDbBytesPerPage: Math.round(mainBytes / PAGES), indexBytesPerPage: Math.round(fileSize(idxPath) / PAGES),
  };
  result["memory"] = { ...memory, "peak RSS sampled every 100 ms (MiB)": peakSampled, "peak RSS from the OS (MiB)": Math.round(process.resourceUsage().maxRSS / 1024), note: "One process holds the server, the index and search worker threads, and the benchmark itself." };
  result["totalWallSeconds"] = ms((performance.now() - t0) / 1000);

  const json = JSON.stringify(result, null, 2);
  if (OUT) fs.writeFileSync(OUT, json + "\n");
  console.log(json);
}

(STAGE === "seed" ? seedStage() : STAGE === "library" ? libraryStage() : main())
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => {
    if (STAGE === "seed" || STAGE === "library") return;
    if (KEEP) console.error(`kept ${ROOT}`);
    else fs.rmSync(ROOT, { recursive: true, force: true });
  });

import { isMainThread, parentPort, workerData } from "node:worker_threads";
import {
  Archive, IntegrityCheck, Searcher, SuggestionSearcher, getClusterCacheCurrentSize, getClusterCacheMaxSize, setClusterCacheMaxSize,
} from "@openzim/libzim";
import type { FromZimWorker, SearchHit, SuggestHit, ToZimWorker, ZimMeta, ZimReply } from "./protocol.js";
import type { ZimWorkerData } from "./protocol.js";

/**
 * Reader for one ZIM package (task Z-02). The file is opened read-only and read in place: nothing is extracted and nothing is written.
 * Every call is bounded by the caller (a time budget for search, a size cap for entries); a call that cannot finish is killed from outside.
 *
 * It runs as a forked child process by default and as a worker thread when asked. libzim reports some faults (a damaged file, a missing
 * index) as uncaught C++ exceptions, which abort the whole process however they are reached, so a thread cannot contain them: a child process
 * can. Bundled as dist/zim-worker.js.
 */
const inThread = !isMainThread && parentPort !== null;
const data: ZimWorkerData = inThread ? (workerData as ZimWorkerData) : (JSON.parse(process.env.NCB_ZIM_WORKER_DATA ?? "{}") as ZimWorkerData);
const send = (m: FromZimWorker): void => {
  if (inThread) parentPort!.postMessage(m);
  else process.send?.(m);
};
if (!inThread) {
  if (!process.send) throw new Error("zim-worker.ts must run as a worker thread or a forked process");
  // The parent is gone (killed, crashed): nothing can use this reader any more.
  process.on("disconnect", () => process.exit(0));
}

const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

setClusterCacheMaxSize(Math.max(1, data.clusterCache));
let archive: Archive | null = null;
let suggester: SuggestionSearcher | null = null;
let direntCache = data.direntCache;

function arch(): Archive {
  if (!archive) {
    archive = new Archive(data.path);
    try { archive.setDirentCacheMaxSize(direntCache); } catch { /* not every build exposes the setter */ }
  }
  return archive;
}

const meta = (a: Archive, key: string): string => {
  try {
    return a.getMetadata(key) ?? "";
  } catch {
    return "";
  }
};

function describe(): ZimMeta {
  const a = arch();
  let mainPath: string | null = null;
  try {
    if (a.hasMainEntry()) mainPath = a.mainEntry.getItem(true).path;
  } catch { mainPath = null; }
  let hasIllustration = false;
  try { hasIllustration = a.hasIllustration(48); } catch { hasIllustration = false; }
  return {
    uuid: a.uuid, title: meta(a, "Title"), name: meta(a, "Name"), description: meta(a, "Description"), language: meta(a, "Language"),
    creator: meta(a, "Creator"), publisher: meta(a, "Publisher"), date: meta(a, "Date"), flavour: meta(a, "Flavour"), tags: meta(a, "Tags"),
    source: meta(a, "Source"), licenseName: meta(a, "License"), scraper: meta(a, "Scraper"),
    articleCount: a.articleCount, mediaCount: a.mediaCount, entryCount: a.entryCount, fileSize: Number(a.filesize),
    hasFulltextIndex: a.hasFulltextIndex(), hasTitleIndex: a.hasTitleIndex(), newNamespaceScheme: a.hasNewNamespaceScheme,
    hasChecksum: a.hasChecksum, mainPath, hasIllustration,
  };
}

function entry(path: string, follow: boolean): ZimReply {
  const a = arch();
  if (!a.hasEntryByPath(path)) return { kind: "entry", entry: { kind: "missing" } };
  const e = a.getEntryByPath(path);
  if (e.isRedirect && !follow) {
    return { kind: "entry", entry: { kind: "redirect", path: e.path, target: e.redirectEntry.path } };
  }
  const item = e.getItem(true);
  const size = Number(item.size);
  if (size > MAX_ENTRY_BYTES) throw Object.assign(new Error("That entry is too large to serve."), { code: "too_large" });
  const buf = item.data.data;
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return { kind: "entry", entry: { kind: "content", path: item.path, title: e.title, mimeType: item.mimetype, size, data: out } };
}

/** Walks results in small chunks so the time budget is checked between chunks and what was found so far is returned. */
function chunked<T>(budgetMs: number, limit: number, offset: number, get: (start: number, n: number) => T[]): { hits: T[]; partial: boolean } {
  const t0 = performance.now();
  const hits: T[] = [];
  const step = 3;
  let partial = false;
  while (hits.length < limit) {
    const n = Math.min(step, limit - hits.length);
    const got = get(offset + hits.length, n);
    hits.push(...got);
    if (got.length < n) break;
    if (performance.now() - t0 > budgetMs && hits.length < limit) { partial = true; break; }
  }
  return { hits, partial };
}

function suggest(query: string, limit: number, budgetMs: number): ZimReply {
  const a = arch();
  suggester ??= new SuggestionSearcher(a);
  const s = suggester.suggest(query);
  const { hits, partial } = chunked<SuggestHit>(budgetMs, limit, 0, (start, n) => {
    const out: SuggestHit[] = [];
    for (const r of s.getResults(start, n)) out.push({ title: r.title, path: r.path, snippet: r.hasSnippet ? r.snippet : "" });
    return out;
  });
  return { kind: "suggest", hits, estimated: s.estimatedMatches, partial };
}

function search(query: string, limit: number, offset: number, budgetMs: number): ZimReply {
  const a = arch();
  if (!a.hasFulltextIndex()) throw Object.assign(new Error("This package has no full-text index."), { code: "no_fulltext" });
  const s = new Searcher(a).search(query);
  const { hits, partial } = chunked<SearchHit>(budgetMs, limit, offset, (start, n) => {
    const out: SearchHit[] = [];
    for (const r of s.getResults(start, n)) out.push({ title: r.title, path: r.path, score: r.score, wordCount: r.wordCount, snippet: r.snippet });
    return out;
  });
  return { kind: "search", hits, estimated: s.estimatedMatches, partial };
}

/** The first position in the title index whose title is after `after` (bytewise, as libzim orders titles). */
function firstAfter(a: Archive, after: string, size: number): number {
  const key = Buffer.from(after);
  let lo = 0;
  let hi = size;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (Buffer.compare(Buffer.from(a.getEntryByTitle(mid).title), key) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The articles by title, after the title `after`. `findByTitle` is a prefix search, not a position, so the title the last page ended on is
 * located by a binary search over the title index and the scan carries on from there in windows.
 */
function browse(after: string | undefined, limit: number): ZimReply {
  const a = arch();
  const all = a.iterByTitle();
  const total = all.size;
  let pos = after ? firstAfter(a, after, total) : 0;
  const items: { path: string; title: string }[] = [];
  let next: string | null = null;
  scan: while (pos < total) {
    for (const e of all.offset(pos, 200)) {
      pos++;
      // Redirects and non-article entries (stylesheets, images) are not listed: a browse list is for reading.
      if (e.isRedirect) continue;
      let mime = "";
      try { mime = e.item.mimetype; } catch { continue; }
      if (!/^text\/html|^application\/xhtml/.test(mime)) continue;
      if (items.length >= limit) { next = items[items.length - 1]!.title; break scan; }
      items.push({ path: e.path, title: e.title });
    }
  }
  return { kind: "browse", items, next };
}

const onMessage = (m: ToZimWorker): void => {
  const fail = (e: unknown) => send({ t: "reply", id: m.id, ok: false, error: e instanceof Error ? e.message : String(e), ...((e as { code?: string })?.code ? { code: (e as { code: string }).code } : {}) });
  const ok = (reply: ZimReply) => send({ t: "reply", id: m.id, ok: true, reply });
  try {
    switch (m.op) {
      case "open": ok({ kind: "meta", meta: describe() }); return;
      case "entry": ok(entry(m.path, m.follow ?? false)); return;
      case "has": ok({ kind: "bool", value: arch().hasEntryByPath(m.path) }); return;
      case "illustration": {
        const a = arch();
        if (!a.hasIllustration(m.size ?? 48)) { ok({ kind: "bytes", data: null }); return; }
        const it = a.getIllustrationItem(m.size ?? 48);
        const out = new Uint8Array(it.data.data.byteLength);
        out.set(it.data.data);
        ok({ kind: "bytes", data: out, mimeType: it.mimetype });
        return;
      }
      case "suggest": ok(suggest(m.query, m.limit, m.budgetMs)); return;
      case "search": ok(search(m.query, m.limit, m.offset, m.budgetMs)); return;
      case "browse": ok(browse(m.after, m.limit)); return;
      case "cache": {
        const a = arch();
        if (m.clusterCache !== undefined) setClusterCacheMaxSize(Math.max(1, m.clusterCache));
        if (m.direntCache !== undefined) { direntCache = m.direntCache; a.setDirentCacheMaxSize(m.direntCache); }
        ok({ kind: "cache", clusterMax: getClusterCacheMaxSize(), clusterCurrent: getClusterCacheCurrentSize(), direntMax: a.getDirentCacheMaxSize(), direntCurrent: a.getDirentCacheCurrentSize() });
        return;
      }
      case "verify": {
        const a = arch();
        const checks: string[] = [];
        let good = true;
        const run = (name: string, sym: symbol) => {
          let r = false;
          try { r = Archive.validate(data.path, [sym]); } catch { r = false; }
          checks.push(`${name}:${r ? "ok" : "failed"}`);
          if (!r) good = false;
        };
        run("dirent_pointers", IntegrityCheck.DIRENT_PTRS);
        run("dirent_order", IntegrityCheck.DIRENT_ORDER);
        run("cluster_pointers", IntegrityCheck.CLUSTER_PTRS);
        if (m.deep && a.hasChecksum) run("checksum", IntegrityCheck.CHECKSUM);
        ok({ kind: "verify", ok: good, checks });
        return;
      }
      case "ping": ok({ kind: "pong" }); return;
      case "debug": {
        if (!data.testHooks) throw new Error("Test hooks are off.");
        if (m.action === "crash") process.exit(7);
        if (m.action === "abort") process.abort();
        if (m.action === "hang") { for (;;) { /* a blocked worker, as a runaway libzim call would be */ } }
        const until = Date.now() + (m.ms ?? 100);
        while (Date.now() < until) { /* busy for a while */ }
        ok({ kind: "ok" });
        return;
      }
    }
  } catch (e) {
    fail(e);
  }
};
if (inThread) parentPort!.on("message", onMessage);
else process.on("message", onMessage);

send({ t: "ready" });

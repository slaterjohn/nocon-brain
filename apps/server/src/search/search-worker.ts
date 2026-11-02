import { parentPort, workerData } from "node:worker_threads";
import { Fts5Index, IndexMissingError, IndexVersionError, type RankingConfig, type SynonymConfig } from "@ncb/search";
import type { FromSearchWorker, SearchWorkerData, ToSearchWorker } from "./protocol.js";

/**
 * Worker thread entry for the read-only `search` worker (D-2): a slow query never blocks the API's event loop, and search is
 * not queued behind the index writer (WAL lets a reader run beside it). Bundled as dist/search-worker.js.
 */
const port = parentPort;
if (!port) throw new Error("search-worker.ts must run in a worker thread");
const data = workerData as SearchWorkerData;
const send = (m: FromSearchWorker) => port.postMessage(m);

let idx: Fts5Index | null = null;
let ranking: RankingConfig = data.ranking;
let synonyms: SynonymConfig = data.synonyms;

function open(): boolean {
  const old = idx;
  idx = null;
  try { old?.close(); } catch { /* closing the old file */ }
  try {
    const next = Fts5Index.openReader(data.indexPath);
    next.setRanking(ranking);
    next.setSynonyms(synonyms);
    idx = next;
    return true;
  } catch (e) {
    if (e instanceof IndexMissingError || e instanceof IndexVersionError) return false;
    return false;
  }
}

send({ t: "ready", open: open() });

port.on("message", (m: ToSearchWorker) => {
  const fail = (e: unknown, code?: string) => send({ t: "reply", id: m.id, ok: false, error: e instanceof Error ? e.message : String(e), ...(code ? { code } : {}) });
  try {
    switch (m.op) {
      case "reopen": open(); send({ t: "reply", id: m.id, ok: true, reply: { kind: "ok" } }); return;
      case "config":
        if (m.ranking) { ranking = m.ranking; idx?.setRanking(ranking); }
        if (m.synonyms) { synonyms = m.synonyms; idx?.setSynonyms(synonyms); }
        send({ t: "reply", id: m.id, ok: true, reply: { kind: "ok" } });
        return;
      default:
    }
    if (!idx) {
      if (m.op === "stats") { send({ t: "reply", id: m.id, ok: true, reply: { kind: "stats", stats: null } }); return; }
      fail(new Error("The search index is not available."), "index_unavailable");
      return;
    }
    switch (m.op) {
      case "search": send({ t: "reply", id: m.id, ok: true, reply: { kind: "search", out: idx.search(m.params) } }); break;
      case "pageIds": {
        const out = idx.search({ ...m.params, pageSize: 50, facets: false, group: false });
        // Collect ids across pages up to the limit.
        const ids = out.hits.map((h) => h.pageId);
        for (let page = 2; ids.length < m.limit && out.hasMore && page <= 60; page++) {
          const more = idx.search({ ...m.params, page, pageSize: 50, facets: false, group: false });
          ids.push(...more.hits.map((h) => h.pageId));
          if (!more.hasMore) break;
        }
        send({ t: "reply", id: m.id, ok: true, reply: { kind: "pageIds", ids: ids.slice(0, m.limit), total: out.total } });
        break;
      }
      case "suggest": send({ t: "reply", id: m.id, ok: true, reply: { kind: "suggest", out: idx.suggest(m.q, m.limit) } }); break;
      case "stats": send({ t: "reply", id: m.id, ok: true, reply: { kind: "stats", stats: idx.stats() } }); break;
      case "vocab": send({ t: "reply", id: m.id, ok: true, reply: { kind: "vocab", df: idx.vocabDf(m.term) } }); break;
    }
  } catch (e) {
    fail(e);
  }
});

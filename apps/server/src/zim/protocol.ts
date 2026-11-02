/**
 * Messages between the server and a `zim` worker thread (task Z-02). One worker thread serves one open ZIM package: libzim's API is
 * synchronous, so a slow search in one package must not delay another, and a crash or hang of one package is restarted on its own.
 */

export interface ZimWorkerData {
  /** Absolute path of the ZIM file. */
  path: string;
  /** libzim cluster cache size in clusters (a cluster is about 1 to 2 MiB once decompressed) and dirent cache size in entries. */
  clusterCache: number;
  direntCache: number;
  /** Test hooks (`crash`, `hang`, `sleep`) are only honoured when true. Never set in production. */
  testHooks?: boolean;
}

/** What `open` learns about a file. Everything the registry stores comes from here. */
export interface ZimMeta {
  uuid: string;
  title: string;
  name: string;
  description: string;
  language: string;
  creator: string;
  publisher: string;
  date: string;
  flavour: string;
  tags: string;
  source: string;
  licenseName: string;
  scraper: string;
  articleCount: number;
  mediaCount: number;
  entryCount: number;
  fileSize: number;
  hasFulltextIndex: boolean;
  hasTitleIndex: boolean;
  newNamespaceScheme: boolean;
  hasChecksum: boolean;
  /** Path of the main entry after following redirects, when the file has one. */
  mainPath: string | null;
  /** True when the 48x48 illustration exists. */
  hasIllustration: boolean;
}

export type EntryReply =
  | { kind: "content"; path: string; title: string; mimeType: string; size: number; data: Uint8Array }
  | { kind: "redirect"; path: string; target: string }
  | { kind: "missing" };

export interface SuggestHit { title: string; path: string; snippet: string }
export interface SearchHit { title: string; path: string; score: number; wordCount: number; snippet: string }

export type ZimRequest =
  | { op: "open" }
  | { op: "entry"; path: string; follow?: boolean }
  | { op: "illustration"; size?: number }
  | { op: "suggest"; query: string; limit: number; budgetMs: number }
  | { op: "search"; query: string; limit: number; offset: number; budgetMs: number }
  | { op: "browse"; after?: string; limit: number }
  | { op: "has"; path: string }
  | { op: "cache"; clusterCache?: number; direntCache?: number }
  | { op: "verify"; deep: boolean }
  | { op: "ping" }
  | { op: "debug"; action: "crash" | "abort" | "hang" | "sleep"; ms?: number };

export type ZimReply =
  | { kind: "meta"; meta: ZimMeta }
  | { kind: "entry"; entry: EntryReply }
  | { kind: "bytes"; data: Uint8Array | null; mimeType?: string }
  | { kind: "suggest"; hits: SuggestHit[]; estimated: number; partial: boolean }
  | { kind: "search"; hits: SearchHit[]; estimated: number; partial: boolean }
  | { kind: "browse"; items: { path: string; title: string }[]; next: string | null }
  | { kind: "bool"; value: boolean }
  | { kind: "cache"; clusterMax: number; clusterCurrent: number; direntMax: number; direntCurrent: number }
  | { kind: "verify"; ok: boolean; checks: string[] }
  | { kind: "pong" }
  | { kind: "ok" };

export type ToZimWorker = { id: number } & ZimRequest;
export type FromZimWorker =
  | { t: "ready" }
  | { t: "reply"; id: number; ok: true; reply: ZimReply }
  | { t: "reply"; id: number; ok: false; error: string; code?: string };

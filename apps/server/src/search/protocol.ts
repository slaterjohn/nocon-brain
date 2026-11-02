import type { Filters, RankingConfig, SearchOutput, SuggestOutput, SynonymConfig } from "@ncb/search";

/** Messages between the main thread and the two search workers (docs/technology-decisions.md D-2). */

export interface SearchWorkerData { indexPath: string; ranking: RankingConfig; synonyms: SynonymConfig }
export interface IndexWorkerData { dataDir: string; mainDbPath: string; indexPath: string; synonyms: SynonymConfig; pollMs: number; batch: number; test?: { crashAfterBatches?: number; slowBatchMs?: number; rebuildBatch?: number } }

export type SearchRequest =
  | { op: "search"; params: import("@ncb/search").SearchParams }
  | { op: "pageIds"; params: import("@ncb/search").SearchParams; limit: number }
  | { op: "suggest"; q: string; limit: number }
  | { op: "reopen" }
  | { op: "config"; ranking?: RankingConfig; synonyms?: SynonymConfig }
  | { op: "stats" }
  | { op: "vocab"; term: string };

export type SearchReply =
  | { kind: "search"; out: SearchOutput }
  | { kind: "pageIds"; ids: number[]; total: number }
  | { kind: "suggest"; out: SuggestOutput }
  | { kind: "ok" }
  | { kind: "stats"; stats: import("@ncb/search").IndexStats | null }
  | { kind: "vocab"; df: number };

export type ToSearchWorker = { id: number } & SearchRequest;
export type FromSearchWorker = { t: "ready"; open: boolean } | { t: "reply"; id: number; ok: true; reply: SearchReply } | { t: "reply"; id: number; ok: false; error: string; code?: string };

export type IndexCommand =
  | { cmd: "sync" }
  | { cmd: "rebuild"; jobId: number; reason: string; generationId: number; fresh?: boolean }
  | { cmd: "optimize" }
  | { cmd: "check"; repair: boolean }
  | { cmd: "synonyms"; synonyms: SynonymConfig }
  | { cmd: "status" }
  | { cmd: "pause" }
  | { cmd: "resume" };

export type ToIndexWorker = { id: number } & IndexCommand;

export interface CheckReport {
  ok: boolean; expected: number; indexed: number; sampled: number;
  mismatches: { pageId: number; field: string }[]; missing: number; extra: number; repaired: number; needsRebuild: boolean;
}

export interface IndexStatusReply {
  open: boolean; docs: number; lastAppliedId: number; generationId: number; pendingRebuild: boolean; stats: import("@ncb/search").IndexStats | null;
}

export type FromIndexWorker =
  | { t: "ready"; state: "ok" | "missing" | "corrupt" | "version"; resumable: boolean; lastAppliedId: number }
  | { t: "reply"; id: number; ok: true; result: unknown }
  | { t: "reply"; id: number; ok: false; error: string }
  | { t: "applied"; lastId: number; count: number; deleted: number; upserted: number }
  | { t: "progress"; jobId: number; done: number; total: number; phase: string }
  | { t: "swapped"; jobId: number; generationId: number; docs: number; ms: number; lastAppliedId: number }
  | { t: "rebuild_failed"; jobId: number; error: string }
  | { t: "error"; message: string };

export type { Filters };

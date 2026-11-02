// The client side of progressive online results (docs/api.md 6.2): a pure reducer that turns search events into a list, and the
// rules that keep what the Human is looking at still.
//
// - Provider, coverage and "done" events always apply: they never change the list.
// - New online results (`append`) and changes to existing ones (`update`) change the list. They apply only when `hold` is false.
//   While `hold` is true (the Human has interacted, or the 2 s time box has passed) they wait in `held` until `release`.
// - A change to a result that is on screen waits too, even before any interaction.
// - Order never changes by itself. `reorder_available` only sets a flag; the Human applies it with a button.
import type { Coverage, SearchResult } from "./search";
import type { OnlineInfo, ProviderRun, ResultUpdate, SearchEvent } from "./online-search";

export interface StreamState {
  /** What is shown: the local page first, then online results in arrival order. */
  results: SearchResult[];
  /** Changes waiting to be shown. */
  held: { append: SearchResult[]; update: ResultUpdate[] };
  providers: ProviderRun[];
  coverage?: Coverage;
  reorderAvailable: boolean;
  done: boolean;
  doneReason?: string;
  lastSeq: number;
}

export type StreamAction =
  | { type: "reset"; results: SearchResult[]; online?: OnlineInfo; coverage?: Coverage; lastSeq?: number }
  | { type: "event"; event: SearchEvent; hold: boolean; visible?: ReadonlySet<string> }
  /** Show everything that was held. */
  | { type: "release" }
  /** Replace the whole list (a snapshot, or the fused order). */
  | { type: "replace"; results: SearchResult[]; online?: OnlineInfo; coverage?: Coverage; lastSeq?: number }
  /** More local results from the next page: appended, duplicates dropped. */
  | { type: "append_local"; results: SearchResult[] }
  /** A result was saved for offline: it is shown as waiting. */
  | { type: "mark_queued"; key: string }
  /** The capture finished: the result is a saved page now (`pageId` set), or went back to online only (`pageId` undefined). */
  | { type: "mark_saved"; key: string; pageId?: string }
  /** A new round of web results was asked for ("Load more from the web"). */
  | { type: "reopen" };

export const initialStream = (results: SearchResult[] = []): StreamState => ({
  results,
  held: { append: [], update: [] },
  providers: [],
  reorderAvailable: false,
  done: false,
  lastSeq: 0,
});

const providersFrom = (online?: OnlineInfo): ProviderRun[] => (online?.providers ?? []).map((p) => ({ ...p }));

export function applyUpdate(r: SearchResult, u: ResultUpdate): SearchResult {
  const next: SearchResult = { ...r };
  if (u.alsoOnline) next.alsoOnline = true;
  if (u.addAttribution) {
    const have = next.attribution ?? [];
    if (!have.some((a) => a.kind === u.addAttribution!.kind && a.id === u.addAttribution!.id)) next.attribution = [...have, u.addAttribution];
  }
  if (u.snippetExtra) next.snippet = r.snippet ? `${r.snippet} ${u.snippetExtra}` : u.snippetExtra;
  return next;
}

function withUpdates(results: SearchResult[], updates: ResultUpdate[]): SearchResult[] {
  if (!updates.length) return results;
  const by = new Map<string, ResultUpdate[]>();
  for (const u of updates) by.set(u.key, [...(by.get(u.key) ?? []), u]);
  return results.map((r) => (by.has(r.key) ? by.get(r.key)!.reduce(applyUpdate, r) : r));
}

function appended(results: SearchResult[], add: SearchResult[]): SearchResult[] {
  if (!add.length) return results;
  const seen = new Set(results.map((r) => r.key));
  const fresh: SearchResult[] = [];
  for (const r of add) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    fresh.push(r);
  }
  return fresh.length ? [...results, ...fresh] : results;
}

function upsertProvider(list: ProviderRun[], id: string, patch: Partial<ProviderRun> & { name?: string }): ProviderRun[] {
  const i = list.findIndex((p) => p.id === id);
  if (i < 0) return [...list, { id, name: patch.name ?? id, adapter: "", state: "pending", count: 0, hasMore: false, ...patch }];
  const next = list.slice();
  next[i] = { ...next[i]!, ...patch };
  return next;
}

export function streamReducer(s: StreamState, a: StreamAction): StreamState {
  switch (a.type) {
    case "reset":
      return { ...initialStream(a.results), providers: providersFrom(a.online), coverage: a.coverage, lastSeq: a.lastSeq ?? 0, done: a.online?.state === "done" };
    case "replace":
      return {
        ...s,
        results: a.results,
        held: { append: [], update: [] },
        providers: a.online ? providersFrom(a.online) : s.providers,
        coverage: a.coverage ?? s.coverage,
        reorderAvailable: false,
        lastSeq: Math.max(s.lastSeq, a.lastSeq ?? 0),
        done: a.online ? a.online.state === "done" || s.done : s.done,
      };
    case "append_local":
      return { ...s, results: appended(s.results, a.results) };
    case "mark_queued":
      return { ...s, results: s.results.map((r) => (r.key === a.key ? { ...r, availability: "queued" as const, actions: { open: r.actions?.open ?? "", saveForOffline: false } } : r)) };
    case "mark_saved":
      return {
        ...s,
        results: s.results.map((r) =>
          r.key !== a.key
            ? r
            : a.pageId
              ? { ...r, availability: "cached" as const, pageId: a.pageId, actions: { open: `/library/pages/${a.pageId}`, saveForOffline: false } }
              : { ...r, availability: "online_only" as const, actions: { open: r.actions?.open ?? "", saveForOffline: true } },
        ),
      };
    case "reopen":
      return { ...s, done: false, doneReason: undefined };
    case "release": {
      const results = appended(withUpdates(s.results, s.held.update), s.held.append);
      return { ...s, results, held: { append: [], update: [] } };
    }
    case "event": {
      const e = a.event;
      if (e.seq <= s.lastSeq) return s; // a replay after a reconnect
      const base = { ...s, lastSeq: e.seq };
      switch (e.type) {
        case "provider_started":
          return { ...base, providers: upsertProvider(base.providers, e.providerId, { name: e.name, adapter: e.adapter, state: "pending", error: undefined }) };
        case "provider_results": {
          const providers = upsertProvider(base.providers, e.providerId, { state: "ok", count: (base.providers.find((p) => p.id === e.providerId)?.count ?? 0) + e.append.length, hasMore: e.hasMore, error: undefined });
          // A change to a result that is on screen waits, whatever the hold flag says.
          const now: ResultUpdate[] = [];
          const later: ResultUpdate[] = [];
          for (const u of e.update) (a.hold || a.visible?.has(u.key) ? later : now).push(u);
          if (a.hold) {
            return { ...base, providers, held: { append: [...base.held.append, ...e.append], update: [...base.held.update, ...later] } };
          }
          const results = appended(withUpdates(base.results, now), e.append);
          return { ...base, providers, results, held: { append: base.held.append, update: [...base.held.update, ...later] } };
        }
        case "provider_error":
          return { ...base, providers: upsertProvider(base.providers, e.providerId, { state: "error", error: { code: e.code, message: e.message, retryAfterMs: e.retryAfterMs } }) };
        case "coverage":
          return { ...base, coverage: e.coverage };
        case "reorder_available":
          return { ...base, reorderAvailable: true };
        case "done":
          return { ...base, done: true, doneReason: e.reason };
      }
      return base;
    }
  }
}

/** Number of new online results waiting. */
export const heldCount = (s: StreamState) => s.held.append.filter((r) => !s.results.some((x) => x.key === r.key)).length;
export const hasHeld = (s: StreamState) => s.held.append.length > 0 || s.held.update.length > 0;

/** Keys of the online results in the list. */
export const onlineCount = (results: SearchResult[]) => results.filter((r) => r.origin === "online").length;

/** Providers that can give another page. */
export const providersWithMore = (s: StreamState) => s.providers.filter((p) => p.state === "ok" && p.hasMore);
export const failedProviders = (s: StreamState) => s.providers.filter((p) => p.state === "error" && p.error);

/** The one live message for a search, built once it has settled. */
export function summaryMessage(q: string, opts: { total: number; capped?: boolean; local: number; online: number; onlineRan: boolean; pending: boolean }): string {
  const plus = opts.capped ? " or more" : "";
  if (!opts.onlineRan) return opts.total === 0 ? `No results for ${q}.` : `${opts.total}${plus} ${opts.total === 1 ? "result" : "results"} for ${q}.`;
  const n = opts.local + opts.online;
  if (n === 0) return `No results for ${q}.${opts.pending ? " The web is still being searched." : ""}`;
  const parts = `${opts.local} from your saved pages, ${opts.online} from the web`;
  return `${n}${plus} ${n === 1 ? "result" : "results"} for ${q}: ${parts}.${opts.pending ? " More may arrive from the web." : ""}`;
}

"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { BookmarkPlus, ListFilter, Search as SearchIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/layout/states";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ApiError, errorMessage, get, post } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useOnlineStatus, useSearchPrefs, type OnlineStatus } from "@/lib/search-prefs";
import { useEvents } from "@/components/layout/events";
import { holdCause, TIME_BOX_MS } from "@/lib/search-freeze";
import { initialStream, onlineCount, streamReducer, summaryMessage } from "@/lib/search-stream";
import { consumeHistoryTraversal, readRestore, saveRestore, updateScroll } from "@/lib/nav-restore";
import type { OnlineInfo, SaveResponse, SearchEvent } from "@/lib/online-search";
import {
  EMPTY_STATE, SCOPE_LABELS, filterCount, paramsFromState, readFacets, requestFromState, searchHref, stateFromParams, typeLabel,
  type Facets, type Scope, type SearchResponse, type SearchResult, type SearchState,
} from "@/lib/search";
import { CoverageDialog } from "./coverage-dialog";
import { FiltersPanel } from "./filters";
import { OnlineFooter, OnlineNote, OnlineStrip } from "./online-panel";
import { useFreeze, useOnlineRun, useVisibleKeys } from "./online-hooks";
import { OperatorHelp } from "./operator-help";
import { ResultItem } from "./result-item";
import { SaveSearchDialog } from "./save-search-dialog";
import { SearchBox } from "./search-box";

const SCOPES: Scope[] = ["all", "offline", "online", "images", "documents"];
const NO_FACETS: Facets = { sources: [], collections: [], domains: [], types: [], languages: [], availability: [], approximate: false };

const ONLINE_OFF_TEXT: Record<NonNullable<OnlineStatus["reason"]>, string> = {
  off: "Online search is off",
  no_provider: "Online search has no provider set up",
  offline: "You are offline",
};

function CategoryTabs({ scope, status, onSelect }: { scope: Scope; status: OnlineStatus; onSelect: (s: Scope) => void }) {
  const onlineAvailable = status.available;
  const refs = React.useRef<Record<string, HTMLButtonElement | null>>({});
  const enabled = SCOPES.filter((s) => s !== "online" || onlineAvailable);
  function onKey(e: React.KeyboardEvent, s: Scope) {
    const i = enabled.indexOf(s);
    let to = -1;
    if (e.key === "ArrowRight") to = (i + 1) % enabled.length;
    else if (e.key === "ArrowLeft") to = (i - 1 + enabled.length) % enabled.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = enabled.length - 1;
    if (to < 0) return;
    e.preventDefault();
    const next = enabled[to]!;
    onSelect(next);
    refs.current[next]?.focus();
  }
  return (
    <div role="tablist" aria-label="Result categories" className="flex flex-wrap gap-x-1 border-b" data-testid="categories">
      {SCOPES.map((s) => {
        const off = s === "online" && !onlineAvailable;
        const selected = s === scope;
        return (
          <button
            key={s}
            ref={(el) => { refs.current[s] = el; }}
            type="button"
            role="tab"
            id={`cat-${s}`}
            aria-selected={selected}
            aria-controls="results-panel"
            aria-disabled={off || undefined}
            aria-describedby={off ? "online-off" : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => !off && onSelect(s)}
            onKeyDown={(e) => onKey(e, s)}
            data-testid={`cat-${s}`}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap",
              selected ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              off && "cursor-not-allowed opacity-70 hover:text-muted-foreground",
            )}
          >
            {SCOPE_LABELS[s]}
            {off ? <span className="ml-1.5 text-xs" aria-hidden="true">Off</span> : null}
          </button>
        );
      })}
      <span id="online-off" className="sr-only">{ONLINE_OFF_TEXT[status.reason ?? "off"]}</span>
    </div>
  );
}

function ActiveFilters({ state, onChange }: { state: SearchState; onChange: (p: Partial<SearchState>) => void }) {
  const chips: { key: string; label: string; clear: () => void }[] = [];
  state.sources.forEach((v) => chips.push({ key: `s${v}`, label: `Source: ${v}`, clear: () => onChange({ sources: state.sources.filter((x) => x !== v) }) }));
  state.collections.forEach((v) => chips.push({ key: `c${v}`, label: `Collection: ${v}`, clear: () => onChange({ collections: state.collections.filter((x) => x !== v) }) }));
  state.domains.forEach((v) => chips.push({ key: `d${v}`, label: `Site: ${v}`, clear: () => onChange({ domains: state.domains.filter((x) => x !== v) }) }));
  state.types.forEach((v) => chips.push({ key: `t${v}`, label: `Type: ${typeLabel(v)}`, clear: () => onChange({ types: state.types.filter((x) => x !== v) }) }));
  state.languages.forEach((v) => chips.push({ key: `l${v}`, label: `Language: ${v}`, clear: () => onChange({ languages: state.languages.filter((x) => x !== v) }) }));
  state.availability.forEach((v) => chips.push({ key: `a${v}`, label: `Availability: ${v.replace("_", " ")}`, clear: () => onChange({ availability: state.availability.filter((x) => x !== v) }) }));
  if (state.dlFrom || state.dlTo) chips.push({ key: "dl", label: `Saved ${state.dlFrom || "…"} to ${state.dlTo || "…"}`, clear: () => onChange({ dlFrom: "", dlTo: "" }) });
  if (state.pubFrom || state.pubTo) chips.push({ key: "pub", label: `Published ${state.pubFrom || "…"} to ${state.pubTo || "…"}`, clear: () => onChange({ pubFrom: "", pubTo: "" }) });
  if (!chips.length) return null;
  return (
    <ul className="mt-3 flex flex-wrap gap-2" aria-label="Active filters" data-testid="active-filters">
      {chips.map((c) => (
        <li key={c.key}>
          <button type="button" onClick={c.clear} className="inline-flex items-center gap-1 rounded-full border bg-secondary px-2.5 py-1 text-xs hover:bg-accent">
            {c.label}
            <X className="size-3" aria-hidden="true" />
            <span className="sr-only"> Remove filter</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ResultsSkeleton() {
  return (
    <div role="status" aria-busy="true" className="space-y-6 py-4" data-testid="results-loading">
      <span className="sr-only">Searching…</span>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-3 w-1/4" />
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-4 w-full max-w-3xl" />
        </div>
      ))}
    </div>
  );
}

type Snapshot = SearchResponse & { lastSeq?: number };

export function ResultsView() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { toast } = useToast();
  const ev = useEvents();
  const [prefs, , prefsReady] = useSearchPrefs();
  const status = useOnlineStatus();
  const onlineAvailable = status.available;
  const state = React.useMemo(() => stateFromParams(params), [params]);
  const stateKey = paramsFromState(state).toString();

  const [text, setText] = React.useState(state.q);
  React.useEffect(() => setText(state.q), [state.q]);

  const [data, setData] = React.useState<Snapshot | null>(null);
  const [stream, dispatch] = React.useReducer(streamReducer, undefined, () => initialStream());
  const results = stream.results;
  const [page, setPage] = React.useState(1);
  const [loading, setLoading] = React.useState(true);
  const [moreBusy, setMoreBusy] = React.useState(false);
  const [webMoreBusy, setWebMoreBusy] = React.useState(false);
  const [error, setError] = React.useState<ApiError | Error | null>(null);
  const [retry, setRetry] = React.useState(0);
  const [announce, setAnnounce] = React.useState("");
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [saveOpen, setSaveOpen] = React.useState(false);
  const [coverageOpen, setCoverageOpen] = React.useState(false);
  const [epoch, setEpoch] = React.useState(0);
  const [boxExpired, setBoxExpired] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const facetsRef = React.useRef<Facets>(NO_FACETS);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const filtersRef = React.useRef<HTMLElement | null>(null);
  const boxRef = React.useRef(false);
  const roundOpen = React.useRef(false);
  const announcedFor = React.useRef("");
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const freezer = useFreeze(panelRef, filtersRef, `${stateKey}#${retry}`);
  const visible = useVisibleKeys(panelRef, results.length);

  const onlineRan = data?.online?.state === "pending" || data?.online?.state === "done";
  const pending = onlineRan && !stream.done;

  // Events that change the list apply at once only while it is open: before any interaction and inside the 2 s time box.
  const onEvent = React.useCallback(
    (e: SearchEvent) => {
      const hold = !roundOpen.current && (freezer.ref.current.frozen || boxRef.current);
      dispatch({ type: "event", event: e, hold, visible: visible.current });
      if (e.type === "done") roundOpen.current = false;
    },
    [freezer.ref, visible],
  );
  useOnlineRun({ searchId: data?.searchId ?? null, active: pending, afterSeq: stream.lastSeq, epoch, onEvent });

  // The 2 s time box starts when the answer to the search arrives.
  React.useEffect(() => {
    if (!data || data.online?.state !== "pending" || boxRef.current) return;
    const t = setTimeout(() => {
      boxRef.current = true;
      setBoxExpired(true);
    }, TIME_BOX_MS);
    return () => clearTimeout(t);
  }, [data]);

  const run = React.useCallback(
    (pageNo: number, signal: { cancelled: boolean }) =>
      // A saved search that is run again goes through its own endpoint, so it records when it ran and how many it found.
      (state.saved && pageNo === 1
        ? post<SearchResponse>(`/api/search/saved/${encodeURIComponent(state.saved)}/run`, { page: pageNo, pageSize: prefs.resultsPerPage })
        : post<SearchResponse>("/api/search", requestFromState(state, { page: pageNo, pageSize: prefs.resultsPerPage, onlineAvailable }))
      ).then((res) => (signal.cancelled ? null : res)),
    // `state` is covered by stateKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stateKey, prefs.resultsPerPage, onlineAvailable],
  );

  // Back or Forward: the list comes back from the snapshot the server kept, not from a new search.
  const mounted = React.useRef(false);
  const mountTraversal = React.useRef(false);
  if (!mounted.current) {
    mounted.current = true;
    mountTraversal.current = consumeHistoryTraversal();
  }

  React.useEffect(() => {
    // Wait for the saved page size and the online status so the first search is not run twice.
    if (!prefsReady || !status.ready) return;
    const signal = { cancelled: false };
    const traversal = mountTraversal.current || consumeHistoryTraversal();
    mountTraversal.current = false;
    setLoading(true);
    setError(null);
    setPage(1);

    const adopt = (res: Snapshot, restored: boolean, scrollY = 0) => {
      setData(res);
      dispatch({ type: "reset", results: res.results, online: res.online, coverage: res.coverage, lastSeq: res.lastSeq });
      if (res.facets) facetsRef.current = readFacets(res.facets);
      roundOpen.current = false;
      // A restored list stays as it was: late results wait behind a button.
      boxRef.current = restored;
      setBoxExpired(restored);
      if (!restored) freezer.reset();
      setLoading(false);
      saveRestore(stateKey, { searchId: res.searchId, scrollY });
      if (restored && scrollY > 0) requestAnimationFrame(() => window.scrollTo(0, scrollY));
    };

    (async () => {
      const rec = traversal && !state.saved ? readRestore(stateKey) : null;
      if (rec) {
        try {
          const snap = await get<Snapshot>(`/api/search/${encodeURIComponent(rec.searchId)}`);
          if (signal.cancelled) return;
          adopt(snap, true, rec.scrollY);
          return;
        } catch {
          /* gone after 30 minutes, or the server restarted: search again */
        }
      }
      const res = await run(1, signal);
      if (!res) return;
      adopt(res, false);
    })().catch((e: Error) => {
      if (signal.cancelled) return;
      setError(e);
      setLoading(false);
      setAnnounce("The search failed.");
    });
    return () => {
      signal.cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, retry, state.q, prefsReady, status.ready]);

  // Remember the scroll position for Back.
  React.useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => updateScroll(stateKey, window.scrollY), 150);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (t) clearTimeout(t);
    };
  }, [stateKey]);

  // One live message per search, made when it has settled: at once without a web search, otherwise when the web search is done or
  // the time box has passed. Everything else on the page that changes by itself is not a live region.
  React.useEffect(() => {
    if (!data || loading || announcedFor.current === data.searchId) return;
    if (pending && !boxExpired) return;
    announcedFor.current = data.searchId;
    const local = data.total ?? data.results.filter((r) => r.origin !== "online").length;
    setAnnounce(summaryMessage(state.q, { total: data.total ?? data.results.length, capped: data.totalCapped, local, online: onlineCount(stream.results), onlineRan, pending }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, loading, pending, boxExpired, stream.done]);

  async function loadMore() {
    setMoreBusy(true);
    try {
      const res = await run(page + 1, { cancelled: false });
      if (!res) return;
      const seen = new Set(results.map((r) => r.key));
      const fresh = res.results.filter((r) => !seen.has(r.key));
      setAnnounce(`${fresh.length} more ${fresh.length === 1 ? "result" : "results"} loaded, ${results.length + fresh.length} in total.`);
      dispatch({ type: "append_local", results: fresh });
      setData((d) => (d ? { ...d, nextCursor: res.nextCursor } : (res as Snapshot)));
      setPage((p) => p + 1);
    } catch (e) {
      toast({ title: "Couldn't load more results", description: errorMessage(e), variant: "error" });
    } finally {
      setMoreBusy(false);
    }
  }

  // ---- The web half ----

  function showNew() {
    const n = stream.held.append.length;
    dispatch({ type: "release" });
    if (n) setAnnounce(`${n} new web ${n === 1 ? "result" : "results"} shown at the end of the list.`);
  }

  async function rerank() {
    if (!data) return;
    try {
      const snap = await get<Snapshot>(`/api/search/${encodeURIComponent(data.searchId)}?order=fused`);
      dispatch({ type: "replace", results: snap.results, online: snap.online, coverage: snap.coverage, lastSeq: snap.lastSeq });
      setAnnounce("Results re-ranked with web results.");
      panelRef.current?.querySelector<HTMLElement>("[data-testid=results-list]")?.focus();
    } catch (e) {
      toast({ title: "Couldn't re-rank the results", description: errorMessage(e), variant: "error" });
    }
  }

  async function loadMoreWeb() {
    if (!data) return;
    setWebMoreBusy(true);
    try {
      const res = await post<{ started: string[] }>(`/api/search/${encodeURIComponent(data.searchId)}/more`, {});
      if (!res.started.length) {
        toast({ title: "No more web results", description: "None of the providers has another page.", variant: "default" });
        return;
      }
      // The Human asked for these, so this round may add to the list as it arrives.
      dispatch({ type: "release" });
      roundOpen.current = true;
      dispatch({ type: "reopen" });
      setEpoch((n) => n + 1);
    } catch (e) {
      toast({ title: "Couldn't load more from the web", description: errorMessage(e), variant: "error" });
    } finally {
      setWebMoreBusy(false);
    }
  }

  const saveOnline = React.useCallback(
    async (r: SearchResult) => {
      if (!data) throw new Error("The search has ended. Search again to save this result.");
      const out = await post<SaveResponse>(`/api/search/${encodeURIComponent(data.searchId)}/results/${encodeURIComponent(r.key)}/save`, { queue: ev.connectivity === "offline" });
      dispatch({ type: "mark_queued", key: r.key });
      void trackSave(out.downloadId, r);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, ev.connectivity],
  );

  /** Follows the capture until the page is saved, then shows the result as a saved page that links to the archive. */
  async function trackSave(downloadId: string, r: SearchResult) {
    for (let i = 0; i < 120 && alive.current; i++) {
      await new Promise((res) => setTimeout(res, i < 4 ? 500 : 1500));
      if (!alive.current) return;
      try {
        const c = await get<{ state: string; pageId?: string }>(`/api/archive/captures/${encodeURIComponent(downloadId)}`);
        if (c.state === "completed") {
          let pageId = c.pageId;
          if (!pageId) {
            const found = await post<{ resolution?: { page?: { id: string } } }>("/api/browser/resolve", { input: r.url });
            pageId = found.resolution?.page?.id;
          }
          dispatch({ type: "mark_saved", key: r.key, pageId });
          toast({ title: pageId ? "Saved for offline" : "Couldn't find the saved page", description: r.title || r.url, variant: pageId ? "success" : "error" });
          return;
        }
        if (c.state === "failed" || c.state === "cancelled") {
          dispatch({ type: "mark_saved", key: r.key });
          toast({ title: "The page could not be saved", description: r.title || r.url, variant: "error" });
          return;
        }
      } catch {
        /* try again */
      }
    }
  }

  const go = React.useCallback(
    (patch: Partial<SearchState>, mode: "push" | "replace" = "replace") => {
      // Changing anything makes it a new search, not the saved one.
      const next = { ...state, saved: "", ...patch };
      const href = `${pathname}?${paramsFromState(next).toString()}`;
      if (mode === "push") router.push(href);
      else router.replace(href);
    },
    [state, pathname, router],
  );

  // "/" focuses the search box when the Human is not typing in a field.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = (q: string) => {
    const t = q.trim();
    if (t) go({ q: t, exact: false }, "push");
  };

  const facets = data?.facets ? readFacets(data.facets) : facetsRef.current;
  const dym = data?.didYouMean;
  const nFilters = filterCount(state);
  const hasMore = !!data?.nextCursor;
  const cov = stream.coverage ?? data?.coverage;
  const warnings = data?.parsed?.warnings ?? [];
  const rebuilding = data?.index && data.index.state !== "ok";
  const showDym = dym && !(state.exact && dym.appliedAutomatically);
  const online: OnlineInfo = { ...(data?.online ?? { state: "disabled", pending: [], disclosure: "" }), disclosure: data?.online?.disclosure ?? "" };
  const noteReason = onlineRan || !status.ready ? null : status.available ? (data?.online?.state === "offline" ? "offline" : null) : status.reason;
  const webOff = state.scope === "online" && !loading && !onlineRan && !!data;
  const uncached = results.filter((r) => r.origin === "online" && r.availability === "online_only");

  return (
    <div className="mx-auto w-full max-w-6xl p-4 sm:p-6" data-testid="results-page">
      <h1 className="sr-only">Search results for {state.q}</h1>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form role="search" aria-label="Search" className="flex min-w-0 flex-1 basis-80 gap-2" onSubmit={(e) => { e.preventDefault(); submit(text); }}>
          <SearchBox id="results-search" label="Search" value={text} onChange={setText} onSubmit={submit} inputRef={inputRef} />
          <Button type="submit" className="h-10 rounded-full px-5">Search</Button>
        </form>
        <OperatorHelp />
        <Button type="button" variant="outline" size="sm" onClick={() => setSaveOpen(true)} data-testid="save-search">
          <BookmarkPlus aria-hidden="true" /> Save this search
        </Button>
      </div>

      <CategoryTabs scope={state.scope} status={status} onSelect={(scope) => go({ scope })} />
      <OnlineNote reason={noteReason} scopeOnline={state.scope === "online"} />

      <div className="mt-4 grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside aria-label="Filters" className="min-w-0" ref={filtersRef}>
          <Button type="button" variant="outline" size="sm" className="lg:hidden" aria-expanded={filtersOpen} aria-controls="filters-wrap" onClick={() => setFiltersOpen((o) => !o)} data-testid="filters-toggle">
            <ListFilter aria-hidden="true" /> Filters{nFilters ? ` (${nFilters})` : ""}
          </Button>
          <div id="filters-wrap" className={cn("mt-3 lg:mt-0 lg:block", filtersOpen ? "block" : "hidden")}>
            <FiltersPanel state={state} facets={facets} onChange={(p) => go(p)} onClear={() => go({ ...EMPTY_STATE, q: state.q, scope: state.scope })} />
          </div>
        </aside>

        <div id="results-panel" role="tabpanel" aria-labelledby={`cat-${state.scope}`} className="min-w-0" aria-busy={loading || pending}>
          <div role="status" aria-live="polite" className="sr-only" data-testid="results-status">{announce}</div>
          {showDym ? (
            <p className="mb-3 text-base" data-testid="did-you-mean">
              {dym.appliedAutomatically ? (
                <>
                  Showing results for <Link href={searchHref({ ...state, q: dym.text, exact: false })} className="font-semibold italic text-primary underline underline-offset-4 hover:no-underline" data-testid="dym-text">{dym.text}</Link>.{" "}
                  <span className="text-muted-foreground">Search instead for </span>
                  <Link href={searchHref({ ...state, exact: true })} className="text-primary underline underline-offset-4 hover:no-underline" data-testid="dym-original">{state.q}</Link>
                </>
              ) : (
                <>
                  Did you mean <Link href={searchHref({ ...state, q: dym.text, exact: false })} className="font-semibold italic text-primary underline underline-offset-4 hover:no-underline" data-testid="dym-text">{dym.text}</Link>?
                </>
              )}
            </p>
          ) : null}
          {rebuilding ? (
            <p className="mb-3 text-sm text-muted-foreground" role="status" data-testid="index-state">
              {data!.index!.state === "error" ? "The search index has a problem. Results may be missing." : "The search index is rebuilding. Some results may be missing for now."}
            </p>
          ) : null}
          {warnings.length ? <ul className="mb-3 space-y-1 text-sm text-muted-foreground">{warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
          {onlineRan && !loading ? (
            <OnlineStrip
              stream={stream}
              cause={holdCause({ frozen: freezer.frozen, reason: freezer.reason }, boxExpired ? TIME_BOX_MS + 1 : 0)}
              pending={pending}
              timeBoxExpired={boxExpired}
              moreBusy={webMoreBusy}
              onShow={showNew}
              onRerank={() => void rerank()}
              onLoadMore={() => void loadMoreWeb()}
              onImprove={() => setCoverageOpen(true)}
              coverage={cov}
            />
          ) : cov && !loading ? (
            <p className="mb-1 text-sm text-muted-foreground" data-testid="coverage-strip">
              {cov.cachedMatches} {cov.cachedMatches === 1 ? "match" : "matches"} in your saved pages{cov.partial ? `, ${cov.partial} partly saved` : ""}
            </p>
          ) : null}
          <ActiveFilters state={state} onChange={(p) => go(p)} />

          <div ref={panelRef} data-testid="results-body">
            {loading && results.length === 0 ? <ResultsSkeleton /> : null}
            {error ? <ErrorState title="The search failed" message={errorMessage(error)} onRetry={() => setRetry((n) => n + 1)} className="mt-4" /> : null}
            {webOff ? (
              <EmptyState
                icon={SearchIcon}
                title="The web was not searched"
                description={online.state === "offline" ? "You are offline. Choose All or Offline to search your saved pages." : "Online search is off, or no search provider is set up. Choose All or Offline to search your saved pages."}
                action={<Button asChild variant="outline"><Link href="/storage/online-search">Online search settings</Link></Button>}
                className="mt-4"
              />
            ) : null}
            {!loading && !error && !webOff && results.length === 0 && !(pending && !boxExpired) ? (
              <EmptyState
                icon={SearchIcon}
                title={`No results for "${state.q}"`}
                description={nFilters || state.scope !== "all" ? "Try removing a filter or choosing All." : "Check the spelling, try fewer or different words, or look in the Library."}
                action={nFilters ? <Button variant="outline" onClick={() => go({ ...EMPTY_STATE, q: state.q })}>Clear filters and category</Button> : undefined}
                className="mt-4"
              />
            ) : null}
            {results.length > 0 ? (
              <>
                <h2 className="sr-only">Results</h2>
                <ol className={cn("divide-y", loading && "opacity-60")} data-testid="results-list" aria-label="Results" tabIndex={-1}>
                  {results.map((r, i) => (
                    <li key={r.key}>
                      <ResultItem result={r} headingId={`result-${i}`} onSaveOnline={r.origin === "online" && data ? saveOnline : undefined} />
                    </li>
                  ))}
                </ol>
                <div className="flex flex-col items-center gap-2 py-6">
                  <p className="text-sm text-muted-foreground" data-testid="results-count">{data?.total != null && !onlineRan ? `Showing ${results.length} of ${data.total}${data.totalCapped ? "+" : ""} results` : `Showing ${results.length} ${results.length === 1 ? "result" : "results"}`}</p>
                  {hasMore ? (
                    <Button variant="outline" onClick={() => void loadMore()} disabled={moreBusy} data-testid="load-more">
                      {moreBusy ? "Loading…" : "Load more results"}
                    </Button>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
          {onlineRan && !loading ? <OnlineFooter stream={stream} pending={pending} disclosure={online.disclosure} /> : null}
        </div>
      </div>
      <SaveSearchDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        state={state}
        onSaved={(s) => toast({ title: "Search saved", description: `${s.name}. Find it in the Search area under Saved searches.`, variant: "success" })}
      />
      {data ? (
        <CoverageDialog
          open={coverageOpen}
          onOpenChange={setCoverageOpen}
          searchId={data.searchId}
          candidates={uncached}
          onQueued={(keys, info) => {
            for (const key of keys) dispatch({ type: "mark_queued", key });
            toast({ title: "Queued for saving", description: `${info.queued} ${info.queued === 1 ? "page" : "pages"} will be saved in the background.`, variant: "success" });
          }}
        />
      ) : null}
    </div>
  );
}

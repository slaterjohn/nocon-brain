"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { BookmarkPlus, ListFilter, Search as SearchIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/layout/states";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ApiError, errorMessage, post } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useOnlineAvailable, useSearchPrefs } from "@/lib/search-prefs";
import {
  EMPTY_STATE, SCOPE_LABELS, filterCount, paramsFromState, readFacets, requestFromState, searchHref, stateFromParams, typeLabel,
  type Facets, type Scope, type SearchResponse, type SearchResult, type SearchState,
} from "@/lib/search";
import { FiltersPanel } from "./filters";
import { OperatorHelp } from "./operator-help";
import { ResultItem } from "./result-item";
import { SaveSearchDialog } from "./save-search-dialog";
import { SearchBox } from "./search-box";

const SCOPES: Scope[] = ["all", "offline", "online", "images", "documents"];
const NO_FACETS: Facets = { sources: [], collections: [], domains: [], types: [], languages: [], availability: [], approximate: false };

function CategoryTabs({ scope, onlineAvailable, onSelect }: { scope: Scope; onlineAvailable: boolean; onSelect: (s: Scope) => void }) {
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
      <span id="online-off" className="sr-only">Online search is off</span>
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

export function ResultsView() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { toast } = useToast();
  const [prefs, , prefsReady] = useSearchPrefs();
  const onlineAvailable = useOnlineAvailable();
  const state = React.useMemo(() => stateFromParams(params), [params]);
  const stateKey = paramsFromState(state).toString();

  const [text, setText] = React.useState(state.q);
  React.useEffect(() => setText(state.q), [state.q]);

  const [data, setData] = React.useState<SearchResponse | null>(null);
  const [results, setResults] = React.useState<SearchResult[]>([]);
  const [page, setPage] = React.useState(1);
  const [loading, setLoading] = React.useState(true);
  const [moreBusy, setMoreBusy] = React.useState(false);
  const [error, setError] = React.useState<ApiError | Error | null>(null);
  const [retry, setRetry] = React.useState(0);
  const [announce, setAnnounce] = React.useState("");
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [saveOpen, setSaveOpen] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const facetsRef = React.useRef<Facets>(NO_FACETS);

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

  React.useEffect(() => {
    // Wait for the saved page size so the first search is not run twice.
    if (!prefsReady) return;
    const signal = { cancelled: false };
    setLoading(true);
    setError(null);
    setPage(1);
    run(1, signal)
      .then((res) => {
        if (!res) return;
        setData(res);
        setResults(res.results);
        const f = readFacets(res.facets);
        facetsRef.current = res.facets ? f : facetsRef.current;
        setLoading(false);
        const n = res.total ?? res.results.length;
        const plus = res.totalCapped ? " or more" : "";
        setAnnounce(n === 0 ? `No results for ${state.q}.` : `${n}${plus} ${n === 1 ? "result" : "results"} for ${state.q}.`);
      })
      .catch((e: Error) => {
        if (signal.cancelled) return;
        setError(e);
        setLoading(false);
        setAnnounce("The search failed.");
      });
    return () => {
      signal.cancelled = true;
    };
  }, [run, retry, state.q, prefsReady]);

  async function loadMore() {
    setMoreBusy(true);
    try {
      const res = await run(page + 1, { cancelled: false });
      if (!res) return;
      setResults((cur) => {
        const seen = new Set(cur.map((r) => r.key));
        const fresh = res.results.filter((r) => !seen.has(r.key));
        setAnnounce(`${fresh.length} more ${fresh.length === 1 ? "result" : "results"} loaded, ${cur.length + fresh.length} in total.`);
        return [...cur, ...fresh];
      });
      setData((d) => (d ? { ...d, nextCursor: res.nextCursor } : res));
      setPage((p) => p + 1);
    } catch (e) {
      toast({ title: "Couldn't load more results", description: errorMessage(e), variant: "error" });
    } finally {
      setMoreBusy(false);
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
  const cov = data?.coverage;
  const warnings = data?.parsed?.warnings ?? [];
  const rebuilding = data?.index && data.index.state !== "ok";
  const showDym = dym && !(state.exact && dym.appliedAutomatically);

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

      <CategoryTabs scope={state.scope} onlineAvailable={onlineAvailable} onSelect={(scope) => go({ scope })} />
      <p className="mt-1.5 text-xs text-muted-foreground" hidden={onlineAvailable}>Online search is off. Results come from your saved pages.</p>

      <div className="mt-4 grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside aria-label="Filters" className="min-w-0">
          <Button type="button" variant="outline" size="sm" className="lg:hidden" aria-expanded={filtersOpen} aria-controls="filters-wrap" onClick={() => setFiltersOpen((o) => !o)} data-testid="filters-toggle">
            <ListFilter aria-hidden="true" /> Filters{nFilters ? ` (${nFilters})` : ""}
          </Button>
          <div id="filters-wrap" className={cn("mt-3 lg:mt-0 lg:block", filtersOpen ? "block" : "hidden")}>
            <FiltersPanel state={state} facets={facets} onChange={(p) => go(p)} onClear={() => go({ ...EMPTY_STATE, q: state.q, scope: state.scope })} />
          </div>
        </aside>

        <div id="results-panel" role="tabpanel" aria-labelledby={`cat-${state.scope}`} className="min-w-0" aria-busy={loading}>
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
          {cov && !loading ? (
            <p className="mb-1 text-sm text-muted-foreground" data-testid="coverage-strip">
              {cov.cachedMatches} {cov.cachedMatches === 1 ? "match" : "matches"} in your saved pages{cov.partial ? `, ${cov.partial} partly saved` : ""}
            </p>
          ) : null}
          <ActiveFilters state={state} onChange={(p) => go(p)} />

          {loading && results.length === 0 ? <ResultsSkeleton /> : null}
          {error ? <ErrorState title="The search failed" message={errorMessage(error)} onRetry={() => setRetry((n) => n + 1)} className="mt-4" /> : null}
          {!loading && !error && results.length === 0 ? (
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
              <ol className={cn("divide-y", loading && "opacity-60")} data-testid="results-list" aria-label="Results">
                {results.map((r, i) => (
                  <li key={r.key}>
                    <ResultItem result={r} headingId={`result-${i}`} />
                  </li>
                ))}
              </ol>
              <div className="flex flex-col items-center gap-2 py-6">
                <p className="text-sm text-muted-foreground" data-testid="results-count">{data?.total != null ? `Showing ${results.length} of ${data.total}${data.totalCapped ? "+" : ""} results` : `Showing ${results.length} ${results.length === 1 ? "result" : "results"}`}</p>
                {hasMore ? (
                  <Button variant="outline" onClick={() => void loadMore()} disabled={moreBusy} data-testid="load-more">
                    {moreBusy ? "Loading…" : "Load more results"}
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </div>
      <SaveSearchDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        state={state}
        onSaved={(s) => toast({ title: "Search saved", description: `${s.name}. Find it in the Search area under Saved searches.`, variant: "success" })}
      />
    </div>
  );
}

"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { BookmarkCheck, Eye, FolderPlus, ListChecks, History, Pencil, Play, Search as SearchIcon, Settings2, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";
import { del, errorMessage, patch, post, useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useSearchPrefs, useSearchServerSettings, type SearchPrefs } from "@/lib/search-prefs";
import { readHistory, readSavedList, searchHref, stateFromSaved, type SavedSearch } from "@/lib/search";
import { formatDate } from "@/components/library/format";
import { SearchBox } from "./search-box";
import { CandidatesDialog, SavedSourceDialog } from "./saved-source";

type View = "saved" | "history" | "settings";
const VIEWS: { id: View; label: string; icon: typeof SearchIcon }[] = [
  { id: "saved", label: "Saved searches", icon: BookmarkCheck },
  { id: "history", label: "History", icon: History },
  { id: "settings", label: "Settings", icon: Settings2 },
];

/** The Search area: a search box plus saved searches, local search history and search settings. */
export function SearchArea() {
  const params = useSearchParams();
  const router = useRouter();
  const v = params.get("view");
  const view: View = v === "history" || v === "settings" ? v : "saved";
  const [q, setQ] = React.useState("");
  const go = (text: string) => {
    const t = text.trim();
    if (t) router.push(searchHref({ q: t }));
  };
  return (
    <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
      <PageHeader title="Search" description="Search your saved pages. Keep searches you run often, and choose how search behaves." />
      <form role="search" aria-label="Search" className="mb-6 flex max-w-2xl gap-2" onSubmit={(e) => { e.preventDefault(); go(q); }}>
        <SearchBox id="area-search" label="Search your saved pages" value={q} onChange={setQ} onSubmit={go} />
        <Button type="submit" className="h-10 rounded-full px-5">Search</Button>
      </form>
      <nav aria-label="Search area sections" className="mb-5 flex flex-wrap gap-1 border-b">
        {VIEWS.map(({ id, label, icon: Icon }) => (
          <Link
            key={id}
            href={id === "saved" ? "/search" : `/search?view=${id}`}
            aria-current={view === id ? "page" : undefined}
            className={cn("-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm", view === id ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            <Icon className="size-4" aria-hidden="true" /> {label}
          </Link>
        ))}
      </nav>
      {view === "saved" ? <SavedSearches /> : null}
      {view === "history" ? <HistoryPanel /> : null}
      {view === "settings" ? <SearchSettings /> : null}
    </div>
  );
}

function SavedSearches() {
  const { toast } = useToast();
  const list = useApi<unknown>("/api/search/saved");
  const items = React.useMemo(() => (list.data ? readSavedList(list.data) : []), [list.data]);
  const [renaming, setRenaming] = React.useState<SavedSearch | null>(null);
  const [name, setName] = React.useState("");
  const [deleting, setDeleting] = React.useState<SavedSearch | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [makingSource, setMakingSource] = React.useState<SavedSearch | null>(null);
  const [reviewing, setReviewing] = React.useState<SavedSearch | null>(null);
  // Sources made in this visit, before the list is read again (the list itself carries `sourceId` after a reload).
  const [sourceIds, setSourceIds] = React.useState<Record<string, string>>({});

  async function rename(e: React.FormEvent) {
    e.preventDefault();
    if (!renaming || !name.trim()) return;
    setBusy(true);
    try {
      await patch(`/api/search/saved/${renaming.id}`, { name: name.trim() });
      toast({ title: "Search renamed", description: name.trim(), variant: "success" });
      setRenaming(null);
      await list.mutate();
    } catch (err) {
      toast({ title: "Couldn't rename the search", description: errorMessage(err), variant: "error" });
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try {
      await del(`/api/search/saved/${deleting.id}`);
      toast({ title: "Search deleted", description: deleting.name, variant: "success" });
      setDeleting(null);
      await list.mutate();
    } catch (err) {
      toast({ title: "Couldn't delete the search", description: errorMessage(err), variant: "error" });
    } finally {
      setBusy(false);
    }
  }
  async function asCollection(s: SavedSearch) {
    try {
      await post("/api/collections", { name: s.name, kind: "saved_search", savedSearchId: s.id });
      toast({ title: "Collection created", description: `${s.name} is now in Collections in the Library.`, variant: "success" });
      await list.mutate();
    } catch (err) {
      toast({ title: "Couldn't make a collection", description: errorMessage(err), variant: "error" });
    }
  }

  if (list.isLoading) return <LoadingSkeleton label="Loading saved searches" />;
  if (list.error) return <ErrorState title="Couldn't load saved searches" message={list.error.message} onRetry={() => void list.mutate()} />;
  if (!items.length) {
    return <EmptyState icon={BookmarkCheck} title="No saved searches yet" description="Run a search, then choose Save this search. It appears here, ready to run again." />;
  }
  return (
    <>
      <h2 className="sr-only">Saved searches</h2>
      <ul className="divide-y rounded-lg border" data-testid="saved-list">
        {items.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3" data-testid="saved-item">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium" data-testid="saved-name">{s.name}</p>
              <p className="truncate text-sm text-muted-foreground">
                {s.query}
                {s.lastRunAt ? ` · last run ${formatDate(s.lastRunAt)}` : ""}
                {s.collectionId ? " · is a collection" : ""}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild size="sm">
                <Link href={searchHref(stateFromSaved(s))} data-testid="saved-run"><Play aria-hidden="true" /> Run<span className="sr-only"> {s.name}</span></Link>
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setRenaming(s); setName(s.name); }} data-testid="saved-rename"><Pencil aria-hidden="true" /> Rename<span className="sr-only"> {s.name}</span></Button>
              {!s.collectionId ? (
                <Button size="sm" variant="outline" onClick={() => void asCollection(s)} data-testid="saved-collection"><FolderPlus aria-hidden="true" /> Save as collection<span className="sr-only">: {s.name}</span></Button>
              ) : null}
              <Button size="sm" variant="outline" onClick={() => setMakingSource(s)} data-testid="saved-source"><Eye aria-hidden="true" /> Watch for new pages<span className="sr-only">: {s.name}</span></Button>
              <Button size="sm" variant="outline" onClick={() => setReviewing(s)} data-testid="saved-candidates"><ListChecks aria-hidden="true" /> New pages<span className="sr-only"> from {s.name}</span></Button>
              <Button size="sm" variant="outline" onClick={() => setDeleting(s)} data-testid="saved-delete"><Trash2 aria-hidden="true" /> Delete<span className="sr-only"> {s.name}</span></Button>
            </div>
          </li>
        ))}
      </ul>

      <SavedSourceDialog search={makingSource} onOpenChange={(o) => !o && setMakingSource(null)} onCreated={(sid, src) => setSourceIds((m) => ({ ...m, [sid]: src }))} />
      <CandidatesDialog search={reviewing} sourceId={reviewing ? (sourceIds[reviewing.id] ?? reviewing.sourceId ?? undefined) : undefined} onOpenChange={(o) => !o && setReviewing(null)} />
      <Dialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent aria-describedby="rename-desc">
          <div><DialogTitle>Rename this search</DialogTitle><DialogDescription id="rename-desc" className="mt-1">Only the name changes. The words and filters stay as they are.</DialogDescription></div>
          <form onSubmit={rename} className="space-y-4">
            <div><Label htmlFor="rename-name" className="mb-1 block">Name</Label><Input id="rename-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" /></div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setRenaming(null)}>Cancel</Button>
              <Button type="submit" disabled={busy || !name.trim()} data-testid="rename-confirm">Rename</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent aria-describedby="delete-desc">
          <div><DialogTitle>Delete this saved search?</DialogTitle><DialogDescription id="delete-desc" className="mt-1">{deleting?.name}. Saved pages are not affected.</DialogDescription></div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => void remove()} disabled={busy} data-testid="delete-confirm">Delete search</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function HistoryPanel() {
  const { toast } = useToast();
  const hist = useApi<unknown>("/api/search/history");
  const { settings, save, saving } = useSearchServerSettings();
  const list = hist.data ? readHistory(hist.data) : null;
  const enabled = settings.data?.privacy?.searchHistory?.enabled ?? list?.enabled ?? true;

  async function clear() {
    try {
      await del("/api/search/history");
      toast({ title: "Search history cleared", variant: "success" });
      await hist.mutate();
    } catch (err) {
      toast({ title: "Couldn't clear the history", description: errorMessage(err), variant: "error" });
    }
  }
  async function removeOne(id: string) {
    try {
      await del(`/api/search/history/${encodeURIComponent(id)}`);
      await hist.mutate();
    } catch (err) {
      toast({ title: "Couldn't remove the entry", description: errorMessage(err), variant: "error" });
    }
  }
  async function toggle(on: boolean) {
    try {
      await save({ privacy: { searchHistory: { enabled: on } } });
      await hist.mutate();
    } catch (err) {
      toast({ title: "Couldn't change the setting", description: errorMessage(err), variant: "error" });
    }
  }
  return (
    <section aria-labelledby="hist-h" className="space-y-4">
      <h2 id="hist-h" className="sr-only">Search history</h2>
      <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
        <Switch id="hist-enabled" checked={enabled} disabled={saving || !settings.data} onCheckedChange={(v) => void toggle(v)} data-testid="history-toggle" />
        <Label htmlFor="hist-enabled" className="flex-1 font-normal">Keep a history of my searches<span className="block text-xs text-muted-foreground">Stored on this server only. Turning it off stops recording new searches.</span></Label>
        <Button variant="outline" size="sm" onClick={() => void clear()} disabled={!list?.items.length} data-testid="history-clear"><Trash2 aria-hidden="true" /> Clear history</Button>
      </div>
      {hist.isLoading ? <LoadingSkeleton label="Loading search history" rows={3} /> : null}
      {hist.error ? <ErrorState title="Couldn't load the history" message={hist.error.message} onRetry={() => void hist.mutate()} /> : null}
      {list && !enabled ? <EmptyState icon={History} title="Search history is off" description="Searches aren't recorded. Turn the switch on to keep them." /> : null}
      {list && enabled && list.items.length === 0 ? <EmptyState icon={History} title="No searches yet" description="Searches you run appear here." /> : null}
      {list && enabled && list.items.length > 0 ? (
        <ul className="divide-y rounded-lg border" data-testid="history-list">
          {list.items.map((h) => (
            <li key={h.id} className="flex items-center gap-3 p-3">
              <Link href={searchHref({ q: h.query, scope: h.scope })} className="min-w-0 flex-1 truncate text-primary underline-offset-4 hover:underline">{h.query}</Link>
              {h.at ? <span className="shrink-0 text-xs text-muted-foreground">{formatDate(h.at)}</span> : null}
              <Button size="sm" variant="ghost" onClick={() => void removeOne(h.id)}><X aria-hidden="true" /><span className="sr-only">Remove {h.query} from history</span></Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function SearchSettings() {
  const [prefs, setPrefs] = useSearchPrefs();
  const { toast } = useToast();
  const { settings, save, saving } = useSearchServerSettings();
  const preferCached = settings.data?.browser?.preferCached;
  const history = settings.data?.privacy?.searchHistory?.enabled;
  const sections: { key: keyof SearchPrefs; label: string; hint: string }[] = [
    { key: "homeRecent", label: "Recent searches", hint: "Your last few searches." },
    { key: "homeBookmarks", label: "Bookmarks", hint: "Your newest bookmarks." },
    { key: "homeCollections", label: "Favourite collections", hint: "Pages in Favourites." },
    { key: "homeStats", label: "Library statistics", hint: "How many pages, sources and collections you have." },
  ];
  async function changePref(p: Partial<SearchPrefs>) {
    try {
      await setPrefs(p);
    } catch (err) {
      toast({ title: "Couldn't change the setting", description: errorMessage(err), variant: "error" });
    }
  }
  async function change(body: Parameters<typeof save>[0]) {
    try {
      await save(body);
    } catch (err) {
      toast({ title: "Couldn't change the setting", description: errorMessage(err), variant: "error" });
    }
  }
  return (
    <div className="max-w-2xl space-y-8">
      <section aria-labelledby="set-results" className="space-y-3">
        <h2 id="set-results" className="text-lg font-semibold">Results</h2>
        <div>
          <Label htmlFor="set-page-size" className="mb-1 block">Results per page</Label>
          <Select id="set-page-size" className="max-w-40" value={String(prefs.resultsPerPage)} onChange={(e) => void changePref({ resultsPerPage: Number(e.target.value) })}>
            {[10, 20, 30, 40, 50].concat([10, 20, 30, 40, 50].includes(prefs.resultsPerPage) ? [] : [prefs.resultsPerPage]).sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
          <p className="mt-1 text-xs text-muted-foreground">Saved to your account.</p>
        </div>
        <div>
          <Label htmlFor="set-prefer" className="mb-1 block">When a page is saved and also online</Label>
          <Select id="set-prefer" className="max-w-sm" disabled={preferCached === undefined || saving} value={preferCached === false ? "live" : "cached"} onChange={(e) => void change({ browser: { preferCached: e.target.value === "cached" } })}>
            <option value="cached">Open the saved copy</option>
            <option value="live">Open the live site</option>
          </Select>
          <p className="mt-1 text-xs text-muted-foreground">Applies to everything you open in the Browser, including search results.</p>
        </div>
      </section>
      <section aria-labelledby="set-online" className="space-y-2">
        <h2 id="set-online" className="text-lg font-semibold">Online search</h2>
        <p className="text-sm text-muted-foreground">Search the web as well as your saved pages. It is off until you switch it on and add a provider.</p>
        <Link href="/storage/online-search" className="text-sm text-primary underline underline-offset-4 hover:no-underline" data-testid="online-settings-link">Online search settings</Link>
      </section>
      <section aria-labelledby="set-history" className="space-y-3">
        <h2 id="set-history" className="text-lg font-semibold">History</h2>
        <div className="flex items-start gap-3">
          <Switch id="set-hist" checked={history ?? true} disabled={history === undefined || saving} onCheckedChange={(v) => void change({ privacy: { searchHistory: { enabled: v } } })} data-testid="settings-history-toggle" />
          <Label htmlFor="set-hist" className="font-normal">Keep a history of my searches<span className="block text-xs text-muted-foreground">Stored on this server only. Off by choice means nothing is written.</span></Label>
        </div>
      </section>
      <section aria-labelledby="set-home" className="space-y-3">
        <h2 id="set-home" className="text-lg font-semibold">Homepage sections</h2>
        <p className="text-sm text-muted-foreground">The homepage shows only the search box until you switch a section on. Saved to your account.</p>
        <ul className="space-y-3">
          {sections.map((s) => (
            <li key={s.key} className="flex items-start gap-3">
              <Switch id={`home-${s.key}`} checked={prefs[s.key] as boolean} onCheckedChange={(v) => void changePref({ [s.key]: v })} />
              <Label htmlFor={`home-${s.key}`} className="font-normal">{s.label}<span className="block text-xs text-muted-foreground">{s.hint}</span></Label>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

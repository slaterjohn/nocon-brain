"use client";

import * as React from "react";
import Link from "next/link";
import { Archive, ExternalLink, FolderPlus, Search, Trash2 } from "lucide-react";
import { api, del, errorMessage } from "@/lib/api";
import type { DeletePreview, Page, PageSummary, SourcePageRow } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { AdvancedSettings } from "@/components/common/advanced-settings";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";
import { useBrowser } from "@/components/browser/tabs";
import { formatBytes, formatDate } from "./format";
import { LibraryNav } from "./library-nav";
import { AddToCollectionDialog } from "./add-to-collection";
import { useCollections, useSources } from "./hooks";
import { pageTypeLabel, priorityLabel } from "@/lib/library-copy";

type Sort = "captured" | "title" | "size" | "site";

interface Filters {
  q: string;
  sort: Sort;
  sourceId: string;
  collectionId: string;
  domain: string;
  from: string;
  to: string;
  multi: boolean;
}
const NO_FILTERS: Omit<Filters, "q" | "sort"> = { sourceId: "", collectionId: "", domain: "", from: "", to: "", multi: false };

/**
 * Loads the pages list. Every filter, the sort and the paging are the server's (docs/api.md section 4): the first request has no
 * cursor, "Show more" sends the `nextCursor` of the last answer and appends.
 */
function usePages(f: Filters, reload: number) {
  const [state, setState] = React.useState<{ items: PageSummary[]; total: number; cursor?: string; loading: boolean; loadingMore: boolean; error?: string }>({
    items: [], total: 0, loading: true, loadingMore: false,
  });
  const query = React.useMemo(() => {
    const p = new URLSearchParams({ sort: f.sort, limit: "50" });
    if (f.q) p.set("q", f.q);
    if (f.domain) p.set("domain", f.domain);
    if (f.sourceId) p.set("sourceId", f.sourceId);
    if (f.collectionId) p.set("collectionId", f.collectionId);
    if (f.from) p.set("from", f.from);
    if (f.to) p.set("to", f.to);
    if (f.multi) p.set("minVersions", "2");
    return p;
  }, [f.q, f.sort, f.sourceId, f.collectionId, f.domain, f.from, f.to, f.multi]);
  React.useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    api<Page<PageSummary>>(`/api/archive/pages?${query}`)
      .then((r) => live && setState({ items: r.items, total: r.total ?? r.items.length, cursor: r.nextCursor, loading: false, loadingMore: false }))
      .catch((e) => live && setState((s) => ({ ...s, loading: false, error: errorMessage(e) })));
    return () => { live = false; };
  }, [query, reload]);
  const loadMore = React.useCallback(() => {
    const cursor = state.cursor;
    if (!cursor) return;
    setState((s) => ({ ...s, loadingMore: true }));
    api<Page<PageSummary>>(`/api/archive/pages?${query}&cursor=${encodeURIComponent(cursor)}`)
      .then((r) => setState((s) => ({ ...s, items: [...s.items, ...r.items], total: r.total ?? s.total, cursor: r.nextCursor, loadingMore: false })))
      .catch((e) => setState((s) => ({ ...s, loadingMore: false, error: errorMessage(e) })));
  }, [query, state.cursor]);
  return { ...state, more: !!state.cursor, loadMore };
}

export function DeleteDialog({ page, onClose, onDeleted, opener }: { page: PageSummary | null; onClose: () => void; onDeleted: () => void; opener: React.RefObject<HTMLElement | null> }) {
  const { toast } = useToast();
  const sources = useSources();
  const collections = useCollections();
  const [preview, setPreview] = React.useState<DeletePreview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmProtected, setConfirmProtected] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    setPreview(null);
    setError(null);
    setConfirmProtected(false);
    if (!page) return;
    let live = true;
    api<DeletePreview>(`/api/archive/pages/${page.id}?dryRun=true`, { method: "DELETE" })
      .then((p) => live && setPreview(p))
      .catch((e) => live && setError(errorMessage(e)));
    return () => { live = false; };
  }, [page]);

  async function confirm() {
    if (!page) return;
    setBusy(true);
    try {
      await del(`/api/archive/pages/${page.id}${confirmProtected ? "?confirmProtected=true" : ""}`);
      toast({ title: "Page deleted", description: page.title });
      onDeleted();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const srcNames = (preview?.references.sources ?? []).map((id) => sources.byId.get(id)?.name ?? "A source");
  const colNames = (preview?.references.collections ?? []).map((id) => collections.byId.get(id)?.name ?? "A collection");

  return (
    <Dialog open={!!page} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        aria-describedby="delete-desc"
        onCloseAutoFocus={(e) => {
          if (opener.current?.isConnected) {
            e.preventDefault();
            opener.current.focus();
          }
        }}
      >
        <div>
          <DialogTitle>Delete this saved page?</DialogTitle>
          <DialogDescription id="delete-desc" className="mt-1">
            This removes {page?.title ? <strong className="break-words">{page.title}</strong> : "the page"} and every saved version of it from this server. It can't be undone. You can
            save the page again later if you are online.
          </DialogDescription>
        </div>
        {preview ? (
          <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="delete-preview">
            <li>{preview.versions} {preview.versions === 1 ? "version" : "versions"} will be deleted.</li>
            <li>About {formatBytes(preview.exclusiveBytes)} of space is freed once the storage tidy-up has run.</li>
            {preview.sharedBytesKept > 0 ? <li>{formatBytes(preview.sharedBytesKept)} is shared with other pages and stays.</li> : null}
            {srcNames.length > 0 ? <li>It is referenced by {srcNames.length === 1 ? "this source" : "these sources"}: {srcNames.join(", ")}. {srcNames.length === 1 ? "It stops" : "They stop"} counting this page.</li> : null}
            {colNames.length > 0 ? <li>It is removed from {colNames.length === 1 ? "this collection" : "these collections"}: {colNames.join(", ")}.</li> : null}
            {preview.references.pins.length > 0 ? <li>It is pinned as {preview.references.pins.map((p) => priorityLabel(p)).join(", ")}.</li> : null}
            {preview.references.bookmarks > 0 ? (
              <li>
                {preview.references.bookmarks} {preview.references.bookmarks === 1 ? "bookmark keeps" : "bookmarks keep"} the web address but lose the saved copy.
              </li>
            ) : null}
          </ul>
        ) : error ? null : (
          <LoadingSkeleton rows={2} label="Checking what will be deleted" />
        )}
        {preview?.requiresConfirmation ? (
          <div className="flex items-start gap-2 rounded-md border border-warning p-3 text-sm">
            <Checkbox id="confirm-protected" checked={confirmProtected} onCheckedChange={(v) => setConfirmProtected(v === true)} />
            <Label htmlFor="confirm-protected" className="text-sm leading-snug">
              This page is protected. I want to delete it anyway.
            </Label>
          </div>
        ) : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" onClick={() => void confirm()} disabled={busy || !preview || (preview.requiresConfirmation && !confirmProtected)} data-testid="confirm-delete">
            <Trash2 aria-hidden="true" /> Delete page
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The Library: every saved page, with search, filters, sort, bulk add to a collection, and delete with a preview of what it affects. */
export function LibraryView() {
  const b = useBrowser();
  const sources = useSources();
  const collections = useCollections();
  const [q, setQ] = React.useState("");
  const [term, setTerm] = React.useState("");
  const [sort, setSort] = React.useState<Sort>("captured");
  const [flt, setFlt] = React.useState(NO_FILTERS);
  const [domainTerm, setDomainTerm] = React.useState("");
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [reload, setReload] = React.useState(0);
  const [target, setTarget] = React.useState<PageSummary | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = React.useState(false);
  const opener = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  React.useEffect(() => {
    const t = setTimeout(() => setFlt((f) => ({ ...f, domain: domainTerm.trim() })), 250);
    return () => clearTimeout(t);
  }, [domainTerm]);

  const filters: Filters = { q: term, sort, ...flt };
  const list = usePages(filters, reload);
  const activeFilters = [flt.sourceId, flt.collectionId, flt.domain, flt.from, flt.to, flt.multi ? "1" : ""].filter(Boolean).length;
  const setF = <K extends keyof typeof NO_FILTERS>(k: K, v: (typeof NO_FILTERS)[K]) => setFlt((f) => ({ ...f, [k]: v }));
  const allSelected = list.items.length > 0 && list.items.every((p) => selected.has(p.id));

  function toggle(id: string, on: boolean) {
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  }

  return (
    <div className="mx-auto w-full max-w-6xl p-4 sm:p-6">
      <PageHeader title="Library" description="Pages you have saved. They open without internet." />
      <LibraryNav />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-0 grow sm:max-w-sm">
          <Label htmlFor="library-q" className="mb-1 block text-sm">Search saved pages</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" aria-hidden="true" />
            <Input id="library-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, site or address" className="pl-9" autoComplete="off" />
          </div>
        </div>
        <div>
          <Label htmlFor="library-sort" className="mb-1 block text-sm">Sort by</Label>
          <Select id="library-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="captured">Newest first</option>
            <option value="title">Title</option>
            <option value="site">Site</option>
            <option value="size">Largest first</option>
          </Select>
        </div>
        {!list.loading || list.items.length > 0 ? (
          <p className="pb-2 text-sm text-muted-foreground" role="status" data-testid="library-count">
            {list.total} {list.total === 1 ? "page" : "pages"}
          </p>
        ) : null}
      </div>

      <div className="mb-4">
        <AdvancedSettings title="Filters" open={filtersOpen} onOpenChange={setFiltersOpen} changed={activeFilters} id="library-filters">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <Label htmlFor="f-source" className="mb-1 block text-sm">Source</Label>
              <Select id="f-source" value={flt.sourceId} onChange={(e) => setF("sourceId", e.target.value)}>
                <option value="">Any source</option>
                {sources.sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </div>
            <div>
              <Label htmlFor="f-collection" className="mb-1 block text-sm">Collection</Label>
              <Select id="f-collection" value={flt.collectionId} onChange={(e) => setF("collectionId", e.target.value)}>
                <option value="">Any collection</option>
                {collections.flat.map((c) => <option key={c.id} value={c.id}>{"  ".repeat(c.depth)}{c.name}</option>)}
              </Select>
            </div>
            <div>
              <Label htmlFor="f-domain" className="mb-1 block text-sm">Site</Label>
              <Input id="f-domain" value={domainTerm} onChange={(e) => setDomainTerm(e.target.value)} placeholder="example.org" autoComplete="off" />
            </div>
            <div>
              <Label htmlFor="f-from" className="mb-1 block text-sm">Saved from</Label>
              <Input id="f-from" type="date" value={flt.from} onChange={(e) => setF("from", e.target.value)} />
            </div>
            <div>
              <Label htmlFor="f-to" className="mb-1 block text-sm">Saved up to</Label>
              <Input id="f-to" type="date" value={flt.to} onChange={(e) => setF("to", e.target.value)} />
            </div>
            <div className="flex items-end gap-2 pb-2">
              <Checkbox id="f-multi" checked={flt.multi} onCheckedChange={(v) => setF("multi", v === true)} />
              <Label htmlFor="f-multi" className="text-sm">Has more than one version</Label>
            </div>
          </div>
          {activeFilters > 0 ? (
            <Button variant="outline" size="sm" onClick={() => { setFlt(NO_FILTERS); setDomainTerm(""); }}>Clear filters</Button>
          ) : null}
        </AdvancedSettings>
      </div>

      {selected.size > 0 ? (
        <div role="region" aria-label="Bulk actions" className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-2 px-3" data-testid="bulk-bar">
          <p role="status" className="mr-auto text-sm">{selected.size} selected</p>
          <Button size="sm" onClick={() => setAddOpen(true)} data-testid="bulk-add"><FolderPlus aria-hidden="true" /> Add to collection</Button>
          <Button size="sm" variant="outline" onClick={() => setSelected(new Set())}>Clear selection</Button>
        </div>
      ) : null}

      {list.loading && list.items.length === 0 ? <LoadingSkeleton label="Loading your saved pages" /> : null}
      {list.error ? <ErrorState title="Couldn't load the Library" message={list.error} onRetry={() => setReload((n) => n + 1)} /> : null}
      {!list.loading && !list.error && list.items.length === 0 ? (
        <EmptyState
          icon={Archive}
          title={term || activeFilters ? "No saved page matches" : "Nothing saved yet"}
          description={term || activeFilters ? "Try different words, or clear the search and filters." : "Type a web address in the Browser and choose Save for offline. The page then appears here."}
        />
      ) : null}
      {list.items.length > 0 ? (
        <>
          <Table aria-label="Saved pages">
            <caption className="sr-only">Saved pages, with site, date saved, number of versions and size</caption>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    aria-label="Select all pages shown"
                    checked={allSelected}
                    onCheckedChange={(v) => setSelected(v === true ? new Set([...selected, ...list.items.map((p) => p.id)]) : new Set([...selected].filter((id) => !list.items.some((p) => p.id === id))))}
                  />
                </TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Site</TableHead>
                <TableHead>Saved</TableHead>
                <TableHead className="text-right">Versions</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.items.map((p) => (
                <TableRow key={p.id} data-testid="library-row">
                  <TableCell>
                    <Checkbox aria-label={`Select ${p.title}`} checked={selected.has(p.id)} onCheckedChange={(v) => toggle(p.id, v === true)} />
                  </TableCell>
                  <TableCell className="max-w-xs">
                    <Link href={`/library/pages/${p.id}`} className="block truncate font-medium text-primary underline-offset-4 hover:underline" data-testid="page-link">{p.title}</Link>
                    <div className="truncate text-xs text-muted-foreground" data-testid="page-origin">
                      {p.imported ? <>Imported document · {p.imported.filename}</> : p.url}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge variant="secondary" data-testid="page-type">{pageTypeLabel(p.type)}</Badge>
                      {p.imported ? <Badge variant="outline">Imported document</Badge> : null}
                    </div>
                    {p.availability !== "archived" ? <Badge variant="warning" className="mt-1">{p.availability === "partial" ? "Partly saved" : "Removed to save space"}</Badge> : null}
                  </TableCell>
                  <TableCell>{p.imported ? <span aria-label="Not from a website">–</span> : p.domain}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatDate(p.lastCapturedAt)}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.versionCount}</TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">{formatBytes(p.totalBytes)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="outline" onClick={() => b.openInBrowser(p.url)}>
                        <ExternalLink aria-hidden="true" /> Open<span className="sr-only"> {p.title} in the browser</span>
                      </Button>
                      <Button size="sm" variant="ghost" onClick={(e) => { opener.current = e.currentTarget; setTarget(p); }}>
                        <Trash2 aria-hidden="true" /> Delete<span className="sr-only"> {p.title}</span>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {list.more ? (
            <div className="mt-4 flex justify-center">
              <Button variant="outline" onClick={list.loadMore} disabled={list.loadingMore}>{list.loadingMore ? "Loading" : "Show more"}</Button>
            </div>
          ) : null}
        </>
      ) : null}
      <DeleteDialog page={target} opener={opener} onClose={() => setTarget(null)} onDeleted={() => { setReload((n) => n + 1); setTimeout(() => document.getElementById("library-q")?.focus(), 50); }} />
      <AddToCollectionDialog pageIds={[...selected]} open={addOpen} onClose={() => setAddOpen(false)} onDone={() => setSelected(new Set())} />
    </div>
  );
}

export type { SourcePageRow };

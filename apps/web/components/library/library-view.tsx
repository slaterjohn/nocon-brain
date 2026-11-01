"use client";

import * as React from "react";
import { Archive, ExternalLink, Search, Trash2 } from "lucide-react";
import { api, del, errorMessage, useApi } from "@/lib/api";
import type { DeletePreview, Page, PageSummary } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";
import { useBrowser } from "@/components/browser/tabs";
import { formatBytes, formatDate } from "./format";

type Sort = "captured" | "title" | "size" | "site";

function DeleteDialog({ page, onClose, onDeleted, opener }: { page: PageSummary | null; onClose: () => void; onDeleted: () => void; opener: React.RefObject<HTMLElement | null> }) {
  const { toast } = useToast();
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
            {preview.sharedBytesKept > 0 ? <li>{formatBytes(preview.sharedBytesKept)} is shared with other pages and stays.</li>  : null}
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

/** The basic Library: every saved page with its site, captured date, versions and size; open it in the browser, or delete it. */
export function LibraryView() {
  const b = useBrowser();
  const [q, setQ] = React.useState("");
  const [term, setTerm] = React.useState("");
  const [sort, setSort] = React.useState<Sort>("captured");
  const [limit, setLimit] = React.useState(50);
  const [target, setTarget] = React.useState<PageSummary | null>(null);
  const opener = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const path = `/api/archive/pages?sort=${sort}&limit=${limit}${term ? `&q=${encodeURIComponent(term)}` : ""}`;
  const list = useApi<Page<PageSummary>>(path);

  return (
    <div className="mx-auto w-full max-w-6xl p-4 sm:p-6">
      <PageHeader title="Library" description="Pages you have saved. They open without internet." />
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
        {list.data ? (
          <p className="pb-2 text-sm text-muted-foreground" role="status" data-testid="library-count">
            {list.data.total} {list.data.total === 1 ? "page" : "pages"}
          </p>
        ) : null}
      </div>

      {list.isLoading ? <LoadingSkeleton label="Loading your saved pages" /> : null}
      {list.error ? <ErrorState title="Couldn't load the Library" message={list.error.message} onRetry={() => void list.mutate()} /> : null}
      {list.data && list.data.items.length === 0 ? (
        <EmptyState
          icon={Archive}
          title={term ? "No saved page matches" : "Nothing saved yet"}
          description={term ? "Try different words, or clear the search." : "Type a web address in the Browser and choose Save for offline. The page then appears here."}
        />
      ) : null}
      {list.data && list.data.items.length > 0 ? (
        <>
          <Table aria-label="Saved pages">
            <caption className="sr-only">Saved pages, with site, date saved, number of versions and size</caption>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Site</TableHead>
                <TableHead>Saved</TableHead>
                <TableHead className="text-right">Versions</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.items.map((p) => (
                <TableRow key={p.id} data-testid="library-row">
                  <TableCell className="max-w-xs">
                    <div className="truncate font-medium">{p.title}</div>
                    <div className="truncate text-xs text-muted-foreground">{p.url}</div>
                    {p.availability !== "archived" ? <Badge variant="warning" className="mt-1">{p.availability === "partial" ? "Partly saved" : "Removed to save space"}</Badge> : null}
                  </TableCell>
                  <TableCell>{p.domain}</TableCell>
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
          {list.data.nextCursor ? (
            <div className="mt-4 flex justify-center">
              <Button variant="outline" onClick={() => setLimit((n) => n + 50)}>Show more</Button>
            </div>
          ) : null}
        </>
      ) : null}
      <DeleteDialog page={target} opener={opener} onClose={() => setTarget(null)} onDeleted={() => { void list.mutate(); setTimeout(() => document.getElementById("library-q")?.focus(), 50); }} />
    </div>
  );
}

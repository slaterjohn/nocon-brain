"use client";

import * as React from "react";
import Link from "next/link";
import { Bookmark as BookmarkIcon, ExternalLink, Save, Trash2 } from "lucide-react";
import { api, del, errorMessage, post, useApi } from "@/lib/api";
import type { Bookmark, SaveResponse } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";
import { useBrowser } from "@/components/browser/tabs";
import { useEvents } from "@/components/layout/events";
import { formatDate } from "./format";
import { usePackages } from "@/components/zim/hooks";
import { zimUrl } from "@/lib/zim";

/** Bookmarks: the address plus the saved copy it links to, when there is one. */
export function BookmarksView() {
  const b = useBrowser();
  const ev = useEvents();
  const { toast } = useToast();
  const pkgs = usePackages();
  const [q, setQ] = React.useState("");
  const [term, setTerm] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const list = useApi<{ items: Bookmark[] }>(`/api/bookmarks${term ? `?q=${encodeURIComponent(term)}` : ""}`);

  async function remove(bm: Bookmark) {
    try {
      await del(`/api/bookmarks/${bm.id}`);
      toast({ title: "Bookmark removed", description: bm.title });
      void list.mutate();
    } catch (e) {
      toast({ title: "Couldn't remove the bookmark", description: errorMessage(e), variant: "error" });
    }
  }
  async function save(bm: Bookmark) {
    try {
      const r = await api<SaveResponse>("/api/browser/save", { method: "POST", body: { url: bm.originalUrl, queue: ev.connectivity === "offline" } });
      toast({ title: r.held ? "Queued" : "Saving", description: r.held ? "It is saved when the connection returns." : "It will appear as saved here shortly." });
      setTimeout(() => void list.mutate(), 4000);
    } catch (e) {
      toast({ title: "Couldn't save the page", description: errorMessage(e), variant: "error" });
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
      <PageHeader title="Bookmarks" description="Addresses you have starred. A bookmark keeps its saved copy, so it opens without internet." actions={<Button asChild variant="outline"><Link href="/history">History</Link></Button>} />
      <div className="mb-4 max-w-sm">
        <Label htmlFor="bm-q" className="mb-1 block text-sm">Search bookmarks</Label>
        <Input id="bm-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      </div>
      {list.isLoading ? <LoadingSkeleton label="Loading bookmarks" /> : null}
      {list.error ? <ErrorState title="Couldn't load bookmarks" message={list.error.message} onRetry={() => void list.mutate()} /> : null}
      {list.data && list.data.items.length === 0 ? (
        <EmptyState icon={BookmarkIcon} title={term ? "No bookmark matches" : "No bookmarks yet"} description="Use the star next to the address bar to bookmark a page." />
      ) : null}
      {list.data && list.data.items.length > 0 ? (
        <ul className="divide-y rounded-lg border" aria-label="Bookmarks">
          {list.data.items.map((bm) => (
            <li key={bm.id} className="flex flex-wrap items-center gap-3 p-3" data-testid="bookmark-row">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{bm.title}</div>
                <div className="truncate text-xs text-muted-foreground">{bm.originalUrl}</div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {bm.archive ? <Badge variant="success">Saved copy</Badge> : null}
                  {bm.zim ? <Badge variant="success" data-testid="bookmark-package">Knowledge package: {pkgs.byId.get(bm.zim.zimId)?.title ?? "package"}</Badge> : null}
                  {!bm.archive && !bm.zim ? <Badge variant="warning">Not saved</Badge> : null}
                  <span>Added {formatDate(bm.createdAt)}</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                <Button size="sm" variant="outline" onClick={() => b.openInBrowser(bm.zim && !bm.archive && !/^https?:\/\//i.test(bm.originalUrl) ? zimUrl(bm.zim.zimId, bm.zim.path) : bm.originalUrl)}>
                  <ExternalLink aria-hidden="true" /> Open<span className="sr-only"> {bm.title}</span>
                </Button>
                {!bm.archive && !bm.zim && /^https?:\/\//i.test(bm.originalUrl) ? (
                  <Button size="sm" variant="outline" onClick={() => void save(bm)}>
                    <Save aria-hidden="true" /> Save for offline<span className="sr-only">: {bm.title}</span>
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => void remove(bm)}>
                  <Trash2 aria-hidden="true" /> Remove<span className="sr-only"> bookmark {bm.title}</span>
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

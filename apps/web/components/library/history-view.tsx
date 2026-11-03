"use client";

import * as React from "react";
import Link from "next/link";
import { History, Trash2 } from "lucide-react";
import { api, del, errorMessage, useApi } from "@/lib/api";
import type { HistoryEntry } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";
import { useBrowser } from "@/components/browser/tabs";
import { formatDate } from "./format";
import { usePackages } from "@/components/zim/hooks";
import { zimUrl } from "@/lib/zim";

const MARKER: Record<HistoryEntry["servedFrom"], { label: string; variant: "success" | "secondary" | "warning" }> = {
  archive: { label: "Saved copy", variant: "success" },
  cache: { label: "Saved copy", variant: "success" },
  zim: { label: "Knowledge package", variant: "success" },
  live: { label: "Live site", variant: "secondary" },
  offline: { label: "Offline, not saved", variant: "warning" },
};

/** History of pages opened in the Browser, each marked as a saved copy or the live site. Local only. */
export function HistoryView() {
  const b = useBrowser();
  const { toast } = useToast();
  const pkgs = usePackages();
  const [q, setQ] = React.useState("");
  const [term, setTerm] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const list = useApi<{ enabled: boolean; items: HistoryEntry[] }>(`/api/history${term ? `?q=${encodeURIComponent(term)}` : ""}`);
  const [busy, setBusy] = React.useState(false);

  async function setEnabled(on: boolean) {
    setBusy(true);
    try {
      await api("/api/settings", { method: "PATCH", body: { privacy: { history: { enabled: on } } } });
      toast({ title: on ? "History is on" : "History is off", description: on ? "Pages you open are recorded on this server." : "Pages you open are no longer recorded. Existing entries stay until you clear them." });
      void list.mutate();
    } catch (e) {
      toast({ title: "Couldn't change history", description: errorMessage(e), variant: "error" });
    } finally {
      setBusy(false);
    }
  }
  async function clear() {
    try {
      const r = await del<{ deleted: number }>("/api/history");
      toast({ title: "History cleared", description: `${r.deleted} ${r.deleted === 1 ? "entry" : "entries"} deleted.` });
      void list.mutate();
    } catch (e) {
      toast({ title: "Couldn't clear history", description: errorMessage(e), variant: "error" });
    }
  }
  async function remove(h: HistoryEntry) {
    try {
      await del(`/api/history/${h.id}`);
      void list.mutate();
    } catch (e) {
      toast({ title: "Couldn't remove the entry", description: errorMessage(e), variant: "error" });
    }
  }

  const enabled = list.data?.enabled ?? true;
  return (
    <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
      <PageHeader title="History" description="Pages opened in the Browser. History stays on this server." actions={<Button asChild variant="outline"><Link href="/bookmarks">Bookmarks</Link></Button>} />
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <div className="min-w-0 grow sm:max-w-sm">
          <Label htmlFor="hist-q" className="mb-1 block text-sm">Search history</Label>
          <Input id="hist-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Switch id="hist-enabled" checked={enabled} disabled={busy || !list.data} onCheckedChange={(v) => void setEnabled(v)} />
          <Label htmlFor="hist-enabled" className="text-sm">Record history</Label>
        </div>
        <Button variant="outline" onClick={() => void clear()} disabled={!list.data || list.data.items.length === 0} data-testid="clear-history">
          <Trash2 aria-hidden="true" /> Clear history
        </Button>
      </div>
      {list.isLoading ? <LoadingSkeleton label="Loading history" /> : null}
      {list.error ? <ErrorState title="Couldn't load history" message={list.error.message} onRetry={() => void list.mutate()} /> : null}
      {list.data && !list.data.enabled ? <p className="mb-3 text-sm text-muted-foreground" role="status">History is switched off, so new pages are not recorded.</p> : null}
      {list.data && list.data.items.length === 0 ? (
        <EmptyState icon={History} title={term ? "No entry matches" : "No history"} description="Pages you open in the Browser appear here." />
      ) : null}
      {list.data && list.data.items.length > 0 ? (
        <ul className="divide-y rounded-lg border" aria-label="History">
          {list.data.items.map((h) => {
            const m = MARKER[h.servedFrom];
            return (
              <li key={h.id} className="flex flex-wrap items-center gap-3 p-3" data-testid="history-row">
                <div className="min-w-0 flex-1">
                  <button type="button" className="block max-w-full truncate text-left font-medium text-primary underline-offset-4 hover:underline" onClick={() => b.openInBrowser(h.zim && h.servedFrom === "zim" ? zimUrl(h.zim.zimId, h.zim.path) : h.url)}>
                    {h.title}
                  </button>
                  <div className="truncate text-xs text-muted-foreground">{h.url}</div>
                  {h.zim ? <div className="truncate text-xs text-muted-foreground" data-testid="history-package">Package: {pkgs.byId.get(h.zim.zimId)?.title ?? "a knowledge package"}</div> : null}
                </div>
                <Badge variant={m.variant}>{m.label}</Badge>
                <time className="text-xs whitespace-nowrap text-muted-foreground" dateTime={h.visitedAt}>{formatDate(h.visitedAt)}</time>
                <Button size="sm" variant="ghost" onClick={() => void remove(h)}>
                  <Trash2 aria-hidden="true" /> Remove<span className="sr-only"> {h.title} from history</span>
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

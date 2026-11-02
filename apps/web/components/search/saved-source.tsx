"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { errorMessage, post, useApi } from "@/lib/api";
import { displayAddress, type SavedSearch } from "@/lib/search";
import { safeHttpUrl } from "@/lib/online-search";
import { buildSchedule, buildWindow, emptyDraft, validateDraft, type Draft } from "@/lib/source-draft";
import { ScheduleSection } from "@/components/library/source-fields";

/** Turns a saved search into a source: it is searched on the web again and again, and new addresses become candidates or saves. */
export function SavedSourceDialog({
  search, onOpenChange, onCreated,
}: {
  search: SavedSearch | null;
  onOpenChange: (o: boolean) => void;
  onCreated: (savedSearchId: string, sourceId: string) => void;
}) {
  const { toast } = useToast();
  const [onResult, setOnResult] = React.useState<"candidates" | "downloads">("candidates");
  const [max, setMax] = React.useState("20");
  const [enabled, setEnabled] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [sched, setSched] = React.useState<Draft>(emptyDraft);
  const [schedErrors, setSchedErrors] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (search) {
      setSched(emptyDraft());
      setSchedErrors({});
      setOnResult("candidates");
      setMax("20");
      setEnabled(true);
      setError("");
    }
  }, [search]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!search) return;
    setError("");
    const all = validateDraft({ ...sched, type: "saved_search", name: search.name }, null, false);
    const errs = Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith("schedule.") || k.startsWith("window.")));
    setSchedErrors(errs);
    if (Object.keys(errs).length) {
      setError("Check the schedule below.");
      return;
    }
    setBusy(true);
    try {
      const schedule = sched.schedKind === "manual" ? undefined : { ...buildSchedule(sched), ...(sched.windowOn ? { window: buildWindow(sched) } : {}) };
      const src = await post<{ id: string }>(`/api/search/saved/${encodeURIComponent(search.id)}/source`, { onResult, maxResults: Math.min(50, Math.max(1, Number(max) || 20)), enabled, ...(schedule ? { schedule } : {}) });
      onCreated(search.id, src.id);
      toast({ title: "Source created", description: `${search.name} is now watched. Run it from here or from Sources in the Library.`, variant: "success" });
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!search} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby="ssrc-desc">
        <div>
          <DialogTitle>Watch this search for new pages</DialogTitle>
          <DialogDescription id="ssrc-desc" className="mt-1">
            Runs {search?.name ? `“${search.name}”` : "the search"} on the web when you ask. It needs online search to be on. Only addresses are kept, never the provider&apos;s snippets.
          </DialogDescription>
        </div>
        <form onSubmit={submit} className="space-y-4">
          {error ? <p role="alert" className="rounded-md border border-destructive/60 bg-destructive/10 p-3 text-sm" data-testid="ssrc-error">{error}</p> : null}
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">New addresses become</legend>
            {([["candidates", "Candidates to review", "You approve or dismiss each one."], ["downloads", "Saves straight away", "Each new page is queued for saving. Brave results still wait for your approval."]] as const).map(([v, l, t]) => (
              <div key={v} className="flex items-start gap-3 rounded-lg border p-3">
                <input type="radio" id={`ssrc-${v}`} name="ssrc-on" className="mt-1 size-4 accent-[var(--primary)]" checked={onResult === v} onChange={() => setOnResult(v)} aria-describedby={`ssrc-${v}-d`} />
                <div><Label htmlFor={`ssrc-${v}`}>{l}</Label><p id={`ssrc-${v}-d`} className="text-xs text-muted-foreground">{t}</p></div>
              </div>
            ))}
          </fieldset>
          <div>
            <Label htmlFor="ssrc-max" className="mb-1 block">Most results per run (1 to 50)</Label>
            <Input id="ssrc-max" type="number" min={1} max={50} className="max-w-24" value={max} onChange={(e) => setMax(e.target.value)} />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">When should it run?</legend>
            <ScheduleSection d={sched} set={(p) => setSched((d) => ({ ...d, ...p }))} errors={schedErrors} ceil={null} />
          </fieldset>
          <div className="flex items-center gap-3">
            <Switch id="ssrc-on" checked={enabled} onCheckedChange={setEnabled} />
            <Label htmlFor="ssrc-on" className="font-normal">Switched on</Label>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy} data-testid="ssrc-create">Create source</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface Candidate { id: string; url: string; title: string | null; state: "new" | "approved" | "queued" | "archived" | "dismissed"; transient: boolean; seenAt: string }
const STATE_LABEL: Record<Candidate["state"], string> = { new: "New", approved: "Approved", queued: "Waiting to be saved", archived: "Saved", dismissed: "Dismissed" };

/** The candidates a watched search found: approve to queue a save, or dismiss. Titles are plain text. */
export function CandidatesDialog({ search, sourceId, onOpenChange }: { search: SavedSearch | null; sourceId?: string; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const q = useApi<{ items: Candidate[] }>(search ? `/api/search/saved/${encodeURIComponent(search.id)}/candidates` : null);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => setPicked(new Set()), [search]);
  const items = q.data?.items ?? [];
  const fresh = items.filter((c) => c.state === "new");

  async function act(kind: "approve" | "dismiss") {
    if (!search || !picked.size) return;
    setBusy(true);
    try {
      await post(`/api/search/saved/${encodeURIComponent(search.id)}/candidates/${kind}`, { ids: [...picked] });
      toast({ title: kind === "approve" ? "Queued for saving" : "Dismissed", description: `${picked.size} ${picked.size === 1 ? "address" : "addresses"}.`, variant: "success" });
      setPicked(new Set());
      await q.mutate();
    } catch (e) {
      toast({ title: kind === "approve" ? "Couldn't approve" : "Couldn't dismiss", description: errorMessage(e), variant: "error" });
    } finally {
      setBusy(false);
    }
  }
  async function runNow() {
    if (!sourceId) return;
    setBusy(true);
    try {
      await post(`/api/sources/${encodeURIComponent(sourceId)}/run`, {});
      toast({ title: "Search started", description: "New addresses appear here when it finishes.", variant: "success" });
      window.setTimeout(() => void q.mutate(), 2500);
    } catch (e) {
      toast({ title: "Couldn't run the search", description: errorMessage(e), variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!search} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" aria-describedby="cand-desc">
        <div>
          <DialogTitle>New pages from {search?.name}</DialogTitle>
          <DialogDescription id="cand-desc" className="mt-1">Addresses this watched search found. Approving queues a save of the page itself.</DialogDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {sourceId ? <Button size="sm" variant="outline" onClick={() => void runNow()} disabled={busy} data-testid="cand-run">Run the search now</Button> : <Link href="/library/sources" className="text-sm text-primary underline underline-offset-4 hover:no-underline">Run it from Sources in the Library</Link>}
          <Button size="sm" variant="outline" onClick={() => void q.mutate()}>Refresh</Button>
        </div>
        {q.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        {q.error ? <p role="alert" className="text-sm text-destructive">{q.error.message}</p> : null}
        {!q.isLoading && !q.error && items.length === 0 ? <p className="text-sm text-muted-foreground" data-testid="cand-empty">No new pages yet.</p> : null}
        {items.length ? (
          <ul className="max-h-72 space-y-2 overflow-y-auto" data-testid="cand-list">
            {items.map((c) => {
              const link = safeHttpUrl(c.url);
              return (
                <li key={c.id} className="flex items-start gap-3 rounded-md border p-2" data-testid="cand-item">
                  <Checkbox id={`cand-${c.id}`} disabled={c.state !== "new"} checked={picked.has(c.id)} onCheckedChange={(v) => setPicked((p) => { const n = new Set(p); if (v === true) n.add(c.id); else n.delete(c.id); return n; })} />
                  <Label htmlFor={`cand-${c.id}`} className="min-w-0 font-normal">
                    <span className="block truncate font-medium">{c.title || (link ? displayAddress(link) : "Address not shown")}</span>
                    <span className="block truncate text-xs text-muted-foreground">{link ? displayAddress(link) : "Not an http or https address"} · {STATE_LABEL[c.state]}{c.transient ? " · only the address is kept" : ""}</span>
                  </Label>
                </li>
              );
            })}
          </ul>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => void act("dismiss")} disabled={busy || !picked.size} data-testid="cand-dismiss">Dismiss</Button>
          <Button onClick={() => void act("approve")} disabled={busy || !picked.size} data-testid="cand-approve">Approve and save</Button>
        </div>
        <p className="sr-only">{fresh.length} new</p>
      </DialogContent>
    </Dialog>
  );
}

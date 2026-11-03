"use client";

import * as React from "react";
import Link from "next/link";
import { Check, ChevronDown, Download, HelpCircle, X } from "lucide-react";
import { errorMessage, get, post, useApi } from "@/lib/api";
import {
  DEFAULT_FILTERS, KIND_LABEL, KIND_SHORT, SORTS, STATE_LABEL, STATE_ORDER, filtersActive, filtersToQuery, hostLabel, runnerHeadline, shouldPoll,
  type BulkResult, type Candidate, type CandidateList, type CandidateState, type Filters, type Overview, type ProvenanceKind,
} from "@/lib/discovery";
import { formatBytes, formatDate, timeAgo } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";
import { ConfirmDialog, Notice } from "@/components/storage/shared";
import { useCollections, useSources } from "@/components/library/hooks";
import { POLL_BUSY_MS, POLL_IDLE_MS, RunPassButton, useRunner } from "./hooks";
import { WhyPanel } from "./why-panel";

const PAGE = 25;
const KINDS: ProvenanceKind[] = ["link", "bookmark", "visit", "missing_link", "saved_search", "search_result", "manual"];
const stateVariant = (s: CandidateState): "success" | "warning" | "destructive" | "secondary" | "outline" =>
  s === "archived" ? "success" : s === "queued" ? "warning" : s === "approved" ? "secondary" : s === "dismissed" || s === "expired" ? "outline" : "secondary";

interface Target { ids: string[]; label: string }

function CandidateRow({
  c, mode, selected, onSelect, open, onToggleWhy, onApprove, onQueue, onDismiss, busy,
}: {
  c: Candidate; mode: string | undefined; selected: boolean; onSelect: (on: boolean) => void; open: boolean; onToggleWhy: () => void;
  onApprove: (c: Candidate) => void; onQueue: (c: Candidate) => void; onDismiss: (c: Candidate) => void; busy: boolean;
}) {
  const name = c.title || c.url;
  const final = c.state === "queued" || c.state === "archived";
  const whyId = `why-${c.id}`;
  return (
    <li className="p-4" data-testid="candidate-row" data-id={c.id} data-state={c.state} data-url={c.url}>
      <div className="flex items-start gap-3">
        <Checkbox checked={selected} onCheckedChange={(v) => onSelect(v === true)} aria-label={`Select ${name}`} className="mt-1" data-testid="candidate-select" />
        <div className="min-w-0 flex-1 space-y-1.5">
          {c.title ? <p className="font-medium" data-testid="candidate-title">{c.title}</p> : null}
          <p className={c.title ? "text-sm break-all text-muted-foreground" : "font-medium break-all"} data-testid="candidate-url">{c.url}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={stateVariant(c.state)} data-testid="candidate-state">{STATE_LABEL[c.state]}</Badge>
            {c.lane === "background" ? <Badge variant="outline">Background</Badge> : null}
            {c.provenanceKinds.map((k) => <Badge key={k} variant="outline" title={KIND_LABEL[k]}>{KIND_SHORT[k]}</Badge>)}
          </div>
          <p className="text-xs text-muted-foreground">
            <span data-testid="candidate-score">Score {Number(c.score.toFixed(2))}</span>
            {" · "}{c.depth} {c.depth === 1 ? "hop" : "hops"} from a saved page
            {c.estimatedBytes != null ? ` · about ${formatBytes(c.estimatedBytes)}` : ""}
            {" · "}seen {timeAgo(c.lastSeenAt)}
            {c.provenanceCount > 1 ? ` · ${c.provenanceCount} reasons` : ""}
            {c.suggestedSource ? <> · for <Link href={`/library/sources/${c.suggestedSource.id}`} className="underline underline-offset-2">{c.suggestedSource.name}</Link></> : null}
          </p>
          {c.state === "queued" ? (
            <p className="text-sm" data-testid="candidate-job">
              Downloading now.{" "}
              <Link href="/downloads" className="underline underline-offset-2" data-download-id={c.downloadId}>Open Downloads{c.downloadId ? <span className="sr-only"> (download {c.downloadId})</span> : null}</Link>
            </p>
          ) : null}
          {c.state === "archived" ? <p className="text-sm" data-testid="candidate-job">Saved. It is in your library now.{c.downloadId ? <> <Link href="/downloads" className="underline underline-offset-2" data-download-id={c.downloadId}>Open Downloads<span className="sr-only"> (download {c.downloadId})</span></Link></> : null}</p> : null}
          {c.state === "approved" ? (
            <p className="text-sm text-muted-foreground" data-testid="candidate-job">
              {mode === "off" ? "Approved, but downloading is off, so it waits. Use “Save now”, or turn downloading on in the settings." : "Approved. It downloads on the next pass."}
            </p>
          ) : null}
          {c.state === "expired" ? <p className="text-sm text-muted-foreground">Nobody acted on this in time. You can still approve it.</p> : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1">
          {c.state === "new" || c.state === "expired" || c.state === "dismissed" ? (
            <Button size="sm" variant="outline" onClick={() => onApprove(c)} disabled={busy} data-testid="candidate-approve"><Check aria-hidden="true" /> Approve<span className="sr-only"> {name}</span></Button>
          ) : null}
          {!final ? (
            <Button size="sm" variant="outline" onClick={() => onQueue(c)} disabled={busy} data-testid="candidate-queue"><Download aria-hidden="true" /> Save now<span className="sr-only"> {name}</span></Button>
          ) : null}
          {!final && c.state !== "dismissed" ? (
            <Button size="sm" variant="ghost" onClick={() => onDismiss(c)} disabled={busy} data-testid="candidate-dismiss"><X aria-hidden="true" /> Dismiss<span className="sr-only"> {name}</span></Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onToggleWhy} aria-expanded={open} aria-controls={`panel-${whyId}`} data-testid="candidate-why">
            <HelpCircle aria-hidden="true" /> Why suggested<span className="sr-only"> for {name}</span>
            <ChevronDown className={open ? "rotate-180" : ""} aria-hidden="true" />
          </Button>
        </div>
      </div>
      {open ? <WhyPanel id={c.id} listedScore={c.score} panelId={`panel-${whyId}`} headingId={`h-${whyId}`} /> : null}
    </li>
  );
}

export function CandidatesView() {
  const [passRunning, setPassRunning] = React.useState(false);
  const runner = useRunner(passRunning);
  const overview = useApi<Overview>("/api/discovery", { refreshInterval: shouldPoll(runner.data, passRunning) ? POLL_BUSY_MS : POLL_IDLE_MS });
  const { sources } = useSources();
  const { flat: collections } = useCollections();

  const [filters, setFilters] = React.useState<Filters>(DEFAULT_FILTERS);
  const [applied, setApplied] = React.useState<Filters>(DEFAULT_FILTERS);
  React.useEffect(() => {
    const t = setTimeout(() => setApplied(filters), 300);
    return () => clearTimeout(t);
  }, [filters]);

  const [items, setItems] = React.useState<Candidate[]>([]);
  const [counts, setCounts] = React.useState<Record<CandidateState, number> | null>(null);
  const [total, setTotal] = React.useState(0);
  const [next, setNext] = React.useState<string | undefined>();
  const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = React.useState("");
  const [loadingMore, setLoadingMore] = React.useState(false);
  const seq = React.useRef(0);
  const loaded = React.useRef(false);
  const pages = React.useRef(1);
  const headingRef = React.useRef<HTMLHeadingElement>(null);

  const load = React.useCallback(async (cursor?: string, quiet = false) => {
    const id = ++seq.current;
    // Only the first load replaces the list with a skeleton. A new filter keeps the rows on screen until the answer arrives, so a focused
    // button or an open "Why suggested" panel is not unmounted (and keyboard focus lost) by a refresh.
    if (!cursor && !quiet && !loaded.current) setStatus("loading");
    try {
      const r = await get<CandidateList>(`/api/discovery/candidates?${filtersToQuery(applied, cursor, PAGE)}`);
      if (id !== seq.current) return;
      loaded.current = true;
      setItems((cur) => (cursor ? [...cur, ...r.items] : r.items));
      if (!cursor) {
        const ids = new Set(r.items.map((i) => i.id));
        setOpenWhy((o) => (o && ids.has(o) ? o : null));
        setSelected((sel) => (sel.size && [...sel].some((x) => !ids.has(x)) ? new Set([...sel].filter((x) => ids.has(x))) : sel));
      }
      setCounts(r.counts);
      setTotal(r.total);
      setNext(r.nextCursor);
      pages.current = cursor ? pages.current + 1 : 1;
      setStatus("ready");
      setError("");
    } catch (e) {
      if (id !== seq.current) return;
      setError(errorMessage(e));
      if (!quiet || !cursor) setStatus((s) => (s === "ready" && quiet ? s : "error"));
    }
  }, [applied]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // While a pass is running or discovery downloads are in flight, refresh the first page (only when no further pages are loaded, so the
  // list under the reader's eyes does not jump). useApi stops the status polling while the tab is hidden; so does this.
  const busy = shouldPoll(runner.data, passRunning);
  React.useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible" && pages.current === 1) void load(undefined, true);
    }, POLL_BUSY_MS);
    return () => clearInterval(t);
  }, [busy, load]);

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [openWhy, setOpenWhy] = React.useState<string | null>(null);
  const [announce, setAnnounce] = React.useState("");
  const [working, setWorking] = React.useState(false);
  const [approveFor, setApproveFor] = React.useState<Target | null>(null);
  const [dismissFor, setDismissFor] = React.useState<Target | null>(null);
  const [failures, setFailures] = React.useState<{ id: string; error?: string }[]>([]);
  const [pickSource, setPickSource] = React.useState("");
  const [pickCollection, setPickCollection] = React.useState("");

  function refocusIfLost() {
    requestAnimationFrame(() => {
      const a = document.activeElement;
      if (!a || a === document.body || !a.isConnected) headingRef.current?.focus();
    });
  }

  async function reload() {
    await load(undefined, true);
    void overview.mutate();
    refocusIfLost();
  }

  const urlOf = (id: string) => items.find((i) => i.id === id)?.url ?? "";

  async function run(fn: () => Promise<string>) {
    setWorking(true);
    setFailures([]);
    try {
      setAnnounce(await fn());
    } catch (e) {
      setAnnounce(`That did not work. ${errorMessage(e)}`);
    } finally {
      setWorking(false);
      await reload();
    }
  }

  const approve = (t: Target) =>
    run(async () => {
      const body = { ...(pickSource ? { sourceId: pickSource } : {}), ...(pickCollection ? { collectionId: pickCollection } : {}) };
      if (t.ids.length === 1) {
        await post(`/api/discovery/candidates/${t.ids[0]}/approve`, body);
        return `Approved ${t.label}.`;
      }
      const r = await post<BulkResult>("/api/discovery/candidates/bulk", { ids: t.ids, action: "approve", ...body });
      setFailures(r.results.filter((x) => !x.ok));
      return `Approved ${r.done} of ${t.ids.length}${r.failed ? `. ${r.failed} could not be approved` : ""}.`;
    }).then(() => {
      setApproveFor(null);
      setSelected(new Set());
    });

  const queue = (ids: string[], label: string) =>
    run(async () => {
      if (ids.length === 1) {
        const r = await post<Candidate & { held?: boolean }>(`/api/discovery/candidates/${ids[0]}/queue`, {});
        return r.held ? `Started saving ${label}. It is held until the connection returns.` : `Started saving ${label}. It is in Downloads.`;
      }
      const r = await post<BulkResult>("/api/discovery/candidates/bulk", { ids, action: "queue" });
      setFailures(r.results.filter((x) => !x.ok));
      return `Started saving ${r.done} of ${ids.length}${r.failed ? `. ${r.failed} could not be started` : ""}.`;
    }).then(() => setSelected(new Set()));

  const dismiss = (t: Target) =>
    run(async () => {
      if (t.ids.length === 1) {
        await post(`/api/discovery/candidates/${t.ids[0]}/dismiss`);
        return `Dismissed ${t.label}. It will not be suggested again.`;
      }
      const r = await post<BulkResult>("/api/discovery/candidates/bulk", { ids: t.ids, action: "dismiss" });
      setFailures(r.results.filter((x) => !x.ok));
      return `Dismissed ${r.done} of ${t.ids.length}${r.failed ? `. ${r.failed} could not be dismissed` : ""}. They will not be suggested again.`;
    }).then(() => {
      setDismissFor(null);
      setSelected(new Set());
    });

  const startApprove = (t: Target) => {
    setPickSource("");
    setPickCollection("");
    setApproveFor(t);
  };

  const pageIds = items.map((i) => i.id);
  const allSelected = pageIds.length > 0 && pageIds.every((i) => selected.has(i));
  const someSelected = selected.size > 0;
  const mode = overview.data?.mode ?? runner.data?.mode;
  const ov = overview.data;
  const noun = (n: number) => (n === 1 ? "suggestion" : "suggestions");

  return (
    <>
      <PageHeader
        title="Discovery"
        description="Pages worth saving next, with the reasons. Nothing is downloaded until you approve it, unless you have allowed automatic downloads in the settings."
        actions={<RunPassButton onRunning={setPassRunning} onDone={() => void reload()} disabled={ov ? !ov.enabled : false} />}
      />

      <div className="mb-4 space-y-3">
        {ov && !ov.enabled ? (
          <Notice title="Discovery is off" testId="discovery-off">
            It is off by default, so nothing is collected, scored or downloaded. <Link href="/discovery/settings" className="underline underline-offset-2">Open the settings</Link> to switch it on.
          </Notice>
        ) : null}
        {ov?.killSwitch.paused ? (
          <Notice tone="warning" title="Discovery is paused" testId="discovery-paused">
            The kill switch is on, so no discovery download will start. <Link href="/discovery/budget" className="underline underline-offset-2">Open the runner panel</Link> to resume.
          </Notice>
        ) : null}
        {runner.data && ov?.enabled && !ov.killSwitch.paused ? (
          <p className="text-sm text-muted-foreground" data-testid="runner-line">
            {runnerHeadline(runner.data)} <Link href="/discovery/budget" className="underline underline-offset-2">Budget and runner</Link>
          </p>
        ) : null}
      </div>

      <section aria-label="Filters" className="mb-4 space-y-3 rounded-lg border p-4">
        <div role="group" aria-label="Show suggestions that are" className="flex flex-wrap gap-1.5" data-testid="state-filter">
          {([...STATE_ORDER, "all"] as (CandidateState | "all")[]).map((s) => {
            const on = filters.state === s;
            const n = s === "all" ? (counts ? Object.values(counts).reduce((a, b) => a + b, 0) : null) : (counts?.[s] ?? null);
            return (
              <Button key={s} size="sm" variant={on ? "default" : "outline"} aria-pressed={on} onClick={() => setFilters((f) => ({ ...f, state: s }))} data-testid={`state-${s}`}>
                {s === "all" ? "All" : STATE_LABEL[s]}
                {n != null ? <span className="tabular-nums opacity-80"> ({n})<span className="sr-only"> {noun(n)}</span></span> : null}
              </Button>
            );
          })}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="f-q">Address or title contains</Label>
            <Input id="f-q" value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="f-host">Site</Label>
            <Input id="f-host" value={filters.host} placeholder="example.org" onChange={(e) => setFilters((f) => ({ ...f, host: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="f-source">Source</Label>
            <Select id="f-source" value={filters.sourceId} onChange={(e) => setFilters((f) => ({ ...f, sourceId: e.target.value }))}>
              <option value="">Any source</option>
              {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="f-prov">Reason</Label>
            <Select id="f-prov" value={filters.provenance} onChange={(e) => setFilters((f) => ({ ...f, provenance: e.target.value }))}>
              <option value="">Any reason</option>
              {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="f-min">Lowest score</Label>
            <Input id="f-min" type="number" inputMode="decimal" value={filters.minScore} onChange={(e) => setFilters((f) => ({ ...f, minScore: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="f-max">Highest score</Label>
            <Input id="f-max" type="number" inputMode="decimal" value={filters.maxScore} onChange={(e) => setFilters((f) => ({ ...f, maxScore: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="f-sort">Order</Label>
            <Select id="f-sort" value={filters.sort} onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value }))}>
              {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </Select>
          </div>
          <div className="flex items-end">
            <Button variant="outline" onClick={() => setFilters(DEFAULT_FILTERS)} disabled={!filtersActive(filters) && filters.state === "new" && filters.sort === "score"}>Clear filters</Button>
          </div>
        </div>
      </section>

      <h2 ref={headingRef} tabIndex={-1} className="mb-2 text-lg font-semibold outline-none" data-testid="list-heading">
        Suggestions{status === "ready" ? <span className="ml-2 text-sm font-normal text-muted-foreground" data-testid="list-total">{total.toLocaleString("en-GB")} {noun(total)}</span> : null}
      </h2>
      <p role="status" className="mb-2 min-h-5 text-sm" data-testid="announce">{announce}</p>
      {failures.length ? (
        <div role="alert" className="mb-3 rounded-md border border-destructive/60 bg-destructive/10 p-3 text-sm" data-testid="bulk-failures">
          <p className="font-medium">These could not be changed:</p>
          <ul className="list-disc pl-5">{failures.map((f) => <li key={f.id} className="break-all">{urlOf(f.id) || f.id}: {f.error ?? "failed"}</li>)}</ul>
        </div>
      ) : null}

      {someSelected ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-3" role="group" aria-label="Actions for the selected suggestions" data-testid="bulk-bar">
          <span className="mr-2 text-sm" data-testid="bulk-count">{selected.size} selected</span>
          <Button size="sm" onClick={() => startApprove({ ids: [...selected], label: `${selected.size} ${noun(selected.size)}` })} disabled={working} data-testid="bulk-approve">Approve selected</Button>
          <Button size="sm" variant="outline" onClick={() => void queue([...selected], `${selected.size} ${noun(selected.size)}`)} disabled={working} data-testid="bulk-queue">Save selected now</Button>
          <Button size="sm" variant="outline" onClick={() => setDismissFor({ ids: [...selected], label: `${selected.size} ${noun(selected.size)}` })} disabled={working} data-testid="bulk-dismiss">Dismiss selected</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear selection</Button>
        </div>
      ) : null}

      {status === "loading" ? <LoadingSkeleton rows={5} label="Loading suggestions" /> : null}
      {status === "error" ? <ErrorState title="Couldn't load suggestions" message={error} onRetry={() => void load()} /> : null}
      {status === "ready" && items.length === 0 ? (
        filtersActive(applied) || applied.state !== "new" ? (
          <EmptyState title="No suggestions match" description="Try a different state or clear the filters." action={<Button variant="outline" onClick={() => setFilters(DEFAULT_FILTERS)}>Clear filters</Button>} />
        ) : ov && !ov.enabled ? (
          <EmptyState title="Nothing to review" description="Discovery is off, so there are no suggestions. Switch it on in the settings, and choose where suggestions may come from." action={<Link href="/discovery/settings" className="text-sm text-primary underline underline-offset-2">Open the settings</Link>} />
        ) : (
          <EmptyState title="Nothing to review" description="Suggestions appear as you save pages with link collection on, bookmark pages, or browse. Save a page and check again." />
        )
      ) : null}

      {status === "ready" && items.length > 0 ? (
        <>
          <div className="mb-2 flex items-center gap-2">
            <Checkbox id="select-all" checked={allSelected} onCheckedChange={(v) => setSelected(v === true ? new Set(pageIds) : new Set())} data-testid="select-all" />
            <Label htmlFor="select-all" className="font-normal">Select all {items.length} shown</Label>
          </div>
          <ul className="divide-y rounded-lg border" data-testid="candidate-list" aria-label="Suggestions">
            {items.map((c) => (
              <CandidateRow
                key={c.id}
                c={c}
                mode={mode}
                busy={working}
                selected={selected.has(c.id)}
                onSelect={(on) => setSelected((s) => { const n = new Set(s); if (on) n.add(c.id); else n.delete(c.id); return n; })}
                open={openWhy === c.id}
                onToggleWhy={() => setOpenWhy((o) => (o === c.id ? null : c.id))}
                onApprove={(x) => startApprove({ ids: [x.id], label: hostLabel(x.url) })}
                onQueue={(x) => void queue([x.id], hostLabel(x.url))}
                onDismiss={(x) => void dismiss({ ids: [x.id], label: hostLabel(x.url) })}
              />
            ))}
          </ul>
          {next ? (
            <div className="mt-3 flex items-center gap-3">
              <Button
                variant="outline"
                disabled={loadingMore}
                onClick={async () => {
                  setLoadingMore(true);
                  await load(next, true);
                  setLoadingMore(false);
                }}
                data-testid="load-more"
              >
                {loadingMore ? "Loading…" : "Show more"}
              </Button>
              <span className="text-sm text-muted-foreground">Showing {items.length.toLocaleString("en-GB")} of {total.toLocaleString("en-GB")}.</span>
            </div>
          ) : null}
        </>
      ) : null}

      <ConfirmDialog
        open={approveFor !== null}
        onOpenChange={(o) => !o && setApproveFor(null)}
        title={approveFor && approveFor.ids.length > 1 ? `Approve ${approveFor.label}?` : "Approve this suggestion?"}
        confirmLabel="Approve"
        busy={working}
        onConfirm={() => approveFor && void approve(approveFor)}
        testId="approve"
        description={
          <p>
            Approving lets discovery download {approveFor && approveFor.ids.length > 1 ? "these pages" : "this page"} on a later pass, within your limits. To save {approveFor && approveFor.ids.length > 1 ? "them" : "it"} straight away, use “Save now” instead.
            You can say where {approveFor && approveFor.ids.length > 1 ? "they" : "it"} should be filed, or leave both blank.
          </p>
        }
      >
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="approve-source">File under a source (optional)</Label>
            <Select id="approve-source" value={pickSource} onChange={(e) => setPickSource(e.target.value)}>
              <option value="">No preference</option>
              {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="approve-collection">Add to a collection once saved (optional)</Label>
            <Select id="approve-collection" value={pickCollection} onChange={(e) => setPickCollection(e.target.value)}>
              <option value="">No collection</option>
              {collections.map((c) => <option key={c.id} value={c.id}>{`${"– ".repeat(c.depth)}${c.name}`}</option>)}
            </Select>
          </div>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={dismissFor !== null}
        onOpenChange={(o) => !o && setDismissFor(null)}
        title={`Dismiss ${dismissFor?.label ?? ""}?`}
        confirmLabel="Dismiss"
        destructive
        busy={working}
        onConfirm={() => dismissFor && void dismiss(dismissFor)}
        testId="dismiss"
        description={<p>Dismissed suggestions are never suggested again. This does not delete anything you have saved.</p>}
      />
    </>
  );
}


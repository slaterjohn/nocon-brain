"use client";

import * as React from "react";
import Link from "next/link";
import { Tabs } from "radix-ui";
import { ArrowUpToLine, Ban, Clock, Download, Pause, Play, RotateCcw } from "lucide-react";
import { errorMessage, patch, post, useApi } from "@/lib/api";
import type { DownloadJob, DownloadState, Page, Priority, QueueSummary } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";
import { useEvents } from "@/components/layout/events";
import { FAILURE_COPY, KIND_LABEL, PRIORITIES, STATE_LABEL } from "@/lib/library-copy";
import { waitText } from "@/lib/storage";
import { cn, formatBytes, formatDate, formatDuration } from "@/lib/utils";

const TABS: DownloadState[] = ["queued", "running", "paused", "completed", "failed", "cancelled"];
const EMPTY_TEXT: Record<DownloadState, string> = {
  queued: "Nothing is waiting. Downloads you start are queued here before they run.",
  running: "Nothing is downloading right now.",
  paused: "No downloads are paused.",
  completed: "Nothing has finished yet.",
  failed: "No downloads have failed.",
  cancelled: "No downloads were cancelled.",
};
const PAUSE_WORDS: Record<string, string> = {
  user: "Paused by you.",
  window_closed: "Paused because the download window is closed. It resumes when the window opens.",
  volume_full: "Paused because a storage volume is low on space. It resumes when space is free.",
  offline: "Paused because there is no internet. It resumes when the connection returns.",
};

function stateVariant(s: DownloadState): "success" | "warning" | "destructive" | "secondary" {
  return s === "completed" ? "success" : s === "failed" ? "destructive" : s === "paused" || s === "running" ? "warning" : "secondary";
}

function range(low: number, high: number, fmt: (n: number) => string) {
  return low === high ? fmt(low) : `${fmt(low)} to ${fmt(high)}`;
}

function failureText(j: DownloadJob) {
  const f = j.failure;
  if (!f) return null;
  const known = FAILURE_COPY[f.code];
  return { message: known?.message ?? f.message, hint: f.hint || known?.hint || "", code: f.code, retryable: f.retryable };
}

function Row({ job, onChange }: { job: DownloadJob; onChange: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);
  const c = job.controls ?? {
    pause: job.state === "queued" || job.state === "running", resume: job.state === "paused", cancel: ["queued", "running", "paused"].includes(job.state),
    retry: job.state === "failed", setPriority: ["queued", "running", "paused"].includes(job.state),
  };
  const active = job.state === "running" || job.state === "queued" || job.state === "paused";
  const pct = job.progress.percent ?? (job.state === "completed" ? 100 : 0);
  const fail = failureText(job);

  async function act(action: "pause" | "resume" | "cancel" | "retry") {
    setBusy(action);
    try {
      await post(`/api/downloads/${job.id}/${action}`);
      onChange();
    } catch (e) {
      toast({ title: `Couldn't ${action} that download`, description: errorMessage(e), variant: "error" });
    } finally {
      setBusy(null);
    }
  }
  async function setPriority(p: Priority) {
    try {
      await patch(`/api/downloads/${job.id}`, { priority: p });
      onChange();
    } catch (e) {
      toast({ title: "Couldn't change the priority", description: errorMessage(e), variant: "error" });
    }
  }
  async function toTop() {
    try {
      await patch(`/api/downloads/${job.id}`, { queueOrder: "top" });
      toast({ title: "Moved to the front of its priority", description: job.title });
      onChange();
    } catch (e) {
      toast({ title: "Couldn't reorder it", description: errorMessage(e), variant: "error" });
    }
  }

  const est = job.estimate;
  return (
    <li className="space-y-3 p-4" data-testid="download-row" data-state={job.state} data-id={job.id}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium" data-testid="download-title">{job.title}</span>
            <Badge variant={stateVariant(job.state)} data-testid="download-state">{STATE_LABEL[job.state]}</Badge>
            <Badge variant="outline">{KIND_LABEL[job.kind] ?? job.kind}</Badge>
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            {job.requestedUrl ? <span className="break-all">{job.requestedUrl}</span> : null}
            {job.sourceId && job.sourceName ? <Link href={`/library/sources/${job.sourceId}`} className="underline underline-offset-2">{job.sourceName}</Link> : null}
            <span>Started by {job.requestedBy === "user" ? "you" : job.requestedBy === "schedule" ? "a schedule" : job.requestedBy}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {c.pause ? <Button size="sm" variant="outline" onClick={() => void act("pause")} disabled={busy !== null} data-testid="dl-pause"><Pause aria-hidden="true" /> Pause<span className="sr-only"> {job.title}</span></Button> : null}
          {c.resume ? <Button size="sm" variant="outline" onClick={() => void act("resume")} disabled={busy !== null} data-testid="dl-resume"><Play aria-hidden="true" /> Resume<span className="sr-only"> {job.title}</span></Button> : null}
          {c.retry && job.failure?.retryable !== false ? <Button size="sm" variant="outline" onClick={() => void act("retry")} disabled={busy !== null} data-testid="dl-retry"><RotateCcw aria-hidden="true" /> Retry<span className="sr-only"> {job.title}</span></Button> : null}
          {job.state === "queued" ? <Button size="sm" variant="ghost" onClick={() => void toTop()} data-testid="dl-top"><ArrowUpToLine aria-hidden="true" /> Move to front<span className="sr-only"> {job.title}</span></Button> : null}
          {c.cancel ? <Button size="sm" variant="ghost" onClick={() => void act("cancel")} disabled={busy !== null} data-testid="dl-cancel"><Ban aria-hidden="true" /> Cancel<span className="sr-only"> {job.title}</span></Button> : null}
        </div>
      </div>

      {active ? (
        <div className="space-y-1">
          <Progress value={pct} label={`Progress of ${job.title}`} />
          <p className="text-sm" data-testid="download-progress">
            {job.progress.label ?? (job.state === "queued" ? "Waiting to start" : job.state === "paused" ? "Paused" : "Downloading")}
            {" · "}{job.progress.pagesDone} {job.progress.pagesDone === 1 ? "page" : "pages"} saved
            {job.progress.pagesFailed ? `, ${job.progress.pagesFailed} failed` : ""}
            {" · "}{formatBytes(job.progress.bytesDone)}
            {job.progress.etaSeconds != null ? ` · about ${formatDuration(job.progress.etaSeconds)} left` : ""}
          </p>
        </div>
      ) : (
        <p className="text-sm" data-testid="download-summary">
          {job.state === "completed" ? "Saved" : job.state === "cancelled" ? "Cancelled" : ""}
          {job.state !== "failed" ? ` · ${job.progress.pagesDone} ${job.progress.pagesDone === 1 ? "page" : "pages"} · ${formatBytes(job.progress.bytesDone)}` : null}
          {job.finishedAt ? ` · ${formatDate(job.finishedAt)}` : ""}
        </p>
      )}

      {est && (est.bytes || est.pages) ? (
        <p className="text-xs text-muted-foreground" data-testid="download-estimate">
          Estimated storage{est.bytes ? `: ${range(est.bytes.low, est.bytes.high, (n) => formatBytes(n, 0))}` : ""}
          {est.pages ? `, ${range(est.pages.low, est.pages.high, (n) => n.toLocaleString("en-GB"))} pages` : ""}
          . This is an estimate, not a measurement ({est.basis}).
        </p>
      ) : null}
      {job.wait ? <p className="text-sm text-warning" data-testid="download-wait" data-reason={job.wait.reason}>{waitText(job.wait)} <Link href="/storage/policy" className="underline underline-offset-2">Storage policy</Link></p> : null}
      {job.pause ? <p className="text-sm text-muted-foreground" data-testid="download-pause">{PAUSE_WORDS[job.pause.reason] ?? job.pause.message}</p> : null}
      {job.stop && job.state === "completed" ? <p className="text-sm text-muted-foreground">{job.stop.message}</p> : null}
      {job.summary ? <p className="text-sm text-muted-foreground">Checked {job.summary.checked} pages: {job.summary.changed} changed, {job.summary.unchanged} unchanged, {job.summary.gone} gone, {job.summary.failed} failed.</p> : null}

      {fail ? (
        <div className="rounded-md border border-destructive/60 p-3 text-sm" data-testid="download-failure">
          <p className="font-medium">{fail.message}</p>
          {fail.hint ? <p className="text-muted-foreground">{fail.hint}</p> : null}
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-muted-foreground">Details</summary>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-xs text-muted-foreground">
              <dt>Code</dt><dd data-testid="failure-code">{fail.code}</dd>
              <dt>Server message</dt><dd>{job.failure?.message}</dd>
              <dt>Retry</dt><dd>{fail.retryable ? "Retrying may help." : "Retrying is unlikely to help."}</dd>
              {job.attempts ? (<><dt>Retries so far</dt><dd>{job.attempts}</dd></>) : null}
            </dl>
          </details>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        {c.setPriority ? (
          <span className="flex items-center gap-1.5">
            <Label htmlFor={`prio-${job.id}`} className="text-xs font-normal">Priority<span className="sr-only"> of {job.title}</span></Label>
            <Select id={`prio-${job.id}`} className="h-7 w-auto py-0 text-xs" value={job.priority} onChange={(e) => void setPriority(e.target.value as Priority)} data-testid="dl-priority">
              {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </Select>
          </span>
        ) : (
          <span>Priority {PRIORITIES.find((p) => p.value === job.priority)?.label}</span>
        )}
        <span>Added {formatDate(job.createdAt)}</span>
        {job.scheduledFor && job.state === "queued" ? <span>Scheduled for {formatDate(job.scheduledFor)}</span> : null}
      </div>
    </li>
  );
}

/** Downloads by state, with live progress from the server-sent events stream and a status line for the download window. */
export function DownloadsView() {
  const { subscribeDownloads, stream, connectivity } = useEvents();
  const queue = useApi<QueueSummary>("/api/downloads/queue", { refreshInterval: 20000 });
  const [tab, setTab] = React.useState<DownloadState | null>(null);
  const [live, setLive] = React.useState<Record<string, DownloadJob>>({});
  const [announce, setAnnounce] = React.useState("");
  const prevState = React.useRef<Record<string, DownloadState>>({});
  const current = tab ?? (queue.data ? (TABS.find((t) => t !== "cancelled" && t !== "completed" && queue.data!.counts[t] > 0) ?? "completed") : "running");
  const list = useApi<Page<DownloadJob>>(`/api/downloads?state=${current}&limit=100`);
  const refetchTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const listMutate = list.mutate;
  const queueMutate = queue.mutate;
  const refetchSoon = React.useCallback(() => {
    if (refetchTimer.current) return;
    refetchTimer.current = setTimeout(() => {
      refetchTimer.current = null;
      void listMutate();
      void queueMutate();
    }, 600);
  }, [listMutate, queueMutate]);

  React.useEffect(() => {
    return subscribeDownloads((e) => {
      if (e.type === "reconnected") {
        setLive({});
        void listMutate();
        void queueMutate();
        return;
      }
      if (e.type === "download.queue") {
        void queueMutate();
        return;
      }
      const d = e.download;
      setLive((m) => ({ ...m, [d.id]: d }));
      const before = prevState.current[d.id];
      if (before !== d.state) {
        prevState.current[d.id] = d.state;
        if (before !== undefined || d.state === "failed" || d.state === "completed") {
          setAnnounce(`${d.title}: ${STATE_LABEL[d.state].toLowerCase()}.`);
        }
        refetchSoon();
      }
    });
  }, [subscribeDownloads, listMutate, queueMutate, refetchSoon]);

  // Live updates win over the last fetch. A job whose live state is a different tab leaves this one.
  const items = React.useMemo(() => {
    const byId = new Map<string, DownloadJob>();
    for (const j of list.data?.items ?? []) byId.set(j.id, j);
    for (const j of Object.values(live)) if (j.state === current || byId.has(j.id)) byId.set(j.id, j);
    return [...byId.values()].filter((j) => (live[j.id]?.state ?? j.state) === current).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [list.data, live, current]);

  const counts = queue.data?.counts;
  const q = queue.data;

  return (
    <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
      <PageHeader title="Downloads" description="Pages being saved, queued or finished. Progress updates by itself." />

      <section aria-label="Download status" className="mb-5 grid gap-3 sm:grid-cols-2" data-testid="download-status">
        <div className="flex items-start gap-3 rounded-lg border p-3 text-sm" data-testid="window-status">
          <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div>
            <p className="font-medium">
              {q ? (q.window.open ? "Download window: open" : "Download window: closed") : "Download window"}
            </p>
            <p className="text-muted-foreground">
              {q
                ? q.window.open
                  ? q.window.closesAt ? `Scheduled downloads can run until ${formatDate(q.window.closesAt)}.` : "No window is set, so downloads can run at any time."
                  : `Scheduled downloads wait${q.window.opensAt ? ` until ${formatDate(q.window.opensAt)}` : ""}. Downloads you start yourself still run.`
                : "Checking…"}
            </p>
            {q?.nextScheduled ? <p className="text-muted-foreground">Next scheduled run: {q.nextScheduled.sourceName}, {formatDate(q.nextScheduled.at)}.</p> : null}
          </div>
        </div>
        <div className="flex items-start gap-3 rounded-lg border p-3 text-sm">
          <Download className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div>
            <p className="font-medium">{counts ? `${counts.running} running, ${counts.queued} queued` : "Queue"}</p>
            {q?.disk.paused ? <p className="text-warning">Background downloads are paused because a storage volume is low on space.</p> : null}
            {q?.storageThrottle?.downloads ? <p className="text-warning" data-testid="storage-throttle">{q.storageThrottle.downloads} background {q.storageThrottle.downloads === 1 ? "download is" : "downloads are"} waiting because storage is nearly full.</p> : null}
            {q?.throttle.active ? <p className="text-muted-foreground">Downloads are slowed because the machine is busy.</p> : null}
            {(q?.connectivity ?? connectivity) === "offline" ? <p className="text-muted-foreground">There is no internet. Downloads wait until it returns.</p> : null}
            {stream === "lost" ? <p className="text-warning">Live updates have stopped. Reload the page to restart them.</p> : null}
            {!q?.disk.paused && !q?.storageThrottle?.downloads && !q?.throttle.active && (q?.connectivity ?? connectivity) !== "offline" && stream !== "lost" ? <p className="text-muted-foreground">Everything is working normally.</p> : null}
          </div>
        </div>
      </section>

      <Tabs.Root value={current} onValueChange={(v) => setTab(v as DownloadState)}>
        <Tabs.List aria-label="Downloads by state" className="relative mb-4 flex gap-1 overflow-x-auto border-b">
          {TABS.map((t) => (
            <Tabs.Trigger
              key={t}
              value={t}
              data-testid={`tab-${t}`}
              className={cn("-mb-px border-b-2 border-transparent px-3 py-2 text-sm whitespace-nowrap text-muted-foreground hover:text-foreground data-[state=active]:border-primary data-[state=active]:font-medium data-[state=active]:text-foreground")}
            >
              {STATE_LABEL[t]}
              {counts ? <span className="ml-1.5 rounded-full bg-secondary px-1.5 py-0.5 text-xs tabular-nums" data-testid={`count-${t}`}>{counts[t]}<span className="sr-only"> downloads</span></span> : null}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value={current} className="rounded-md">
          {list.isLoading ? <LoadingSkeleton label="Loading downloads" /> : null}
          {list.error ? <ErrorState title="Couldn't load downloads" message={list.error.message} onRetry={() => void list.mutate()} /> : null}
          {list.data && items.length === 0 ? <EmptyState icon={Download} title={`No ${STATE_LABEL[current].toLowerCase()} downloads`} description={EMPTY_TEXT[current]} /> : null}
          {items.length > 0 ? (
            <ul className="divide-y rounded-lg border" aria-label={`${STATE_LABEL[current]} downloads`}>
              {items.map((j) => <Row key={j.id} job={j} onChange={() => { void list.mutate(); void queue.mutate(); }} />)}
            </ul>
          ) : null}
        </Tabs.Content>
      </Tabs.Root>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="download-announcer">{announce}</div>
    </div>
  );
}

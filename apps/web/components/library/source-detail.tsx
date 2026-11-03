"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pencil, Trash2 } from "lucide-react";
import { useApi } from "@/lib/api";
import type { Page, Source, SourcePageRow, SourceStats } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Breadcrumb } from "@/components/common/breadcrumb";
import { ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";
import { describeRetention, describeSchedule, describeWindow, sourceStatus } from "@/lib/describe";
import { FAILURE_COPY, MODES, PROFILES, STATE_LABEL, priorityLabel, typeLabel } from "@/lib/library-copy";
import { formatBytes, formatDate } from "@/lib/utils";
import { LibraryNav } from "./library-nav";
import { DeleteSourceDialog, EnableButton, RunButtons, useSourceActions } from "./source-actions";
import { useCollections } from "./hooks";
import { PackageSourcePanel } from "@/components/zim/package-source";

function Stat({ label, value, note }: { label: string; value: React.ReactNode; note?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums">{value}</dd>
      {note ? <dd className="text-xs text-muted-foreground">{note}</dd> : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-4">
      <dt className="w-44 shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-sm">{children}</dd>
    </div>
  );
}

export function SourceDetailView({ id }: { id: string }) {
  const router = useRouter();
  // The source itself is polled while it runs, so the badge leaves "Running" on its own when the downloads end (a slow machine
  // can still be indexing an import when the page opens).
  const [polling, setPolling] = React.useState(false);
  const src = useApi<Source>(`/api/sources/${id}`, { refreshInterval: polling ? 2500 : undefined });
  const running = src.data?.lastStatus === "running";
  React.useEffect(() => setPolling(running), [running]);
  const kp = src.data?.type === "knowledge_package";
  const stats = useApi<SourceStats>(`/api/sources/${id}/stats`, { refreshInterval: running ? 4000 : undefined, enabled: !kp });
  const [limit, setLimit] = React.useState(25);
  const pages = useApi<Page<SourcePageRow>>(`/api/sources/${id}/pages?limit=${limit}`, { refreshInterval: running ? 6000 : undefined, enabled: !kp });
  const cols = useCollections();
  const actions = useSourceActions(() => { void src.mutate(); void stats.mutate(); void pages.mutate(); });
  const [deleting, setDeleting] = React.useState(false);
  const opener = React.useRef<HTMLElement | null>(null);

  if (src.isLoading) return <div className="mx-auto w-full max-w-5xl p-4 sm:p-6"><LoadingSkeleton variant="page" label="Loading the source" /></div>;
  if (src.error || !src.data) {
    return (
      <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
        <LibraryNav />
        <ErrorState title={src.error?.status === 404 ? "This source no longer exists" : "Couldn't load this source"} message={src.error?.message} onRetry={src.error?.status === 404 ? undefined : () => void src.mutate()} />
      </div>
    );
  }
  const s = src.data;
  const st = sourceStatus(s);
  const s2 = stats.data;

  return (
    <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
      <Breadcrumb items={[{ label: "Library", href: "/library" }, { label: "Sources", href: "/library/sources" }, { label: s.name }]} />
      <PageHeader
        title={s.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant={st.variant} data-testid="source-status">{st.label}</Badge>
            <span>{s.system ? "Built-in source" : typeLabel(s.type)}</span>
            {s.startUrl ? <span className="break-all">{s.startUrl}</span> : null}
          </span>
        }
        actions={
          <>
            {s.system || kp ? null : <RunButtons s={s} actions={actions} size="default" />}
            <EnableButton s={s} actions={actions} size="default" />
            {kp ? null : <Button asChild variant="outline"><Link href={`/library/sources/${s.id}/edit`} data-testid="edit-source"><Pencil aria-hidden="true" /> Edit<span className="sr-only"> {s.name}</span></Link></Button>}
            {s.system ? null : <Button variant="ghost" onClick={(e) => { opener.current = e.currentTarget; setDeleting(true); }} data-testid="delete-source"><Trash2 aria-hidden="true" /> Delete<span className="sr-only"> {s.name}</span></Button>}
          </>
        }
      />
      <LibraryNav />

      {kp ? null : <section aria-labelledby="stats-h" className="mb-8">
        <h2 id="stats-h" className="mb-2 text-lg font-semibold">Statistics</h2>
        {stats.isLoading ? <LoadingSkeleton rows={2} label="Loading statistics" /> : null}
        {stats.error ? <ErrorState title="Couldn't load statistics" message={stats.error.message} onRetry={() => void stats.mutate()} /> : null}
        {s2 ? (
          <>
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="source-stats">
              <Stat label="Pages" value={s2.pages} />
              <Stat label="Versions kept" value={s2.versions} />
              <Stat label="Size of the latest versions" value={formatBytes(s2.latestBytes)} />
              <Stat label="Failed runs" value={s2.failedRuns} note={s2.lastRunAt ? `Last run ${formatDate(s2.lastRunAt)}` : "Never run"} />
            </dl>
            {s2.byPriority.length ? (
              <p className="mt-3 text-sm text-muted-foreground" data-testid="stats-priority">
                Pages by priority: {s2.byPriority.map((b) => `${priorityLabel(b.priority)} ${b.pages}`).join(", ")}.
              </p>
            ) : null}
          </>
        ) : null}
      </section>}

      {kp ? null : <section aria-labelledby="runs-h" className="mb-8">
        <h2 id="runs-h" className="mb-2 text-lg font-semibold">Recent runs</h2>
        {s2 && s2.lastRuns.length === 0 ? <p className="text-sm text-muted-foreground">This source has not run yet.{s.system ? "" : " Choose Run now to start it."}</p> : null}
        {s2 && s2.lastRuns.length > 0 ? (
          <Table aria-label="Recent runs">
            <caption className="sr-only">Recent runs of this source</caption>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Pages saved</TableHead>
                <TableHead className="text-right">Failed</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {s2.lastRuns.map((r) => (
                <TableRow key={r.id} data-testid="run-row">
                  <TableCell className="whitespace-nowrap">{formatDate(r.startedAt ?? r.createdAt)}</TableCell>
                  <TableCell>{STATE_LABEL[r.state] ?? r.state}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.pagesDone}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.pagesFailed}</TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">{formatBytes(r.bytesDone)}</TableCell>
                  <TableCell className="max-w-xs text-sm">
                    {r.failure ? (
                      <>
                        {(r.failure.code && FAILURE_COPY[r.failure.code]?.message) || r.failure.message}
                        {r.failure.code ? <span className="block text-xs text-muted-foreground">Code: {r.failure.code}</span> : null}
                      </>
                    ) : "–"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </section>}

      <section aria-labelledby="settings-h" className="mb-8">
        <h2 id="settings-h" className="mb-2 text-lg font-semibold">Settings</h2>
        <dl className="divide-y rounded-lg border px-4" data-testid="source-settings">
          {s.description ? <Row label="Description">{s.description}</Row> : null}
          {!s.system && !kp ? <Row label="Mode">{MODES.find((m) => m.value === s.strategy)?.label ?? s.strategy}</Row> : null}
          {!s.system && !kp && s.type !== "single_page" ? <Row label="Amount">{PROFILES.find((p) => p.value === s.profile)?.label ?? s.profile}: {s.config.maxPages.toLocaleString("en-GB")} pages, {s.config.depth} links deep, up to {formatBytes(s.config.maxBytes, 0)}</Row> : null}
          {kp ? null : <Row label="Runs">{describeSchedule(s.schedule)}</Row>}
          {!kp && s.schedule?.window ? <Row label="Download window">{describeWindow(s.schedule.window)}</Row> : null}
          {kp ? null : <Row label="Next run">{s.paused || !s.enabled ? "Not scheduled" : s.nextRunAt ? formatDate(s.nextRunAt) : "None planned"}</Row>}
          <Row label="Priority">{priorityLabel(s.priority)}</Row>
          {kp ? null : <Row label="Retention">{describeRetention(s.retention)}</Row>}
          <Row label="Automatic removal">{kp || s.priority === "P1" ? "Never. Packages are removed only by hand." : s.automaticEviction ? "Allowed when space runs short" : "Not allowed"}</Row>
          {s.storageBudgetBytes ? <Row label="Storage budget">{formatBytes(s.storageBudgetBytes)}</Row> : null}
          {s.collections.length ? <Row label="Collections">{s.collections.map((c) => cols.byId.get(c)?.name ?? "A collection").join(", ")}</Row> : null}
        </dl>
      </section>

      {kp ? <PackageSourcePanel source={s} /> : null}
      {kp ? null : <section aria-labelledby="pages-h">
        <h2 id="pages-h" className="mb-2 text-lg font-semibold">Pages from this source</h2>
        {pages.isLoading ? <LoadingSkeleton rows={3} label="Loading pages" /> : null}
        {pages.data && pages.data.items.length === 0 ? <p className="text-sm text-muted-foreground" data-testid="source-no-pages">No pages yet.</p> : null}
        {pages.data && pages.data.items.length > 0 ? (
          <>
            <Table aria-label="Pages from this source">
              <caption className="sr-only">Pages saved from this source</caption>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Site</TableHead>
                  <TableHead className="text-right">Depth</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Last seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pages.data.items.map((p) => (
                  <TableRow key={p.pageId} data-testid="source-page-row">
                    <TableCell className="max-w-sm">
                      <Link href={`/library/pages/${p.pageId}`} className="block truncate font-medium text-primary underline-offset-4 hover:underline">{p.title || p.url}</Link>
                      <div className="truncate text-xs text-muted-foreground">{p.url}</div>
                    </TableCell>
                    <TableCell>{p.host}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.depth ?? "–"}</TableCell>
                    <TableCell>{priorityLabel(p.effectivePriority)}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatDate(p.lastSeenAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="mt-2 text-sm text-muted-foreground" role="status">Showing {pages.data.items.length} of {pages.data.total ?? pages.data.items.length}.</p>
            {pages.data.nextCursor ? <div className="mt-2"><Button variant="outline" onClick={() => setLimit((n) => n + 25)}>Show more</Button></div> : null}
          </>
        ) : null}
      </section>}

      <DeleteSourceDialog source={deleting ? s : null} opener={opener} onClose={() => setDeleting(false)} onDeleted={() => router.push("/library/sources")} />
    </div>
  );
}

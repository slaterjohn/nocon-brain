"use client";

import * as React from "react";
import { useApi } from "@/lib/api";
import type { Dashboard, WorkerStatus } from "@/lib/types";
import { formatBytes, formatDate, timeAgo } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";

const WORKER_LABEL: Record<WorkerStatus["name"], string> = {
  runner: "Job runner",
  extract: "Text extraction",
  index: "Search index",
  search: "Search",
  zim: "ZIM reader",
  renderer: "Page renderer",
};

const WORKER_VARIANT: Record<WorkerStatus["state"], "success" | "warning" | "destructive" | "secondary"> = {
  idle: "success",
  busy: "success",
  down: "destructive",
  disabled: "secondary",
};

const WORKER_TEXT: Record<WorkerStatus["state"], string> = { idle: "Idle", busy: "Busy", down: "Not running", disabled: "Off" };

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-1">
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        {hint ? <span className="mt-1 block text-xs text-muted-foreground">{hint}</span> : null}
      </dd>
    </div>
  );
}

export function DashboardView() {
  const { data, error, isLoading, mutate } = useApi<Dashboard>("/api/system/dashboard", { refreshInterval: 10_000 });

  return (
    <>
      <PageHeader title="Dashboard" description="How the server, storage and queue are doing right now. This page refreshes every 10 seconds." />
      {error && !data ? (
        <ErrorState title="Couldn't load the dashboard" message={error.message} onRetry={() => void mutate()} />
      ) : isLoading || !data ? (
        <LoadingSkeleton variant="cards" rows={4} label="Loading the dashboard" />
      ) : (
        <div className="space-y-6">
          {error ? <ErrorState title="Couldn't refresh" message={`${error.message} Showing the last data received.`} onRetry={() => void mutate()} /> : null}
          <section aria-labelledby="jobs-h">
            <h2 id="jobs-h" className="mb-2 text-lg font-semibold">Jobs</h2>
            <dl className="grid gap-3 sm:grid-cols-3">
              <Stat label="Running" value={data.jobs.active} />
              <Stat label="Waiting" value={data.jobs.queued} />
              <Stat label="Failed in the last 24 hours" value={data.jobs.failedLast24h} />
            </dl>
          </section>

          <section aria-labelledby="storage-h">
            <h2 id="storage-h" className="mb-2 text-lg font-semibold">Storage</h2>
            <StorageCard storage={data.storage} />
          </section>

          <section aria-labelledby="workers-h">
            <h2 id="workers-h" className="mb-2 text-lg font-semibold">Workers</h2>
            {data.workers.length === 0 ? (
              <EmptyState title="No workers reported" description="The server hasn't reported any workers yet. Check the activity log if this persists." />
            ) : (
              <Table aria-label="Worker status">
                <TableHeader>
                  <TableRow>
                    <TableHead>Worker</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last heartbeat</TableHead>
                    <TableHead className="text-right">Memory</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.workers.map((w) => (
                    <TableRow key={w.name}>
                      <TableCell className="font-medium">{WORKER_LABEL[w.name] ?? w.name}</TableCell>
                      <TableCell>
                        <Badge variant={WORKER_VARIANT[w.state]}>{WORKER_TEXT[w.state]}</Badge>
                      </TableCell>
                      <TableCell>{w.lastHeartbeatAt ? timeAgo(w.lastHeartbeatAt) : "None yet"}</TableCell>
                      <TableCell className="text-right tabular-nums">{w.memoryMb != null ? `${Math.round(w.memoryMb)} MB` : "–"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>

          <section aria-labelledby="archive-h">
            <h2 id="archive-h" className="mb-2 text-lg font-semibold">Archive</h2>
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Pages" value={data.pages.total} hint={`${data.pages.archived} saved, ${data.pages.partial} partial`} />
              <Stat label="Sources" value={data.sources.total} hint={`${data.sources.enabled} enabled`} />
              <Stat label="Collections" value={data.collections} />
              <Stat label="Search index" value={data.index.state === "ok" ? "Ready" : data.index.state === "rebuilding" ? "Rebuilding" : "Missing"} hint={`${data.index.docs} documents, ${formatBytes(data.index.sizeBytes)}`} />
            </dl>
            <p className="mt-3 text-sm text-muted-foreground" data-testid="last-update">
              Last update: {data.lastUpdateAt ? `${formatDate(data.lastUpdateAt)} (${timeAgo(data.lastUpdateAt)})` : "Nothing has been archived yet."}
            </p>
          </section>
        </div>
      )}
    </>
  );
}

function StorageCard({ storage }: { storage: Dashboard["storage"] }) {
  const total = storage.usedBytes + storage.availableBytes;
  const pct = total > 0 ? (storage.usedBytes / total) * 100 : 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{formatBytes(storage.usedBytes)} used, {formatBytes(storage.availableBytes)} available</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <Progress value={pct} label="Storage used" />
        <p className="text-sm text-muted-foreground">
          {total > 0 ? `${pct.toFixed(1)}% of ${formatBytes(total)} used.` : "No storage volume is registered yet."}
        </p>
      </CardContent>
    </Card>
  );
}

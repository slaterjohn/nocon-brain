"use client";

import * as React from "react";
import { Download } from "lucide-react";
import { useApi } from "@/lib/api";
import type { CaptureProgress } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";
import { useEvents } from "@/components/layout/events";

/** Recent single-page saves and where each one is. Crawls and sources arrive in a later release. */
export function DownloadsView() {
  const { captures } = useEvents();
  const list = useApi<{ items: CaptureProgress[] }>("/api/archive/captures", { refreshInterval: 15000 });
  // Live events win over the last fetched list.
  const items = (list.data?.items ?? []).map((i) => captures[i.downloadId] ?? i);
  for (const c of Object.values(captures)) if (!items.some((i) => i.downloadId === c.downloadId)) items.unshift(c);
  return (
    <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
      <PageHeader title="Downloads" description="Pages being saved, and the ones saved recently." />
      {list.isLoading ? <LoadingSkeleton label="Loading downloads" /> : null}
      {list.error ? <ErrorState title="Couldn't load downloads" message={list.error.message} onRetry={() => void list.mutate()} /> : null}
      {list.data && items.length === 0 ? <EmptyState icon={Download} title="No downloads" description="Pages you save for offline are listed here while they are saved." /> : null}
      {items.length > 0 ? (
        <ul className="divide-y rounded-lg border" aria-label="Downloads">
          {items.map((c) => (
            <li key={c.downloadId} className="flex flex-wrap items-center gap-3 p-3" data-testid="download-row" data-state={c.state}>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{c.url}</div>
                <div className="text-sm text-muted-foreground">{c.state === "failed" ? `${c.label}. ${c.failureMessage ?? ""}` : c.label}</div>
              </div>
              {c.state === "running" || c.state === "queued" ? <Progress value={c.percent} label={`Progress for ${c.url}`} className="w-32" /> : null}
              <Badge variant={c.state === "completed" ? "success" : c.state === "failed" ? "destructive" : "secondary"}>
                {c.state === "completed" ? "Saved" : c.state === "failed" ? "Failed" : c.held ? "Queued" : c.state === "running" ? "Saving" : "Waiting"}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

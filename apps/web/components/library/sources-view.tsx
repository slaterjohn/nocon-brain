"use client";

import * as React from "react";
import Link from "next/link";
import { Globe } from "lucide-react";
import { api } from "@/lib/api";
import type { SourceStats } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";
import { describeSchedule, sourceStatus } from "@/lib/describe";
import { typeLabel, priorityLabel } from "@/lib/library-copy";
import { formatBytes, formatDate } from "@/lib/utils";
import { LibraryNav } from "./library-nav";
import { useSources } from "./hooks";
import { EnableButton, NewSourceLink, RunButtons, useSourceActions } from "./source-actions";

function whenText(iso: string | null, empty: string) {
  return iso ? formatDate(iso) : empty;
}

/** Sources with status, last run, next run, pages, size and priority. */
export function SourcesView() {
  const list = useSources();
  const actions = useSourceActions(() => void list.mutate());
  const [sizes, setSizes] = React.useState<Record<string, number>>({});
  const [runs, setRuns] = React.useState<Record<string, { at?: string | null }>>({});

  React.useEffect(() => {
    let live = true;
    for (const s of list.sources) {
      api<SourceStats>(`/api/sources/${s.id}/stats`)
        .then((st) => {
          if (!live) return;
          setSizes((m) => ({ ...m, [s.id]: st.latestBytes }));
          setRuns((m) => ({ ...m, [s.id]: { at: st.lastRunAt ?? st.lastRuns[0]?.finishedAt ?? st.lastRuns[0]?.createdAt } }));
        })
        .catch(() => {});
    }
    return () => { live = false; };
  }, [list.sources]);

  return (
    <div className="mx-auto w-full max-w-6xl p-4 sm:p-6">
      <PageHeader title="Library" description="Pages you have saved. They open without internet." />
      <LibraryNav />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Sources</h2>
          <p className="text-sm text-muted-foreground">A source says what to save, how deep to go, how often to check it and how much it matters.</p>
        </div>
        <NewSourceLink />
      </div>
      {list.isLoading ? <LoadingSkeleton label="Loading sources" /> : null}
      {list.error ? <ErrorState title="Couldn't load sources" message={list.error.message} onRetry={() => void list.mutate()} /> : null}
      {list.data && list.sources.length === 0 ? <EmptyState icon={Globe} title="No sources yet" description="Create a source to save a site, a section, a sitemap or a feed." action={<NewSourceLink />} /> : null}
      {list.sources.length > 0 ? (
        <Table aria-label="Sources">
          <caption className="sr-only">Sources, with status, last run, next run, pages, size and priority</caption>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last run</TableHead>
              <TableHead>Next run</TableHead>
              <TableHead className="text-right">Pages</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.sources.map((s) => {
              const st = sourceStatus(s);
              return (
                <TableRow key={s.id} data-testid="source-row" data-name={s.name}>
                  <TableCell className="max-w-xs">
                    <Link href={`/library/sources/${s.id}`} className="block truncate font-medium text-primary underline-offset-4 hover:underline">{s.name}</Link>
                    <div className="truncate text-xs text-muted-foreground">
                      {s.system ? "Built in" : typeLabel(s.type)}{s.startUrl ? ` · ${s.startUrl}` : ""}
                    </div>
                  </TableCell>
                  <TableCell><Badge variant={st.variant} data-testid="source-status">{st.label}</Badge></TableCell>
                  <TableCell className="whitespace-nowrap">{whenText(s.lastRunAt ?? runs[s.id]?.at ?? null, "Never")}</TableCell>
                  <TableCell className="whitespace-nowrap">{s.paused || !s.enabled ? "Not scheduled" : s.nextRunAt ? formatDate(s.nextRunAt) : describeSchedule(s.schedule) === "Only when you run it" ? "Manual" : "Not scheduled"}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.pageCount}</TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">{sizes[s.id] !== undefined ? formatBytes(sizes[s.id]) : "–"}</TableCell>
                  <TableCell className="whitespace-nowrap">{priorityLabel(s.priority)}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap justify-end gap-1">
                      {s.system ? null : <RunButtons s={s} actions={actions} />}
                      <EnableButton s={s} actions={actions} />
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : null}
    </div>
  );
}

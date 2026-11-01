"use client";

import * as React from "react";
import { ApiError, api } from "@/lib/api";
import { LOG_AREAS, LOG_LEVELS, type LogEntry, type LogLevel, type Page } from "@/lib/types";
import { formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";

const PAGE_SIZE = 50;

const LEVEL_TEXT: Record<LogLevel, string> = { debug: "Debug", info: "Information", warn: "Warning", error: "Error" };
const AREA_TEXT: Record<string, string> = {
  crawl: "Crawling", pipeline: "Pipeline", storage: "Storage", search: "Search", auth: "Sign-in", system: "System", zim: "ZIM", provider: "Providers",
};
const LEVEL_VARIANT: Record<LogLevel, "secondary" | "outline" | "warning" | "destructive"> = {
  debug: "outline", info: "secondary", warn: "warning", error: "destructive",
};

export function ActivityView() {
  const [level, setLevel] = React.useState("");
  const [area, setArea] = React.useState("");
  const [items, setItems] = React.useState<LogEntry[]>([]);
  const [cursor, setCursor] = React.useState<string | undefined>();
  const [loading, setLoading] = React.useState(true);
  const [more, setMore] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);
  const seq = React.useRef(0);

  const load = React.useCallback(
    async (after?: string) => {
      const id = ++seq.current;
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (level) qs.set("level", level);
      if (area) qs.set("area", area);
      if (after) qs.set("cursor", after);
      if (after) setMore(true);
      else setLoading(true);
      try {
        const res = await api<Page<LogEntry>>(`/api/system/logs?${qs}`);
        if (id !== seq.current) return;
        setItems((cur) => (after ? [...cur, ...res.items] : res.items));
        setCursor(res.nextCursor);
        setError(null);
      } catch (e) {
        if (id !== seq.current) return;
        setError(e as ApiError);
      } finally {
        if (id === seq.current) {
          setLoading(false);
          setMore(false);
        }
      }
    },
    [level, area],
  );

  React.useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeader title="Activity log" description="What the server has been doing. Newest first." />
      <form className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(e) => e.preventDefault()} aria-label="Filter the activity log">
        <div className="space-y-1.5">
          <Label htmlFor="log-level">Level</Label>
          <Select id="log-level" value={level} onChange={(e) => setLevel(e.target.value)} className="w-44">
            <option value="">All levels</option>
            {LOG_LEVELS.map((l) => (
              <option key={l} value={l}>{LEVEL_TEXT[l]}</option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="log-area">Area</Label>
          <Select id="log-area" value={area} onChange={(e) => setArea(e.target.value)} className="w-44">
            <option value="">All areas</option>
            {LOG_AREAS.map((a) => (
              <option key={a} value={a}>{AREA_TEXT[a] ?? a}</option>
            ))}
          </Select>
        </div>
        {level || area ? (
          <Button variant="ghost" onClick={() => { setLevel(""); setArea(""); }}>Clear filters</Button>
        ) : null}
      </form>

      {error && items.length === 0 ? (
        <ErrorState title="Couldn't load the activity log" message={error.message} onRetry={() => void load()} />
      ) : loading ? (
        <LoadingSkeleton rows={8} label="Loading the activity log" />
      ) : items.length === 0 ? (
        <EmptyState
          title={level || area ? "No entries match these filters" : "Nothing logged yet"}
          description={level || area ? "Try a different level or area, or clear the filters." : "Entries appear here as the server works."}
        />
      ) : (
        <>
          <p className="sr-only" role="status">{items.length} entries shown{cursor ? ", more available" : ""}</p>
          <Table aria-label="Activity log entries">
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Level</TableHead>
                <TableHead>Area</TableHead>
                <TableHead>Message</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((l) => (
                <TableRow key={l.id} data-testid="log-row">
                  <TableCell className="whitespace-nowrap">{formatDate(l.at)}</TableCell>
                  <TableCell><Badge variant={LEVEL_VARIANT[l.level] ?? "secondary"}>{LEVEL_TEXT[l.level] ?? l.level}</Badge></TableCell>
                  <TableCell>{AREA_TEXT[l.area] ?? l.area}</TableCell>
                  <TableCell className="min-w-64">{l.message}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {error ? <ErrorState className="mt-3" title="Couldn't load more" message={error.message} onRetry={() => cursor && void load(cursor)} /> : null}
          {cursor ? (
            <div className="mt-4 flex justify-center">
              <Button variant="outline" disabled={more} onClick={() => void load(cursor)}>
                {more ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : (
            <p className="mt-4 text-center text-sm text-muted-foreground">That's everything.</p>
          )}
        </>
      )}
    </>
  );
}

"use client";

import * as React from "react";
import Link from "next/link";
import { errorMessage, get } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TRIGGER_TEXT, type AuditRecord } from "@/lib/storage";
import { formatBytes, formatDate } from "@/lib/utils";
import { PriorityBadge } from "./shared";

export function AuditTable({ items, showPage = true }: { items: AuditRecord[]; showPage?: boolean }) {
  return (
    <Table aria-label="Removal record">
      <caption className="sr-only">Every automatic removal and every deletion by hand, newest first</caption>
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead><TableHead>What happened</TableHead>{showPage ? <TableHead>Page</TableHead> : null}<TableHead>Priority</TableHead><TableHead>Why</TableHead><TableHead className="text-right">Freed</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((a) => (
          <TableRow key={a.id} data-testid="audit-row" data-kind={a.kind}>
            <TableCell className="whitespace-nowrap">{formatDate(a.at)}</TableCell>
            <TableCell>
              <Badge variant={a.kind === "evicted" ? "warning" : "secondary"}>{a.kind === "evicted" ? "Removed automatically" : "Deleted by hand"}</Badge>
              {a.confirmedProtected ? <p className="mt-1 text-xs text-muted-foreground">Protected content, confirmed by hand.</p> : null}
            </TableCell>
            {showPage ? (
              <TableCell className="max-w-xs">
                {a.pageId ? <Link href={`/storage/pages/${a.pageId}`} className="block truncate text-primary underline underline-offset-2">{a.pageUrl}</Link> : <span className="block truncate" title={a.pageUrl}>{a.pageUrl}<span className="text-xs text-muted-foreground"> (page deleted)</span></span>}
                {a.versionNo ? <span className="text-xs text-muted-foreground">Version {a.versionNo}</span> : null}
              </TableCell>
            ) : null}
            <TableCell><PriorityBadge priority={a.priority} surplus={a.surplus} /></TableCell>
            <TableCell className="min-w-56 text-sm"><p>{a.reason}</p>{a.trigger ? <p className="text-xs text-muted-foreground">{TRIGGER_TEXT[a.trigger]}</p> : null}</TableCell>
            <TableCell className="text-right tabular-nums">{formatBytes(a.exclusiveBytes)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function AuditView() {
  const [kind, setKind] = React.useState<"" | "evicted" | "deleted">("");
  const [items, setItems] = React.useState<AuditRecord[] | null>(null);
  const [next, setNext] = React.useState<string | undefined>();
  const [error, setError] = React.useState<string | null>(null);
  const [more, setMore] = React.useState(false);

  const load = React.useCallback(async (cursor?: string) => {
    const qs = new URLSearchParams({ limit: "50" });
    if (kind) qs.set("kind", kind);
    if (cursor) qs.set("cursor", cursor);
    try {
      const r = await get<{ items: AuditRecord[]; nextCursor?: string }>(`/api/storage/audit?${qs}`);
      setItems((cur) => (cursor && cur ? [...cur, ...r.items] : r.items));
      setNext(r.nextCursor);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [kind]);

  React.useEffect(() => { setItems(null); void load(); }, [load]);

  return (
    <>
      <PageHeader title="Removal record" description="Every automatic removal and every deletion by hand, with the reason. This record is kept even when the activity log is cleared." />
      <div className="mb-4 flex items-center gap-2">
        <Label htmlFor="audit-kind" className="text-sm">Show</Label>
        <Select id="audit-kind" className="w-auto" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} data-testid="audit-kind">
          <option value="">Everything</option>
          <option value="evicted">Removed automatically</option>
          <option value="deleted">Deleted by hand</option>
        </Select>
      </div>
      {error && !items ? <ErrorState title="Couldn't load the record" message={error} onRetry={() => void load()} /> : null}
      {!items && !error ? <LoadingSkeleton label="Loading the record" /> : null}
      {items && items.length === 0 ? <EmptyState title="Nothing has been removed" description="When a saved copy is removed to make room, or you delete a page, it is listed here with the reason." /> : null}
      {items && items.length > 0 ? (
        <>
          <AuditTable items={items} />
          {next ? <div className="mt-3"><Button variant="outline" disabled={more} onClick={async () => { setMore(true); await load(next); setMore(false); }}>Show more</Button></div> : null}
        </>
      ) : null}
    </>
  );
}

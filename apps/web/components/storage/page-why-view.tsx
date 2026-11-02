"use client";

import * as React from "react";
import Link from "next/link";
import { Pin, PinOff } from "lucide-react";
import { del, errorMessage, put, useApi } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { Field } from "@/components/common/form";
import { Breadcrumb } from "@/components/common/breadcrumb";
import { ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PRIORITIES } from "@/lib/library-copy";
import { SKIP_REASON_TEXT, type PageStorageExplanation, type ReferenceSummary } from "@/lib/storage";
import type { Priority } from "@/lib/types";
import { formatDate } from "@/lib/utils";
import { AuditTable } from "./audit-view";
import { Notice, PriorityBadge, ProtectedNote } from "./shared";

const KIND_TEXT: Record<ReferenceSummary["kind"], string> = { source: "Source", collection: "Collection", pin: "Pin", bookmark: "Bookmark" };
const STATUS_TEXT: Record<string, string> = { ready: "Saved", partial: "Partly saved", capturing: "Being saved", failed: "Failed", evicting: "Being removed", evicted: "Removed to save space" };

function References({ refs }: { refs: ReferenceSummary[] }) {
  if (refs.length === 0) return <p className="text-sm text-muted-foreground" data-testid="no-refs">Nothing keeps this page now. It counts as Opportunistic (P4) and is among the first to go.</p>;
  return (
    <Table aria-label="What keeps this page">
      <caption className="sr-only">What keeps this page, and what each allows</caption>
      <TableHeader><TableRow><TableHead>Kind</TableHead><TableHead>Name</TableHead><TableHead>Priority</TableHead><TableHead>Automatic removal</TableHead><TableHead>Keeps old copies</TableHead></TableRow></TableHeader>
      <TableBody>
        {refs.map((r) => (
          <TableRow key={`${r.kind}-${r.id}`} data-testid="reference-row">
            <TableCell>{KIND_TEXT[r.kind]}</TableCell>
            <TableCell>{r.label ?? r.id}</TableCell>
            <TableCell><PriorityBadge priority={r.priority} /></TableCell>
            <TableCell>{r.autoEvict ? "Allowed" : "Not allowed"}</TableCell>
            <TableCell>{r.retains ? "Yes" : "No"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function PageWhyView({ id }: { id: string }) {
  const q = useApi<PageStorageExplanation>(`/api/storage/pages/${encodeURIComponent(id)}`);
  const { toast } = useToast();
  const [prio, setPrio] = React.useState<Priority>("P1");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState("");
  const e = q.data;

  async function pin() {
    setBusy(true); setError(null);
    try {
      const body: { priority: Priority; reason?: string } = { priority: prio };
      if (reason.trim()) body.reason = reason.trim();
      q.setData(await put<PageStorageExplanation>(`/api/storage/pages/${encodeURIComponent(id)}/pin`, body));
      setStatus(`Page pinned at ${PRIORITIES.find((p) => p.value === prio)?.label}.`);
      toast({ title: "Page pinned", variant: "success" });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function unpin() {
    setBusy(true); setError(null);
    try {
      q.setData(await del<PageStorageExplanation>(`/api/storage/pages/${encodeURIComponent(id)}/pin`));
      setStatus("Pin removed.");
      toast({ title: "Pin removed", variant: "success" });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (q.isLoading) return <LoadingSkeleton variant="page" label="Loading the explanation" />;
  if (q.error || !e) {
    return <ErrorState title={q.error?.status === 404 ? "This page is not saved" : "Couldn't load the explanation"} message={q.error?.status === 404 ? "It may have been deleted. The removal record lists deleted pages." : q.error?.message} onRetry={q.error?.status === 404 ? undefined : () => void q.mutate()} />;
  }

  const newest = e.versions[0];
  const anyRemoved = e.versions.some((v) => v.status === "evicted");
  const headline = !newest
    ? "No copy of this page is stored."
    : newest.status === "evicted"
      ? "The newest copy was removed to save space."
      : newest.decision === "kept"
        ? "Automatic removal can't take this page now."
        : "This page can be removed automatically if space runs short.";

  return (
    <>
      <Breadcrumb items={[{ label: "Storage and settings", href: "/storage" }, { label: "Removal record", href: "/storage/audit" }, { label: "Why this page" }]} />
      <PageHeader
        title="Why is this page kept?"
        description={<span className="break-all" data-testid="why-url">{e.page.url}</span>}
        actions={<Button variant="outline" asChild><Link href={`/library/pages/${e.page.id}`}>Open in the Library</Link></Button>}
      />
      <div className="space-y-8">
        <section aria-labelledby="why-sum" className="space-y-3 rounded-lg border p-4" data-testid="why-summary">
          <h2 id="why-sum" className="text-lg font-semibold">The short answer</h2>
          <div className="flex flex-wrap items-center gap-2">
            <PriorityBadge priority={e.page.effectivePriority} />
            {newest ? <Badge variant={newest.decision === "kept" ? "success" : "warning"} data-testid="why-decision">{newest.status === "evicted" ? "Removed" : newest.decision === "kept" ? "Kept" : "Can be removed"}</Badge> : null}
            {e.pin ? <Badge variant="outline">Pinned</Badge> : null}
          </div>
          <p className="font-medium" data-testid="why-headline">{headline}</p>
          {newest && newest.reasons.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="why-reasons">{newest.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          ) : null}
          {newest?.skipReason ? <p className="text-sm text-muted-foreground">{SKIP_REASON_TEXT[newest.skipReason]}</p> : null}
          {e.page.cachedPriority && e.page.cachedPriority !== e.page.effectivePriority ? (
            <p className="text-sm text-muted-foreground">The Library shows {e.page.cachedPriority} until it catches up. The priority that counts now is {e.page.effectivePriority}.</p>
          ) : null}
          <ProtectedNote />
        </section>

        <section aria-labelledby="pin-h" className="space-y-3" data-testid="pin-section">
          <h2 id="pin-h" className="text-lg font-semibold">Keep this page</h2>
          {e.pin ? (
            <div className="space-y-3">
              <p className="text-sm" data-testid="pin-state">Pinned at <PriorityBadge priority={e.pin.priority} />{e.pin.reason ? ` because: ${e.pin.reason}` : ""}. {e.pin.priority === "P1" ? "A Protected pin stops automatic removal of every copy of this page." : ""}</p>
              <Button variant="outline" onClick={() => void unpin()} disabled={busy} data-testid="unpin"><PinOff aria-hidden="true" /> Unpin this page</Button>
            </div>
          ) : (
            <div className="max-w-xl space-y-3">
              <p className="text-sm text-muted-foreground">Pin the page to keep it whatever its sources say. A Protected (P1) pin means it is never removed automatically.</p>
              <Field id="pin-prio" label="Keep it at">
                {(p) => <Select {...p} value={prio} onChange={(ev) => setPrio(ev.target.value as Priority)} data-testid="pin-priority">{PRIORITIES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</Select>}
              </Field>
              <Field id="pin-reason" label="Why" optional hint="A short note for later. Up to 300 characters.">
                {(p) => <Input {...p} value={reason} maxLength={300} onChange={(ev) => setReason(ev.target.value)} />}
              </Field>
              <Button onClick={() => void pin()} disabled={busy} data-testid="pin"><Pin aria-hidden="true" /> Pin this page</Button>
            </div>
          )}
          {error ? <Notice tone="warning" testId="pin-error">{error}</Notice> : null}
          <p role="status" className="text-sm text-muted-foreground" data-testid="pin-status">{status}</p>
        </section>

        <section aria-labelledby="refs-h" className="space-y-2">
          <h2 id="refs-h" className="text-lg font-semibold">What keeps it</h2>
          <References refs={e.references} />
          <p className="text-sm text-muted-foreground">A page in several places takes the highest priority of them. One &quot;not allowed&quot; is enough to stop automatic removal of the page.</p>
        </section>

        <section aria-labelledby="ver-h" className="space-y-2">
          <h2 id="ver-h" className="text-lg font-semibold">Copies</h2>
          <ul className="divide-y rounded-lg border" data-testid="why-versions">
            {e.versions.map((v) => (
              <li key={v.versionId} className="space-y-1 p-4" data-testid="why-version" data-status={v.status}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">Version {v.versionNo}{v.isLatest ? " (newest)" : ""}</span>
                  <Badge variant="secondary">{STATUS_TEXT[v.status] ?? v.status}</Badge>
                  <PriorityBadge priority={v.priority} surplus={v.surplus} />
                  <Badge variant={v.status === "evicted" ? "warning" : v.decision === "kept" ? "success" : "warning"}>{v.status === "evicted" ? "Removed" : v.decision === "kept" ? "Kept" : "Can be removed"}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">Saved {formatDate(v.fetchedAt)}{v.evictedAt ? `. Removed ${formatDate(v.evictedAt)}` : ""}.</p>
                {v.reasons.length > 0 ? <ul className="list-disc pl-5 text-sm">{v.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
              </li>
            ))}
            {e.versions.length === 0 ? <li className="p-4 text-sm text-muted-foreground">No copies are recorded.</li> : null}
          </ul>
        </section>

        <section aria-labelledby="hist-h" className="space-y-2" data-testid="why-history">
          <h2 id="hist-h" className="text-lg font-semibold">History</h2>
          {e.history.length === 0 ? <p className="text-sm text-muted-foreground">{anyRemoved ? "A copy was removed, but no record is kept for it." : "No copy of this page has been removed."}</p> : <AuditTable items={e.history} showPage={false} />}
        </section>
      </div>
    </>
  );
}

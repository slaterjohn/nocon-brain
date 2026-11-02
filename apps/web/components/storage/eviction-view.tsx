"use client";

import * as React from "react";
import Link from "next/link";
import { History, Play, Search } from "lucide-react";
import { ApiError, errorMessage, post, useApi } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { AdvancedSettings } from "@/components/common/advanced-settings";
import { Field } from "@/components/common/form";
import { ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PRIORITIES } from "@/lib/library-copy";
import {
  planHeadline, RUN_STATE_TEXT, SKIP_REASON_TEXT, skippedSummary, STEP_TEXT, toBytes, TRIGGER_TEXT,
  type EvictionPlan, type EvictionResult, type EvictionRunRow, type SizeUnit, type Volume,
} from "@/lib/storage";
import type { Priority } from "@/lib/types";
import { formatBytes, formatDate } from "@/lib/utils";
import { ConfirmDialog, Notice, PriorityBadge, ProtectedNote } from "./shared";

function RunHistory({ reload }: { reload: number }) {
  const q = useApi<{ items: EvictionRunRow[] }>("/api/storage/eviction/runs?limit=20");
  const mutate = q.mutate;
  React.useEffect(() => { if (reload > 0) void mutate(); }, [reload, mutate]);
  return (
    <section aria-labelledby="runs-h" className="space-y-2" data-testid="run-history">
      <h2 id="runs-h" className="flex items-center gap-2 text-lg font-semibold"><History className="size-5" aria-hidden="true" /> Run history</h2>
      {q.error && !q.data ? <ErrorState title="Couldn't load the history" message={q.error.message} onRetry={() => void mutate()} /> : null}
      {!q.data && !q.error ? <LoadingSkeleton rows={3} label="Loading the history" /> : null}
      {q.data && q.data.items.length === 0 ? <p className="text-sm text-muted-foreground">Nothing has been removed yet.</p> : null}
      {q.data && q.data.items.length > 0 ? (
        <Table aria-label="Removal runs">
          <caption className="sr-only">Removal runs, newest first</caption>
          <TableHeader><TableRow><TableHead>Started</TableHead><TableHead>Why</TableHead><TableHead>State</TableHead><TableHead className="text-right">Removed</TableHead><TableHead className="text-right">Skipped</TableHead><TableHead className="text-right">Freed</TableHead></TableRow></TableHeader>
          <TableBody>
            {q.data.items.map((r) => (
              <TableRow key={r.id} data-testid="run-row">
                <TableCell>{formatDate(r.startedAt)}</TableCell>
                <TableCell>{TRIGGER_TEXT[r.trigger]}</TableCell>
                <TableCell><Badge variant={r.state === "done" ? "success" : r.state === "running" ? "secondary" : "warning"}>{RUN_STATE_TEXT[r.state]}</Badge>{r.error ? <span className="ml-2 text-xs text-muted-foreground">{r.error}</span> : null}</TableCell>
                <TableCell className="text-right tabular-nums">{r.versionsEvicted}</TableCell>
                <TableCell className="text-right tabular-nums">{r.versionsSkipped}</TableCell>
                <TableCell className="text-right tabular-nums">{formatBytes(r.bytesFreed)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </section>
  );
}

export function PlanView({ plan, onRunClick }: { plan: EvictionPlan; onRunClick: (e: React.MouseEvent<HTMLButtonElement>) => void }) {
  const skips = skippedSummary(plan.skippedCounts);
  const skippedTotal = skips.reduce((n, s) => n + s.count, 0);
  const things = plan.itemsTotal + plan.unreferencedBlobs.count;
  return (
    <div className="space-y-6" data-testid="plan">
      <div className="space-y-3 rounded-lg border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" data-testid="plan-dry">Dry run: nothing has been removed</Badge>
          <Badge variant={plan.sufficient ? "success" : "destructive"} data-testid="plan-sufficiency">{plan.sufficient ? "Enough" : "Insufficient"}</Badge>
        </div>
        <p className="text-base font-medium" data-testid="plan-headline">{planHeadline(plan)}</p>
        <p className="text-sm text-muted-foreground" data-testid="plan-summary">{plan.summary}</p>
        {plan.throttleOpportunistic ? <p className="text-sm text-muted-foreground">Opportunistic downloads are also being slowed. Nothing is deleted for that.</p> : null}
        {plan.insufficient ? (
          <Notice tone="warning" title="This plan can't be run" testId="plan-insufficient">
            Nothing that is allowed to go would free enough space. Free space by hand, add a volume, or review which sources are Protected or Important. Nothing is removed from an insufficient plan.
          </Notice>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={onRunClick} disabled={plan.insufficient || things === 0} data-testid="plan-run"><Play aria-hidden="true" /> Run this plan</Button>
          <span className="text-xs text-muted-foreground">Kept until {formatDate(plan.expiresAt)}. Asks again before anything is removed.</span>
        </div>
      </div>

      {plan.steps.length > 0 ? (
        <section aria-labelledby="steps-h" className="space-y-2">
          <h3 id="steps-h" className="text-base font-semibold">Order of removal</h3>
          <ol className="list-decimal space-y-1 pl-5 text-sm" data-testid="plan-steps">
            {plan.steps.map((s) => (
              <li key={s.step}>{STEP_TEXT[s.step]}: {s.versions.toLocaleString("en-GB")} {s.versions === 1 ? "copy" : "copies"}, frees {formatBytes(s.exclusiveBytes)}</li>
            ))}
          </ol>
        </section>
      ) : null}

      <section aria-labelledby="items-h" className="space-y-2">
        <h3 id="items-h" className="text-base font-semibold">What would be removed</h3>
        {plan.itemsTotal === 0 ? <p className="text-sm text-muted-foreground" data-testid="plan-no-items">No saved copies would be removed.</p> : (
          <>
            <Table aria-label="Copies this plan would remove">
              <caption className="sr-only">Copies this plan would remove, in order, with the reason for each</caption>
              <TableHeader><TableRow><TableHead>Page</TableHead><TableHead>Priority</TableHead><TableHead>Reason</TableHead><TableHead className="text-right">Frees</TableHead></TableRow></TableHeader>
              <TableBody>
                {plan.items.map((i) => (
                  <TableRow key={i.versionId} data-testid="plan-item">
                    <TableCell className="max-w-xs">
                      <Link href={`/storage/pages/${i.pageId}`} className="block truncate text-primary underline underline-offset-2" data-testid="plan-item-page">{i.pageUrl}</Link>
                      <span className="text-xs text-muted-foreground">Version {i.versionNo}</span>
                    </TableCell>
                    <TableCell><PriorityBadge priority={i.priority} surplus={i.surplus} /></TableCell>
                    <TableCell className="min-w-56 text-sm" data-testid="plan-item-reason">{i.reason}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatBytes(i.exclusiveBytes)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {plan.itemsTotal > plan.items.length ? <p className="text-sm text-muted-foreground">Showing the first {plan.items.length} of {plan.itemsTotal.toLocaleString("en-GB")}.</p> : null}
          </>
        )}
        {plan.unreferencedBlobs.count > 0 ? <p className="text-sm" data-testid="plan-unreferenced">Also {plan.unreferencedBlobs.count.toLocaleString("en-GB")} unused {plan.unreferencedBlobs.count === 1 ? "file" : "files"} ({formatBytes(plan.unreferencedBlobs.bytes)}) that nothing uses. No saved content is lost.</p> : null}
      </section>

      <section aria-labelledby="skipped-h" className="space-y-2" data-testid="plan-skipped">
        <h3 id="skipped-h" className="text-base font-semibold">What is left alone</h3>
        {skippedTotal === 0 ? <p className="text-sm text-muted-foreground">Nothing was skipped.</p> : (
          <>
            <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="skip-counts">
              {skips.map((s) => <li key={s.reason}>{s.count.toLocaleString("en-GB")} {s.count === 1 ? "copy" : "copies"}: {SKIP_REASON_TEXT[s.reason]}</li>)}
            </ul>
            {plan.skipped.length > 0 ? (
              <Table aria-label="Copies left alone">
                <caption className="sr-only">Copies this plan leaves alone, with the reason for each</caption>
                <TableHeader><TableRow><TableHead>Page</TableHead><TableHead>Why it stays</TableHead></TableRow></TableHeader>
                <TableBody>
                  {plan.skipped.map((s) => (
                    <TableRow key={s.versionId} data-testid="skip-item" data-reason={s.reason}>
                      <TableCell className="max-w-xs"><Link href={`/storage/pages/${s.pageId}`} className="block truncate text-primary underline underline-offset-2">{s.pageUrl}</Link></TableCell>
                      <TableCell className="text-sm" data-testid="skip-reason">{SKIP_REASON_TEXT[s.reason]}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : null}
            {skippedTotal > plan.skipped.length ? <p className="text-sm text-muted-foreground">Showing the first {plan.skipped.length} of {skippedTotal.toLocaleString("en-GB")}.</p> : null}
          </>
        )}
      </section>
    </div>
  );
}

export function EvictionView() {
  const volumes = useApi<{ items: Volume[] }>("/api/storage/volumes");
  const { toast } = useToast();
  const [mode, setMode] = React.useState<"pressure" | "prune">("pressure");
  const [incoming, setIncoming] = React.useState<Priority>("P1");
  const [need, setNeed] = React.useState({ text: "", unit: "MB" as SizeUnit });
  const [volumeId, setVolumeId] = React.useState("");
  const [advOpen, setAdvOpen] = React.useState(false);
  const [needError, setNeedError] = React.useState<string | undefined>();
  const [plan, setPlan] = React.useState<EvictionPlan | null>(null);
  const [planBusy, setPlanBusy] = React.useState(false);
  const [planError, setPlanError] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState(false);
  const [runBusy, setRunBusy] = React.useState(false);
  const [runError, setRunError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<EvictionResult | null>(null);
  const [reload, setReload] = React.useState(0);
  const planRef = React.useRef<HTMLDivElement>(null);

  async function preview(e: React.FormEvent) {
    e.preventDefault();
    const b = toBytes(need.text, need.unit);
    if (b === undefined) { setNeedError("Enter a number above zero, or leave it empty."); setAdvOpen(true); setTimeout(() => document.getElementById("ev-need")?.focus(), 0); return; }
    setNeedError(undefined);
    setPlanBusy(true); setPlanError(null); setResult(null);
    try {
      const body: Record<string, unknown> = { mode, incomingPriority: incoming };
      if (b) body.bytesNeeded = b;
      if (volumeId) body.volumeId = volumeId;
      const p = await post<EvictionPlan>("/api/storage/eviction/plan", body);
      setPlan(p);
      setTimeout(() => planRef.current?.focus(), 50);
    } catch (err) {
      setPlanError(errorMessage(err));
    } finally {
      setPlanBusy(false);
    }
  }

  async function run() {
    if (!plan) return;
    setRunBusy(true); setRunError(null);
    try {
      const r = await post<EvictionResult>("/api/storage/eviction/run", { planId: plan.planId });
      setResult(r);
      setPlan(null);
      setConfirm(false);
      setReload((n) => n + 1);
      toast({ title: "Removal finished", description: `${r.evicted} removed, ${formatBytes(r.bytesFreed)} freed.`, variant: "success" });
    } catch (err) {
      const kind = err instanceof ApiError && err.status === 404 ? "This plan has expired. Preview it again." : null;
      setRunError(kind ?? errorMessage(err));
    } finally {
      setRunBusy(false);
    }
  }

  const things = plan ? plan.itemsTotal + plan.unreferencedBlobs.count : 0;

  return (
    <>
      <PageHeader title="Removal preview" description="See what automatic removal would do before anything is removed. A preview changes nothing." />
      <div className="mb-6"><ProtectedNote /></div>

      <form onSubmit={(e) => void preview(e)} noValidate className="mb-8 space-y-4 rounded-lg border p-4" aria-label="Preview a removal plan" data-testid="plan-form">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="ev-mode" label="What to plan" hint={mode === "pressure" ? "Free room for a download, or bring a volume down to its target." : "Only tidy copies that nothing keeps and files nothing uses."}>
            {(p) => (
              <Select {...p} value={mode} onChange={(e) => setMode(e.target.value as "pressure" | "prune")} data-testid="ev-mode">
                <option value="pressure">Make room</option>
                <option value="prune">Tidy up only</option>
              </Select>
            )}
          </Field>
          {mode === "pressure" ? (
            <Field id="ev-incoming" label="Priority of the download that needs room" hint="Protected (P1) lets every eligible class through. Lower priorities may only free less important content.">
              {(p) => (
                <Select {...p} value={incoming} onChange={(e) => setIncoming(e.target.value as Priority)} data-testid="ev-incoming">
                  {PRIORITIES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                </Select>
              )}
            </Field>
          ) : null}
        </div>
        <AdvancedSettings open={advOpen} onOpenChange={setAdvOpen} title="Advanced settings: amount and volume" id="ev-adv">
          <Field id="ev-need" label="Room needed" hint="Leave empty to plan what the volume needs to fall to its target." error={needError}>
            {(p) => (
              <div className="flex gap-2">
                <Input {...p} inputMode="decimal" value={need.text} onChange={(e) => setNeed({ ...need, text: e.target.value })} className="max-w-32" data-testid="ev-need" />
                <Select aria-label="Room needed, unit" value={need.unit} onChange={(e) => setNeed({ ...need, unit: e.target.value as SizeUnit })} className="w-24"><option>MB</option><option>GB</option><option>TB</option></Select>
              </div>
            )}
          </Field>
          <Field id="ev-volume" label="Volume" hint="The default volume if you don't choose one.">
            {(p) => (
              <Select {...p} value={volumeId} onChange={(e) => setVolumeId(e.target.value)}>
                <option value="">Default volume</option>
                {(volumes.data?.items ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </Select>
            )}
          </Field>
        </AdvancedSettings>
        <Button type="submit" disabled={planBusy} data-testid="plan-preview"><Search aria-hidden="true" /> {planBusy ? "Working out the plan…" : "Preview removal"}</Button>
      </form>

      {planError ? <ErrorState title="Couldn't make a plan" message={planError} /> : null}
      <div ref={planRef} tabIndex={-1} className="outline-none" aria-live="polite">
        {plan ? <PlanView plan={plan} onRunClick={() => { setRunError(null); setConfirm(true); }} /> : null}
        {result ? (
          <Notice tone="info" title="Removal finished" testId="run-result">
            {result.evicted.toLocaleString("en-GB")} {result.evicted === 1 ? "copy" : "copies"} removed and {formatBytes(result.bytesFreed)} freed. {result.skipped.length ? `${result.skipped.length} ${result.skipped.length === 1 ? "copy was" : "copies were"} left alone because ${result.skipped.length === 1 ? "it" : "they"} changed since the preview.` : "Nothing was skipped."}
          </Notice>
        ) : null}
      </div>

      <div className="mt-10"><RunHistory reload={reload} /></div>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Run this plan?"
        description={
          <>
            <p data-testid="run-confirm-text">This removes {plan?.itemsTotal.toLocaleString("en-GB")} saved {plan?.itemsTotal === 1 ? "copy" : "copies"} and frees about {plan ? formatBytes(plan.reclaimableBytes) : ""}. Removed copies can&apos;t be brought back, though the pages can be saved again.</p>
            <p>Everything is checked again as it goes. Anything that has become Protected, pinned or busy since the preview is left alone.</p>
          </>
        }
        confirmLabel="Remove now"
        destructive
        busy={runBusy}
        confirmDisabled={things === 0}
        onConfirm={() => void run()}
        testId="run"
      >
        {runError ? <Notice tone="warning" testId="run-error">{runError}</Notice> : null}
      </ConfirmDialog>
    </>
  );
}

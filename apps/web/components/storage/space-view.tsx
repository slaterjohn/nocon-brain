"use client";

import * as React from "react";
import Link from "next/link";
import { HardDrive, TrendingUp } from "lucide-react";
import { errorMessage, patch, useApi } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { AdvancedSettings } from "@/components/common/advanced-settings";
import { ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";
import { useSources } from "@/components/library/hooks";
import { PRIORITIES } from "@/lib/library-copy";
import {
  confidenceText, fullAtText, growthText, projectedUsedText, rangeText, volumeUsedPct, VOLUME_STATE_HELP, VOLUME_STATE_TEXT, RUN_STATE_TEXT, TRIGGER_TEXT,
  type StorageOverview, type UsageReport, type Volume,
} from "@/lib/storage";
import type { Priority, Source } from "@/lib/types";
import { formatBytes, formatDate } from "@/lib/utils";
import { Notice, ProtectedNote, UsageKey, UsageTable } from "./shared";

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-1 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right tabular-nums">{children}</dd>
    </div>
  );
}

export function VolumeCard({ v, over }: { v: Volume; over: boolean }) {
  const pct = volumeUsedPct(v);
  const online = v.state === "online";
  return (
    <Card data-testid="volume-card" data-state={v.state}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <HardDrive className="size-4" aria-hidden="true" /> {v.name}
          <Badge variant={online ? "success" : v.state === "offline" ? "destructive" : "warning"} data-testid="volume-state">{VOLUME_STATE_TEXT[v.state]}</Badge>
          {v.isDefault ? <Badge variant="outline">Default</Badge> : null}
          {over ? <Badge variant="warning">Over its eviction threshold</Badge> : null}
        </CardTitle>
        <CardDescription className="break-all">{v.rootPath}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {v.state === "offline" ? (
          <Notice tone="warning" title="This volume is offline" testId="offline-note">
            {VOLUME_STATE_HELP.offline} The figures below are the last ones known and may be out of date.
          </Notice>
        ) : null}
        <div>
          <Progress value={pct} label={`Disk usage of ${v.name}`} barClassName={pct >= v.thresholds.evictStartPct ? "bg-warning" : undefined} />
          <p className="mt-1 text-xs text-muted-foreground" data-testid="volume-pct">Disk usage {pct}%. Slows background downloads at {v.thresholds.softPct}%, starts removing at {v.thresholds.evictStartPct}%, stops at {v.thresholds.evictTargetPct}%.</p>
        </div>
        <dl className="divide-y">
          <Fact label="Size of the volume">{formatBytes(v.capacityBytes)}</Fact>
          {v.quotaBytes ? <Fact label="Limit set for NoConBrain">{formatBytes(v.quotaBytes)}</Fact> : null}
          <Fact label="Used by NoConBrain">{formatBytes(v.usedBytes)}</Fact>
          <Fact label="Available">{formatBytes(v.availableBytes)}</Fact>
          <Fact label="Promised to running downloads">{formatBytes(v.reservedBytes)}</Fact>
          <Fact label="Always kept free">{formatBytes(v.reserveFreeBytes)}</Fact>
        </dl>
        <p className="text-xs text-muted-foreground">Used by priority: {(["P1", "P2", "P3", "P4"] as Priority[]).map((p) => `${p} ${formatBytes(v.usageByPriority?.[p] ?? 0)}`).join(", ")}.</p>
      </CardContent>
    </Card>
  );
}

function SourcePriority({ sourceId, name, src, reloadSources, onChanged }: { sourceId: string; name: string; src: Source | undefined; reloadSources: () => Promise<void>; onChanged: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);
  if (!src) return <span className="text-sm text-muted-foreground">Not in the Library</span>;
  async function change(p: Priority) {
    setBusy(true);
    try {
      await patch(`/api/sources/${sourceId}`, { priority: p });
      toast({ title: "Priority changed", description: `${name} is now ${PRIORITIES.find((x) => x.value === p)?.label}. Usage and the removal plan follow it.`, variant: "success" });
      await reloadSources();
      onChanged();
    } catch (e) {
      toast({ title: "Couldn't change the priority", description: errorMessage(e), variant: "error" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Select aria-label={`Priority of ${name}`} className="h-8 w-auto py-0 text-sm" value={src.priority} disabled={busy} onChange={(e) => void change(e.target.value as Priority)} data-testid="source-priority">
      {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
    </Select>
  );
}

function Usage({ by, caption, nameHeading, children, sources, onChanged, reload }: {
  sources?: ReturnType<typeof useSources>; by: UsageReport["by"]; caption: string; nameHeading: string; children?: React.ReactNode; onChanged: () => void; reload: number;
}) {
  const q = useApi<UsageReport>(`/api/storage/usage?by=${by}`);
  const reloadUsage = q.mutate;
  React.useEffect(() => { if (reload > 0) void reloadUsage(); }, [reload, reloadUsage]);
  return (
    <section aria-labelledby={`usage-${by}-h`} className="space-y-2" data-testid={`usage-${by}`}>
      <h3 id={`usage-${by}-h`} className="text-base font-semibold">{caption}</h3>
      {children}
      {q.error && !q.data ? <ErrorState title="Couldn't load this" message={q.error.message} onRetry={() => void q.mutate()} /> : null}
      {!q.data && !q.error ? <LoadingSkeleton rows={3} label={`Loading ${caption.toLowerCase()}`} /> : null}
      {q.data ? (
        <UsageTable
          report={q.data}
          caption={caption}
          nameHeading={nameHeading}
          showSplit={by !== "kind" && by !== "volume"}
          actionHeading="Priority"
          renderAction={sources ? (row) => (row.key === "unassigned" ? <span className="text-sm text-muted-foreground">None</span> : <SourcePriority sourceId={row.key} name={row.label ?? row.key} src={sources.byId.get(row.key)} reloadSources={sources.mutate} onChanged={onChanged} />) : undefined}
        />
      ) : null}
    </section>
  );
}

export function SpaceView() {
  const overview = useApi<StorageOverview>("/api/storage", { refreshInterval: 15_000 });
  const sources = useSources();
  const [reload, setReload] = React.useState(0);
  const refresh = React.useCallback(() => { setReload((n) => n + 1); void overview.mutate(); }, [overview]);
  const o = overview.data;

  return (
    <>
      <PageHeader title="Storage overview" description="Where the space goes, how it is split by priority, and what is likely to happen next." />
      {overview.error && !o ? <ErrorState title="Couldn't load storage" message={overview.error.message} onRetry={() => void overview.mutate()} /> : null}
      {!o && !overview.error ? <LoadingSkeleton variant="page" label="Loading storage" /> : null}
      {o ? (
        <div className="space-y-10">
          <section aria-labelledby="vol-h" className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="vol-h" className="text-lg font-semibold">Volumes</h2>
              <Link href="/storage/volumes" className="text-sm text-primary underline underline-offset-2">Manage volumes</Link>
            </div>
            <p className="text-sm text-muted-foreground" data-testid="totals">
              {formatBytes(o.totals.usedBytes)} used and {formatBytes(o.totals.availableBytes)} available across {o.volumes.length} {o.volumes.length === 1 ? "volume" : "volumes"}
              {o.totals.reservedBytes ? `, with ${formatBytes(o.totals.reservedBytes)} promised to running downloads` : ""}
              {o.totals.unreferencedBytes ? `. ${formatBytes(o.totals.unreferencedBytes)} is unused and waiting to be cleared` : ""}.
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              {o.volumes.map((v) => <VolumeCard key={v.id} v={v} over={o.eviction.overThreshold.includes(v.id)} />)}
            </div>
          </section>

          <section aria-labelledby="usage-h" className="space-y-6">
            <div>
              <h2 id="usage-h" className="text-lg font-semibold">Usage</h2>
              <p className="text-sm text-muted-foreground">Each file is counted once. A file that two groups both use is shown as shared under each of them, because removing one group would not free it.</p>
            </div>
            <UsageKey />
            <Usage by="priority" caption="Usage by priority" nameHeading="Priority" onChanged={refresh} reload={reload} />
            <Usage by="source" caption="Usage by source" nameHeading="Source" sources={sources} onChanged={refresh} reload={reload}>
              <p className="text-sm text-muted-foreground">Change a source&apos;s priority here to see the effect on the table above and on the <Link href="/storage/eviction" className="text-primary underline underline-offset-2">removal plan</Link>.</p>
            </Usage>
            <Usage by="kind" caption="Usage by kind of file" nameHeading="Kind" onChanged={refresh} reload={reload} />
            <Usage by="volume" caption="Usage by volume" nameHeading="Volume" onChanged={refresh} reload={reload} />
          </section>

          <section aria-labelledby="fc-h" className="space-y-3" data-testid="forecast">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="fc-h" className="flex items-center gap-2 text-lg font-semibold"><TrendingUp className="size-5" aria-hidden="true" /> Forecast</h2>
              <Badge variant="warning" data-testid="forecast-label">Estimate</Badge>
            </div>
            <Notice testId="forecast-note">
              This is an estimate, not a promise. Every figure is a range, built from the assumptions below. {confidenceText(o.forecast.confidence)}
            </Notice>
            <dl className="divide-y rounded-lg border px-4">
              <Fact label="Growth"><span data-testid="forecast-growth">{growthText(o.forecast)}</span></Fact>
              <Fact label="Used space"><span data-testid="forecast-used">{projectedUsedText(o.forecast)}</span></Fact>
              <Fact label="When it could fill"><span className="text-right" data-testid="forecast-full">{fullAtText(o.forecast, (iso) => formatDate(iso).replace(/,.*$/, ""))}</span></Fact>
            </dl>
            <div>
              <h3 className="mb-1 text-sm font-medium">What this assumes</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground" data-testid="forecast-assumptions">
                {o.forecast.assumptions.map((a) => <li key={a}>{a}</li>)}
              </ul>
            </div>
            {o.forecast.perSource.length > 0 ? <ForecastSources f={o.forecast} /> : null}
          </section>

          <section aria-labelledby="state-h" className="space-y-3">
            <h2 id="state-h" className="text-lg font-semibold">Removal and upkeep</h2>
            <div className="grid gap-4 md:grid-cols-2">
              <Card data-testid="eviction-state">
                <CardHeader><CardTitle>Automatic removal</CardTitle></CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <p><Badge variant={o.eviction.autoEviction ? "success" : "secondary"}>{o.eviction.autoEviction ? "On" : "Off"}</Badge> {o.eviction.autoEviction ? "Old content is removed when a volume passes its eviction threshold." : "Nothing is removed when a volume fills up. Downloads that need room will fail instead."}</p>
                  <p>{o.eviction.throttling ? "Opportunistic downloads are being slowed now." : "Opportunistic downloads are not being slowed."}</p>
                  <p>{o.eviction.overThreshold.length ? `${o.eviction.overThreshold.length} ${o.eviction.overThreshold.length === 1 ? "volume is" : "volumes are"} over the eviction threshold.` : "No volume is over the eviction threshold."}</p>
                  <p className="text-muted-foreground" data-testid="last-eviction">
                    {o.eviction.lastRun
                      ? `Last run ${formatDate(o.eviction.lastRun.startedAt)}: ${RUN_STATE_TEXT[o.eviction.lastRun.state].toLowerCase()}, ${TRIGGER_TEXT[o.eviction.lastRun.trigger].toLowerCase()}, ${o.eviction.lastRun.versionsEvicted} removed, ${formatBytes(o.eviction.lastRun.bytesFreed)} freed.`
                      : "Nothing has been removed yet."}
                  </p>
                  <ProtectedNote />
                  <p><Link href="/storage/eviction" className="text-primary underline underline-offset-2">Preview and run removal</Link>{" · "}<Link href="/storage/policy" className="text-primary underline underline-offset-2">Edit the policy</Link></p>
                </CardContent>
              </Card>
              <Card data-testid="maintenance-state">
                <CardHeader><CardTitle>Upkeep</CardTitle></CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <p className="text-muted-foreground">
                    {o.maintenance.lastRun
                      ? `Last ${o.maintenance.lastRun.kind === "repair" ? "repair" : "check"} ${formatDate(o.maintenance.lastRun.startedAt)}${o.maintenance.lastRun.dryRun ? " (dry run, nothing changed)" : ""}.`
                      : "No check has been run yet."}
                  </p>
                  <p><Link href="/storage/maintenance" className="text-primary underline underline-offset-2">Check and repair storage</Link></p>
                </CardContent>
              </Card>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

function ForecastSources({ f }: { f: StorageOverview["forecast"] }) {
  const [open, setOpen] = React.useState(false);
  return (
    <AdvancedSettings open={open} onOpenChange={setOpen} title="Forecast by source" id="fc-src">
      <table className="w-full text-sm">
        <caption className="sr-only">Forecast by source, as ranges</caption>
        <thead><tr className="text-left text-xs text-muted-foreground"><th scope="col" className="py-1 pr-3">Source</th><th scope="col" className="py-1 pr-3">Saved pages</th><th scope="col" className="py-1 pr-3">Size of a page</th><th scope="col" className="py-1">Still to come</th></tr></thead>
        <tbody>
          {f.perSource.map((s) => (
            <tr key={s.sourceId} className="border-t">
              <th scope="row" className="py-1 pr-3 text-left font-normal">{s.name}</th>
              <td className="py-1 pr-3 tabular-nums">{s.observedPages.toLocaleString("en-GB")}</td>
              <td className="py-1 pr-3">{rangeText(s.bytesPerPage.low, s.bytesPerPage.high)}</td>
              <td className="py-1">{s.plannedPages ? `${s.plannedPages.toLocaleString("en-GB")} pages, ${rangeText(s.plannedBytes.low, s.plannedBytes.high)}` : "None planned"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </AdvancedSettings>
  );
}

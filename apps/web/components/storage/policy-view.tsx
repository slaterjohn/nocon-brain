"use client";

import * as React from "react";
import Link from "next/link";
import { errorMessage, fieldErrors, patch, put, useApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { AdvancedSettings } from "@/components/common/advanced-settings";
import { Field, FormError, ToggleRow } from "@/components/common/form";
import { ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";
import { fromBytes, thresholdErrors, toBytes, type SizeUnit, type StoragePolicy } from "@/lib/storage";
import { formatDate } from "@/lib/utils";
import { ConfirmDialog, Notice, ProtectedNote } from "./shared";

export const PERMIT_ACK_LABEL = "I understand that Important content can now be removed automatically, and that removed pages can't be brought back.";

function ThresholdCard({ row, onSaved }: { row: StoragePolicy["volumeThresholds"][number]; onSaved: () => void }) {
  const { toast } = useToast();
  const [v, setV] = React.useState({ soft: String(row.softPct), start: String(row.evictStartPct), target: String(row.evictTargetPct) });
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => setV({ soft: String(row.softPct), start: String(row.evictStartPct), target: String(row.evictTargetPct) }), [row.softPct, row.evictStartPct, row.evictTargetPct]);
  const dirty = Number(v.soft) !== row.softPct || Number(v.start) !== row.evictStartPct || Number(v.target) !== row.evictTargetPct;
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const errs = thresholdErrors({ softPct: Number(v.soft), evictStartPct: Number(v.start), evictTargetPct: Number(v.target) });
    setErrors(errs);
    if (Object.keys(errs).length) { setTimeout(() => document.querySelector<HTMLElement>(`#th-${row.volumeId} [aria-invalid="true"]`)?.focus(), 0); return; }
    setBusy(true);
    try {
      await patch(`/api/storage/volumes/${row.volumeId}`, { thresholds: { softPct: Number(v.soft), evictStartPct: Number(v.start), evictTargetPct: Number(v.target) } });
      toast({ title: "Thresholds saved", description: row.name, variant: "success" });
      onSaved();
    } catch (err) {
      const fe = fieldErrors(err);
      setErrors({ softPct: fe["thresholds.softPct"] ?? "", evictStartPct: fe["thresholds.evictStartPct"] ?? "", evictTargetPct: fe["thresholds.evictTargetPct"] ?? "" });
      toast({ title: "Couldn't save the thresholds", description: errorMessage(err), variant: "error" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <form id={`th-${row.volumeId}`} onSubmit={(e) => void save(e)} noValidate className="space-y-3 rounded-lg border p-4" data-testid="threshold-form" aria-label={`Thresholds for ${row.name}`}>
      <h3 className="text-sm font-semibold">{row.name}</h3>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field id={`th-soft-${row.volumeId}`} label="Slow downloads at (%)" hint="Opportunistic downloads wait above this." error={errors.softPct || undefined}>
          {(p) => <Input {...p} inputMode="numeric" value={v.soft} onChange={(e) => setV({ ...v, soft: e.target.value })} />}
        </Field>
        <Field id={`th-start-${row.volumeId}`} label="Start removing at (%)" hint="Removal begins above this." error={errors.evictStartPct || undefined}>
          {(p) => <Input {...p} inputMode="numeric" value={v.start} onChange={(e) => setV({ ...v, start: e.target.value })} />}
        </Field>
        <Field id={`th-target-${row.volumeId}`} label="Stop removing at (%)" hint="Removal stops once the volume is below this." error={errors.evictTargetPct || undefined}>
          {(p) => <Input {...p} inputMode="numeric" value={v.target} onChange={(e) => setV({ ...v, target: e.target.value })} />}
        </Field>
      </div>
      <Button type="submit" size="sm" disabled={!dirty || busy}>{busy ? "Saving…" : "Save thresholds"}<span className="sr-only"> for {row.name}</span></Button>
    </form>
  );
}

export function PolicyView() {
  const q = useApi<StoragePolicy>("/api/storage/policy");
  const { toast } = useToast();
  const p = q.data;
  const [auto, setAuto] = React.useState(true);
  const [throttle, setThrottle] = React.useState(true);
  const [prune, setPrune] = React.useState(true);
  const [grace, setGrace] = React.useState("24");
  const [batch, setBatch] = React.useState<{ text: string; unit: SizeUnit }>({ text: "", unit: "GB" });
  const [horizon, setHorizon] = React.useState("30");
  const [scrub, setScrub] = React.useState("64");
  const [advOpen, setAdvOpen] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [permitOpen, setPermitOpen] = React.useState(false);
  const [ack, setAck] = React.useState(false);
  const [permitBusy, setPermitBusy] = React.useState(false);
  const [permitError, setPermitError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState("");

  React.useEffect(() => {
    if (!p) return;
    setAuto(p.autoEviction); setThrottle(p.throttleOpportunistic); setPrune(p.pruneSurplusVersions);
    setGrace(String(Math.round((p.orphanGraceSeconds / 3600) * 100) / 100));
    setBatch(fromBytes(p.maxEvictionBatchBytes));
    setHorizon(String(p.forecastHorizonDays)); setScrub(String(p.scrubMegabytesPerRun));
  }, [p]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const g = Number(grace);
    if (!Number.isFinite(g) || g < 0 || g > 8760) errs.grace = "Enter hours from 0 to 8760.";
    const b = toBytes(batch.text, batch.unit);
    if (b === undefined) errs.batch = "Enter a number above zero, or leave it empty for no cap.";
    const h = Number(horizon);
    if (!Number.isInteger(h) || h < 7 || h > 365) errs.horizon = "Enter whole days from 7 to 365.";
    const s = Number(scrub);
    if (!Number.isInteger(s) || s < 0 || s > 4096) errs.scrub = "Enter megabytes from 0 to 4096.";
    setErrors(errs);
    if (Object.keys(errs).length) { setAdvOpen(true); setTimeout(() => document.querySelector<HTMLElement>('#policy-form [aria-invalid="true"]')?.focus(), 0); return; }
    setBusy(true); setFormError(null);
    try {
      await put("/api/storage/policy", {
        autoEviction: auto, throttleOpportunistic: throttle, pruneSurplusVersions: prune,
        orphanGraceSeconds: Math.round(g * 3600), maxEvictionBatchBytes: b ?? null, forecastHorizonDays: h, scrubMegabytesPerRun: s,
      });
      toast({ title: "Policy saved", variant: "success" });
      setSaved("Policy saved.");
      await q.mutate();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function setPermit(on: boolean) {
    setPermitBusy(true); setPermitError(null);
    try {
      await put("/api/storage/policy", on ? { permitImportantEviction: true, acknowledged: true } : { permitImportantEviction: false });
      toast({ title: on ? "Important content can now be removed automatically" : "Important content is protected from automatic removal again", variant: on ? "default" : "success" });
      setPermitOpen(false); setAck(false);
      await q.mutate();
    } catch (err) {
      setPermitError(errorMessage(err));
    } finally {
      setPermitBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Storage policy" description="When NoConBrain may remove saved copies to make room, and when each volume starts to act." />
      {q.error && !p ? <ErrorState title="Couldn't load the policy" message={q.error.message} onRetry={() => void q.mutate()} /> : null}
      {!p && !q.error ? <LoadingSkeleton variant="page" label="Loading the policy" /> : null}
      {p ? (
        <div className="space-y-8">
          <Notice testId="policy-protected" title="Protected content is safe">
            Protected (P1) content is never removed automatically, whatever any setting below says. Pages in a P1 source, collection or pin are always kept.
          </Notice>

          <form id="policy-form" onSubmit={(e) => void save(e)} noValidate className="space-y-5" aria-label="Removal settings">
            <FormError message={formError} />
            <Card>
              <CardHeader><CardTitle>Automatic removal</CardTitle><CardDescription>What happens when a volume fills up.</CardDescription></CardHeader>
              <CardContent className="space-y-5">
                <ToggleRow id="pol-auto" label="Remove old content when a volume is nearly full" description="Starts above a volume's eviction threshold and stops at its target. Lowest priority goes first. With this off, nothing is removed to make room and downloads that need space fail.">
                  {(a) => <Switch {...a} checked={auto} onCheckedChange={setAuto} data-testid="pol-auto" />}
                </ToggleRow>
                <ToggleRow id="pol-throttle" label="Slow Opportunistic downloads when space is getting short" description="Background Opportunistic (P4) downloads wait while every volume is above its soft threshold. Downloads you start yourself are never slowed.">
                  {(a) => <Switch {...a} checked={throttle} onCheckedChange={setThrottle} data-testid="pol-throttle" />}
                </ToggleRow>
                <ToggleRow id="pol-prune" label="Tidy up copies that nothing keeps" description="Removes old copies that no source, collection, pin or bookmark keeps any more. These count as Opportunistic and go first.">
                  {(a) => <Switch {...a} checked={prune} onCheckedChange={setPrune} data-testid="pol-prune" />}
                </ToggleRow>
                <ProtectedNote />
              </CardContent>
            </Card>

            <AdvancedSettings open={advOpen} onOpenChange={setAdvOpen} title="Advanced settings: grace period, caps and checks" id="pol-adv">
              <Field id="pol-grace" label="Keep unused files for (hours)" hint="How long a file that nothing uses is kept before it is deleted." error={errors.grace}>
                {(a) => <Input {...a} inputMode="decimal" value={grace} onChange={(e) => setGrace(e.target.value)} className="max-w-32" />}
              </Field>
              <Field id="pol-batch" label="Most one tidy-up may remove" hint="Leave empty for no cap. Does not limit removal when a download needs room." error={errors.batch}>
                {(a) => (
                  <div className="flex gap-2">
                    <Input {...a} inputMode="decimal" value={batch.text} onChange={(e) => setBatch({ ...batch, text: e.target.value })} className="max-w-32" />
                    <Select aria-label="Most one tidy-up may remove, unit" value={batch.unit} onChange={(e) => setBatch({ ...batch, unit: e.target.value as SizeUnit })} className="w-24"><option>MB</option><option>GB</option><option>TB</option></Select>
                  </div>
                )}
              </Field>
              <Field id="pol-horizon" label="Forecast period (days)" hint="How far ahead the forecast looks. 7 to 365." error={errors.horizon}>
                {(a) => <Input {...a} inputMode="numeric" value={horizon} onChange={(e) => setHorizon(e.target.value)} className="max-w-32" />}
              </Field>
              <Field id="pol-scrub" label="Checksum check per pass (MB)" hint="How much stored data is re-read and checked each time. 0 turns it off." error={errors.scrub}>
                {(a) => <Input {...a} inputMode="numeric" value={scrub} onChange={(e) => setScrub(e.target.value)} className="max-w-32" />}
              </Field>
            </AdvancedSettings>
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={busy} data-testid="policy-save">{busy ? "Saving…" : "Save policy"}</Button>
              <p role="status" className="text-sm text-muted-foreground" data-testid="policy-status">{saved}</p>
            </div>
          </form>

          <section aria-labelledby="permit-h" className="space-y-3" data-testid="permit-section">
            <h2 id="permit-h" className="text-lg font-semibold">Important (P2) content</h2>
            <Card className={p.permitImportantEviction ? "border-warning/70" : undefined}>
              <CardContent className="space-y-3 pt-4">
                <ToggleRow id="pol-permit" label="Allow automatic removal of Important (P2) content" description="Off by default. When space is critically short, Important content can be removed after everything less important has gone.">
                  {(a) => (
                    <Switch
                      {...a}
                      checked={p.permitImportantEviction}
                      onCheckedChange={(on) => { if (on) { setAck(false); setPermitError(null); setPermitOpen(true); } else void setPermit(false); }}
                      disabled={permitBusy}
                      data-testid="pol-permit"
                    />
                  )}
                </ToggleRow>
                <p className="text-sm" data-testid="permit-state">
                  {p.permitImportantEviction ? `On. Confirmed ${p.permitAcknowledgedAt ? formatDate(p.permitAcknowledgedAt) : ""}. Important content can be removed when nothing less important is left.` : "Off. Important content is only removed if you delete it yourself."}
                </p>
                {permitError && !permitOpen ? <FormError message={permitError} /> : null}
                <ProtectedNote />
                <p className="text-sm text-muted-foreground">Pages that a source or pin marks as &quot;never remove automatically&quot; are still kept.</p>
              </CardContent>
            </Card>
          </section>

          <section aria-labelledby="th-h" className="space-y-3" data-testid="thresholds">
            <h2 id="th-h" className="text-lg font-semibold">Thresholds by volume</h2>
            <p className="text-sm text-muted-foreground">Percentages are shares of the room NoConBrain has on a volume. <Link href="/storage/volumes" className="text-primary underline underline-offset-2">Manage volumes</Link></p>
            {p.volumeThresholds.map((r) => <ThresholdCard key={r.volumeId} row={r} onSaved={() => void q.mutate()} />)}
          </section>
        </div>
      ) : null}

      <ConfirmDialog
        open={permitOpen}
        onOpenChange={(o) => { setPermitOpen(o); if (!o) setAck(false); }}
        title="Allow removal of Important content?"
        description={
          <>
            <p data-testid="permit-warning">{p?.warnings.permitImportantEviction}</p>
            <p>Protected (P1) content is still never removed automatically.</p>
          </>
        }
        confirmLabel="Allow removal"
        destructive
        busy={permitBusy}
        confirmDisabled={!ack}
        onConfirm={() => void setPermit(true)}
        testId="permit"
      >
        <div className="flex items-start gap-2">
          <Checkbox id="permit-ack" checked={ack} onCheckedChange={(v) => setAck(v === true)} data-testid="permit-ack" />
          <Label htmlFor="permit-ack" className="font-normal leading-snug">{PERMIT_ACK_LABEL}</Label>
        </div>
        {permitError ? <FormError message={permitError} /> : null}
      </ConfirmDialog>
    </>
  );
}

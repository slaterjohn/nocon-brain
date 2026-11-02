"use client";

import * as React from "react";
import { Pencil, Plus, ScanSearch, Trash2 } from "lucide-react";
import { del, errorMessage, fieldErrors, patch, post, useApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input, Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { AdvancedSettings } from "@/components/common/advanced-settings";
import { Field, FormError } from "@/components/common/form";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";
import { useSources } from "@/components/library/hooks";
import { fromBytes, thresholdErrors, toBytes, VOLUME_STATE_HELP, VOLUME_STATE_TEXT, type SizeUnit, type StorageOverview, type Volume, type VolumeState } from "@/lib/storage";
import { ConfirmDialog, Notice, useReturnFocus } from "./shared";
import { VolumeCard } from "./space-view";

interface VerifyReport { volume: Volume; markerOk: boolean; writable: boolean; checkedBlobs: number; missingBlobs: number; missingExamples: string[] }

function SizeField({ id, label, hint, error, text, unit, onText, onUnit }: {
  id: string; label: string; hint: string; error?: string; text: string; unit: SizeUnit; onText: (v: string) => void; onUnit: (u: SizeUnit) => void;
}) {
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      {(p) => (
        <div className="flex gap-2">
          <Input {...p} inputMode="decimal" value={text} onChange={(e) => onText(e.target.value)} className="max-w-40" />
          <Select aria-label={`${label}, unit`} value={unit} onChange={(e) => onUnit(e.target.value as SizeUnit)} className="w-24">
            <option>MB</option><option>GB</option><option>TB</option>
          </Select>
        </div>
      )}
    </Field>
  );
}

const SETTABLE: VolumeState[] = ["online", "readonly", "draining", "disabled"];

export function VolumeDialog({ volume, open, onClose, onSaved }: { volume: Volume | null; open: boolean; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const editing = volume !== null;
  const [name, setName] = React.useState("");
  const [path, setPath] = React.useState("");
  const [quota, setQuota] = React.useState<{ text: string; unit: SizeUnit }>({ text: "", unit: "GB" });
  const [reserve, setReserve] = React.useState<{ text: string; unit: SizeUnit }>({ text: "", unit: "GB" });
  const [makeDefault, setMakeDefault] = React.useState(false);
  const [state, setState] = React.useState<VolumeState>("online");
  const [th, setTh] = React.useState({ softPct: "85", evictStartPct: "90", evictTargetPct: "80" });
  const [advOpen, setAdvOpen] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const returnFocus = useReturnFocus(open);

  React.useEffect(() => {
    if (!open) return;
    setErrors({}); setFormError(null); setAdvOpen(false);
    setName(volume?.name ?? "");
    setPath("");
    setQuota(fromBytes(volume?.quotaBytes));
    setReserve(volume ? fromBytes(volume.reserveFreeBytes) : { text: "", unit: "GB" });
    setMakeDefault(volume?.isDefault ?? false);
    setState(volume && SETTABLE.includes(volume.state) ? volume.state : "online");
    setTh({ softPct: String(volume?.thresholds.softPct ?? 85), evictStartPct: String(volume?.thresholds.evictStartPct ?? 90), evictTargetPct: String(volume?.thresholds.evictTargetPct ?? 80) });
  }, [open, volume]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = "Enter a name.";
    if (!editing && !path.trim()) errs.path = "Enter the folder on the drive, for example /mnt/archive.";
    const q = toBytes(quota.text, quota.unit);
    if (q === undefined) errs.quota = "Enter a number above zero, or leave it empty for no limit.";
    const r = toBytes(reserve.text, reserve.unit);
    if (r === undefined) errs.reserve = "Enter a number above zero, or leave it empty.";
    if (editing) Object.assign(errs, thresholdErrors({ softPct: Number(th.softPct), evictStartPct: Number(th.evictStartPct), evictTargetPct: Number(th.evictTargetPct) }));
    setErrors(errs);
    if (Object.keys(errs).length) {
      if (["softPct", "evictStartPct", "evictTargetPct"].some((k) => errs[k])) setAdvOpen(true);
      setTimeout(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      if (editing) {
        await patch(`/api/storage/volumes/${volume!.id}`, {
          name: name.trim(), quotaBytes: q ?? null, ...(r !== null ? { reserveFreeBytes: r } : {}),
          thresholds: { softPct: Number(th.softPct), evictStartPct: Number(th.evictStartPct), evictTargetPct: Number(th.evictTargetPct) },
          ...(SETTABLE.includes(volume!.state) ? { state } : {}), ...(makeDefault && !volume!.isDefault ? { isDefault: true } : {}),
        });
        toast({ title: "Volume saved", description: name.trim(), variant: "success" });
      } else {
        await post("/api/storage/volumes", { name: name.trim(), path: path.trim(), ...(q ? { quotaBytes: q } : {}), ...(r ? { reserveFreeBytes: r } : {}), ...(makeDefault ? { makeDefault: true } : {}) });
        toast({ title: "Volume added", description: name.trim(), variant: "success" });
      }
      onSaved();
      onClose();
    } catch (err) {
      const fe = fieldErrors(err);
      const mapped: Record<string, string> = {};
      for (const [k, v] of Object.entries(fe)) mapped[k.replace(/^thresholds\./, "").replace(/^quotaBytes$/, "quota").replace(/^reserveFreeBytes$/, "reserve")] = v;
      if (Object.keys(mapped).length) {
        setErrors(mapped);
        if (["softPct", "evictStartPct", "evictTargetPct"].some((k) => mapped[k])) setAdvOpen(true);
      } else setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl" data-testid="volume-dialog" onCloseAutoFocus={returnFocus}>
        <DialogTitle>{editing ? `Edit ${volume!.name}` : "Add a volume"}</DialogTitle>
        <DialogDescription>{editing ? "Change the name, the limit and when removal starts." : "Register a folder on a drive. The folder must be inside a location the server has been allowed to use."}</DialogDescription>
        <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
          <FormError message={formError} />
          <Field id="vol-name" label="Name" error={errors.name}>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />}</Field>
          {!editing ? (
            <Field id="vol-path" label="Folder" hint="The full path on the machine running NoConBrain." error={errors.path}>
              {(p) => <Input {...p} value={path} onChange={(e) => setPath(e.target.value)} autoComplete="off" spellCheck={false} />}
            </Field>
          ) : null}
          <SizeField id="vol-quota" label="Limit for NoConBrain" hint="The most this volume may hold. Leave empty to use the whole drive." error={errors.quota} text={quota.text} unit={quota.unit} onText={(v) => setQuota({ ...quota, text: v })} onUnit={(u) => setQuota({ ...quota, unit: u })} />
          <SizeField id="vol-reserve" label="Always keep free" hint="Space left alone for other things on the drive. Background downloads pause below this." error={errors.reserve} text={reserve.text} unit={reserve.unit} onText={(v) => setReserve({ ...reserve, text: v })} onUnit={(u) => setReserve({ ...reserve, unit: u })} />
          <div className="flex items-center gap-2">
            <Checkbox id="vol-default" checked={makeDefault} disabled={editing && volume!.isDefault} onCheckedChange={(v) => setMakeDefault(v === true)} />
            <Label htmlFor="vol-default" className="font-normal">Use as the default volume{editing && volume!.isDefault ? " (it already is)" : ""}</Label>
          </div>
          {editing ? (
            <AdvancedSettings open={advOpen} onOpenChange={setAdvOpen} title="Advanced settings: state and thresholds" id="vol-adv">
              {SETTABLE.includes(volume!.state) ? (
                <Field id="vol-state" label="State" hint={VOLUME_STATE_HELP[state]}>
                  {(p) => <Select {...p} value={state} onChange={(e) => setState(e.target.value as VolumeState)}>{SETTABLE.map((s) => <option key={s} value={s}>{VOLUME_STATE_TEXT[s]}</option>)}</Select>}
                </Field>
              ) : (
                <p className="text-sm text-muted-foreground">This volume is {VOLUME_STATE_TEXT[volume!.state].toLowerCase()}, so its state can&apos;t be set by hand. {VOLUME_STATE_HELP[volume!.state]}</p>
              )}
              <p className="text-xs text-muted-foreground">Thresholds are shares of the room NoConBrain has on the volume: its limit if one is set, otherwise its own files plus the free space.</p>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field id="vol-soft" label="Slow downloads at" hint="Percent. Opportunistic downloads wait above this." error={errors.softPct}>
                  {(p) => <Input {...p} inputMode="numeric" value={th.softPct} onChange={(e) => setTh({ ...th, softPct: e.target.value })} />}
                </Field>
                <Field id="vol-start" label="Start removing at" hint="Percent. Removal begins above this." error={errors.evictStartPct}>
                  {(p) => <Input {...p} inputMode="numeric" value={th.evictStartPct} onChange={(e) => setTh({ ...th, evictStartPct: e.target.value })} />}
                </Field>
                <Field id="vol-target" label="Stop removing at" hint="Percent. Must be below the start." error={errors.evictTargetPct}>
                  {(p) => <Input {...p} inputMode="numeric" value={th.evictTargetPct} onChange={(e) => setTh({ ...th, evictTargetPct: e.target.value })} />}
                </Field>
              </div>
            </AdvancedSettings>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy} data-testid="volume-save">{busy ? "Saving…" : editing ? "Save volume" : "Add volume"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function VerifyDialog({ volume, onClose }: { volume: Volume | null; onClose: () => void }) {
  const [report, setReport] = React.useState<VerifyReport | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const returnFocus = useReturnFocus(volume !== null);
  React.useEffect(() => {
    setReport(null); setError(null);
    if (!volume) return;
    let live = true;
    post<VerifyReport>(`/api/storage/volumes/${volume.id}/verify`).then((r) => live && setReport(r)).catch((e) => live && setError(errorMessage(e)));
    return () => { live = false; };
  }, [volume]);
  return (
    <Dialog open={!!volume} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="verify-dialog" onCloseAutoFocus={returnFocus}>
        <DialogTitle>Check {volume?.name}</DialogTitle>
        <DialogDescription>Looks for the drive&apos;s marker, tries a test write and checks that every stored file is still there. It reports only and changes nothing.</DialogDescription>
        <div role="status" aria-live="polite" className="text-sm" data-testid="verify-result">
          {!report && !error ? "Checking…" : null}
          {error ? <FormError message={error} /> : null}
          {report ? (
            <ul className="list-disc space-y-1 pl-5">
              <li>{report.markerOk ? "The drive's marker file is in place." : "The drive's marker file is missing or does not match. This looks like a different or unplugged drive."}</li>
              <li>{report.writable ? "A test write worked." : "The volume can't be written to right now."}</li>
              <li>{report.checkedBlobs.toLocaleString("en-GB")} stored {report.checkedBlobs === 1 ? "file" : "files"} checked, {report.missingBlobs === 0 ? "none missing" : `${report.missingBlobs.toLocaleString("en-GB")} missing`}.</li>
            </ul>
          ) : null}
        </div>
        <div className="flex justify-end"><Button variant="outline" onClick={onClose}>Close</Button></div>
      </DialogContent>
    </Dialog>
  );
}

export function VolumesView() {
  const overview = useApi<StorageOverview>("/api/storage", { refreshInterval: 15_000 });
  const sources = useSources();
  const { toast } = useToast();
  const [edit, setEdit] = React.useState<{ volume: Volume | null } | null>(null);
  const [checking, setChecking] = React.useState<Volume | null>(null);
  const [removing, setRemoving] = React.useState<Volume | null>(null);
  const [removeError, setRemoveError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const o = overview.data;

  async function remove() {
    if (!removing) return;
    setBusy(true);
    setRemoveError(null);
    try {
      await del(`/api/storage/volumes/${removing.id}`);
      toast({ title: "Volume removed", description: removing.name, variant: "success" });
      setRemoving(null);
      await overview.mutate();
    } catch (e) {
      setRemoveError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Volumes"
        description="The drives and folders NoConBrain saves to. New files go to a source's preferred volume when it has room, otherwise to the writable volume with the most room."
        actions={<Button onClick={() => setEdit({ volume: null })} data-testid="volume-add"><Plus aria-hidden="true" /> Add a volume</Button>}
      />
      {overview.error && !o ? <ErrorState title="Couldn't load volumes" message={overview.error.message} onRetry={() => void overview.mutate()} /> : null}
      {!o && !overview.error ? <LoadingSkeleton variant="cards" rows={2} label="Loading volumes" /> : null}
      {o && o.volumes.length === 0 ? <EmptyState title="No volumes yet" description="Add a volume to start saving pages." /> : null}
      {o ? (
        <ul className="grid gap-4 md:grid-cols-2" aria-label="Volumes">
          {o.volumes.map((v) => {
            const prefers = sources.sources.filter((s) => s.preferredVolumeId === v.id);
            return (
              <li key={v.id} className="space-y-2" data-testid="volume-item">
                <VolumeCard v={v} over={o.eviction.overThreshold.includes(v.id)} />
                <p className="px-1 text-sm text-muted-foreground" data-testid="volume-preferred">
                  {v.isDefault ? "Default volume. " : ""}
                  {prefers.length ? `Preferred by ${prefers.map((s) => s.name).join(", ")}.` : "No source prefers this volume."}
                </p>
                <div className="flex flex-wrap gap-2 px-1">
                  <Button size="sm" variant="outline" onClick={() => setEdit({ volume: v })} data-testid="volume-edit"><Pencil aria-hidden="true" /> Edit<span className="sr-only"> {v.name}</span></Button>
                  <Button size="sm" variant="outline" onClick={() => setChecking(v)} data-testid="volume-verify"><ScanSearch aria-hidden="true" /> Check<span className="sr-only"> {v.name}</span></Button>
                  <Button size="sm" variant="ghost" onClick={() => { setRemoveError(null); setRemoving(v); }} data-testid="volume-remove"><Trash2 aria-hidden="true" /> Remove<span className="sr-only"> {v.name}</span></Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      <p className="mt-6 text-sm text-muted-foreground">Moving saved files from one volume to another is not available yet.</p>
      <VolumeDialog open={edit !== null} volume={edit?.volume ?? null} onClose={() => setEdit(null)} onSaved={() => void overview.mutate()} />
      <VerifyDialog volume={checking} onClose={() => setChecking(null)} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o2) => !o2 && setRemoving(null)}
        title={`Remove ${removing?.name ?? "this volume"}?`}
        description={<><p>This only forgets the volume. It does not delete the folder or anything in it.</p><p>A volume that still holds saved files can&apos;t be removed. Set it to draining and wait for it to empty first.</p></>}
        confirmLabel="Remove volume"
        destructive
        busy={busy}
        onConfirm={() => void remove()}
        testId="volume-remove"
      >
        {removeError ? <Notice tone="warning" testId="volume-remove-error">{removeError}</Notice> : null}
      </ConfirmDialog>
    </>
  );
}
